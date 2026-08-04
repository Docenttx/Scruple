"""Scruple Signer — OS security patch date extraction & 90-day recency check.

Satisfies C2PA GPSR §6.3.2 and §6.4.2 (Level 2): the Signer MUST
extract and validate the OS security patch level date against a 90-day
rolling window, not rely on VM instance age as a proxy.

## Detection method

Detection order (returns first success):

  1. **RPM systems (Oracle Linux / RHEL / Alma / Rocky)**
     Reads `/var/log/dnf.rpm.log` (or `/var/log/dnf/dnf.rpm.log`) for
     the most recent `INSTALL` or `UPDATE` line and takes its timestamp.
     Fallback: `rpm -qa --qf '%{INSTALLTIME:date}\\n'` and take the
     most-recent INSTALLTIME across all packages.

  2. **Debian/Ubuntu systems (dev/workspace + any Ubuntu-based CVMs)**
     Reads `/var/log/apt/history.log` (+ rotated `.gz` if needed) for
     the most recent `End-Date:` and takes that timestamp.

  3. **Fallback signal** (all detection failed): returns None. Callers
     treat "no signal" the same as "stale" — refuse to sign.

## Interpretation

The returned date is "the most recent time a package was installed or
upgraded on this system." That is the strongest defensible per-instance
signal of patch recency without querying an external CVE feed and
without depending on the specific vendor advisory format. On a
production Signer CVM under the Instance Pool + rotation lifecycle
(GPSA §C.2.3), this date will be close to the CVM's `time_created`
because the base image is patched at build time. On a stale instance
(one that missed rotation and has been running longer than the 90-day
window without any package activity), this date will fall behind
`now - 90d` and the guard trips.

## Cost

At most one file read + one datetime parse per Signer process (cached
for process lifetime). Fallback rpm query runs one subprocess. All are
milliseconds.
"""

from __future__ import annotations

import gzip
import os
import re
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


PATCH_MAX_AGE_DAYS_DEFAULT = 90.0

# dnf.rpm.log format: "2026-08-04T02:00:00Z SUBDEBUG Installed: package-1.2.3-x86_64"
# (dnf5 uses ISO 8601 timestamps; older dnf uses "Aug 04 02:00:00" — accept both)
_DNF_LINE = re.compile(
    r"^(?P<ts>[0-9T:\-\.Z+]+)\s+\S+\s+(?:Installed|Updated|Upgraded|Reinstalled):",
)
_DNF_LINE_LEGACY = re.compile(
    r"^(?P<mon>[A-Z][a-z]{2})\s+(?P<day>\d{1,2})\s+(?P<hms>\d{2}:\d{2}:\d{2})\s+.*"
    r"(?:Installed|Updated|Upgraded|Reinstalled):",
)

# apt history.log format:
#   Start-Date: 2026-08-01  15:23:45
#   End-Date: 2026-08-01  15:24:02
_APT_END_DATE = re.compile(r"^End-Date:\s+(?P<ymd>\d{4}-\d{2}-\d{2})\s+(?P<hms>\d{2}:\d{2}:\d{2})")


_cache_lock = threading.Lock()
_cache: Dict[str, Any] = {}
_CACHE_KEY = "patch_date_utc"


def _parse_iso(ts: str) -> Optional[datetime]:
    s = ts.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _parse_legacy_dnf(m: re.Match) -> Optional[datetime]:
    """Legacy 'Aug 04 02:00:00' without year — assume current year (heuristic;
    this format is essentially deprecated on OL9+ but kept as a safety net)."""
    mon_map = {"Jan":1,"Feb":2,"Mar":3,"Apr":4,"May":5,"Jun":6,
               "Jul":7,"Aug":8,"Sep":9,"Oct":10,"Nov":11,"Dec":12}
    try:
        mon = mon_map[m.group("mon")]
        day = int(m.group("day"))
        h, mi, s = [int(x) for x in m.group("hms").split(":")]
        yr = datetime.now(timezone.utc).year
        dt = datetime(yr, mon, day, h, mi, s, tzinfo=timezone.utc)
        # If the resulting date is in the future, roll back one year
        if dt > datetime.now(timezone.utc) + timedelta(days=1):
            dt = dt.replace(year=yr - 1)
        return dt
    except Exception:
        return None


def _read_last_dnf_ts(log_path: Path) -> Optional[datetime]:
    """Read a dnf.rpm.log and return the timestamp of the most recent
    INSTALL/UPDATE/UPGRADE line, or None."""
    if not log_path.exists() or not log_path.is_file():
        return None
    try:
        # Read line-by-line, keep track of the last matching timestamp.
        # File is usually small (< 1MB); reading whole is fine.
        latest: Optional[datetime] = None
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                m = _DNF_LINE.match(line)
                if m:
                    dt = _parse_iso(m.group("ts"))
                    if dt and (latest is None or dt > latest):
                        latest = dt
                    continue
                m2 = _DNF_LINE_LEGACY.match(line)
                if m2:
                    dt = _parse_legacy_dnf(m2)
                    if dt and (latest is None or dt > latest):
                        latest = dt
        return latest
    except Exception:
        return None


def _read_last_apt_ts(log_path: Path) -> Optional[datetime]:
    """Read /var/log/apt/history.log and return the latest End-Date."""
    if not log_path.exists() or not log_path.is_file():
        return None
    try:
        latest: Optional[datetime] = None
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                m = _APT_END_DATE.match(line)
                if m:
                    ymd = m.group("ymd")
                    hms = m.group("hms")
                    dt = _parse_iso(f"{ymd}T{hms}+00:00")
                    if dt and (latest is None or dt > latest):
                        latest = dt
        return latest
    except Exception:
        return None


def _rpm_qa_last_installtime() -> Optional[datetime]:
    """Fallback: shell out to rpm and read the newest INSTALLTIME across all packages."""
    try:
        # %{INSTALLTIME} gives epoch seconds; portable across rpm versions.
        r = subprocess.run(
            ["rpm", "-qa", "--qf", "%{INSTALLTIME}\n"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0 or not r.stdout:
            return None
        latest_epoch = 0
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line or not line.isdigit():
                continue
            v = int(line)
            if v > latest_epoch:
                latest_epoch = v
        if latest_epoch == 0:
            return None
        return datetime.fromtimestamp(latest_epoch, tz=timezone.utc)
    except Exception:
        return None


def os_security_patch_date() -> Optional[datetime]:
    """Return the most-recent OS package-install/upgrade UTC datetime,
    or None if all detection methods failed. Cached for process lifetime.
    """
    with _cache_lock:
        if _CACHE_KEY in _cache:
            return _cache[_CACHE_KEY]

        # 1. RPM-based (Oracle Linux, RHEL, Alma, Rocky)
        for p in (Path("/var/log/dnf.rpm.log"),
                  Path("/var/log/dnf/dnf.rpm.log")):
            dt = _read_last_dnf_ts(p)
            if dt:
                _cache[_CACHE_KEY] = dt
                return dt

        # 2. Debian/Ubuntu apt
        dt = _read_last_apt_ts(Path("/var/log/apt/history.log"))
        if dt:
            _cache[_CACHE_KEY] = dt
            return dt

        # 3. rpm fallback (shell out)
        dt = _rpm_qa_last_installtime()
        if dt:
            _cache[_CACHE_KEY] = dt
            return dt

        _cache[_CACHE_KEY] = None
        return None


def _max_age_days() -> float:
    """Configurable, defaults to 90 (the L2 spec floor)."""
    try:
        v = float(os.environ.get("SCRUPLE_OS_PATCH_MAX_AGE_DAYS",
                                 str(PATCH_MAX_AGE_DAYS_DEFAULT)))
        return v if v > 0 else PATCH_MAX_AGE_DAYS_DEFAULT
    except Exception:
        return PATCH_MAX_AGE_DAYS_DEFAULT


def patch_recency_verdict() -> Dict[str, Any]:
    """Compute the sign / refuse-to-sign verdict for OS patch recency.

    Returns dict with:
      refuse: bool
      reason: str
      patch_date: str | None            (ISO 8601 UTC)
      patch_age_days: float | None
      max_age_days: float
      source: str                       (which detection method fired)
      detection_available: bool

    Fail-closed policy (production):
      - If SCRUPLE_C2PA_VAULT_KEY_OCID is set (production Signer CVM),
        and detection returns None, refuse=True (can't prove patch recency).
      - If SCRUPLE_C2PA_VAULT_KEY_OCID is unset (dev / non-signer host),
        detection failure is tolerated: refuse=False so dev signing works.
    """
    max_age = _max_age_days()
    is_production = bool(os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID"))

    dt = os_security_patch_date()
    if dt is None:
        return {
            "refuse": is_production,
            "reason": (
                "OS patch date unavailable (no dnf/apt history readable) — "
                "refuse=True in production (fail-closed); refuse=False in dev."
            ),
            "patch_date": None,
            "patch_age_days": None,
            "max_age_days": max_age,
            "source": "none",
            "detection_available": False,
        }

    # Determine which source fired (by reading cache we just populated)
    # This is a cheap re-check for observability; source labelling only.
    source = "unknown"
    for p, label in (
        (Path("/var/log/dnf.rpm.log"), "dnf.rpm.log"),
        (Path("/var/log/dnf/dnf.rpm.log"), "dnf/dnf.rpm.log"),
        (Path("/var/log/apt/history.log"), "apt/history.log"),
    ):
        if p.exists():
            source = label
            break
    else:
        source = "rpm-qa-fallback"

    age = (datetime.now(timezone.utc) - dt).total_seconds() / 86400.0
    if age > max_age:
        return {
            "refuse": True,
            "reason": (
                f"OS security patch age {age:.2f}d exceeds max {max_age:.0f}d. "
                f"Most recent package install/upgrade was {dt.isoformat()} "
                f"(source: {source}). Refusing to sign."
            ),
            "patch_date": dt.isoformat(),
            "patch_age_days": round(age, 3),
            "max_age_days": max_age,
            "source": source,
            "detection_available": True,
        }
    return {
        "refuse": False,
        "reason": f"OS patch age {age:.2f}d within max {max_age:.0f}d",
        "patch_date": dt.isoformat(),
        "patch_age_days": round(age, 3),
        "max_age_days": max_age,
        "source": source,
        "detection_available": True,
    }
