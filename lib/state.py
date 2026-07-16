"""Cross-module state — one project id per open .blend, last-N receipts."""

from __future__ import annotations

from collections import deque
from typing import Any, Deque, Dict, Optional

MAX_RECENT_RECEIPTS = 5


class AddonState:
    def __init__(self) -> None:
        self.active_project_id: Optional[int] = None
        self.active_project_name: Optional[str] = None
        self.active_project_status: Optional[str] = None
        self.recent_receipts: Deque[Dict[str, Any]] = deque(maxlen=MAX_RECENT_RECEIPTS)
        self.last_error: Optional[str] = None
        self.payment_method_summary: Optional[str] = None

    def record_receipt(self, receipt: Dict[str, Any]) -> None:
        self.recent_receipts.appendleft(dict(receipt))

    def clear(self) -> None:
        self.active_project_id = None
        self.active_project_name = None
        self.active_project_status = None
        self.recent_receipts.clear()
        self.last_error = None
        self.payment_method_summary = None


STATE = AddonState()


def get() -> AddonState:
    return STATE


def reset() -> None:
    STATE.clear()
