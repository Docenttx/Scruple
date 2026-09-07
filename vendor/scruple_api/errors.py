"""Exceptions this package raises.

Every one is a subclass of ScrupleError. The ones that matter most to an
adapter author are NoBaselineError (D-3: witnessing without a baseline
is impossible from this SDK, not merely discouraged), MimeRequiredError
(property 1: MIME is declared, never guessed), and
ModalityUnavailableError (property 2: an unknown or inapplicable
modality fails closed, never downgrades).
"""

from __future__ import annotations

from typing import Any, Optional


class ScrupleError(Exception):
    """Base class for every exception this package raises."""


class ScrupleTransportError(ScrupleError):
    """Raised internally by http._transport() on a network-level failure
    (DNS, connection refused, timeout, malformed response). This is an
    implementation detail of the http module: it is caught by
    http.submit() and turned into a Result, so it should never reach
    adapter code directly."""


class ScrupleAPIError(ScrupleError):
    """The server reached us and said no. Carries the HTTP status and,
    where the server sent one, its structured error code and detail so
    an adapter can show something more useful than the exception text."""

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
        detail: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.detail = detail


class BaselineConflictError(ScrupleAPIError):
    """A baseline already exists and attach() was asked to establish a
    fresh one instead of verifying it. Practically unreachable through
    Client.attach() (it verifies first) but kept distinct for callers
    that talk to the baseline lifecycle directly."""


class NoBaselineError(ScrupleError):
    """witness() or mark() was attempted with no baseline established on
    this session. Raised BEFORE any network call -- D-3 says a leaf
    without a baseline_ref is not Scruple-witnessed at all, so the SDK
    refuses locally rather than letting a server 409 be the first sign
    of trouble. Call Client.attach() first."""


class MimeRequiredError(ScrupleError):
    """capture() was called with no `mime`, or an empty/whitespace one.
    There is no fallback to mimetypes.guess_type() or to
    application/octet-stream anywhere in this package -- see
    capture.capture()'s docstring for why."""


class ModalityUnavailableError(ScrupleError):
    """mark() was asked for a modality that is unknown, or that GET
    /capabilities reports unavailable for this host/mime, or that could
    not be confirmed available at all. Raised before the /mark request
    is sent -- there is no downgrade to a substitute modality."""
