# OSS study: OpenTelemetry's API/SDK split, applied to Scruple

**Bottom line:** OTel proves a spec-with-many-vendors pattern works — thin no-op API package, separate SDK package, a late-binding proxy that upgrades in place when the real SDK registers itself, and a self-declared per-language compliance matrix — and every piece of it maps cleanly onto `scruple-host-sdk` except the enforcement layer, which OTel deliberately leaves social and Scruple cannot, because Scruple signs evidence rather than just describing telemetry. Split `scruple-host-sdk` into a thin `scruple-api` (interfaces + a no-op default, safe to vendor into any codebase with zero network risk) and a `scruple-sdk` (the real `http.py`-gated implementation), replace prose-only P1–P8 with an OTel-style numbered, anchor-linked matrix that vendors self-attest against, then bolt on what OTel has no analogue for: a machine-checked baseline attestation that verifies the self-attestation instead of trusting it. Treat the witness leaf's 8 canonical fields the way OTel treats semantic-convention attributes — a versioned registry with `stability`, `deprecated.renamed_to`, and a schema-transform path — not a hand-maintained struct. The one place the OTel model breaks down hardest: OTel's compliance matrix has no cell for "and we cryptographically proved it," because OTel was never asked to produce evidence, only telemetry.

Sources cloned via `git clone --depth 50`: `/data/oss-study/otel-spec` (open-telemetry/opentelemetry-specification), `/data/oss-study/otel-semconv` (open-telemetry/semantic-conventions), `/data/oss-study/otel-python` (open-telemetry/opentelemetry-python). All three cloned successfully — no fallback to WebFetch was needed.

**License:** All three repos are Apache License 2.0 (confirmed by reading `LICENSE` in each). Apache-2.0 §3 is an explicit, irrevocable patent grant from each contributor covering their contributions, with a termination-on-litigation clause. This matters for a "many vendors implement our spec" model: vendors adopting an Apache-2.0 spec get patent peace of mind for free, which lowers the switching/adoption barrier relative to a spec under a plain copyright license.

---

## 1. The API/SDK split — the priority finding

### 1.1 What the spec says the split *is*, and why

`specification/overview.md` states the architecture directly:

> "OpenTelemetry clients are designed to separate the portion of each signal which must be imported as cross-cutting concerns from the portions which can be managed independently. [...] each signal consists of four types of packages: API, SDK, Semantic Conventions, and Contrib."
>
> "**API** packages consist of the cross-cutting public interfaces used for instrumentation. Any portion of an OpenTelemetry client which is imported into third-party libraries and application code is considered part of the API."
>
> "**SDK** [...] is the implementation of the API provided by the OpenTelemetry project. Within an application, the SDK is installed and managed by the application owner. [...] **Instrumentation authors MUST NOT directly reference any SDK package of any kind, only the API.**"

The reasoning given is architectural, not political: instrumentation is a **cross-cutting concern** (`overview.md`, citing the Wikipedia definition) — code that gets mixed into every library that wants to describe itself. A cross-cutting concern that pulls in a heavyweight, fast-moving, configuration-bearing implementation would create version-lock hell across an entire dependency graph. `specification/versioning-and-stability.md` names this explicitly as a design goal:

> "Instrumentation APIs cannot create a version conflict, ever. Otherwise, the OpenTelemetry API cannot be embedded in widely shared libraries, such as web frameworks. [...] Transitive dependencies of the API cannot create a version conflict."

### 1.2 What is literally in each package (verified in code, not just docs)

`opentelemetry-python/opentelemetry-api/pyproject.toml`:
```
dependencies = [
    "typing-extensions >= 4.5.0",
]
```
That's the entire runtime dependency list of the API package — no dependency on the SDK, no vendor backend, nothing else.

`opentelemetry-python/opentelemetry-sdk/pyproject.toml`:
```
dependencies = [
  "opentelemetry-api == 1.45.0.dev",
  "opentelemetry-semantic-conventions == 0.66b0.dev",
  "typing-extensions >= 4.5.0",
]
```
The dependency arrow points one way: SDK → API. A library that only calls the API (e.g. an instrumented HTTP client) never pulls in the SDK's exporters, processors, samplers, or resource detectors. Those only load when the *application owner* installs the SDK.

### 1.3 The no-op default — read from the actual code

`specification/trace/api.md`, "Behavior of the API in the absence of an installed SDK":

> "In general, in the absence of an installed SDK, the Trace API is a 'no-op' API. This means that operations on a Tracer, or on Spans, should have no side effects and do nothing. However, there is one important exception [...] related to propagation of a `SpanContext`."

In `opentelemetry-python/opentelemetry-api/src/opentelemetry/trace/__init__.py`, this isn't aspirational — it's a real, small implementation with three cooperating classes:

```python
class NoOpTracerProvider(TracerProvider):
    """The default TracerProvider, used when no implementation is available.
    All operations are no-op.
    """
    def get_tracer(self, ...) -> "Tracer":
        return NoOpTracer()
```

```python
class NoOpTracer(Tracer):
    """The default Tracer, used when no Tracer implementation is available.
    All operations are no-op.
    """
    def start_span(self, name, context=None, ...) -> "Span":
        current_span = get_current_span(context)
        if isinstance(current_span, NonRecordingSpan):
            return current_span
        ...
        return NonRecordingSpan(context=parent_span_context)
```

The load-bearing property: an app or library can call `tracer.start_span(...)`, `span.set_attribute(...)`, `span.end()` — the *entire* API surface — with **zero SDK installed**, and it costs a few no-op function calls, never a `None`-check, `try/except`, or crash. This is why library authors are willing to instrument unconditionally: instrumenting costs nothing to a consumer who never sets up telemetry. Compare to a hypothetical world where calling the untooled API throws — no library maintainer would ship that as a mandatory import.

### 1.4 The late-binding proxy — how the SDK "plugs in" at runtime

This is the mechanism that makes the no-op default *and* live upgrade both work without the instrumented code ever re-importing anything. Three module-level globals and a class, all in `opentelemetry/trace/__init__.py`:

```python
_TRACER_PROVIDER_SET_ONCE = Once()
_TRACER_PROVIDER: TracerProvider | None = None
_PROXY_TRACER_PROVIDER = ProxyTracerProvider()

def set_tracer_provider(tracer_provider: TracerProvider) -> None:
    """Sets the current global TracerProvider object.
    This can only be done once, a warning will be logged if any further attempt is made.
    """
    _set_tracer_provider(tracer_provider, log=True)

def get_tracer_provider() -> TracerProvider:
    if _TRACER_PROVIDER is None:
        if OTEL_PYTHON_TRACER_PROVIDER not in os.environ:
            return _PROXY_TRACER_PROVIDER
        tracer_provider = _load_provider(OTEL_PYTHON_TRACER_PROVIDER, "tracer_provider")
        _set_tracer_provider(tracer_provider, log=False)
    return cast("TracerProvider", _TRACER_PROVIDER)
```

`ProxyTracer` is the trick that lets code obtained *before* the SDK is installed still start working the moment it is:

```python
class ProxyTracer(Tracer):
    def __init__(self, ...):
        self._real_tracer: Tracer | None = None
        self._noop_tracer = NoOpTracer()

    @property
    def _tracer(self) -> Tracer:
        if self._real_tracer:
            return self._real_tracer
        if _TRACER_PROVIDER:
            self._real_tracer = _TRACER_PROVIDER.get_tracer(...)
            return self._real_tracer
        return self._noop_tracer

    def start_span(self, *args, **kwargs) -> Span:
        return self._tracer.start_span(*args, **kwargs)
```

Sequence: a library calls `trace.get_tracer("my.module")` at import time, long before `main()` runs. Because no `TracerProvider` is set yet, it gets back a `ProxyTracer` wrapping a `NoOpTracer`. Later, the application owner's bootstrap code calls `trace.set_tracer_provider(TracerProvider())` (the real SDK class, `opentelemetry.sdk.trace.TracerProvider`). `_TRACER_PROVIDER` flips from `None` to the real provider exactly once (`Once()` — a threadsafe do-once), permanently. Every `ProxyTracer` object created earlier lazily resolves `self._tracer` on its **next call** and now returns the real tracer. No re-import, no dependency injection, no restart — the exact same object reference the library cached at import time starts producing real telemetry.

There is also an env-var-driven plugin discovery path via Python entry points, used for auto-instrumentation agents rather than the common app-owner path:

`opentelemetry-sdk/pyproject.toml`:
```
[project.entry-points.opentelemetry_tracer_provider]
sdk_tracer_provider = "opentelemetry.sdk.trace:TracerProvider"
```

`opentelemetry-api/src/opentelemetry/util/_providers.py`:
```python
def _load_provider(provider_environment_variable, provider):
    from opentelemetry.util._importlib_metadata import entry_points
    provider_name = environ.get(provider_environment_variable, f"default_{provider}")
    return entry_points(group=f"opentelemetry_{provider}", name=provider_name).__iter__().__next__().load()()
```
If `OTEL_PYTHON_TRACER_PROVIDER` is set, `get_tracer_provider()` resolves an SDK class by name via Python's standard packaging entry-point registry rather than requiring an explicit `set_tracer_provider()` call in code — this is what lets `opentelemetry-instrument` wrap an arbitrary, un-modified process and inject the SDK without touching its source.

### 1.5 Why this is load-bearing for adoption

Two guarantees fall directly out of the split, both stated as explicit design goals in `versioning-and-stability.md`:
- "It MUST always be possible to upgrade to the latest minor version of the OpenTelemetry SDK, without creating compilation or runtime errors" — because instrumented code never references the SDK, upgrading the SDK independently of every instrumented library is safe by construction.
- "A library that imports the OpenTelemetry API should never become incompatible with other libraries due to a version conflict in one of OpenTelemetry's dependencies" — the API's near-zero dependency footprint (one small typing shim) means two libraries pinning different API minor versions essentially never collide.

The practical consequence: a database driver, web framework, or gRPC library can hard-depend on `opentelemetry-api` in its own `pyproject.toml`/`package.json` forever, unconditionally, regardless of whether the end application ever turns on tracing. That's what "every library instrumented out of the box" (`overview.md`, Instrumentation Libraries section) requires as a precondition.

---

## 2. Semantic conventions

### 2.1 The model: YAML-defined, versioned, machine-checked shape

Each concept is a YAML "group" of attributes. `otel-semconv/model/http/common.yaml`:
```yaml
groups:
  - id: attributes.http.common
    type: attribute_group
    brief: "Describes HTTP attributes."
    attributes:
      - ref: http.request.method
        requirement_level: required
      - ref: http.response.status_code
        requirement_level:
          conditionally_required: If and only if one was received/sent.
      - ref: error.type
        requirement_level:
          conditionally_required: If request has ended with an error.
        note: |
          ... SHOULD be set to exception type ...
```
Attribute *definitions* (name, type, stability, examples, deprecation) live separately in a per-namespace registry, e.g. `otel-semconv/model/http/registry.yaml`:
```yaml
  - id: http.request.method
    stability: stable
    ...
  - id: http.request.body.size
    type: int
    stability: development  # this should not be marked stable with other HTTP attributes
```
So the model answers "if you record this concept, what are the exact attribute names, their types, and whether each is required/conditionally-required/opt-in" as structured, typed data — not free-text prose. `requirement_level` even has RFC-2119-equivalent granularity baked into the schema itself (`required` / `conditionally_required: <condition text>` / `recommended` / `opt_in`).

### 2.2 What enforces conformance

Two different things, and the distinction matters for the synthesis below:

1. **Shape/validity of the convention definitions themselves is machine-enforced in CI**, via the Weaver tool plus Open Policy Agent (Rego) policies checked into `otel-semconv/policies/`:
```
# otel-semconv/policies/brief.rego
package after_resolution
import rego.v1
deny contains finding if {
    some attr in input.registry.attributes
    brief := object.get(attr, "brief", null)
    {brief == null, brief == ""}[_]
    finding := {"id": "brief_required", "message": sprintf("Attribute '%s' is invalid. Attributes must have a brief.", [attr.key]), "level": "violation", ...}
}
```
   The `Makefile` wires this into `make check` via a containerized `weaver registry check` run. This catches malformed conventions (missing briefs, bad naming, invalid types) before merge.

2. **Whether a given vendor's instrumentation actually emits attributes that match the convention is NOT machine-checked anywhere in these three repos.** There is no test in `otel-python` (or referenced from the spec) that inspects emitted spans from, say, `opentelemetry-instrumentation-flask` and asserts `http.request.method` is present with the right type. Conformance to semantic conventions, once you leave the "is the YAML well-formed" question, is documentation + code review + the compliance matrix (§4) — not a runtime gate.

### 2.3 Codegen

`otel-semconv/templates/registry/markdown/weaver.yaml` and sibling template dirs drive Weaver to generate docs and, per-language, typed constants from the YAML (the spec says in `overview.md`: "Both the collector and the client libraries SHOULD autogenerate semantic convention keys and enum values into constants ... The YAML files MUST be used as the source of truth for generation"). Generation prevents *typos* in constant names; it does nothing to guarantee an instrumentation library actually calls `span.set_attribute(SemanticAttributes.HTTP_REQUEST_METHOD, ...)` at the right place.

### 2.4 Deprecation / rename mechanism

`otel-semconv/model/http/deprecated/registry-deprecated.yaml`:
```yaml
  - id: http.method
    type: string
    brief: 'Deprecated, use `http.request.method` instead.'
    stability: development
    deprecated:
      reason: renamed
      renamed_to: http.request.method
```
A structured `deprecated.reason` + `deprecated.renamed_to` pointer, not prose. This is consumed by Telemetry Schemas (`specification/schemas/README.md`) to let collectors/backends transform old-named telemetry into new names without breaking dashboards — see §5.

---

## 3. Stability guarantees

`specification/maturity-levels.md` defines the ladder: **Development → Alpha → Beta → Release Candidate → Stable → Deprecated → Unmaintained/Removed.** Each level's text is itself a set of behavioral commitments, e.g. Stable: "Breaking changes ... are only allowed under special circumstances. Whenever possible, users should be given prior notice." Deprecated: "Components that are included in distributions are expected to exist for at least two minor releases or six months, whichever happens later. They also MUST communicate in which version they will be removed."

`specification/versioning-and-stability.md` then applies this ladder specifically to API vs SDK, with different commitments per package type:

- **API Stability**: "Backward-incompatible changes to API packages MUST NOT be made unless the major version number is incremented. All existing API calls MUST continue to compile and function against all future minor versions of the same major version."
- **SDK Stability**: splits SDK's public surface into **plugin interfaces** (`SpanProcessor`, `Exporter`, `Sampler` — extension points vendors/users implement) and **constructors** (config objects, env vars, builders — what app owners call). Both must remain backward compatible once stable, with an explicit escape hatch for extending plugin interfaces without a major bump: "add a method overload," or add default implementations, or "add a new interface instead of extending the existing one and accept the new interface in addition to the old one in every place."
- Marking something Development vs Stable is a per-*component*, not per-*package*, decision — "different packages within the same release may have different levels of stability" and "The API MUST become stable before the other components" (i.e., API stabilizes first, SDK/semconv can lag).

---

## 4. The specification compliance matrix

Found at `otel-spec/spec-compliance-matrix.md`, generated from `otel-spec/spec-compliance-matrix/{go,java,js,python,...}.yaml` by `otel-spec/.github/scripts/compliance_matrix.py`, driven by `make compliance-matrix`.

**Granularity of a "requirement":** a single named leaf behavior nested under a linked spec-section heading, e.g. under `[TracerProvider](specification/trace/api.md#tracerprovider-operations)`: "Create TracerProvider", "Get a Tracer", "Get a Tracer with schema_url", "Safe for concurrent calls", "Shutdown (SDK only required)". This is finer than a section, coarser than an RFC-2119 sentence — each row is roughly one testable behavior, hand-extracted from spec prose by whoever wrote that language's YAML, not auto-derived from parsed MUST/SHOULD sentences.

**Requirement phrasing:** the spec-wide notation is RFC 2119 (`specification/README.md`, "Notation Conventions and Compliance"):
> "The keywords 'MUST', 'MUST NOT', 'REQUIRED', 'SHOULD', 'SHOULD NOT', 'RECOMMENDED', 'NOT RECOMMENDED', 'MAY', and 'OPTIONAL' ... are to be interpreted as described in BCP 14 [RFC2119] [RFC8174]." And: "An implementation of the specification is not compliant if it fails to satisfy one or more of the 'MUST', 'MUST NOT', 'REQUIRED' requirements."

**Are requirements individually addressable/numbered?** No stable requirement IDs exist. Addressability is only via markdown anchor (`specification/trace/api.md#tracerprovider-operations`) plus a hand-written row name in the matrix — there is no `REQ-047` scheme. Cross-referencing a MUST sentence to a matrix cell is a manual, human act done once when the YAML row is authored.

**Per-language YAML example** (`python.yaml`):
```yaml
sections:
  - name: Traces
    features:
      - heading: '[TracerProvider](specification/trace/api.md#tracerprovider-operations)'
        features:
          - name: Create TracerProvider
            status: '+'
          - name: Get a Tracer with scope attributes
            status: '+'
```
Legend: `+` implemented, `-` not implemented, `?` unknown, blank = unknown, `N/A` = not applicable to that language. `CONTRIBUTING.md` §"Compliance Matrix": "To update the compliance matrix, edit the language YAML file in `spec-compliance-matrix/` ... and regenerate: `make compliance-matrix`. Compliance matrix updates do not require a CHANGELOG entry."

**Who fills it in, and how it's enforced:** self-reported by that language SIG's own maintainers via a normal PR requiring "two or more approvals from code owners, with approvals from at least two companies" (`CONTRIBUTING.md`) — the same generic PR-review bar as any other change. **There is no CI job that runs a client's actual test suite and derives `+`/`-` automatically.** This is the self-declared, social-enforcement model referenced in the task brief, and it is confirmed rather than assumed: nothing in `.github/scripts/compliance_matrix.py` does anything but re-render YAML → Markdown; it never inspects the target language's source or test results.

---

## 5. Instrumentation libraries

Confirmed in `overview.md` (Instrumentation Libraries section) and the glossary: "Instrumentation Author: The maintainer of OpenTelemetry instrumentation written against the OpenTelemetry API." and (Overview, API section) "Instrumentation authors MUST NOT directly reference any SDK package of any kind, only the API." Naming convention: "opentelemetry-instrumentation" + instrumented-library name (`opentelemetry-instrumentation-flask`), with an escape hatch for third parties outside the OTel org (`{company}-opentelemetry-instrumentation-{component}`) to avoid namespace collisions.

Mechanically this works because of §1.2/§1.3: a library only needs `opentelemetry-api` (one dependency, `typing-extensions`) in its manifest, and every call against that API is a safe no-op if the embedding application never sets up an SDK. So `opentelemetry-instrumentation-flask` can be a permanent, unconditional dependency of a web app's Flask integration without forcing every Flask user who doesn't care about tracing to pull in exporters, batch processors, or a configured backend.

---

## Mapping to Scruple

### 5.1 Should `scruple-host-sdk` split into API + SDK packages?

**Yes, and the shape is dictated directly by the module list.** Currently `scruple-host-sdk` (13 modules: `http.py`, `client.py`, `capture.py`, `witness_flow.py`, `queue.py`, `payment.py`, `capabilities.py`, `manifest.py`, `state.py`, `auth.py`, `preferences.py`, `errors.py`, `__init__.py`) is one package a vendor imports wholesale. That conflates two very different consumers:

- **Instrumentation call sites** — the code a vendor sprinkles through their own Save handler, ComfyUI node, Kohya training loop: "here is an artifact, here is an event, capture/witness it." This is the cross-cutting surface, analogous to `tracer.start_span()`.
- **The thing that actually talks to our witness server, holds the tenant key, and enforces the boundary** — `http.py` (the sole network gateway, AST-scanned for bypasses), `auth.py`, `queue.py`, `payment.py`.

Proposed split:

| Package | Contents | Analogous OTel role |
|---|---|---|
| `scruple-api` | Interfaces/dataclasses for `capture`, `witness_flow`, `manifest`, `capabilities`, `errors`; a `NoOpWitnessClient` default | `opentelemetry-api` |
| `scruple-sdk` | `http.py` (network gateway), `client.py`, `auth.py`, `queue.py`, `payment.py`, `state.py`, `preferences.py`; depends on `scruple-api` | `opentelemetry-sdk` |

`scruple-api` should have **zero network capability** — no `http.py`, no key material, nothing that can reach our servers — mirroring `opentelemetry-api`'s zero-SDK-dependency property. That is a stronger, security-relevant version of OTel's version-conflict argument: OTel keeps the API free of *implementation* dependencies to avoid version lock; Scruple should keep `scruple-api` free of *network* capability so that a vendor can wire `scruple-api` calls into every code path in their stack — including paths that run before the tenant key is provisioned, or in code review by people who don't yet trust us — without anyone needing to audit those call sites for exfiltration risk. The AST bypass-scan test that currently guards `http.py` as the sole gateway becomes trivially true for the entire `scruple-api` package: it contains no networking code to scan.

The no-op default matters for exactly the same adoption reason as OTel: a vendor's engineer wiring `scruple-api` calls into their Save handler during development, before a Scruple contract or tenant key exists, should get inert calls, not `None`-checks or crashes. That is what makes it safe to recommend "instrument now, wire up the real SDK later" as normal integration advice — currently, without this split, every call site in a vendor's code either has live network/key dependencies wired in from day one, or the vendor writes defensive stub logic themselves. **What breaks if we don't split:** vendors either (a) delay wiring in Scruple calls until the contract/key exists, which means the highest-leverage integration work (finding every call site) happens under time pressure at the end instead of incrementally, or (b) vendor engineers write their own ad hoc "is Scruple configured?" guards around every call site, which is exactly the kind of vendor-side inconsistency P1–P8 exist to prevent.

A late-binding proxy (`ProxyTracer` equivalent) is less obviously needed for Scruple than for OTel, because Scruple's SDK is provisioned once at process/service startup with a tenant key (there's no "auto-instrumentation agent injects the SDK into an already-running process" use case analogous to OTel's `opentelemetry-instrument`). A simple `set_witness_provider()`-once pattern, without the lazy proxy object, is probably sufficient — worth flagging as a place where blindly copying OTel's mechanism would be over-engineering for our actual deployment topology.

### 5.2 The conformance matrix — exact shape

OTel's matrix works because "feature implemented: yes/no/unknown" is a low-stakes self-report — worst case a dashboard has a gap. Scruple's stakes are different (P1 is a runtime-boundary claim we then rely on for signing), so the matrix should carry more than status.

**Rows:** one per numbered sub-requirement, not one per P-number. P1–P8 today are eight paragraphs; each should be decomposed the way OTel decomposes `trace/api.md#tracerprovider-operations` into "Create TracerProvider" / "Get a Tracer" / etc. — e.g. P1 becomes:

```
P1.1 — capture code runs in an acceptable boundary (enumerate: server-side / attested-client / TEE)
P1.2 — capture code is NOT in an unacceptable boundary (browser JS, disableable plugin, user-root server)
P1.3 — hash-computation code is included in the measured/attested boundary
P2.1 — baseline covers event-trigger → hash-computation → witness-submission, end to end
P2.2 — every executable/script/config participating in hashing or dispatch is in the tamper-surface
P3.1 — tenant API key is held by the platform, not distributed to end users
...
```

Anchor each row to the requirement's exact heading in `SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` (`#p1-runtime-boundary-integrity` etc.), same as OTel anchors matrix rows to `specification/trace/api.md#...`.

**Columns:** one per vendor integration (HF Spaces, RunPod, a ComfyUI host, a Kohya host — the endpoint-level unit, mirroring OTel's one-column-per-language), plus a legend of `+` (attested — see below), `-` (not met), `N/A`, blank (unknown/unreviewed). Unlike OTel, add a second row-pair per requirement: **self-declared status** (vendor-filled, like OTel) and **evidence reference** (a baseline-attestation ID or receipt ID from `/v2/baseline` / `/v2/receipt/{leaf_id}` that backs the claim) — this second column has no OTel analogue and is the whole point of §5.3.

**Who fills it in:** the vendor's integration engineer fills the self-declared column, same social process as OTel's per-language SIG (PR against a `vendors/<vendor>.yaml` file, reviewed by Scruple). The evidence column is filled by *us*, mechanically, from `/v2/baseline` output — never hand-entered — because that's the column a signature depends on.

### 5.3 Where the OTel pattern breaks, and what to add

OTel's compliance matrix is a **self-report with no enforcement mechanism whatsoever** — confirmed above: `compliance_matrix.py` only re-renders YAML into Markdown; nothing runs a client's test suite or inspects its behavior. That's fine for OTel because the worst-case failure mode of a false `+` is a missing span attribute in someone's dashboard. It is explicitly *social*: PR review, two-company approval, done.

Scruple cannot adopt this as-is because Scruple's claim isn't "we implement this feature," it's "this artifact's provenance is real, and we're staking a cryptographic signature on it." A self-declared `+` on P1 (runtime boundary integrity) with no verification is a vendor lying for free, and Scruple's whole value proposition (`feedback_scruple_is_binary_via_baseline_attestation`) is that our compliance is binary and backed by signed evidence, not a spectrum of self-reported feature flags.

What must be added, concretely:
1. **A verification tier the matrix cell points to, not just a status glyph.** Each `+` must resolve to a baseline attestation object (from `/v2/baseline` — already in the REST surface) that Scruple's own systems generated by measuring the vendor's boundary, not text the vendor typed into a YAML file. OTel has nothing like this because OTel never measures a client implementation's *code* — it only checks whether an API call exists.
2. **A revocation/staleness path.** OTel's matrix is a point-in-time snapshot with no expiry; a vendor could update their code and the `+` would silently go stale forever with no mechanism to catch it. Because Scruple signs receipts based on trust in a vendor's boundary, a matrix cell must have a validity window tied to the baseline attestation's own freshness (`/v2/baseline/rebaseline` should be the thing that refreshes a matrix cell, on a cadence, not a manual PR).
3. **No "N/A meets required" ambiguity.** OTel's `N/A` (not applicable to that language) is benign. Scruple's matrix cannot have an unreviewed-but-shipping vendor sitting in a blank/unknown cell the way OTel's matrix routinely does (many cells across `spec-compliance-matrix.md` are blank) — a blank P1 cell for a vendor whose witness leaves we're signing is a live liability, not a documentation gap. Scruple's matrix needs a "no attestation on file yet → witness endpoint must refuse" enforcement point, which has no OTel counterpart because OTel's API never refuses to compile against an unimplemented SDK feature.

In short: OTel's matrix is a **reporting artifact**; Scruple's matrix must be a **gating artifact** wired to `/v2/witness`'s actual accept/reject behavior, with the semconv-side lesson (§2.2 — Weaver's Rego policies *do* mechanically enforce shape/validity in CI) being the closer precedent than the trace-matrix side: Scruple should build the Rego-policy-style automated check, not the trace-matrix-style social one, and use the "matrix" purely as the human-readable index into evidence that's independently verified elsewhere.

### 5.4 Semantic conventions vs the witness leaf's 8 canonical fields

Semantic conventions are close to the right model for the leaf schema, with one caveat: OTel's semconv governs *attribute names/types/requirement-levels for open-ended, extensible telemetry* (anyone can add a namespace); Scruple's leaf is a small, closed, security-relevant record. Adopt the mechanics, not the extensibility posture.

Sketch, using the actual precedent files:
- **A registry file per leaf**, structured like `otel-semconv/model/http/registry.yaml`, one entry per canonical field:
```yaml
groups:
  - id: registry.witness-leaf
    type: attribute_group
    brief: "Canonical fields of a Scruple witness leaf."
    attributes:
      - id: leaf_signature
        type: string
        stability: stable
        requirement_level: required
        brief: "..."
      - id: leaf_signer_key_id
        type: string
        stability: stable
        requirement_level: required
      - id: prev_record_hash
        type: string
        stability: development   # matches otel's "should not be marked stable" pattern for a field known to be dropped in practice
        requirement_level: recommended
```
  The 3 currently-dropped fields get `stability: development` (or a Scruple-equivalent `stability: defined_not_wired`) rather than silently existing only in code comments — this makes "defined but not yet carried through `ingest.ts`" a queryable registry fact instead of tribal knowledge discovered by reading `01-leaf-signature.md`.
- **A `requirement_level`** per field (`required` / `conditionally_required: <condition>` / `opt_in`), same enum OTel uses — this replaces prose like "Five fields are returned that `ingest.ts` never reads" with a machine-checkable assertion: any writer/reader pair (`witness/route.ts`, `ingest.ts`, `verify`) can be linted against the registry to catch exactly the "wire says `signer_surrogate`, column says `leaf_signer_surrogate`" naming trap documented in `01-leaf-signature.md` before it ships, the same way Weaver's `brief.rego` catches missing briefs before merge.
- **A deprecated/renamed pointer**, structured like `otel-semconv`'s `deprecated: {reason: renamed, renamed_to: ...}`, for any future leaf-field rename — this is exactly the field-name-trap class of bug already documented in `01-leaf-signature.md` (wire `signer_surrogate` vs column `leaf_signer_surrogate`), and it's the kind of drift a structured rename-pointer prevents by making old→new an explicit, generated fact rather than something a human has to remember when reading two different files.
- **Skip OTel's Telemetry Schema transform layer** (`specification/schemas/README.md` — old-attribute-name → new-attribute-name rewriting for *already-emitted, already-stored* telemetry so old dashboards keep working against new data). Scruple's leaves are signed once at creation and never rewritten after the fact — mutating a signed leaf's field names post-hoc would break the signature's meaning. Where OTel transforms old data to look new, Scruple should instead version the leaf schema itself (`leaf_schema_version` on the leaf, the way OTLP resources carry a schema URL) and let readers dispatch on that version, rather than trying to make old leaves numerically indistinguishable from new ones.

---

## What was surprising

1. **The no-op API isn't a marketing claim — it's ~15 lines of code** (`NoOpTracerProvider` → `NoOpTracer` → `NonRecordingSpan`), and the harder, more interesting piece is `ProxyTracer`: objects created *before* SDK registration silently upgrade in place afterward via a single `Once()`-guarded global. That's a reusable mechanism, not just a design principle, and it's the piece worth actually porting if Scruple ever needs late SDK injection.
2. **OTel's compliance matrix has genuinely zero automated enforcement** — I expected at least a lint that cross-checks matrix claims against a test suite; there isn't one, anywhere in `.github/scripts/`. It is pure PR-review social process, confirmed by reading the generator script itself (it only transforms YAML to Markdown).
3. **Semantic conventions *do* have real CI enforcement — via OPA/Rego policies (`policies/brief.rego`)** — but only for the *shape* of the convention definitions, never for whether any given instrumentation actually emits conforming telemetry. This is a genuinely useful distinction to borrow: enforce the registry's own well-formedness mechanically (cheap, Scruple should do this for the leaf-field registry), and treat "does the vendor's runtime actually conform" as the separate, harder problem that needs the baseline-attestation machinery — don't conflate the two the way a naive reading of "OTel enforces semconv" might suggest.
