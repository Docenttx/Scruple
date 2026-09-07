"""Adapter-facing configuration knobs: base_url override, timeout,
verbose logging.

Deliberately thin. Rendering a settings panel is the adapter's job (host
hook contract, CANON_SKELETON.md §4) -- this module only holds values
and normalizes the one field (`base_url`) that has a wrong-shape trap
(trailing slash, empty string) worth catching in one place instead of at
every call site.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_BASE_URL = "https://scruple.ai"
DEFAULT_TIMEOUT_SECONDS = 30.0


@dataclass
class Preferences:
    base_url: str = DEFAULT_BASE_URL
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    verbose: bool = False

    def normalized_base_url(self) -> str:
        return (self.base_url or DEFAULT_BASE_URL).strip().rstrip("/")
