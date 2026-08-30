# OSS Study: TestifySec/in-toto `witness` and `archivista`

**Bottom line.** `witness`'s reusable unit is the `Attestor` interface — five methods,
registered by `init()` side-effect into a global registry keyed by name/predicate-type/RunType,
executed in five ordered phases (prematerial → material → execute → product → postproduct) with
extra mixin interfaces (`Subjecter`, `Materialer`, `Producer`, `BackReffer`) an attestor
opts into to expose cross-attestor data. This maps cleanly onto a Scruple capture-plugin
contract and is worth copying almost verbatim. It does **not** solve P1/P3: `witness run`
executes the measured command and holds (or reaches) the signing key in the *same process*,
so its actual answer to "who watches the watcher" is "trust the CI runner, and use OIDC-bound
keyless signing (Fulcio) so a compromised key can't be reused off-box" — an assumed-trusted-host
model, not a solved one. Repos: `in-toto/witness` (CLI, Apache-2.0), `in-toto/go-witness`
(the actual attestor/signer/policy engine, Apache-2.0), `testifysec/archivista` (storage/graph
API, Apache-2.0). All three carry Apache 2.0 §3's explicit patent grant.

---

## 0. Repo map (important correction)

The `witness` CLI repo (`in-toto/witness`) has **no `attestation/` directory** — `witness`
is a thin cobra-CLI wrapper. The actual attestor interfaces, the built-in attestors, the
signer backends, and the policy engine all live in a separate Go module,
`github.com/in-toto/go-witness` (`witness`'s `go.mod` pins `go-witness v0.12.0`). I cloned
both (plus `archivista`). All clones succeeded — nothing to report as unavailable.

- `/data/oss-study/witness` — CLI (`cmd/`, `options/`), docs, policy examples
- `/data/oss-study/go-witness` — `attestation/` (interfaces + 25 built-in attestors),
  `signer/` (key backends), `policy/`, `dsse/`, `intoto/`, `registry/`
- `/data/oss-study/archivista` — storage/GraphQL server

---

## 1. The Attestor interface

**File:** `go-witness/attestation/factory.go:31-37`

```go
type Attestor interface {
	Name() string
	Type() string
	RunType() RunType
	Attest(ctx *AttestationContext) error
	Schema() *jsonschema.Schema
}
```

Five methods. `Name()` is the CLI/config-facing short name (`"git"`, `"environment"`).
`Type()` is the versioned in-toto predicate URI (`"https://witness.dev/attestations/environment/v0.1"`).
`RunType()` declares which of the five execution phases the attestor belongs to (see §1.2).
`Attest(ctx)` does the actual capture work, writing into the receiver's own struct fields
(the struct *is* the evidence — it gets JSON-marshaled straight into the in-toto predicate).
`Schema()` returns a JSON Schema (via `jsonschema.Reflect(&a)`) generated from the same struct,
used for both documentation generation (`docgen/`) and, per attestor, embedding a
`$schema`-style contract into the predicate.

### 1.1 Registration — real code, not a description

**File:** `go-witness/attestation/factory.go:25-29, 111-123`

```go
var (
	attestorRegistry   = registry.New[Attestor]()
	attestationsByType = map[string]registry.Entry[Attestor]{}
	attestationsByRun  = map[RunType]registry.Entry[Attestor]{}
)

func RegisterAttestation(name, predicateType string, run RunType, factoryFunc registry.FactoryFunc[Attestor], opts ...registry.Configurer) {
	registrationEntry := attestorRegistry.Register(name, factoryFunc, opts...)
	attestationsByType[predicateType] = registrationEntry
	attestationsByRun[run] = registrationEntry
}
```

Every attestor package registers itself via a Go `init()` side effect. Example, the
environment attestor, **`go-witness/attestation/environment/environment.go:50-52`**:

```go
func init() {
	attestation.RegisterAttestation(Name, Type, RunType, func() attestation.Attestor { return New() })
}
```

This is import-time, plugin-by-linking: the CLI (`witness`) imports every attestor
package it wants available (see `witness/cmd/run.go` imports), which triggers each
`init()`, which populates three global maps: registry-by-name, by-predicate-type, and
by-RunType. `attestation.GetAttestor("git")` or `attestation.GetAttestor(predicateURI)`
both resolve through `FactoryByName` / `FactoryByType` (`factory.go:125-146`). There is
**no dynamic/runtime plugin loading** (no `.so`, no subprocess protocol like HashiCorp's
`go-plugin`) — every attestor is compiled into the same binary. This is a meaningful
limitation to flag for our mapping: witness's "pluggability" is source-level (write a
Go package, register it, recompile), not binary-level (drop in a plugin at deploy time).
A vendor wanting a new attestor forks or vendors the Go module.

### 1.2 RunType / phase model

**File:** `go-witness/attestation/context.go:32-49`

```go
type RunType string

const (
	PreMaterialRunType RunType = "prematerial"
	MaterialRunType    RunType = "material"
	ExecuteRunType     RunType = "execute"
	ProductRunType     RunType = "product"
	PostProductRunType RunType = "postproduct"
	VerifyRunType      RunType = "verify"
)

func runTypeOrder() []RunType {
	return []RunType{PreMaterialRunType, MaterialRunType, ExecuteRunType, ProductRunType, PostProductRunType}
}
```

Phases, and what each is *for* (from usage across the codebase, not doc prose):

| Phase | Purpose | Example attestors |
|---|---|---|
| `prematerial` | Capture ambient/environment context BEFORE anything is hashed — who/where/what CI system, what commit | `environment`, `git`, `github`, `gitlab`, `jenkins`, `aws-codebuild`, `gcp-iit`, `jwt`, `lockfiles`, `omnitrail`, `maven` |
| `material` | Hash the working directory / declared inputs **before** the watched command runs — this is the "before" baseline | `material` (built-in, always run — see `witness/cmd/run.go:36`: `alwaysRunAttestors = []attestation.Attestor{product.New(), material.New()}`) |
| `execute` | Run and observe the actual watched process | `commandrun` (spawns/traces the process), `network-trace` (taps into commandrun's execute hooks) |
| `product` | Hash the working directory **after** — diff against `material` to find new/changed files = outputs | `product` (built-in, always run) |
| `postproduct` | Inspect/scan the products that were just identified | `docker`, `oci`, `sbom`, `slsa`, `sarif`, `vex`, `k8smanifest`, `link` |
| `verify` (separate track) | Not a capture phase — runs `policyverify` attestor, mutually exclusive with all others (`context.go:196-198`) | `policyverify` |

Ordering and concurrency, **`go-witness/attestation/context.go:181-238`**: `RunAttestors()`
buckets all attestors by `RunType()`, then walks `runTypeOrder()` phase by phase; **within**
a phase, attestors run concurrently via goroutines + `sync.WaitGroup` (`context.go:225-234`).
Cross-phase is strictly sequential; within-phase is parallel. If any attestor's `RunType()`
is empty, `RunAttestors` errors before anything runs (`context.go:184-190`).

### 1.3 Cross-attestor data — the mixin interfaces

**File:** `go-witness/attestation/factory.go:39-97`. None of these are required by
`Attestor` — an attestor implements the ones relevant to it, and the engine type-asserts
for them at collection time (`context.go:264-273`):

- **`Subjecter`** — `Subjects() map[string]cryptoutil.DigestSet`. Exposes named,
  hashed facts that get promoted into the in-toto Statement's `subject` array —
  the index keys Archivista and Rekor search on. Git's implementation
  (`attestation/git/git.go:299-346`) emits `commithash:<sha>`, `authoremail:<hash>`,
  `committeremail:<hash>`, `parenthash:<sha>` (one per parent), `refnameshort:<hash>` —
  five kinds of subject from one attestor.
- **`Materialer`** — `Materials() map[string]cryptoutil.DigestSet` — files observed as
  inputs (the `material` attestor's whole job, `attestation/material/material.go:116`).
- **`Producer`** — `Products() map[string]Product` — files identified as outputs
  (the `product` attestor's job, `attestation/product/product.go:234`).
- **`BackReffer`** — `BackRefs() map[string]cryptoutil.DigestSet` — a *subset* of an
  attestor's subjects flagged as good traversal anchors for finding *other* collections.
  Git flags only `commithash` as a backref (`git.go:351-360`), not the other four
  subjects — an explicit editorial choice about which facts are worth graph-indexing.
- **`Exporter`** / **`MultiExporter`** — lets an attestor split itself out of the single
  collection into its own separately-signed attestation (or several — one per file/finding).
- **`ExecuteHookDeclarer`** — see §1.4, the one true "attestors depend on each other"
  mechanism, and it's narrowly scoped to the `execute` phase.

There is **no general dependency graph** between attestors (no "attestor B requires
attestor A's output" declaration) — the only inter-attestor coupling is (a) implicit,
via the shared `AttestationContext` accumulating `Materials()`/`Products()` maps that
later phases can read (`context.go:311-343`), and (b) explicit, via execute hooks.

### 1.4 Execute hooks — the one real coupling mechanism, and it matters for P1

**File:** `go-witness/attestation/execute_hooks.go` (full file read). This is new
(2026 copyright) and is how attestors tap into a *running, traced process* rather than
just diffing before/after state. Two stages only:

```go
const (
	// StagePreExec is called after fork but before exec continues.
	// The process is frozen ... using PTRACE after receiving SIGTRAP.
	StagePreExec ExecuteHookStage = iota
	// StagePreExit is called when the process is about to exit but hasn't completed yet.
	// Relies on PTRACE_EVENT_EXIT.
	StagePreExit
)
```

Flow: a phase-`execute` attestor implementing `ExecuteHookDeclarer.DeclareHooks(hooks)`
declares intent (`Declare(attestor, stage)`) *before* any goroutines start
(`context.go:206-214` — "Phase 1" explicitly precedes "Phase 2" concurrent run).
`commandrun` then forks+ptraces the child and calls `RunHooks(StagePreExec, pid)` /
`RunHooks(StagePreExit, pid)` at the right moments; other attestors (only `network-trace`
uses this today) register a callback that runs with the PID, e.g. to attach an eBPF map
tracking that specific PID's syscalls. This is explicitly commandrun-centric — "command-run
is the only attestor that executes processes; other attestors observe or modify those
processes" (comment, `execute_hooks.go:62-64`).

**Why this matters for P1**: witness's PTRACE-based execute hook is the closest thing in
this codebase to "instrument the watched process from *outside* its own address space
rather than trusting it to self-report." It's a real, if narrow, answer to "don't let the
watched code lie about itself." But it only covers processes `witness run` itself forked —
it says nothing about the surrounding host, the `witness` binary, or the key material (see §6).

---

## 2. Shipped attestors — evidence source and environment-vs-artifact split

25 attestor packages under `go-witness/attestation/`. Classified by what they capture
and where from (RunType from the const blocks read directly, `grep` output above):

**Environment/identity evidence** (who/where/what-system — not artifact bytes):
| Attestor | RunType | What it captures |
|---|---|---|
| `environment` | prematerial | OS, hostname, `user.Current()` username, filtered `os.Environ()` |
| `git` | prematerial | commit hash, author/committer, refs, working-tree status |
| `github` / `gitlab` / `jenkins` / `aws-codebuild` | prematerial | CI-provided env vars (job name, pipeline, run ID) — trusts the CI platform's own env |
| `gcp-iit` / `aws-iid` | prematerial | cloud instance-identity documents (GCP metadata server, AWS IID + signing cert chain) — cryptographically-backed-by-cloud-provider identity |
| `jwt` | prematerial | an externally-supplied JWT (e.g., OIDC token) as identity evidence |

**Artifact/process evidence** (bytes, hashes, execution):
| Attestor | RunType | What it captures |
|---|---|---|
| `material` | material | pre-execution hash of the working directory (the "before" baseline) |
| `commandrun` | execute | spawns/traces the actual command; captures stdout/stderr, exit code; optional ptrace-based syscall trace |
| `network-trace` | execute | eBPF-based network syscalls of the traced PID (via execute hooks) |
| `product` | product | post-execution hash of new/changed files (the "after" diff) |
| `docker` / `oci` | postproduct | image manifests/layers built |
| `sbom` | postproduct | SPDX document for products |
| `slsa` | postproduct | assembles a SLSA v1.0 provenance predicate from the other attestations in the collection |
| `sarif` / `secretscan` / `vex` | postproduct | static-analysis / secret-scan / vulnerability-exception findings on products |
| `k8smanifest` / `link` | postproduct | k8s manifest capture / in-toto legacy Link predicate |
| `lockfiles` / `omnitrail` / `maven` / `system-packages` | prematerial | dependency/package inventories |

The prematerial "environment" bucket is exactly our P4 (principal identity) surface, and
it's a real split in their own architecture, not something I'm imposing — `environment`,
`git`, `github`/`gitlab`/`jenkins`, `gcp-iit`/`aws-iid`, `jwt` are *all* prematerial-only,
never touch file bytes, and are explicitly separated by RunType from every artifact
attestor. That structural separation (environment attestors are a distinct RunType
bucket) is worth taking directly.

---

## 3. Signing

**Key backends found**, `go-witness/signer/`: `file` (raw key on disk, optional passphrase
or passphrase-file), `kms/{aws,azure,gcp,hashivault}`, `fulcio` (Sigstore keyless — OIDC
token exchanged for a short-lived cert, no persistent key at all), `vault` (HashiCorp Vault
transit signing), `spiffe` (SPIFFE/SPIRE workload identity as signer). **No TPM backend**
found anywhere in `go-witness` (`find . -iname "*tpm*"` — nothing).

**How signing is invoked**, `witness/cmd/run.go:63-79`: a single `runRun()` call loads
signers (`loadSigners`, from CLI flags — file path, KMS URI, or OIDC flow for fulcio),
builds the attestor list, runs `AttestationContext.RunAttestors()`, then signs the
resulting DSSE envelope with whichever signer was configured — **all in the same process,
same host, same invocation** that also ran the watched command. There is no separate
signing service or air gap in the reference implementation; `fulcio`'s keyless flow is
the *only* backend where the "key" (an ephemeral cert issued after OIDC auth) is not
something the process could exfiltrate ahead of time, because it doesn't exist until
the process requests it, bound to the OIDC identity token supplied at request time.

**Key custody vs. the watched code**: nothing in the run path segregates "the code that
captures evidence" from "the code that holds/uses the signing key" into different trust
domains — they're the same binary, same process, same privileges. See §6.

---

## 4. Policy

**File:** `witness/docs/concepts/policy.md` (read in full) + real example embedded in
that doc. A witness policy is itself a DSSE-signed JSON document
(payload type `https://witness.testifysec.com/policy/v0.1`) containing: `expires`,
trusted `roots` (X.509) and `publickeys`, a map of `steps` (pipeline stage name →
required attestations + trusted `functionaries` + optional `artifactsFrom` other steps),
and per-attestation `regopolicies` — base64-encoded OPA Rego modules evaluated against
that attestation's content, expected to set a `deny[msg]` rule.

Real policy fragment (from the doc, `policy.md` lines ~155-200), showing a `build` step
that requires the `material`/`command-run`/`product` predicate types, trusts a specific
publickey functionary, declares `artifactsFrom: ["clone"]`, and embeds a Rego check on
the exact command that was run:

```json
"build": {
  "name": "build",
  "artifactsFrom": ["clone"],
  "attestations": [
    { "type": "https://witness.dev/attestations/material/v0.1", "regopolicies": [] },
    {
      "type": "https://witness.dev/attestations/command-run/v0.1",
      "regopolicies": [{
        "name": "expected command",
        "module": "cGFja2FnZSBjb21tYW5kcnVuLmNtZAoKZGVueVttc2ddIHsKCWlucHV0LmNtZCAhPSBbImdvIiwgImJ1aWxkIiwgIi1vPXRlc3RhcHAiLCAiLiJdCgltc2cgOj0gInVuZXhwZWN0ZWQgY21kIgp9Cg=="
      }]
    }
  ]
}
```
(that base64 decodes to a Rego module: `package commandrun.cmd` / `deny[msg] { input.cmd != ["go","build","-o=testapp","."]; msg := "unexpected cmd" }`)

Verification (`policy.md` §"Verification Process", 5 numbered steps) is: (1) check DSSE
signatures on each attestation collection against the policy's trusted keys/roots,
discard failures; (2) map each collection's signer to the step's declared
`functionaries`; (3) optionally check RFC-3161 timestamps against trusted TSAs;
(4) check that `material`/`product` hashes are internally consistent across steps per
`artifactsFrom` — i.e., that step B's declared inputs actually match step A's declared
outputs, a supply-chain-graph consistency check; (5) run every embedded Rego `deny` rule.
This is a direct evolution of the classic in-toto **layout** (functionaries + step
ordering + material/product matching), with Rego bolted on for content-level policy that
layouts alone can't express.

---

## 5. Archivista

**Confirmed from `archivista/README.md`** (read directly, not paraphrased-from-memory):
storage is two-tier — the **entire signed attestation** (DSSE envelope) goes into a
configured object store (local dir or S3-compatible blob store), while metadata is
"scraped" from the attestation and written into a SQL store (MySQL or Postgres via the
`ent` ORM — `ent.graphql`, `ent.resolvers.go` present) exposed over **GraphQL**
(`archivista.graphql`, `gqlgen.yml`). Retrieval is Gitoid-based at minimum (works even
with `ARCHIVISTA_ENABLE_SQL_STORE=false`, README line 91) or graph-query based when SQL
is enabled. The graph edges are exactly the `Subjecter`/`BackReffer` output from §1.3:
"Archivista uses Subjects on the in-toto Statement as edges on this graph... Producers
of attestations (such as Witness) can use these subjects as a way to expose relationships
between attestations" (README, "How Archivista Works"). Their own worked example: a
compiled-artifact subject plus a git-commit-hash subject on the same statement lets you
traverse from a commit to "other relevant attestations such as those describing code
reviews, testing, and scanning that happened on that git commit." Also supports
"download and export attestations to transfer across an air gap" (README feature list) —
directly relevant if TME/air-gap ever needs an evidence-store analog.

---

## 6. Mapping to Scruple

### 6.1 Capture plugin interface — proposed signatures

Witness's `Attestor` interface translates almost 1:1. Keep the five witness methods,
add the mixins as optional protocol members (Python: `Protocol` checked via
`isinstance`/`hasattr`; TS: optional interface members checked with `in`/duck-typing —
mirroring witness's own type-assertion-based mixin pattern, not a rigid inheritance tree).

**Python** (the SDK language; this is the canonical definition, TS should be generated
or hand-kept in sync with it):

```python
from typing import Protocol, runtime_checkable
from enum import Enum

class CapturePhase(str, Enum):
    PRE_BASELINE = "pre_baseline"   # ~ witness prematerial: identity/environment, before any hashing
    BASELINE     = "baseline"       # ~ witness material: hash/state of the workspace before the watched action
    WITNESS      = "witness"        # ~ witness execute: observe the watched action itself
    MARK         = "mark"           # ~ witness product: hash/state after, diff against baseline
    RECEIPT      = "receipt"        # ~ witness postproduct: inspect/summarize what MARK identified

class CapturePlugin(Protocol):
    def name(self) -> str: ...
    def evidence_type(self) -> str:            # versioned predicate URI, e.g. "scruple.dev/evidence/comfyui-workflow/v1"
        ...
    def phase(self) -> CapturePhase: ...
    def capture(self, ctx: "CaptureContext") -> None: ...   # writes onto self; ctx exposes host/env/prior-phase data
    def schema(self) -> dict: ...               # JSON Schema of this plugin's own evidence shape

@runtime_checkable
class Subjecter(Protocol):
    def subjects(self) -> dict[str, "DigestSet"]: ...

@runtime_checkable
class BackReffer(Protocol):
    def back_refs(self) -> dict[str, "DigestSet"]: ...

# Registration mirrors witness's init()-time side effect, but explicit rather than
# import-magic, since Python import order across vendor plugin packages is less
# reliable than Go's compile-time linking:
def register_capture_plugin(name: str, evidence_type: str, phase: CapturePhase,
                             factory: Callable[[], CapturePlugin]) -> None: ...
```

**TypeScript** (plugin authors targeting web/Electron hosts — Blender/Fusion/Meshroom/
ToonBoom shells, Studio's browser side):

```ts
type CapturePhase =
  | "pre_baseline" | "baseline" | "witness" | "mark" | "receipt";

interface CapturePlugin {
  name(): string;
  evidenceType(): string;          // versioned predicate URI
  phase(): CapturePhase;
  capture(ctx: CaptureContext): Promise<void>;   // async: host apps are event-loop-bound
  schema(): JSONSchema;
}

interface Subjecter {
  subjects(): Record<string, DigestSet>;
}
interface BackReffer {
  backRefs(): Record<string, DigestSet>;
}

function registerCapturePlugin(
  name: string, evidenceType: string, phase: CapturePhase,
  factory: () => CapturePlugin
): void;
```

Deliberate departure from witness: `capture()` is `async` in TS (host apps like
ComfyUI/Blender are event-loop or callback-driven; witness's Go `Attest` is synchronous
because it runs in a CLI wrapper process it fully controls). And registration is an
explicit function call, not import-time `init()` side effect — vendor plugin loading in
a browser/Electron/Python-notebook host can't rely on Go-style link-time registration.

### 6.2 Does the phase model map onto baseline → witness events → mark → receipt?

Mostly yes, with one real mismatch:

- **baseline ≈ prematerial + material combined.** Witness splits "who/where" (prematerial)
  from "hash the workspace" (material) into two phases that both run *before* the watched
  action. Scruple's "baseline" is currently one concept; witness's split argues for
  keeping ours as one *phase* but two *plugin kinds* within it — identity/environment
  capture plugins and workspace-state capture plugins — since they genuinely capture
  different things and a vendor may have one without the other (e.g., a hosted API with
  no meaningful "workspace" to hash, only caller identity).
- **witness events ≈ execute.** Direct match — this is where witness's PTRACE execute-hook
  mechanism (§1.4) lives, and it's the one part of their architecture that actually
  tries to observe a process from outside itself rather than trust its self-report. Worth
  studying further if Scruple ever needs to watch a vendor's inference process rather than
  just diffing files before/after.
- **mark ≈ product**, **receipt ≈ postproduct.** Direct match — "mark" is witness's
  after-diff, "receipt" is witness's inspect-the-diff (SBOM/SLSA/sarif-equivalent) step.
- **Where it does not fit**: witness has no phase for *signing itself*, no phase for
  *attestation import* (P8), and no concept of a runtime boundary check (P1) or key
  custody (P3) at all — those are entirely outside the phase model, handled (or not) by
  which process the CLI happens to run in and which signer backend was configured. If
  Scruple's receipt phase is meant to also carry "was this verified or passthrough"
  (P7) and "who signed and where does the key live" (P3), those need to be first-class
  parts of the phase/plugin contract in a way witness's model doesn't provide — witness
  treats signing as a CLI-level concern bolted on *after* all phases complete
  (`witness/cmd/run.go`: attest first, sign last, same process), not something any
  attestor declares or participates in.

### 6.3 P1–P8: what witness's architecture actually addresses

| # | Requirement | Witness's answer | Verdict |
|---|---|---|---|
| P1 | Runtime boundary integrity (capture code not modifiable by the witnessed party) | PTRACE-based execute hooks (§1.4) genuinely observe the child process from outside its address space for the narrow case of `commandrun`. But the `witness` binary itself, and every non-`execute` attestor, run as ordinary code on the same host as whatever they're attesting, with no isolation, no attestation of the witness binary's own integrity, no measured-boot/enclave requirement anywhere in the codebase I found. | **Partially addressed, narrowly** — one attestor's one mechanism, not an architectural guarantee. |
| P2 | Baseline coverage of the capture path | `material`/`product` attestors *are* baseline coverage for files — that's their whole purpose, and it's mandatory (`alwaysRunAttestors`, `witness/cmd/run.go:36`). | **Addressed**, for file-based workloads. |
| P3 | API key/signing-key custody (unreachable by the witnessed party) | Not addressed for `file`/`kms`/`vault`/`spiffe` backends — the same process that ran the watched command holds or can reach the key. Only `fulcio` (keyless) sidesteps this, because there's no persistent key to steal, only an ephemeral cert bound to a one-time OIDC exchange. | **Assumed away** except in the keyless path, and even keyless still runs the OIDC exchange from the same process that ran the command. |
| P4 | Principal identity | Strong, real answer: `environment`/`git`/`github`/`gitlab`/`jenkins`/`gcp-iit`/`aws-iid`/`jwt` attestors, plus X.509-cert-constraint functionaries and SPIFFE-URI matching in policy (`policy.md` "certConstraint"). | **Addressed well.** |
| P5 | Immutable event chain | DSSE-signed collections + policy's `artifactsFrom` material/product consistency check across steps (§4) gives a verifiable chain of custody between pipeline steps, not a tamper-evident *log* (no append-only ledger/Merkle log in `go-witness` itself — that's Rekor's job, external, only wired via optional timestamp/transparency features). | **Partially addressed**, and depends on an external transparency log for the "can't be silently rewritten" property. |
| P6 | Zero-content posture | No general mechanism — attestors capture whatever their author wrote them to capture (`environment`'s var filtering, `secretscan`'s detectors, are the only content-minimization examples found); it's per-attestor discipline, not a platform guarantee. | **Assumed away / left to attestor author.** |
| P7 | Attestation declaration (verified vs. passthrough) | `functionary` types (`root` vs `publickey`) and cert constraints let a *policy* distinguish trust levels of different signers, but there's no attestor-level or predicate-level flag meaning "this evidence was independently verified" vs. "this evidence is a vendor's self-report passed through." | **Not addressed** — policy can express trust *of a signer*, not trust *of a capture method*. |
| P8 | Attestation import discipline | Archivista's export/import-across-airgap feature (README) and `witness`'s ability to consume externally-produced DSSE envelopes exist, but I found no explicit provenance-tagging of "this was imported, not natively captured here." | **Not addressed explicitly.** |

### 6.4 The crux question: does witness solve "the party being measured runs the measuring code"?

**No — it depends on the CI system (or whatever host runs `witness run`) being trusted.**
Traced directly through the real code, not inferred: `witness/cmd/run.go:runRun()` is one
function that (a) builds the attestor list including `commandrun` wrapping the user's
actual command, (b) calls `AttestationContext.RunAttestors()` which executes every phase
including spawning the watched process, and (c) signs the resulting collection with
whichever signer was configured — all synchronously, in the same OS process, on the same
host, with the same privileges as the command it's attesting. The PTRACE execute-hook
mechanism (§1.4) is real and does place the *tracer* outside the *traced child's* address
space, so a `commandrun`-wrapped process can't literally rewrite its own trace mid-flight —
but the tracer (witness itself) is not itself isolated from the host, has no attestation
of its own integrity, and — critically — a party with control over the host (which is
exactly the party being measured, in a self-hosted-runner or vendor-controlled-inference-host
scenario like ours) can simply not invoke `witness run` correctly, patch the `witness`
binary, or substitute environment/git values before the process starts. Their actual
mitigation, to the extent one exists, is organizational/infrastructural: run `witness` in
CI systems the measured party doesn't fully control (GitHub-hosted runners, not self-hosted),
and prefer `fulcio` keyless signing bound to the CI platform's OIDC identity so that even if
someone captures fraudulent evidence, they can't sign it as a trusted CI identity without
that platform's OIDC token — which pushes the actual trust boundary to the CI platform, not
to anything in the witness codebase. This is precisely our P1/P3 problem, unsolved by
witness: `L2_FLOOR.md`'s own critique of Scruple's *current* witness leaf — HMAC key in a
systemd env var, "the same Linux host as the web application," "Scruple can mint any
leaf" — is the identical failure mode witness's reference implementation has, just with a
different vendor as the trusted/untrusted party. Neither system isolates capture-plus-signing
compute (SEV-SNP CVM, attested, key-never-leaves-TEE — the standard the *C2PA* path already
meets per that same table) from the party whose behavior is being measured; witness gives us
a good *plugin contract* for the evidence, not an architecture for where that contract has to
execute.
