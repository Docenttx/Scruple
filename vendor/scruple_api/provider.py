"""Late-binding provider registration -- ported from OpenTelemetry's
`opentelemetry-api/src/opentelemetry/trace/__init__.py`
(`Once` / `_TRACER_PROVIDER` / `ProxyTracerProvider` / `ProxyTracer`).

See `docs/canon/oss-study/opentelemetry.md` §1.3-1.5 for the study; the
sources were read at `/data/oss-study/otel-python`. What follows is the
pattern, not the code.

THE PROBLEM IT SOLVES, IN OUR SHAPE
-----------------------------------
A vendor instruments once. Whether Scruple is configured is a deployment
concern that is decided later, by someone else, in another file. Both of
those facts are true at the same time, and the instrumented module runs
first:

    # vendors/acme/inference/handler.py   -- imported at process start
    import scruple_api
    recorder = scruple_api.get_recorder(host="acme-inference", integration_version="4.2.0")

    def on_artifact(path, mime):
        recorder.witness_file(path, mime=mime, kind="artifact")

    # vendors/acme/bootstrap.py           -- runs later, if at all
    import scruple_host_sdk
    scruple_host_sdk.register(api_key=os.environ["SCRUPLE_API_KEY"])

At the moment `handler.py` is imported there is no provider, so
`get_recorder()` hands back a `ProxyWitnessRecorder` wrapping a
`NoOpWitnessRecorder`. `on_artifact` is live and inert. When
`bootstrap.py` later registers a real provider, the *same recorder
object* -- the one `handler.py` captured in a module global and can never
be persuaded to look up again -- resolves a real recorder on its next
call and starts producing leaves. No re-import, no restart, no dependency
injection through six layers of vendor code, and no `if scruple_enabled:`
guard at every call site.

This is not hypothetical for us in the way the OTel study guessed it was.
The study (§5.1) concluded the proxy was "probably over-engineering for
our actual deployment topology" on the grounds that Scruple's SDK is
provisioned once at service startup. That reasoning holds for a plain
server process and fails for the embedded-interpreter hosts this SDK
exists for: a Blender add-on's module body runs at *enable* time, well
before its `register()` hook; a Fusion add-in and a ComfyUI custom node
have the same shape. Module-level `get_recorder(...)` before
configuration is the normal case there, not an edge case.

WHAT DID NOT TRANSFER FROM OTEL, DELIBERATELY
---------------------------------------------
1. **Entry-point provider discovery.** OTel's `get_tracer_provider()`
   will, if `OTEL_PYTHON_TRACER_PROVIDER` is set, resolve a provider class
   by name out of the installed-distribution entry-point registry
   (`opentelemetry-api/src/opentelemetry/util/_providers.py`). Not ported,
   for two independent reasons. It needs installed-distribution metadata,
   which a vendored copy dropped into an embedded interpreter does not
   have. And it would make the effective provider selectable by an
   environment variable -- i.e. by the measured party, at runtime, from a
   value they control. A capture path chosen by whoever controls the
   environment is `unattested-client` by definition, whatever the
   deployment claims (`surface.py`, module caveat). Registration here is
   an explicit call in code we publish and measure. There is no env-var
   path and there will not be one.

2. **Warn-and-continue on re-registration.** OTel logs
   "Overriding of current TracerProvider is not allowed" and keeps the
   first provider; the caller is not told in any way they can act on. The
   worst case there is a dropped span. Ours is evidence attributed to a
   provider the caller does not think is running, so a *different*
   provider raises `ProviderAlreadySetError`. Re-registering the same
   object is idempotent and silent, because add-on enable/disable cycles
   do exactly that.

3. **A total no-op.** OTel's `NoOpTracer` does nothing at all, and that is
   right for telemetry. Ours cannot: two of the three properties
   CANON_SKELETON.md §5 says the SDK owns are decidable without a network
   and must therefore hold with no SDK present. `NoOpWitnessRecorder`
   below is a *validating* no-op -- it refuses an undeclared MIME and an
   unknown modality, and reports honestly that nothing was witnessed. See
   `capture.require_mime` and `modality.require_known`, each of which has
   exactly one implementation and two call sites straddling the line.
"""

from __future__ import annotations

import os
from threading import Lock
from typing import Any, Callable, Dict, Iterable, List, Optional, Protocol, runtime_checkable

from .capture import require_mime
from .errors import ScrupleError
from .modality import Capability, require_known
from .outcomes import AttachResult, MarkOutcome, Outstanding, WitnessOutcome

__all__ = [
    "Once",
    "ProviderAlreadySetError",
    "WitnessRecorder",
    "WitnessProvider",
    "NoOpWitnessRecorder",
    "NoOpWitnessProvider",
    "ProxyWitnessRecorder",
    "ProxyWitnessProvider",
    "set_witness_provider",
    "get_witness_provider",
    "reset_witness_provider",
    "get_recorder",
    "is_configured",
    "NO_SDK_REASON",
]

NO_SDK_REASON = (
    "no Scruple SDK is registered in this process; nothing was witnessed. "
    "Call scruple_host_sdk.register(...) during startup."
)


class ProviderAlreadySetError(ScrupleError):
    """A second, different witness provider was registered. See this
    module's docstring, item 2: unlike OTel we refuse rather than warn,
    because the caller of the losing registration would otherwise carry
    on believing their provider is the one producing evidence."""


class Once:
    """Threadsafe do-once. Straight port of
    `opentelemetry-api/src/opentelemetry/util/_once.py`, including the
    unlocked fast path -- the read of `_done` is a single attribute load
    and racing it can only cost a redundant lock acquisition, never a
    second execution."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._done = False

    def do_once(self, func: Callable[[], None]) -> bool:
        if self._done:
            return False
        with self._lock:
            if not self._done:
                func()
                self._done = True
                return True
        return False

    def reset(self) -> None:
        with self._lock:
            self._done = False


# ── The two interfaces ──────────────────────────────────────────────────────


@runtime_checkable
class WitnessRecorder(Protocol):
    """The instrumentation surface. `scruple_host_sdk.Client` satisfies
    this structurally -- it is not a subclass and does not import this
    module, which is the point: the SDK's real object and the no-op are
    interchangeable at every call site.

    Deliberately absent, and it is the same list CANON_SKELETON.md §5
    gives for an adapter: there is no `request()`, no payment method, no
    MIME-deciding method, no applicability-deciding method, and no retry
    method. `payment` has no shape in `scruple-api` at all -- giving the
    API a payment type would be the first step toward an adapter handling
    payment, which §5 forbids outright.
    """

    def attach(self, **kwargs: Any) -> AttachResult: ...
    def witness(self, *, kind: str, content_hash: str, mime: str, **kwargs: Any) -> WitnessOutcome: ...
    def witness_file(self, path: str, *, mime: str, kind: str, **kwargs: Any) -> WitnessOutcome: ...
    def mark(self, *, leaf_id: str, mime: str, **kwargs: Any) -> MarkOutcome: ...
    def capabilities(self, *, mime: str) -> List[Capability]: ...
    def detach(self) -> Dict[str, int]: ...


@runtime_checkable
class WitnessProvider(Protocol):
    """Hands out recorders. One per process, registered once."""

    def get_recorder(self, *, host: str, integration_version: str, **kwargs: Any) -> WitnessRecorder: ...


# ── The no-op default ───────────────────────────────────────────────────────


class NoOpWitnessRecorder:
    """What instrumentation gets when no SDK is registered.

    Inert on the wire, not inert on the contract. Every method here
    either enforces a §5 property that is decidable locally, or returns an
    outcome that says plainly that nothing happened. None of them raises
    for the ordinary "not configured" case -- a vendor's Save handler must
    not start throwing because a deployment has not wired Scruple in yet.
    """

    __slots__ = ("host", "integration_version")

    def __init__(self, *, host: str = "", integration_version: str = "") -> None:
        self.host = host
        self.integration_version = integration_version

    # -- lifecycle ------------------------------------------------------
    def attach(self, **kwargs: Any) -> AttachResult:
        """No baseline, and no pretence of one. `baseline_ref=None` is the
        same field D-3 makes `witness()` gate on, so a caller that checks
        `attach().baseline_ref` gets the truth."""
        return AttachResult(baseline_ref=None, established=False, drifted=False)

    def detach(self) -> Dict[str, int]:
        """Nothing was ever queued -- see property 3's placement note in
        `scruple_api/__init__.py`. Zeros, not a lie about a flush."""
        return {"succeeded": 0, "failed": 0, "remaining": 0}

    # -- capture / witness ----------------------------------------------
    def witness(self, *, kind: str, content_hash: str, mime: str, **kwargs: Any) -> WitnessOutcome:
        require_mime(mime, caller="witness()")
        return _unwitnessed()

    def witness_file(self, path: str, *, mime: str, kind: str, **kwargs: Any) -> WitnessOutcome:
        """Property 1 is enforced here, by the same function `capture()`
        uses. The file is NOT hashed or read: hashing costs real time on
        every save for a result nothing will ever consume. The two checks
        that are kept are the two that catch a miswired call site --
        undeclared MIME, and a path that is not there."""
        require_mime(mime, caller="witness_file()")
        if not path or not os.path.exists(path):
            raise FileNotFoundError(f"witness_file(): no file at {path!r}")
        return _unwitnessed()

    def mark(
        self,
        *,
        leaf_id: str,
        mime: str,
        modalities: Optional[Iterable[str]] = None,
        **kwargs: Any,
    ) -> MarkOutcome:
        """Property 2's local half, enforced by the same function the SDK
        uses. An unknown modality raises here exactly as it would with an
        SDK registered. A *known* modality is reported outstanding --
        requested, not applied, with a reason. There is no path through
        this method that returns `witnessed=True` or puts anything in
        `modalities_applied`."""
        requested = list(dict.fromkeys(modalities or []))
        for m in requested:
            require_known(m)
        return MarkOutcome(
            leaf_id=leaf_id,
            modalities_requested=requested,
            modalities_applied=[],
            outstanding=[Outstanding(modality=m, reason=NO_SDK_REASON) for m in requested],
            local_lock={},
            witnessed=False,
            queued=False,
            error=NO_SDK_REASON,
        )

    def capabilities(self, *, mime: str) -> List[Capability]:
        """Empty, never a synthesised optimistic list. The SDK's
        `capabilities.check()` treats an empty result as "could not be
        determined -> refuse", so this fails closed downstream too."""
        return []


def _unwitnessed() -> WitnessOutcome:
    return WitnessOutcome(
        leaf_id=None,
        leaf_hash=None,
        witnessed=False,
        leaf_scheme=None,
        baseline_ref=None,
        queued=False,  # see property 3's placement note -- nothing was spooled
        error=NO_SDK_REASON,
    )


class NoOpWitnessProvider:
    def get_recorder(self, *, host: str, integration_version: str, **kwargs: Any) -> WitnessRecorder:
        return NoOpWitnessRecorder(host=host, integration_version=integration_version)


# ── The proxy: the part that makes late binding work ───────────────────────


class ProxyWitnessRecorder:
    """The `ProxyTracer` equivalent. Holds no state that a late-arriving
    provider would invalidate; it resolves on every call until it can
    resolve for real, then caches.

    Resolution is deliberately per-call and not cached-on-first-miss: the
    whole point is that an object created before registration works after
    it, and a recorder that memoised the no-op on its first pre-config
    call would be permanently dead.
    """

    __slots__ = ("_host", "_integration_version", "_kwargs", "_real", "_noop")

    def __init__(self, *, host: str, integration_version: str, **kwargs: Any) -> None:
        self._host = host
        self._integration_version = integration_version
        self._kwargs = kwargs
        self._real: Optional[WitnessRecorder] = None
        self._noop = NoOpWitnessRecorder(host=host, integration_version=integration_version)

    @property
    def _recorder(self) -> WitnessRecorder:
        if self._real is not None:
            return self._real
        provider = _WITNESS_PROVIDER
        if provider is not None:
            self._real = provider.get_recorder(
                host=self._host, integration_version=self._integration_version, **self._kwargs
            )
            return self._real
        return self._noop

    @property
    def is_live(self) -> bool:
        """True once this recorder is backed by a registered provider.
        For diagnostics and tests; call sites should not branch on it --
        branching on configuration state at the call site is the thing
        this whole module exists to remove."""
        return self._real is not None or _WITNESS_PROVIDER is not None

    def attach(self, **kwargs: Any) -> AttachResult:
        return self._recorder.attach(**kwargs)

    def witness(self, *, kind: str, content_hash: str, mime: str, **kwargs: Any) -> WitnessOutcome:
        return self._recorder.witness(kind=kind, content_hash=content_hash, mime=mime, **kwargs)

    def witness_file(self, path: str, *, mime: str, kind: str, **kwargs: Any) -> WitnessOutcome:
        return self._recorder.witness_file(path, mime=mime, kind=kind, **kwargs)

    def mark(self, *, leaf_id: str, mime: str, **kwargs: Any) -> MarkOutcome:
        return self._recorder.mark(leaf_id=leaf_id, mime=mime, **kwargs)

    def capabilities(self, *, mime: str) -> List[Capability]:
        return self._recorder.capabilities(mime=mime)

    def detach(self) -> Dict[str, int]:
        return self._recorder.detach()


class ProxyWitnessProvider:
    def get_recorder(self, *, host: str, integration_version: str, **kwargs: Any) -> WitnessRecorder:
        if _WITNESS_PROVIDER is not None:
            return _WITNESS_PROVIDER.get_recorder(
                host=host, integration_version=integration_version, **kwargs
            )
        return ProxyWitnessRecorder(host=host, integration_version=integration_version, **kwargs)


# ── The globals, and the Once that guards them ─────────────────────────────

_PROVIDER_SET_ONCE = Once()
_WITNESS_PROVIDER: Optional[WitnessProvider] = None
_PROXY_PROVIDER = ProxyWitnessProvider()


def set_witness_provider(provider: WitnessProvider) -> None:
    """Register the process-wide provider. Called by
    `scruple_host_sdk.register()`, not by instrumentation.

    Idempotent for the same object. A different object raises -- see the
    module docstring, item 2. `reset_witness_provider()` is the deliberate
    escape hatch for a host that tears an integration down and stands it
    back up (add-on disable/enable).
    """

    def _install() -> None:
        global _WITNESS_PROVIDER
        _WITNESS_PROVIDER = provider

    did_set = _PROVIDER_SET_ONCE.do_once(_install)
    if not did_set and _WITNESS_PROVIDER is not provider:
        raise ProviderAlreadySetError(
            "A different Scruple witness provider is already registered in "
            "this process. It was NOT replaced. Evidence would otherwise be "
            "produced by a provider the caller of this registration does not "
            "know about. Call reset_witness_provider() first if you are "
            "deliberately re-registering (add-on disable/enable)."
        )


def get_witness_provider() -> WitnessProvider:
    """The registered provider, or the proxy that will pick one up later.
    Never None, and never raises -- unconfigured is a legal state."""
    if _WITNESS_PROVIDER is None:
        return _PROXY_PROVIDER
    return _WITNESS_PROVIDER


def reset_witness_provider() -> None:
    """Clear the registration. Public and documented, unlike OTel, because
    embedded hosts really do tear down and re-enable an integration inside
    one interpreter. Recorders already handed out fall back to their no-op
    on their next call and pick up the next registration after that."""
    global _WITNESS_PROVIDER
    _WITNESS_PROVIDER = None
    _PROVIDER_SET_ONCE.reset()


def is_configured() -> bool:
    return _WITNESS_PROVIDER is not None


def get_recorder(*, host: str, integration_version: str, **kwargs: Any) -> WitnessRecorder:
    """The one call instrumentation makes. Safe at module scope, safe
    before configuration, safe forever after."""
    return get_witness_provider().get_recorder(
        host=host, integration_version=integration_version, **kwargs
    )
