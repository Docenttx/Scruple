"""Verbosity-aware logging shim.

Kept from lib/logging.py unchanged. This is the one module of the old
lib/ with no SDK counterpart at all -- `scruple_host_sdk` has no logging
module and its inventory of what it owns does not list one, so this
stays as adapter code (gap.json, modules row 12, verdict
"keep -- adapter code").

Renamed from `logging` to `log` on the way across so that nothing in
this package can shadow the standard library module by accident.
"""

from __future__ import annotations

import os
import sys
import time

_PREFIX = "[scruple]"

_verbose = os.environ.get("SCRUPLE_BLENDER_VERBOSE") == "1"


def set_verbose(flag: bool) -> None:
    global _verbose
    _verbose = bool(flag)


def is_verbose() -> bool:
    return _verbose


def _emit(level: str, msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    line = f"{_PREFIX} {ts} {level} {msg}"
    print(line, file=sys.stderr, flush=True)


def info(msg: str) -> None:
    if _verbose:
        _emit("INFO", msg)


def warn(msg: str) -> None:
    _emit("WARN", msg)


def error(msg: str) -> None:
    _emit("ERR ", msg)
