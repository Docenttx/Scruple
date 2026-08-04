"""Tests for OS patch date extraction / recency verdict."""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import os_patch_check  # noqa: E402


class TestParseIso(unittest.TestCase):
    def test_z_suffix(self):
        dt = os_patch_check._parse_iso("2026-08-04T02:00:00Z")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.year, 2026)

    def test_offset_suffix(self):
        dt = os_patch_check._parse_iso("2026-08-04T02:00:00+00:00")
        self.assertIsNotNone(dt)

    def test_bad_input(self):
        self.assertIsNone(os_patch_check._parse_iso("not a date"))
        self.assertIsNone(os_patch_check._parse_iso(""))


class TestReadLastDnf(unittest.TestCase):
    def _fake_log(self, lines):
        p = Path("/tmp/scruple_test_dnf.rpm.log")
        p.write_text("\n".join(lines))
        return p

    def test_iso_format(self):
        p = self._fake_log([
            "2026-08-01T12:00:00Z SUBDEBUG Installed: pkg-a-1.0",
            "2026-08-03T14:30:00Z SUBDEBUG Updated: pkg-b-2.0",
            "2026-08-02T09:00:00Z SUBDEBUG Installed: pkg-c-1.1",
        ])
        dt = os_patch_check._read_last_dnf_ts(p)
        self.assertIsNotNone(dt)
        self.assertEqual(dt.day, 3)
        p.unlink()

    def test_no_matching_lines(self):
        p = self._fake_log([
            "2026-08-01T12:00:00Z SUBDEBUG Some unrelated log line",
            "2026-08-02T09:00:00Z SUBDEBUG Downloaded: pkg-c-1.1",
        ])
        dt = os_patch_check._read_last_dnf_ts(p)
        self.assertIsNone(dt)
        p.unlink()

    def test_nonexistent(self):
        dt = os_patch_check._read_last_dnf_ts(Path("/nonexistent/file"))
        self.assertIsNone(dt)


class TestReadLastApt(unittest.TestCase):
    def test_typical_apt_log(self):
        p = Path("/tmp/scruple_test_apt_history.log")
        p.write_text("""Start-Date: 2026-08-01  15:23:45
Commandline: apt install curl
End-Date: 2026-08-01  15:24:02

Start-Date: 2026-08-03  09:12:00
Commandline: apt upgrade
End-Date: 2026-08-03  09:15:30

Start-Date: 2026-08-02  11:00:00
Commandline: apt install jq
End-Date: 2026-08-02  11:00:20
""")
        dt = os_patch_check._read_last_apt_ts(p)
        self.assertIsNotNone(dt)
        self.assertEqual(dt.day, 3)
        p.unlink()


class TestPatchRecencyVerdict(unittest.TestCase):
    def setUp(self):
        # Ensure fresh cache for each test
        with os_patch_check._cache_lock:
            os_patch_check._cache.clear()
        # Simulate dev mode (VAULT_KEY_OCID unset)
        os.environ.pop("SCRUPLE_C2PA_VAULT_KEY_OCID", None)

    def test_dev_mode_none_signal_permits(self):
        """In dev with no detection signal, sign is permitted."""
        with patch.object(os_patch_check, "os_security_patch_date", return_value=None):
            v = os_patch_check.patch_recency_verdict()
        self.assertFalse(v["refuse"])
        self.assertEqual(v["source"], "none")

    def test_production_none_signal_refuses(self):
        """In production, no detection signal means refuse-to-sign (fail-closed)."""
        os.environ["SCRUPLE_C2PA_VAULT_KEY_OCID"] = "ocid1.key.oc1.iad.aaaaaaa"
        try:
            with patch.object(os_patch_check, "os_security_patch_date", return_value=None):
                v = os_patch_check.patch_recency_verdict()
            self.assertTrue(v["refuse"])
        finally:
            os.environ.pop("SCRUPLE_C2PA_VAULT_KEY_OCID", None)

    def test_fresh_patch_permits(self):
        fresh = datetime.now(timezone.utc) - timedelta(days=10)
        with patch.object(os_patch_check, "os_security_patch_date", return_value=fresh):
            v = os_patch_check.patch_recency_verdict()
        self.assertFalse(v["refuse"])
        self.assertIsNotNone(v["patch_date"])
        self.assertLess(v["patch_age_days"], 11)

    def test_stale_patch_refuses(self):
        stale = datetime.now(timezone.utc) - timedelta(days=120)
        with patch.object(os_patch_check, "os_security_patch_date", return_value=stale):
            v = os_patch_check.patch_recency_verdict()
        self.assertTrue(v["refuse"])
        self.assertGreater(v["patch_age_days"], 90)

    def test_configurable_max_age(self):
        os.environ["SCRUPLE_OS_PATCH_MAX_AGE_DAYS"] = "30"
        try:
            recent = datetime.now(timezone.utc) - timedelta(days=45)
            with patch.object(os_patch_check, "os_security_patch_date", return_value=recent):
                v = os_patch_check.patch_recency_verdict()
            self.assertTrue(v["refuse"])
            self.assertEqual(v["max_age_days"], 30.0)
        finally:
            os.environ.pop("SCRUPLE_OS_PATCH_MAX_AGE_DAYS", None)


class TestIntegration(unittest.TestCase):
    def test_real_host_detection_returns_something_or_none(self):
        """On any workstation the module runs cleanly and returns either a
        real datetime or None. Both are acceptable; no crash."""
        with os_patch_check._cache_lock:
            os_patch_check._cache.clear()
        result = os_patch_check.os_security_patch_date()
        # Should not raise; may be None or a datetime
        self.assertTrue(result is None or isinstance(result, datetime))


if __name__ == "__main__":
    unittest.main()
