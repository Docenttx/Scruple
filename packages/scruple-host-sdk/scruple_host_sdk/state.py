"""Cross-call session state: one Client, one baseline, a short receipt
history, and a cache of what GET /capabilities has already told us.

Deliberately dumb -- a bag of fields Client reads and writes. Anything
that decides something (whether a modality is available, whether a
baseline is stale) lives in capabilities.py or client.py, not here.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional, Tuple

MAX_RECENT_RECEIPTS = 5


@dataclass
class SessionState:
    host: Optional[str] = None
    integration_version: Optional[str] = None

    # Set only after a live (non-queued) 2xx from POST/GET baseline*.
    # D-3: this is the field witness_flow.witness() checks before making
    # any network call at all.
    baseline_ref: Optional[str] = None
    tamper_surface_hash: Optional[str] = None

    recent_receipts: Deque[Dict[str, Any]] = field(default_factory=lambda: deque(maxlen=MAX_RECENT_RECEIPTS))
    last_error: Optional[str] = None

    # (host, mime) -> [Capability, ...], populated by capabilities.fetch()
    capabilities_cache: Dict[Tuple[str, str], List[Any]] = field(default_factory=dict)

    def record_receipt(self, receipt: Dict[str, Any]) -> None:
        self.recent_receipts.appendleft(dict(receipt))

    def clear(self) -> None:
        self.baseline_ref = None
        self.tamper_surface_hash = None
        self.recent_receipts.clear()
        self.last_error = None
        self.capabilities_cache.clear()
