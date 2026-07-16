"""Verbosity-aware logging shim.

Blender addons print to stdout. Silencing chatty modules by default keeps
the console clean; users can flip on `verbose` in preferences to get the
full trace when reporting a bug.
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
