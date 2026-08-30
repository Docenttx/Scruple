"""Re-export of the exception hierarchy, which lives in `scruple-api`.

This file is a shim on purpose and must stay one. The classes have to be
the SAME class objects on both sides of the API/SDK line: a vendor writes
`except ScrupleError:` once, at a call site that may be running against
the no-op today and a registered SDK tomorrow, and two structurally
identical hierarchies defined in two packages would make that `except`
silently stop matching. One definition, imported.

See `scruple_api/errors.py` for the classes and why each exists.
"""

from __future__ import annotations

from scruple_api.errors import (
    BaselineConflictError,
    MimeRequiredError,
    ModalityUnavailableError,
    NoBaselineError,
    ScrupleAPIError,
    ScrupleError,
    ScrupleTransportError,
)

__all__ = [
    "ScrupleError",
    "ScrupleTransportError",
    "ScrupleAPIError",
    "BaselineConflictError",
    "NoBaselineError",
    "MimeRequiredError",
    "ModalityUnavailableError",
]
