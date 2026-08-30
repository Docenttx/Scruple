# WO series — making the canon the floor everywhere

_2026-08-30. Sequenced overnight work orders. Goal: the L2 floor, the capture
component and the ratchet become the substrate every integration sits on —
vendor-hosted inference now, desktop plugins later — with a skeleton that
accommodates a host we have not met yet._

---

## The generalization, first — because it decides every WO below

`CANON_SKELETON.md` §4 already has a host hook contract: nine hooks, each
observed in at least two shells. It says **when** to capture. It does not say
**how the bytes are observed**, or **where the observing code runs** — and
those are the two axes that decide whether P1 holds.

Three axes, not one:

| Axis | Question | Values |
|---|---|---|
| **Hook** *(exists)* | When does capture fire? | `document.save`, `artifact.produced`, `graph.execute`, `model.write`, … |
| **Surface** *(new)* | How are the bytes observed? | `network-gate`, `filesystem-watch`, `in-process-callback`, `host-api-callback` |
| **Placement** *(new)* | Where does the capture code run? | `server-library`, `sidecar-gate`, `attested-client`, `unattested-client` |

**Assurance is a function of placement and attestation, and nothing else.**
That is what makes the skeleton general: a new host is onboarded by naming its
hooks, its surfaces and its placement — never by writing new evidence logic.

### The placements, and what P1 costs in each

| Placement | Example | Why P1 holds (or doesn't) | Difficulty |
|---|---|---|---|
| **`server-library`** | HF Inference API, a vendor's own backend calling the SDK | Tenant has no code execution there at all. **P1 is free.** P3 is ordinary secret management | **Easiest — and the most valuable for the vendor strategy** |
| **`sidecar-gate`** | RunPod pod, hosted ComfyUI, Kohya | Tenant has root in *their* container; P1 holds only via topology, proved by probes | Medium — this is the H-4 spec |
| **`attested-client`** | Fusion add-in, code-signed UXP plugin | P1's code-signed-installer branch. Host app enforces the boundary | Later — the plugins |
| **`unattested-client`** | Browser JS, a script the user edits | **P1 cannot hold.** Declared, never claimed as witnessed | Must be representable so it can be refused |

The fourth exists so the model can *say no*. A placement that cannot pass is
better named than excluded — that is how the standard refuses a shape rather
than bending for it.

**Note the ordering this implies.** We have been building the hard case first.
`server-library` is where Hugging Face and RunPod-serverless actually live, it
gets P1 for free, and it is the shortest path to a vendor running real traffic.
Night 2 builds it first for that reason.

---

## Night 1 — the leaf, the envelope, the key

Nothing downstream is worth building on a leaf that drops fields or a secret
that is global. This night is unglamorous and it is the load-bearing one.

### WO-1 · Make the leaf whole, and give it a registry
- Restore `input_hash`, `workflow_hash`, `model_fingerprints_hash` to
  `/v2/witness`. The stub at `app/api/v2/witness/route.ts:~115`
  (`workflowHash: body.graph ? undefined : undefined`) accepts a graph and
  discards it. The legacy v2.2 canvas leaf carries all three; the new API is
  currently worse evidence than the path it replaces.
- Add a **leaf-field registry** on the OTel semantic-conventions pattern: one
  YAML naming every field, its type, its version, and `deprecated.renamed_to`.
- Generate the TS types and the Python types from it. One definition, two
  emitters.
- **Acceptance:** a test fails if a field is emitted that the registry does not
  define, or defined and not emitted. The known drift —
  `services/witness-server/server.js:661` returns `signer_surrogate` while
  `:234-236,626` write `leaf_signer_surrogate` — is either reconciled or
  recorded as a rename in the registry, and the test proves it.

### WO-2 · Statement / predicate / envelope split
- Adopt in-toto's four-layer shape: a DSSE-style envelope carrying a
  `scruple-vendor-baseline` predicate, so P1–P8 version independently of the
  signing machinery.
- Publish the predicate type and its schema. This is a **format we implement**,
  not a library we vendor — no Apache-2.0 patent-grant exposure (see
  `oss-study/SYNTHESIS.md` §5).
- **Acceptance:** an existing leaf round-trips through the envelope unchanged;
  the predicate version is independently bumpable in a test.

### WO-3 · The ratchet, both sides, with shared vectors
- Implement §4 of `H4-DUKPT-CAPTURE-COMPONENT.md` in **Python** (component) and
  **TypeScript** (server). HKDF chain, zeroize, strict-increase.
- One JSON file of **shared test vectors** consumed by both suites. This is the
  only defence against two implementations that each pass their own tests and
  disagree on the wire.
- `components` table; `POST /v2/components/provision`; one-time token; IK
  derived from the BDK; seal to attestation where available, `0600` otherwise.
- **Acceptance:** cross-language vector parity; a replayed counter is rejected;
  a component cannot derive another's IK given its own state; a gap verifies and
  is *recorded* rather than rejected.

### WO-4 · Reconciliation
- Per-component counter accounting, gap records, heartbeat window, silence
  detection.
- A reconciliation view: per component — last counter, gaps, last seen, posture.
- **Acceptance:** a simulated component that stops mid-stream is marked silent
  within its window; a suppressed event leaves a gap that does **not**
  invalidate the leaves around it.

**Night 1 also closes H-2**, because the per-event ratchet is the demotion of
the shared HMAC that H-2 asked for.

---

## Night 2 — the component, and proving the skeleton is general

### WO-5 · Surface + placement abstraction
- Add the two new axes to `CANON_SKELETON.md` §4 as a first-class contract:
  a `CaptureSurface` interface (open, observe, close) and a declared
  `placement`, with assurance derived from placement + attestation.
- Interface in TS and Python, following witness's `Attestor` shape
  (`Name/Type/RunType/Attest/Schema` — see `oss-study/witness.md`).
  **Caveat carried from that study:** their attestors are compiled in via Go
  `init()`; do not promise hot-pluggability we are not building.
- **Acceptance — this is the WO that answers "any vendor/app":** a written
  mapping of **six** hosts onto the three axes, at least three of which we have
  no code for — ComfyUI, Kohya, a `server-library` vendor (HF-shaped), Fusion,
  Blender, and one deliberately hostile case (browser JS) that the model must
  classify as `unattested-client` and refuse. **Any host that cannot be
  expressed is a defect in the abstraction, and the WO is not done until the
  gap is either closed or named in the doc.**

### WO-6 · `server-library` placement — the easiest and most valuable
- The SDK path a vendor calls from their own backend. P1 free, P3 ordinary.
- Ratchet, queue-on-failure, envelope, leaf.
- **Acceptance:** a worked reference integration against a stub vendor backend,
  producing verifiable leaves end to end through the surrogate CVM.

### WO-7 · `scruple-capture` sidecar for ComfyUI
- HTTP gate **and** WS gate (today's WS sidecar is pass-through — that is one of
  the two surfaces, and the ComfyUI evidence in the H-4 spec shows why one is
  not enough) plus the filesystem watcher on `IN_CLOSE_WRITE`.
- Correlation of output → `prompt_id` via `executing`/`execution_success`.
- Published with a `build_measurement`.
- **Acceptance:** an image retrieved over WS produces a leaf; a file written
  directly into the output volume produces a leaf; neither path can produce a
  retrievable artifact with no leaf.

### WO-8 · API/SDK split
- `scruple-api` — no network capability at all; `scruple-sdk` — wraps `http.py`.
  The seam already exists: only 4 of 13 modules import `http`, and an AST test
  already enforces it by inspection. Packaging should enforce it instead.
- Port OTel's `Once()`-guarded late-binding provider swap so call sites written
  before the SDK is registered start working after it, with no restart.
- **Acceptance:** importing `scruple-api` alone cannot open a socket, proved by
  an AST scan *and* a runtime test; instrumentation written against the API
  no-ops cleanly with no SDK installed.

---

## Night 3 — conformance, and the retrofit

### WO-9 · The probe suite
- The six probes from `H4-DUKPT-CAPTURE-COMPONENT.md` §7, runnable **from inside
  a tenant container**, emitting a signed results bundle.
- Plus a **self-grade harness**: any integration grades itself against P1–P8 and
  emits the same shape as `STUDIO_P1-P8_GRADE.md`.
- Certification is per **configuration**, EMV L3-style, re-run on material
  change — not per vendor, and not perpetual.
- **Acceptance:** run against today's Studio and reproduce the grade already
  committed, including both FAILs. **A conformance suite that cannot reproduce a
  known failure is not evidence of anything.**

### WO-10 · Retrofit canvas
- Canvas migrates onto the component. It already passes P1/P3/P4, so this is a
  re-platform, not a rewrite, and it proves the component against a path known
  to work.
- Fix the swallowed ingest failure at `lib/canvas/witness.ts:155` (§7 silent
  drop). Write the baseline that closes canvas's P2 and P7.
- **Acceptance:** canvas grades PASS on all eight, produced by WO-9's harness
  rather than by hand.

### WO-11 · Kohya honesty, then Kohya properly
- **Immediately:** stop the hook docstring claiming a leaf is signed; stop the
  route returning `ok: true` for an unwitnessed save; resolve the two divergent
  hook copies. These are hours, and they stop the estate misreporting.
- **Then:** re-place Kohya as `sidecar-gate`. The pod stops being where
  measurement happens.
- **Acceptance:** no path reports a checkpoint as witnessed unless a leaf exists.

### WO-12 · Retire the global secret
- `SCRUPLE_APPS_WITNESS_SECRET` retired, not rotated. Client-side plaintext key
  storage (`%APPDATA%`) moved onto the component's custody model. **H-4 closes.**
- **Acceptance:** no code path reads a global witness secret; a grep proves it.

---

## Later — plugins, and why they wait but are designed for now

The plugins are `attested-client`, and they carry a **different threat model**
that the abstraction must hold without bending:

- On an inference host, the tenant is the adversary and we are proving *what a
  machine did*.
- In Fusion or Blender, the user is attesting **their own work**, and the
  adversary is a third party disputing the claim later. Fusion already tracks
  project work natively; tampering means hacking Fusion.

That is why the no-AI market works there, and it is the reason
`digitalSourceType` defaulting to `TRAINED_ALGORITHMIC_MEDIA` is a **correctness
bug for the plugin claim, not a preference** — it asserts the opposite of what
the plugin exists to prove. Fix it when placement lands, since placement is what
determines the correct default.

Requirement on WO-5: the abstraction must express `attested-client` **now**,
even though nothing implements it until later. If the model only fits the hosts
we have built, we have described our code rather than designed a skeleton.

---

## Sequencing and honesty about scope

Nights are dependency groupings, not promises about a clock. If a night
overruns, the rule is **finish a WO or leave it clearly unstarted** — a half-
migrated leaf format is worse than either end state.

Two hard gates:

1. **WO-1 gates everything.** Do not build on a leaf that drops three hashes.
2. **WO-3 gates WO-6 and WO-7.** No component ships before the ratchet has
   cross-language vector parity.

## Open — needs a founder call, not a technical one

1. **Who holds the BDK?** Spec recommends Scruple-held, which stops a vendor
   forging their own tenants' leaves. Vendor-held suits sovereignty-constrained
   vendors and weakens the claim. Recommend Scruple-held default, vendor-held as
   a declared, receipt-visible variant.
2. **Does canvas's Modal deployment have attestable compute?** If not, the
   reference integration can only ever demonstrate `passthrough` — a reference
   implementation unable to demonstrate its own strongest tier. May justify
   building the reference on a `server-library` vendor with attestable hardware
   instead.
3. **Is training on a user-controlled pod supportable at all?** Open since the
   Studio grade. WO-11's second half assumes yes-via-sidecar. If the answer is
   no, WO-11 becomes a deprecation instead, and that is cheaper.
