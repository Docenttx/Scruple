I have what I need. Writing the plan.

---

# Phase 4 — The plan: Scruple Web Studio to full L2

**Status:** Plan only. Read-only investigation; nothing edited, created, or committed. `docs/canon/studio-l2/04-PLAN.md` exists but is **0 bytes** — this report is the output, not that file.
**Date:** 2026-08-29
**Signing target throughout:** the surrogate at `http://127.0.0.1:8799`. The real Signer CVM stays down. **`127.0.0.1:5799` was not contacted at any point in this phase.**
**Sources:** `docs/canon/studio-l2/{01-leaf-signature,02-watermark,03-c2pa}.md`, `docs/canon/WO-05-studio-comfyui-kohya.md`, `L2_FLOOR.md`, `CANON_SKELETON.md`, `STUDIO_L2_MERGE.md`, plus my own verification of the load-bearing claims below.

---

## 0. Three corrections the plan is built on

Before the tasks, three findings that change what the plan can be. All three contradict something in the documents that commissioned it, and I verified each myself rather than inheriting it.

### 0.1 Studio's canvas path does not capture what `STUDIO_L2_MERGE.md` credits it with

The merge doc's opening claim — *"the full ComfyUI workflow graph, **dual** model fingerprints, a container manifest carrying real git-commit SHAs"* — is true of `modal/scruple_runner.py`, and false of the path Studio actually uses. Phase 1 §5 flagged it with the cause marked UNVERIFIED; Phase 3 Headline 3 established the cause. I confirmed it directly at `lib/canvas/witness.ts:124-145`: the `ingestIteration` call passes `workflow` (via `spec.providerExtras.workflowApiJson`) and `machineManifestHash`, and **nothing else**. No `modelFingerprints`. No `containerMachineManifest`. No `containerMachineManifestHash`.

So on the canvas-proxy path today:

| Claim | Reality | Evidence |
|---|---|---|
| workflow graph | **yes** | `lib/canvas/witness.ts:97-102` → `ingest.ts:206-207` |
| dual model fingerprints | **no** — `model_fingerprints_hash` is NULL, and the canonical record sent to the witness carries `model_fingerprints_hash: ''` | `lib/canvas/witness.ts:124-145`; `services/witness-server/server.js:604` |
| container manifest with git SHAs | **no, and nowhere in the estate** — no `ingestIteration` call site passes it | `lib/compute/modal.ts:125-126` parses it; nothing forwards it |
| toolchain pinning at git-SHA granularity | **no** — the leaf carries `machines.manifest_hash`, the *declarative* descriptor, in which every `commit_sha` is `null` and three of six packs pin the mutable ref `main` | `lib/canvas/manifest.ts:24-25`; `config/default-machine-manifest.json` |

This is the single most consequential finding across all three phases, because it is upstream of both remaining gaps. A C2PA manifest can only assert what the leaf carries, and WO-05's premise — *"`container_manifest.py` **already computes exactly this**… it is mostly wiring"* (WO-05 §1, §4 T-3) — is optimistic for the canvas path specifically. The measurement exists; it is never invoked on the path Studio uses, because the canvas container never calls `run_workflow`.

**Consequence for the plan:** capture completeness (tasks 7–8) is a prerequisite for the strongest C2PA assertions, not an optional extra, and it must be sequenced before anything asserts toolchain pinning to a third party.

### 0.2 Gap 2 is three prerequisites, not one, and the third is not engineering

Phase 1's headline is correct and I verified both halves independently:

```
$ grep -c "leaf_signature" /opt/scruple-witness/server.js   → 0
$ ls -l /opt/scruple-witness/server.js  services/witness-server/server.js
   Jul 16 06:29  50312 bytes        Aug 29 06:16  57846 bytes
```

The deployed witness is six weeks stale and has no H-1 code. Storing the leaf signature in `ingest.ts` is correct, cheap, and testable today — **and produces NULL in production until `/opt/scruple-witness/` is redeployed and given a signer.** The merge doc's *"Studio's leaves become independently verifiable"* is true of the code and false of production. `services/witness-server/check-deployment.mjs` exists precisely to catch this drift and evidently has not been run against H-1.

### 0.3 The C2PA path is broken for every caller, not merely unreached from Studio

Verified:

```
$ ls services/c2pa-signer/keys/
cert.cnf  es256.pub  regen-dev-cert.sh  signer-root.pem  signer.key  signer.pem
```

`lib/c2pa/signAsset.ts:19-20` names `keys/es256.pem` as the private key. **That file does not exist**, and `signAsset()` returns `{ok:false}` at line 303 before ever spawning Python. The working pair — `signer.pem` / `signer.key`, which `keys/regen-dev-cert.sh:5-6` documents as what it produces — sits beside it unused. This is a two-line fix that today makes every C2PA task untestable, and it is invisible to CI because `services/c2pa-signer`'s pytest suite tests the partition boundary and never signs anything (`.github/workflows/tests.yml` says so in terms: *"the c2pa-rs path beyond it is not [covered], and this workflow does not pretend otherwise"*).

---

## 1. Where the three reports disagree, and which I trust

They are unusually consistent — migration numbering is coordinated (041/042/043), the ordering recommendations compose, and Phases 2 and 3 both independently reject marking at generation for the same reason. Five genuine tensions:

**(a) Is a witnessed watermark derivative blocked on a witness-server change? — Phase 2 says partly; I say no, and this matters most.**

Phase 2 §5e concludes *"the honest scope for step 4 is: extend `canonicalRecordV22` into a `v2.3` scheme carrying `master_hash` and `watermark_payload_hex`"*, and its summary table marks that row **"gated on the deployment question from Phase 1."**

I read `services/witness-server/server.js:598-614` directly. The canonical record is eight fields — `run_sequence`, `output_hash`, `input_hash`, `workflow_hash`, `model_fingerprints_hash`, `machine_manifest_hash`, `server_timestamp`, `prev_record_hash`. Nothing prevents witnessing the derivative bytes **today, unchanged**, as an ordinary `v2.2` leaf with `content_hash = derivative_hash` at the next `run_sequence`. That leaf commits the released bytes, chains via `prev_record_hash` to the master's leaf, and populates `watermark_derivative_leaf_hash` — which is the whole of Phase 2's stated objective (§7.6 assertion 3: *"This single assertion is the whole of Phase 2"*).

The preimage extension commits the *lineage* in-leaf. That is strictly better and should be the end state. It is **not** a prerequisite. Phase 2's own §5a diagnosis is about **ordering** (finalize precedes watermark, and `server.js:577` refuses leaves on a locked project), not about the preimage — and the ordering fix is entirely app-side.

I trust my reading here, and it is the reason task 11 is surrogate-completable rather than blocked. If I am wrong, the failure is loud and immediate: the derivative leaf comes back `v2.2` with a `leaf_hash` that does not commit `master_hash`, which is exactly what the gate in task 11 asserts.

**(b) Neither report resolves `run_sequence` allocation for the derivative leaf.**

`001_core.sql:63` is `UNIQUE(project_id, run_sequence)` on `iterations`. Phase 2's Change 3 witnesses a derivative at *"runSequence: `<next>`"* while **UPDATE**ing the master row — so the derivative consumes a sequence number on the witness chain with no `iterations` row behind it. Inside `lock/local` that is harmless because the project seals immediately afterwards. Through `POST /api/v2/watermark` on an unlocked project it is not: the next captured iteration takes the same `run_sequence` app-side (`ingest.ts` allocates from the `iterations` count) and the two chains diverge. Neither report notices. This is a design detail task 10 must settle, and it is the reason I make the data model its own task with its own gate.

**(c) Columns on `iterations` versus a derivative side table.**

Phase 1 adds 4 columns, Phase 2 adds 2 (and raises the side-table question itself, citing §4.4's multiple-derivatives-over-time case), Phase 3 adds 7. That is **13 new columns on a table that already carries 32**, with an overwrite bug latent in all of them: a day-1 local lock and a day-30 chain lock produce two derivatives and two signed assets for one master, and the single-column design silently keeps the last. Phase 2 is right to raise it, and neither of the other reports considered it. **Decide this once, before migration 042, not after 043.** Phase 1's four columns are genuinely master-row properties and are unaffected.

**(d) "No new HTTP servers" (Phase 2) versus "build the signer daemon" (Phase 3).**

Both are right and the asymmetry is principled: the watermark embedder holds **no key**, so isolating it buys nothing and costs a listener with its own auth and patch-recency story on the app host (Phase 2 §4a). The C2PA signer holds the key the entire L2 argument rests on, so it *must* be reachable across a network boundary or `L2_FLOOR.md` H-1 is unimplementable (Phase 3 §2b/§6.3). A reviewer skimming the two summaries will see a contradiction; there isn't one.

**(e) Minor: Phase 1 calls the Kohya no-leaf gap "a fourth gap… not in `STUDIO_L2_MERGE.md`."** True of that document, but WO-05 §3.1 found it on 2026-08-26 and made it T-4. It is not new; it is unmerged. I fold it in as task 20.

**Where Phase 3 corrects WO-05:** WO-05 §1's table asserts §3 baselining is easy for Studio because the container manifest already computes the tamper surface. Phase 3 shows that manifest never reaches a canvas leaf, and the fallback descriptor pins nothing. I trust Phase 3 — it cites the type declaration (`lib/canvas/manifest.ts:24-25`) and the config, and I verified the call site. WO-05 T-3 is therefore larger than WO-05 believed, and it depends on task 8.

---

## 2. The dependency spine

```
  1 tests ──────────────────────────────────────────────────► everything
  2 delete dead    3 cheap unblocks ───────────────► 13,14 (C2PA testable)
                                    └─────────────► 7 (container manifest)

  4 store leaf sig ──► 5 verify tells truth ──► 6 DEPLOY H-1  [CVM DECISION]
        │                                              │
        │                                              └─► production truth
        └──────────────────────────────────► 14 (§4: manifest cites the leaf)

  7 runner capture ──┐
  8 canvas capture ──┴──► 14 (ai.scruple.machine can be honest)

  9 encoder honest ──► 10 data model ──► 11 watermarkAndWitness + REORDER
                                              │        (the load-bearing edit)
                                              ├──► 12 /v2/watermark
                                              ├──► 17 sign the derivative
                                              └──► 19 chain tier 4/5  [SCR_ID DECISION]

 13 vault-http ──► 14 assertions ──► 15 sign route ──► 16 /v2/mark real
                                                  └──► 18 signer daemon [real CVM for the claim]

 20 Kohya witnesses ──► 21 per-session HMAC ──► 22 training provenance
 23 baseline from container manifest  [STANDARD DECISION, needs 8]
```

Two hard sequencing rules, both from the reports and both worth restating:

- **Task 5 must land in the same change as task 4.** Between them, `/api/v2/verify` keeps asserting `independently_verifiable: true` on an HMAC while the correct value sits unread in the adjacent column (Phase 1 §7).
- **Task 4 is a hard prerequisite for task 14**, not merely a cheaper win to do first. A Studio content credential referencing a leaf whose only backing is an HMAC is a C2PA Level 2 artifact asserting a provenance chain below L2 — the `L2_FLOOR.md` §1 inversion reproduced inside the C2PA modality, and far harder to walk back than the current silence (Phase 3 §4).

---

## 3. The tasks

Size is relative effort, not calendar time. **Surrogate** = completable and verifiable end-to-end against `127.0.0.1:8799` today. **Blocked** = needs the real CVM, or a decision that is not engineering's to make.

| # | Task | Size | Status |
|---|---|---|---|
| 1 | Studio test harness + characterization suite | medium | surrogate |
| 2 | Delete the dead, keep the live | small | no signer needed |
| 3 | The cheap unblocks | small | surrogate |
| 4 | Store the leaf signature | small | surrogate |
| 5 | Make `/v2/verify` and `/v2/witness` tell the truth | small | surrogate |
| 6 | Deploy H-1 to `/opt/scruple-witness/` | small code, ops | **BLOCKED — CVM decision** |
| 7 | Runner path: pass what is parsed, stop fabricating | small | surrogate |
| 8 | Canvas path: fingerprints + container manifest | large | surrogate; **feasibility UNVERIFIED** |
| 9 | Watermark encoder: correctness and honest claims | medium | no signer needed |
| 10 | The derivative data model + migration 042 | small | **decision-gated** |
| 11 | `watermarkAndWitness` + reorder `lock/local` | medium | surrogate |
| 12 | `POST /api/v2/watermark` + `/v2/mark` applies | small | surrogate |
| 13 | `vault-http` transport + third `signing_mode` | medium | surrogate |
| 14 | Assertion contract + Studio builders + migration 043 | medium | surrogate |
| 15 | Sign route takes a source, not a path | medium | surrogate |
| 16 | `/v2/mark` c2pa real + receipt/verify + button | small | surrogate |
| 17 | Publication ordering: sign the derivative | medium | surrogate |
| 18 | Signer HTTP daemon + transport switch | large | surrogate for code; **real CVM for the claim** |
| 19 | Chain-lock tier 4/5 watermark | medium | **decision-gated (SCR_ID, `pinned_hint`)** |
| 20 | Kohya route actually witnesses | medium | surrogate; **decision-gated (tenancy)** |
| 21 | Per-session HMAC | medium | no signer needed; launch blocker |
| 22 | Training provenance capture | large | **decision-gated** |
| 23 | Baseline from the container manifest | large | **decision-gated (Standard)** |

**Nineteen of twenty-three are completable against the surrogate.** The four that are not are one ops decision (6), two Standard decisions (19, 23), and one CA question (18's trust-list half — see §4).

---

### Tranche A — make it testable, make it smaller

#### Task 1 · Studio test harness and characterization suite · **medium** · surrogate

**Studio has no tests at all.** I confirmed it: `grep -rln "canvas\|captureOutput\|canvas-proxy\|kohya" test/` returns nothing. Every task below alters provenance capture, and WO-05 T-2 says the right thing — *"altering provenance capture with no tests is how §5 got broken in the first place."*

**Where the tests go.** The infrastructure already exists and should be extended, not duplicated:

- `test/integration/harness.ts` — already boots real Next against a throwaway DB and **already refuses a production witness URL**, substituting `http://127.0.0.1:1` (`harness.ts:41-58`). Its header comment records that the first run of these tests wrote 9 rows into `/opt/scruple-witness/witness.db`. Extend it with two optional capabilities: boot the CVM surrogate, and boot the **git** copy of `services/witness-server/server.js` on a scratch port with `SCRUPLE_WITNESS_KMS_*` pointed at the surrogate. `services/witness-server/tests/leaf_signer.test.mjs:34-46` already does the second and is the pattern to copy.
- `test/integration/studio-capture.test.ts` — **new.** Drives `captureOutput` (`lib/canvas/witness.ts:74`), which is the function `app/canvas-proxy/[sessionId]/[[...path]]/route.ts:216` actually calls. No Modal, no ComfyUI, no GPU: the proxy's entire contract with the capture layer is bytes plus a `canvas_pending_iterations` row. Phase 1 §6.5 and Phase 3 §7.5 both give the seeding SQL.
- `test/integration/leaf-signature.test.ts` — **new.** Phase 1 §6.6 (a)–(f).
- `test/watermark/` — **new.** Layer-0 encoder assertions, run under `node --test`/pytest without a server. Note `grep -rn "lib/watermark" test/ packages/` returns nothing today: **no test anywhere imports the watermark applier.**
- CI: `.github/workflows/tests.yml` already has an `integration` job pinned to `WITNESS_SERVER_URL: http://127.0.0.1:1`. Studio tests join it. Following the file's own convention, each new job says what breaks if it triggers.

The characterization suite must pin **current** behaviour, including the wrong parts, so later tasks show up as deliberate changes: `model_fingerprints_hash` is NULL on canvas iterations; `container_machine_manifest` is NULL; `watermark_derivative_leaf_hash` is NULL; `/api/v2/verify` returns `independently_verifiable: true` for an HMAC-only row.

**Gate:** `npm run test:integration` runs a Studio capture test in CI that asserts an `iterations` row with `witnessed=1`, `leaf_scheme='v2.2'`, and `output_hash` equal to sha256 of the input bytes — and a second test that asserts the four NULL columns above, each with a comment naming the task that will flip it. The harness refuses to run if `WITNESS_SERVER_URL` resolves to `:5799`.

#### Task 2 · Delete the dead, keep the live (WO-05 T-1) · **small**

All three targets still exist. `research/electron-source/ComfyUI-Scruple` (dead since May, raises `ModuleNotFoundError` as committed, called "dead code" at `modal/canvas_app.py:116`). `research/scruple-kohya-image/{Dockerfile,start.sh}` superseded — **but `scruple_safetensors_hook.py` in that same directory is live and must move somewhere live first.** `forge` is still a valid appId wired through four files (`app/api/apps/[appId]/session/route.ts`, `lib/apps/session-backends.ts`, `lib/apps/backends/runpod-session.ts`, `app/canvas-proxy/.../route.ts`) and always 503s: delete or give it a registry entry. Stop describing `external/scruple-nodes` as a Scruple integration; leave the directory alone.

**Gate:** nothing imports what was deleted; `scruple_safetensors_hook.py` still resolves from its new home; `npm run typecheck` and the Python suites stay green.

#### Task 3 · The cheap unblocks · **small** · surrogate

Four independent fixes, each ≤5 lines, each of which currently blocks testing something larger. Worth its own commit because the gate is "things that could not be run before now run."

- `lib/c2pa/signAsset.ts:19-20` → `signer.pem` / `signer.key`. **Verified: `es256.pem` does not exist.** Blocks all C2PA work.
- `services/c2pa-signer/signer_runtime.py:103-107` — stop inferring "this is a CVM" from "an OCID is set." Phase 3 §6.5 measured the consequence: pointing at the surrogate as its README instructs flips `_is_production_signer()` true, IMDS answers (this *is* an OCI host), and the age guard refuses at 147.44 days against a 60-day max. Worse, under 60 days it would have emitted `ai.scruple.signer-runtime.v1` **naming the app-tier instance as the signer** inside a signed manifest.
- `services/c2pa-signer/signer_runtime.py:36` — `IMDS_URL` is hardcoded with no override, so the surrogate README's claim that the *unmodified* module was pointed at it requires patching a constant. Add `SCRUPLE_SIGNER_IMDS_URL`.
- `lib/runs/execute.ts:75-95` and `:244-261` — pass the `containerMachineManifestHash` and `containerMachineManifest` both call sites already receive from `lib/compute/modal.ts:125-126` and both drop. `ingest.ts:260-282` has the resolution ladder written and waiting; branch 1 is unreachable today. (Also folded here rather than task 7 because it is four lines and unblocks the `ai.scruple.machine` assertion for the runner path.)
- Optional, flagged separately by Phase 1 §2: `CREATE INDEX idx_iterations_output_hash ON iterations(output_hash)`. The public unauthenticated `/api/v2/verify` full-scans `iterations` on every call.

**Gate:** the Phase 3 §7.3(d) in-memory sign produces `validation_state: Valid` with the Studio assertion set; `signer_runtime.age_guard_verdict()` returns `refuse: false` with the surrogate OCID set; a runner-path iteration lands with non-NULL `container_machine_manifest`.

---

### Tranche B — the leaf signature (Gap 2, the cheapest L2 win)

#### Task 4 · Store the leaf signature · **small** · surrogate

Phase 1 §2–§3, taken as written. Migration `041_iterations_leaf_signature.sql` adds **four** nullable columns — `leaf_signature`, `leaf_signer_key_id`, `leaf_signature_alg`, `leaf_signer_surrogate` — plus a partial index. `STUDIO_L2_MERGE.md` says three; Phase 1 argues for the fourth and I agree: with the real CVM down, every leaf signed between now and its return is software-keyed, and if the flag is not persisted a surrogate-signed and an HSM-signed leaf are byte-indistinguishable at rest, which is precisely the failure `services/cvm-surrogate/README.md` exists to prevent.

Then: five fields declared on `WitnessIterationResult` (`lib/scruple/witness.ts:37`); the positional INSERT at `lib/iterations/ingest.ts:321-331` goes 32→36 columns **and** 32→36 placeholders; four bound values after `ingest.ts:365`; `independentlyVerifiable` + `signerSurrogate` on `IngestResult`; four optional fields on `IterationRow` (`lib/types.ts:94`).

Three traps, all from Phase 1 and all real:

- **The wire field is `signer_surrogate`, not `leaf_signer_surrogate`.** The witness's own *column* is the latter (`server.js:234-236`); the *wire* field is the former (`server.js:661`). Reading the column name yields `undefined` forever, and `WitnessIterationResult`'s index signature (`lib/scruple/witness.ts:39`) means TypeScript will not say so.
- **The surrogate flag is three-way NULL/0/1.** `server.js:661` defaults `signer_surrogate` to `false` when there is no signature at all, so a naive `? 1 : 0` writes `0` — "signed by a production key" — onto every unsigned leaf in the estate.
- **A placeholder count that matches while the order is wrong is caught by nothing** and would write the key OCID into the surrogate flag. The gate below checks semantics, not presence, for exactly this reason.

**Do not backfill.** Re-signing a historical leaf produces a signature dated now over a record witnessed weeks ago — a stronger claim than the evidence supports, and the same error `039_v2_modalities_and_attestation_status.sql:9-12` already refuses for modality selection.

**Reach:** this is not a Studio change. Every one of the eight `ingestIteration` call sites gains at once — Studio's canvas path, the run/CLI pipeline, `/api/generate` in all three shapes, `POST /api/iterations`, and the Fusion 360 CAD add-in.

**Gate:** Phase 1 §6.6 (a)–(d) green — the row carries an ECDSA signature distinct from the HMAC, `leaf_signer_surrogate=1`, the signature **verifies against the surrogate's published PEM in a process holding no `SCRUPLE_WITNESS_SECRET`**, a forged leaf hash fails, and `Buffer.from(sig,'base64')[0] === 0x30` (DER, not a house encoding).

#### Task 5 · Make `/v2/verify` and `/v2/witness` tell the truth · **small** · surrogate

`app/api/v2/verify/[content_hash]/route.ts:62-64` reads `witness_signature` and comments that it holds an ECDSA signature. It does not — it holds the HMAC from `ingest.ts:361`, produced at `server.js:250-256`. `witnessResult.signature` is non-null for *every* successful witness call, so **the endpoint answers `independently_verifiable: true` for every witnessed row it has ever seen**, names `ECDSA_SHA_256` as the algorithm, and instructs callers to fetch a key from `/api/signer/pubkey` — a route that **404s on the deployed witness**, because it shipped in the same undeployed commit.

Phase 1 §4b is the fix: read `leaf_signature`, report `algorithm` and `key_id` **from the row rather than asserting them**, and add `key_custody: 'software_surrogate' | 'hsm_vault'`. A software key gives third-party verifiability but not GPSR C.2.2 custody; both facts are true and a verifier is entitled to both.

Two other writers need the same treatment, and they are separate code paths: `app/api/v2/witness/route.ts` does **not** use `ingestIteration` — it calls `witnessIteration()` at line 114 and INSERTs itself at 171-199, so without the same four fields the canon surface silently regresses relative to the ingest path (Phase 1 §4c). The Adobe/Photoshop routes (`app/api/scruple/witness/{adobe,photoshop}/route.ts`) can simply be allowed to report `false` — that is honest, and they are superseded.

One presentational fix rides along: `app/receipt/[scrId]/page.tsx:263-268` describes the HMAC as "Scruple's per-record seal" and becomes incomplete the moment `leaf_signature` is populated.

**Anticipate this:** after tasks 4 and 5 land, and until task 6 does, **every leaf honestly reports `independently_verifiable: false`.** That will look like a regression to anyone reading the endpoint without reading this plan. It is not. It is the first time the endpoint has told the truth.

**Gate:** Phase 1 §6.6(f) — the sharp variant. Run the scratch witness with `SCRUPLE_WITNESS_KMS_*` **unset** so `leaf_signer.js:87` yields `disabled`. That produces `witnessed=1`, `witness_signature` non-null, `leaf_signature` NULL — the exact row the old code called independently verifiable and the new code calls `false`. That single case is the whole bug and belongs in the permanent suite.

#### Task 6 · Deploy H-1 to `/opt/scruple-witness/` · **small code, real ops** · **BLOCKED**

Redeploy `services/witness-server/` over the six-week-stale copy; add `SCRUPLE_WITNESS_KMS_ENDPOINT` / `SCRUPLE_WITNESS_KMS_KEY_OCID` (or `SCRUPLE_WITNESS_SIGNER=vault-py`) to `/etc/systemd/system/scruple-witness.service`, which today sets only `SCRUPLE_WITNESS_SECRET` and `PORT`; run `node services/witness-server/check-deployment.mjs` and require exit 0 as a permanent step.

Nothing in tasks 4–5 is wasted if this never happens — they are correct in themselves and they fix a live overstatement. But **nobody may describe Studio's leaves as independently verifiable until this lands**, and this is where the CVM decision bites. See §4 for the decomposition; the key point is that *deploying H-1 pointed at a surrogate or a local key* is a real intermediate state with real value and a real honesty cost, and choosing it is not engineering's call.

Also worth noting under `L2_FLOOR.md` H-3: `/opt/scruple-witness/` is not in git, so the component that computes everyone else's baseline is the one component nothing can measure. Redeploying from git is the first step out of that circularity.

**Gate:** `check-deployment.mjs` exits 0 against the live service; `GET /api/signer` on the production witness reports `self_check.ok: true` and a truthful `surrogate` flag; a freshly witnessed production leaf carries a non-NULL `leaf_signature`; `/api/signer/pubkey` returns 200.

---

### Tranche C — make the leaf carry what Studio claims

#### Task 7 · Runner path: stop fabricating (WO-05 T-6) · **small** · surrogate

`modal/scruple_runner.py:653-661` swallows container-manifest failure and lets `machine_manifest_hash` "just stay `''`" — a leaf silently loses its machine binding. The model-name fallback fabricates `ModelPatcher_{id()%10000}`, an identifier derived from a Python object address, recorded as if it named a model; it is stable for no longer than the process. Replace with an explicit unidentified-model marker. Leave `"attestation": None` at line 672 alone — WO-05 §3.3 is right that reporting absence is honest and is more than the attestation verifier plugins manage.

**Gate:** no leaf carries an empty `machine_manifest_hash` or a `ModelPatcher_`-shaped model name; a forced container-manifest failure produces a visible error rather than a silently weaker leaf.

#### Task 8 · Canvas path: fingerprints and container manifest · **large** · surrogate; **feasibility UNVERIFIED**

This is the task that makes §0.1 false rather than true, and it is the largest single unknown in the plan.

The canvas container never calls `run_workflow`, so `_hash_workflow_models` and `cached_container_manifest` never execute for it. Phase 3 §6.1 offers two routes:

- **(a)** add a small Scruple endpoint to the canvas container. This reverses the deliberate removal of `scruple_nodes` at `modal/canvas_app.py:116-124`, changes the image, changes `manifest_hash`, and therefore **re-baselines every machine**. Phase 2 refused to reopen that decision for the watermark; the argument is weaker here (a fingerprint endpoint reads files and returns hashes; it does not touch pixels or poison training data) but the re-baseline cost is identical.
- **(b)** have `captureOutput` obtain fingerprints from a `web_run`-class container over the shared models volume. `modal/canvas_app.py:126-130` states the volume is shared — *"Provenance reads the same model_fingerprints either way"* — which is currently aspirational for the canvas path.

Phase 3 recommends (b) because it needs no image change, and marks it **UNVERIFIED** whether a `web_run` container can enumerate the *canvas* container's `custom_nodes/`: the models volume is shared, the ComfyUI install is not. My reading of that is: **(b) probably reaches the model fingerprints and probably does not reach the container manifest.** If that holds, the honest outcome is dual fingerprints via (b) and `ai.scruple.machine.v1` deferred until (a) is accepted — which is exactly Phase 3's recommendation to emit the machine assertion only when a real container manifest is present, never as a descriptor fallback.

**Do a spike before committing to a route.** This is the one task where the estimate could be wrong by a factor of three.

**Gate:** a canvas-proxy iteration lands with non-NULL `model_fingerprints_hash`; the characterization test from task 1 that asserts NULL is deliberately inverted in the same commit. Separately and explicitly: either `container_machine_manifest` is non-NULL, **or** a written finding says (b) cannot reach it and names what (a) would cost.

---

### Tranche D — watermarking (Gap 3)

#### Task 9 · Encoder correctness and honest claims · **medium** · no signer needed

Independent of everything else and can land immediately. Five things, all correctness:

- **Alpha is silently destroyed.** `image_dct.py:103` converts to `YCbCr` and `:139` re-merges via `.convert('RGB')`. Measured by Phase 2: an RGBA master returns an RGB derivative. **ComfyUI routinely emits RGBA PNGs**, so for Studio specifically this is data loss on the released artifact — a transparent output comes back with an opaque background and no warning. Split the `A` band before conversion and re-merge after.
- **One clock reading.** `embed.ts:59` mints the timestamp inside the payload; `apply.ts:114` reads the clock *again* for `watermark_signed_at`. Under load these differ, so the column is not a reliable index into the payload — and `app/receipt/[scrId]/page.tsx:616-618` renders it as if it were.
- `outputQuality` is declared at `embed.ts:89` and never sent (`embed.ts:114-120`), so `image_dct.embed_image` always uses its default 95. `inputFormat` is likewise dead.
- Validate `scrId` against `/^SCRB?_[0-9A-Fa-f]{6,16}$/` before `embed.ts:74` interpolates it **unescaped into Python source**. Not live today — the only caller passes a server-derived value — but it becomes live the instant an endpoint accepts an `scr_id` from a request body.
- Narrow `isWatermarkable` (`lib/v2/capabilities.ts:54-57`) from "any image/video/audio except SVG" to the raster set the encoder actually handles. Today `GET /api/v2/capabilities?mime=video/mp4` answers *available*, `/v2/mark` passes the gate, and `apply.ts:59` then skips it — the server offering a modality it cannot perform, which is `CANON_SKELETON.md` D-7's fail-closed rule inverted. `test/v2/capabilities.test.ts:15` asserts the current behaviour and must change; **that is the point.**

**And the honesty item, which is not code.** Phase 2 §2 measured the robustness matrix `WATERMARK_DESIGN_v1.md §9` claims:

```
JPEG q70 → RECOVERED    JPEG q65 → none    JPEG q60 → none   (claimed to survive)
resize 90% → none       resize 50% → none                    (claimed to survive)
crop 90% → none                                              (claimed at ≥60%)
PSNR 42.40 dB                                                (claim holds exactly)
```

The mechanism is isolated and credible: `image_dct.py:174-175` derives the block grid from the **received** image's width, so any width change re-indexes every bit. Cropping the *bottom* only (width preserved) recovers; cropping the right by 56px does not. There is no sync template and no grid search. The perceptual claim holds; the robustness claims do not, and the JPEG threshold is ~q70 — **below Twitter/X and Instagram's typical re-encode.** Correcting §9 and §10.2 is a documentation task, but whether a mark this fragile is shippable is a product decision (see §5).

**Gate:** a robustness harness in `test/watermark/` asserting the **measured** matrix, not the design doc's — a green test claiming "survives resize 50%" would be asserting a falsehood. Plus: RGBA in, RGBA out, alpha byte-identical; `decodeImageWatermark(...).signedAtUnixSeconds * 1000 === Date.parse(watermark_signed_at)` exactly; `capabilities?mime=video/mp4` returns `available: false` with a reason naming §9.2.2/§9.2.3 as unimplemented.

#### Task 10 · The derivative data model + migration 042 · **small** · **decision-gated**

The disagreement in §1(c), settled before any column lands. Two questions:

1. **Columns on `iterations`, or an `artifact_derivatives` side table?** §4.4 contemplates multiple derivatives per master over an artifact's life (day-1 local lock, day-30 chain lock), and the current single-column design silently overwrites the first. The same applies to task 14's seven C2PA columns. A side table keyed `(iteration_id, kind, created_at)` with `kind ∈ {watermark, c2pa}` costs one join and removes the overwrite bug from both tracks.
2. **How is a derivative leaf's `run_sequence` allocated?** Per §1(b): either allocate from a shared counter that both `iterations` and derivatives draw on, or give the derivative its own `iterations` row with `output_kind='derivative'`. The second is more code and makes `/api/v2/verify` work on the released bytes for free, which is worth something.

My recommendation, offered as a recommendation and not a decision: **side table, and allocate the derivative a real `run_sequence`.** But this is exactly the kind of call that is cheap now and expensive after 043.

**Gate:** the migration exists and applies cleanly; `watermark_derivative_leaf_hash` (unused since `038_watermark_derivative.sql:25-27`) is either populated by the new model or explicitly retired with a comment saying which; `IterationRow` in `lib/types.ts` declares the migration-037/038/039 columns it currently omits, and the two casts at `apply.ts:48-51` and `app/receipt/[scrId]/page.tsx:568-574` are deleted.

#### Task 11 · `watermarkAndWitness` + reorder `lock/local` · **medium** · surrogate — **the core**

Phase 2's Change 7 is the load-bearing edit and its §5a is the diagnosis: `services/witness-server/server.js:1172` inserts into `locked_projects` on finalize, `server.js:577` then refuses every subsequent leaf, and `app/api/lock/local/route.ts` finalizes at 97-119 and watermarks at 151-160. **The current sequencing makes a witnessed derivative structurally impossible.** That is why the column has been NULL since migration 038.

The new order inside the lock route:

```
1. build Merkle over the master leaves                   (unchanged)
2. derive the tier's payload
3. embed → derivative bytes → derivative_hash
4. WITNESS the derivative leaf                           ← project still unlocked
5. persist the derivative leaf hash
6. rebuild the Merkle over master + derivative leaves
7. confirmAndExecute('finalize')                         ← seals the project LAST
```

Plus Phase 2's Change 2 (extract `watermarkIteration` from the loop body at `apply.ts:57-125`) and Change 3 (new `lib/watermark/witness.ts` composing embed-then-witness). Per §1(a), **step 4 works against the unmodified witness server** as a plain `v2.2` leaf over `content_hash = derivative_hash`. The in-leaf lineage (`master_hash`, `watermark_payload_hex`, `ingredient_master_leaf_hash`) is a later enhancement that does need a witness-server change and therefore task 6.

Worth knowing while doing this: that lineage shape is **already designed and already correctly validated — in the wrong module.** `lib/witness/ingest.ts:45-51` declares all three fields citing `WATERMARK_DESIGN_v1.md §7.4`, and lines 219-244 validate them properly together (all-three-or-none, 64-hex, magic byte `5c` asserted, version nibble asserted). Then the values are dropped: they are in neither the v2.3 nor v2.4 preimage and not in the `log_leaves` INSERT. A caller can submit perfect derivative lineage to `/api/v1/log/{stream}` and get back a leaf that commits none of it. That module is the Continuous Audit path, not Studio's — but the validation is written and can be lifted.

Keep the existing failure posture verbatim: `app/api/lock/local/route.ts:149-150` says a watermark error does not roll back the lock, and that stays true. A witness outage leaves a marked derivative with a NULL leaf hash and an explicit `witnessed: false`, never a silent claim — the same discipline as `ingest.ts:304-306`.

**Gate:** Phase 2 §7.6, in order. (1) `iterations.output_hash` unchanged and `readArtifact(output_hash)` byte-identical to what was ingested — **the §4.3 master-preservation invariant asserted as a test rather than as a comment**; (2) `watermark_derivative_hash` set and different; (3) **`watermark_derivative_leaf_hash` is not NULL** — this single assertion is the whole of Phase 2; (4) the derivative decodes to the expected tier and timestamp; (5) the master decodes to `null`; (6) the scratch witness log shows a second leaf for the project chaining `prev_record_hash` to the master's.

#### Task 12 · `POST /api/v2/watermark` + `/v2/mark` applies · **small** · surrogate

A Next route at `app/api/v2/watermark/route.ts`, not a server in `services/watermark/`. Phase 2 §4a's reasoning is sound and I agree with all four points, the second most of all: **watermarking involves no key**, so there is nothing to hold at C.2.2 custody and nothing to isolate — unlike the C2PA signer, whose separation exists precisely because the key must stay inside the attested CVM. Standing up a byte-accepting Python listener on the app host would add a surface with its own auth, rate limiting and patch-recency story, and — like `/opt/scruple-witness/` — a strong tendency to end up outside the measured TOE.

Auth via `requireScope(req, 'mark:write')`. **No `scr_id` and no `pinned_hint` in the request** — both are server facts, which also closes the `embed.ts:74` interpolation hole by construction. **No raw bytes in v1** — every SaaS caller already has its bytes in the artifact store. Errors through `v2Error`, including a **409 on an already-locked project**, which after task 11 is the genuinely correct answer rather than defensive padding.

`/v2/mark` calls the shared function, not this route over HTTP. `CANON_SKELETON.md` §6's objection to per-modality endpoints is about the atomicity of the *recorded selection*; it does not forbid a byte-level capability route. `/v2/watermark` is the capability; `/v2/mark` remains the one call that commits the selection to the leaf.

**Gate:** `POST /v2/mark` with `modalities: ['watermark']` on a Studio image returns `watermark` in `applied` rather than `outstanding`; the same call on a locked project returns 409; on `video/mp4` it returns `modality_unavailable` (post-task-9 narrowing) rather than accepting and skipping.

---

### Tranche E — C2PA (Gap 1)

#### Task 13 · `vault-http` transport + third `signing_mode` · **medium** · surrogate

`services/c2pa-signer/vault_sign.py:55-91` requires the `oci` SDK — **not installed on this host** — and `InstancePrincipalsSecurityTokenSigner`, which targets `169.254.169.254` regardless of `SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT`. Mirror what `services/witness-server/leaf_signer.js` already does: speak raw HTTP to the KMS endpoint. Phase 3 §6.4 verified the request shape against `services/cvm-surrogate/surrogate.py:212-270`, which validates exactly those fields and rejects anything else.

`signing_mode()` must return a **third** value, `'vault-http'`, not `'vault'`. A surrogate-signed asset reporting `signing_mode: "vault"` is the dev-indistinguishable-from-production failure the surrogate exists to prevent — the same argument as task 4's fourth column, and it should be made the same way twice.

**Gate:** `vault_sign.signing_mode()` returns `'vault-http'`; `signer_identity()` contains `surrogate`; `vault_sign_es256(b'probe')` returns 64 raw R‖S bytes that verify against `$SURROGATE_BASE/testnet/pubkey.pem`; the surrogate's key metadata still reports `protectionMode: SOFTWARE` (**if it ever says `HSM`, stop — the surrogate has been made to lie**).

#### Task 14 · Assertion contract + Studio builders + migration 043 · **medium** · surrogate

`ai.scruple.workflow` is **already on the allowlist** (`config/c2pa-assertions.json`, `created.application_tier`), and Phase 3 ran the real partitioner against a Studio-shaped set: `created_count: 3, rejected_count: 0`. So the base Studio manifest needs no contract change — a better starting position than Gap 1 implied. What is missing is the caller: `app/api/scruple/c2pa/sign/route.ts:163-170` never passes `workflow`, so the `product === 'studio'` branch at `signAsset.ts:258-260` is dead code. **The interface for Studio's provenance was designed and never wired.**

Phase 3 §3b settles the size question by measurement: the to-be-signed COSE structure is **1931 bytes regardless of assertion payload size** (0 / 8 / 64 / 256 KiB all identical), because the claim carries hashed URIs. So the argument against embedding the graph is **not size — it is disclosure**, and disclosure is `workflow_publication`.

New `lib/c2pa/studioAssertions.ts` with three pure functions over an `IterationRow`. `ai.scruple.workflow.v1` gains `input_hash` (without it a verifier reading only the credential cannot re-derive the leaf), `leaf_scheme` (**`v1` means the witness was unreachable and the hash is just the output hash — signing a `v1` iteration without saying so is the same class of error as task 5's**), and `disclosure`. `deriveDigitalSourceType` reads `input_artifacts`: any `init_image`/`source_image`/`control_image` → `COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA`. The route sets no digital source type today, so **every Studio asset would claim pure GenAI provenance regardless of whether a human-supplied image fed it.**

Two new labels — `ai.scruple.workflow-graph` (only when `workflow_publication === 'full'`) and `ai.scruple.machine` — must be added to **both** `config/c2pa-assertions.json` and `SCRUPLE_LABELS` in `signAsset.ts:201-206`, in **one commit**: adding to the second without the first makes `signAsset.ts:222-228` throw **at module load** and the app fails to boot. That coupling is deliberate and correct.

**Defer emitting `ai.scruple.machine` until task 8 lands.** A descriptor manifest with six `commit_sha: null` and three `main` refs pins nothing, and a manifest presenting descriptor and container identically would be the §12.4 mistake in a new place. `buildMachineAssertion` should return `null` — not a descriptor fallback.

The disclosure default is a product decision (§5). What is not negotiable: `app/receipt/[scrId]/page.tsx:376-382` treats publication mode as *presentation only*, which is fine for a page the user can re-render and wrong for an exported, permanently-attached credential — and `app/api/iterations/[id]/publication/route.ts:22-26` makes the mode upgrade-only precisely because disclosure cannot be undone.

**Gate:** the partitioner accepts the extended Studio set and still **refuses** an unlisted label (that fail-closed boundary is what makes the contract addition load-bearing — assert both directions); a signed manifest carries `ai.scruple.workflow.v1` with `input_hash`, `leaf_scheme` and `disclosure`; a `hash-only` iteration produces a manifest containing no graph, asserted by reading the manifest back.

#### Task 15 · The sign route takes a source, not a path · **medium** · surrogate

`asset_path` is a path **on the machine running Next.js** (`route.ts:147-153`). Studio has none and never will — the browser holds no filesystem path, the Modal container's paths are meaningless to the app host, and `components/LockButtons.tsx:84-86` already names this as the first of two blockers on the C2PA button. Replace with `source: {kind: 'iteration'} | {kind: 'upload'} | {kind: 'path'}`, where `kind: 'path'` is dev-only and **400s whenever `SCRUPLE_C2PA_SIGNER_URL` is set**. For `kind: 'iteration'` the route resolves bytes itself: `readArtifact(output_hash)`, falling back to the storage pointer.

Pass `format` from `iterations.output_content_type` rather than guessing from the file extension via `mimeFromPath` — under `kind: 'iteration'` there is no filename anyway, and this removes a whole class of the octet-stream problem `lib/v2/capabilities.ts:1-8` describes.

Store the result (migration 043 or the task-10 side table) rather than leaving it in a `/tmp` directory that `route.ts:158` creates and **nothing ever cleans up**. `route.ts:194` hardcodes `certSubjectKeyId: 'dev-cert'` in the audit leaf; it should come from the signer result.

Note in passing, from Phase 3: the local artifact copy that makes this work is described at `ingest.ts:5-7` as short-lived pending a "retention sweeper (Pivot S12)". **There is no sweeper** — nothing in `lib/`, `scripts/` or `app/` implements one. So the copy is permanent, which is why `artifactPath(output_hash)` would work today with no change at all. That is the trap: it works *because* the signer is a subprocess of the web app, and stops working the instant the L2 architecture the whole programme is built around exists.

**Gate:** a Studio iteration signs end-to-end through the surrogate with no `asset_path` anywhere in the request; the signed bytes are stored and retrievable; `kind: 'path'` 400s when a signer URL is configured; `c2pa.Reader` reports `validation_state: Valid` and `issuer: Scruple Dev Root CA` (so nothing produced here can be mistaken for a real credential).

#### Task 16 · `/v2/mark` c2pa real, receipt and verify surfaces, the button · **small** · surrogate

`app/api/v2/mark/route.ts:106-113` becomes a real call. **Keep the fail-closed MIME gate at 86-95 exactly as it is** — and note it catches a real Studio case: `video/webm` is not in `C2PA_SIGNABLE` (`lib/v2/capabilities.ts:39-45`), not in `formats.GENERATE_MIMES`, and not in `Builder.get_supported_mime_types()` on c2pa 0.36, and **Studio produces webm** (`lib/canvas/witness.ts:104-105`). A user selecting C2PA on a webm output gets a correct 4xx today; that must survive, because the alternative is a silent skip.

Add a `c2pa` block to `app/api/v2/receipt/[leaf_id]/route.ts`, surfacing `signing_mode` so `'vault-http'` reads as *surrogate* on the receipt. That route's header calls itself "deliberately unflattering"; this is exactly that, and it is the reason to keep the third enum value rather than collapsing it. Then delete the `unavailable` string in `components/LockButtons.tsx:74-89`.

**Gate:** `POST /v2/mark` with `modalities: ['c2pa','watermark']` on a Studio PNG returns both in `applied`; the receipt shows `signing_mode: 'vault-http'`; the same call on a webm returns `modality_unavailable` for c2pa while still applying the local lock (D-5).

#### Task 17 · Publication ordering: sign the derivative · **medium** · surrogate

Extends task 11's sequence with `5b. C2PA-sign the derivative`, with the **clean master as a C2PA ingredient** carrying its own `leaf_hash`. Migration `038_watermark_derivative.sql:5-9` already prescribes exactly this — *"own hash, own signed C2PA manifest, own witness leaf, and reference the master via a `c2pa.actions.v2` `c2pa.edited` action + ingredient"* — and `Builder.add_ingredient_from_stream` exists in c2pa 0.36. This is the one place a **C2PA-native** mechanism expresses a Scruple relation, so a generic verifier sees the lineage without understanding `ai.scruple.*`.

Phase 3 §5b offers a third leaf over the signed bytes, and then argues for shipping the simpler form first: record the signed asset's hash on the derivative without minting a third leaf, accepting that the distributed file's exact bytes are committed by the C2PA signature rather than by a witness leaf. **I agree with shipping the simple form** — the C2PA signature *is* an ECDSA signature by the same key — but the consequence should be stated in the receipt rather than left implicit: after tasks 11 and 17, the file the user distributes is the C2PA-signed watermarked derivative, and its bytes are committed by the manifest, while the *pre-signing* derivative bytes are committed by the witness leaf. That is defensible. It is not the same as "the leaf commits what you downloaded," and the receipt should not imply it does.

Also in the manifest, from Phase 3 §4(i): `leaf_signature`, `leaf_signer_key_id`, `leaf_signature_alg`, `receipt_url`, `verify_url`, and `witness_key_url`. **That last field is what turns the leaf reference from a claim into evidence** — without it, `leaf_hash` is a lookup key into Scruple's database and nothing more. Do **not** use `Builder.set_remote_url`: a credential whose provenance is a live fetch against Scruple is exactly the "verifiable only with the issuer's cooperation" shape the receipt route's own header rejects.

**Gate:** Phase 3 §7.6, both halves in one run — a third party holding only the signed file and a public PEM verifies (1) the C2PA signature with any C2PA tool and (2) the referenced leaf's ECDSA signature, in a process with no `SCRUPLE_WITNESS_SECRET` and no OCI credentials. **Neither half alone is worth anything**, and half (2) cannot pass until task 4 lands — which is the dependency between the phases made executable.

#### Task 18 · Signer HTTP daemon + transport switch · **large** · surrogate for the code; **real CVM for the claim**

`services/c2pa-signer/server.py` does not exist anywhere. The `:8443` daemon exists only in `deploy/oci-signer-rotation/terraform/instance-pool.tf:43-47` and in a runbook documenting a multipart API the route does not implement; `SCRUPLE_C2PA_SIGNER_URL` appears in two doc files and **zero lines of code**. This is the piece the Terraform assumes and git does not contain.

`signAsset()` gains a transport switch: unset → today's `spawn(sign.py)`; set → multipart POST. **The job spec stays byte-identical between transports** — one manifest builder, one assertion contract, one partition enforcement, two ways of moving bytes. That is the property worth protecting.

The code is fully exercisable against a loopback daemon plus the surrogate. What it cannot establish is anything about real KMS latency per leaf, instance-principal auth from inside the pool, or SEV-SNP attestation — `services/cvm-surrogate/README.md` says so, and correctly does not pretend otherwise.

**Gate:** the same Studio asset signs identically through both transports, asserted by comparing the manifests; `GET /health` returns the shape the runbook's smoke test expects; `signing_mode` is truthful in both.

---

### Tranche F — the rest of WO-05, and chain lock

#### Task 19 · Chain-lock tier 4/5 watermark (D-6, §9.3) · **medium** · **decision-gated**

Verified four ways by Phase 2 §3: `app/api/lock/chain/route.ts` contains **no `watermark` token at all**; `watermarkProjectIterations` has exactly one call site; the tier-4/5 branch of `buildPayloadHex` is unreachable in production; and `apply.ts:3-4` documents a wiring that does not exist. §9.5 counts the SCR_ID mark as one of four independent verification paths for chain lock; **chain lock currently ships one of four.**

Two obstacles beyond the wiring, both blocking and both decisions:

- **There are three different SCR_ID derivations in play.** `lib/scruple/hash.ts:20-23` produces `'SCR_' + merkleRoot.slice(0,6)` — 6 characters *of* the root. `services/witness-server/server.js:1215-1217` mints `'SCR_' + sha256(rootSource).substring(0,8)` — 8 characters of a *hash of* the root. These are different identifiers for the same lock. Embedding `preScr` (`chain/route.ts:76`) would mark the file with an identifier naming **no RVN asset**.
- **The 6-character form does not round-trip.** Measured: `SCR_A38E30 → 5c14a38e30… → SCR_A38E3000`, `roundtrip_ok=False`, because `payload.py:73-81` keeps a minimum of 8 hex digits. Every scruple-web-derived SCR_ID decodes to a *different string* than the one embedded, and a verifier querying it on RVN finds nothing. `SCRB_` also loses its namespace — `_scr_id_to_u64` strips it and `_u64_to_scr_id` always re-emits `SCR_`.

Widening `deriveScrId` to 8 changes a user-facing identifier for all future locks and cannot be applied retroactively. That is a product decision.

`pinned_hint` for tier 5 has **no implementation anywhere and no test vector** — `WATERMARK_DESIGN_v1.md §3.1` defines what it is for and not how to derive it. Until specified, tier 5 should embed tier 4's payload and the response should say so, rather than invent a hint no resolver understands.

Also flagged for whoever opens this file: `chain/route.ts:48` has `if (false && REQUIRE_PAYMENT && !body.paymentIntentId)` — a disabled payment gate on the $100/$150 path.

**Gate:** the embedded SCR_ID string-equals `projects.scr_id` (the **minted** value, not `preScr`); `decodeImageWatermark(...).scrId` round-trips it exactly; `SCRB_` survives on the persistent tier; tier 5 either carries a specified hint or explicitly reports that it carried tier 4's payload.

#### Task 20 · Make the Kohya witness route witness (WO-05 T-4) · **medium** · surrogate; decision-gated

`app/api/apps/kohya/witness/route.ts` creates **no iteration row and no witness leaf**. Its header at lines 6-7 claims it "POSTs to the witness server for the leaf hash + HMAC seal"; its body at 113-118 says the opposite in terms; and it returns `ok: true` at line 199 regardless. Header and body contradict each other and the header is the one that reads like documentation. This matters for Studio's framing: **Studio is "ComfyUI *and Kohya*", and the Kohya half is not on the ingest path at all** — it gains nothing from task 4 because it produces no leaf to sign.

Note the timing pressure: the canonical surface it defers to is `/api/v1/log/*`, which `CANON_SKELETON.md` D-1 marks for **deletion**, and which I confirmed still exists (`app/api/v1/{log,proof,registry,streams,tenants}`). This route cannot be left as-is through that change.

The principal question its own comment raises is a decision: the pod HMAC authenticates the hook, not the human. WO-05 recommends (a) exchange the pod HMAC for a scoped session key at pod start via `/v2/session/handoff`; (b) look up the session owner and witness on their behalf is less work. I agree with WO-05 that (a) is cleaner and matches the canon auth model, but it is bound up with task 21.

**Gate:** the route returns `witnessed: true` only when a leaf exists and `false` otherwise — **never `ok: true` over nothing** (D-8); the header comment and the body agree.

#### Task 21 · Per-session HMAC (WO-05 T-8) · **medium** · launch blocker

`SCRUPLE_APPS_WITNESS_SECRET` is global across `lib/apps/backends/runpod-session.ts` and `app/api/apps/kohya/witness/route.ts`. **Any pod can witness as any user.** Pre-launch this is a configuration decision; at launch it is a tenancy boundary that does not exist. Not a Standard clause; `L2_FLOOR.md` H-4 covers it if the floor is read as client-binding — which is itself open (§5).

**Gate:** a secret captured from one pod cannot witness for another user, asserted as a test.

#### Task 22 · Training provenance capture (WO-05 T-5) · **large** · decision-gated

`training_runs` (`001_core.sql:88`) provides for `dataset_path`, `dataset_merkle`, `image_count`, `caption_count`, `base_model_path`, `base_model_hash`, `parent_run_id`, `lineage_type`, `parent_checkpoint_hash`, and six hyperparameter columns. The live path writes three: `model_hash`, `header_hash`, `structural_summary`. **For a training tool this is the whole provenance question** — a checkpoint hash says a file exists and says nothing about what it was trained on. The schema was designed by someone who understood that; the capture path never caught up. Collect at run start from the Kohya config, not at checkpoint write.

Before building capture for `parent_run_id` / `lineage_type` / `parent_checkpoint_hash`, confirm fine-tune-of-a-fine-tune lineage is still wanted (§5).

**Gate:** a real training run produces a `training_runs` row with dataset and base-model fields populated, and a leaf that commits to them.

#### Task 23 · Baseline from the container manifest (WO-05 T-3, D-3) · **large** · **decision-gated (Standard)**

WO-05's T-3 remains the task that would make Studio the first integration to satisfy §3 and §4 — but per §0.1 and task 8, it is more than wiring on the canvas path, and it rests on three Standard questions WO-05 §5 raised and did not answer. It also collides with `CANON_SKELETON.md` **D-3** — *"`POST /v2/witness` rejects a leaf whose `baseline_ref` is absent or unknown"* — which, enforced today, would refuse every Studio leaf. Whether D-3 binds the canvas path before Studio has baselines is a sequencing decision with a real product consequence.

**Gate:** every Studio leaf carries a `baseline_ref`; a rebuilt image produces a rebaseline leaf with a **non-null `witness_leaf_id`** (a permanent null today, which is why §4 is unimplemented end to end).

---

## 4. The CVM question, decomposed

"Blocked on the real CVM" conflates four different blockers with four different owners. Separating them is what makes 19 of 23 tasks surrogate-completable.

| Blocker | What it actually gates | Owner |
|---|---|---|
| **CVM powered on** | Task 6 only. Nothing else in the plan. | Founder — ~$135/month (`L2_FLOOR.md` §5) |
| **HSM key custody (GPSR C.2.2)** | The *evidence claim*, not any code. A surrogate-signed leaf is genuinely third-party verifiable and genuinely not L2 custody. | Founder — and it is a claim question, not a build question |
| **C2PA trust-list certificate** | Whether a manifest validates for anyone outside `verify_trust: false`. **No amount of CVM or surrogate work advances this** — it is a CA question ("wait for the CA: days to weeks"). | Founder / external CA |
| **Attestation survives stop/start** | Whether "bring the CVM up per batch" is viable at all. `L2_FLOOR.md` §5 marks it **UNVERIFIED**; the cloud-init that binds the signer key to the SEV-SNP measurement is first-boot-only in the YAML. | Engineering, but only the real machine answers |

The third row is the one nobody has scheduled and it has the longest lead time. If a trust-list certificate is weeks out, that is an argument for starting it **now, in parallel with task 1**, independent of every other decision here.

The fourth is a correctness question wearing a cost question's clothes, exactly as `L2_FLOOR.md` §5 says. It should be tested before anyone plans around either "keep it up" or "bring it up per batch."

**On the interim posture, stated plainly rather than assumed:** `L2_FLOOR.md` §5 already considered and rejected asymmetric signing outside a TEE on its merits — it buys third-party verifiability and non-repudiation without C.2.2 custody, so the evidence layer would sit below L2 while claiming parity. The surrogate is precisely that arrangement. Whether leaves signed by it may be shown to a customer at all, and with what label, is open (§5, Q3). The engineering is ready either way: task 4's fourth column and task 13's third `signing_mode` exist so that a surrogate-signed artifact is **distinguishable at rest**, not merely at the moment of signing.

---

## 5. Product and Standard decisions — OPEN, for the founder

These are not engineering calls and I have not made them. Each names what is blocked and what it costs to defer.

**P-1 · Does the CVM come back up, and on which vault tier?** ~$135/month for a 24/7 pool of 2 on the Default vault; a Virtual Private Vault is ~$2,855. Oracle documents **both** as FIPS 140-2 Level 3 HSMs — the difference is dedicated versus shared partition tenancy, not certification level — and whether GPSR C.2.2 requires the dedicated partition is an interpretive call Oracle does not settle. **A 20x cost difference resting on a reading**, and worth a determination. Confidential Computing itself carries no premium; preemptible instances are incompatible with it, so that saving does not exist. *Blocks: task 6, and every production truth claim.*

**P-2 · Is `L2_FLOOR.md` §2's "same signing key" a statement of intent, or a claim already made to a counterparty?** It appears in a public-facing capability register. If it has been shown to the C2PA reviewer, the EU AI Office, or a customer, the gap between claim and implementation is more urgent than any of the engineering below it. *Blocks: nothing technically; changes the priority of everything.*

**P-3 · May a surrogate-signed leaf be shown to a customer, and labelled how?** See §4. The plan makes it distinguishable at rest either way. *Blocks: the receipt copy in tasks 5 and 16.*

**P-4 · Columns or a side table for derivatives?** Cheap now, expensive after migration 043. See §1(c). *Blocks: tasks 10, 14.*

**P-5 · Which SCR_ID is canonical, and does `deriveScrId` widen from 6 to 8 hex characters?** Three derivations exist for one lock; the 6-character form cannot round-trip through the watermark payload. Widening changes a user-facing identifier for future locks and must not be applied retroactively. *Blocks: task 19.*

**P-6 · How is `pinned_hint` derived?** No spec, no test vector, no resolver. *Blocks: tier 5 only; tier 4 can ship without it.*

**P-7 · What is the default C2PA disclosure level?** `hash-only` is the recommended maximum in Phase 3; `full` embeds the ComfyUI graph in a permanently-attached, irreversible artifact. Studio users may consider their graphs their trade secret. *Blocks: shipping tasks 14–15 to real users, not building them.*

**P-8 · Is the current watermark shippable?** It survives JPEG down to ~q70 and fails **every** resize and crop, against a design doc claiming q60, 50% resize and 60% crop. The perceptual claim (42.4 dB) holds exactly. Three options: ship it and correct the claim; fix the sync (a repeated tiling with correlation-based grid search is the standard remedy, and is real work); or hold §9.2 until it is fixed. Correcting `WATERMARK_DESIGN_v1.md §9`/`§10.2` is overdue regardless and should not wait on the choice — presenting the current matrix to a regulator would be the `L2_FLOOR.md` H-5 failure in a new place. *Blocks: external presentation, not tasks 9–12.*

**P-9 · Is watermarking automatic on every published Studio artifact, or opt-in?** EU AI Act Article 50 arguably makes it mandatory for a GenAI provider; §9.5 explicitly contemplates a user choosing watermark-only or neither. These pull in opposite directions and the resolution belongs in the Standard, not in a route handler. *Blocks: the default in task 12.*

**P-10 · Whose baseline is it when Scruple operates the environment?** WO-05 §5.3, unchanged: a baseline Scruple both produces and attests is weaker evidence than one attested against a customer-controlled surface, and §12.2's note on what the customer-compute chain does and does not prove bears directly. **This is a Standard question.** Two sub-questions ride with it: is the container manifest the tamper surface or part of it (custom nodes mounted rather than baked are outside it), and does every Modal rebuild constitute a §4 transition event? *Blocks: task 23.*

**P-11 · Does D-3 (no baseline, no witness) bind the canvas path before Studio has baselines?** Enforced today it refuses every Studio leaf. *Blocks: sequencing of task 23 against the canon surface.*

**P-12 · Is fine-tune-of-a-fine-tune lineage still wanted?** Four `training_runs` columns describe it. *Blocks: scope of task 22.*

**P-13 · Does the L2 floor bind the client side (H-4)?** §6 says security ends at the signing moment and Phase 1 is the integrator's discipline. Reading the floor as client-binding makes the per-session HMAC mandatory rather than a launch-hygiene item. *Blocks: the priority of task 21, not its content.*

**P-14 · Do chain-locked events keep a cheaper evidence path?** The RVN argument genuinely holds for them. A two-tier path is defensible but must be **stated in the Standard** rather than left implicit in an implementation. *Blocks: nothing here; shapes how tasks 4–6 are described externally.*

---

## 6. Open questions, ranked by how much they block

1. **P-1 — the CVM and the vault tier.** Blocks task 6 outright and every claim of production independent verifiability. Everything else routes around it, which is the point of the surrogate — but nothing *closes* without it.
2. **P-4 — the derivative data model.** Blocks tasks 10, 11, 14, 15. The cheapest decision on this list and the most expensive to reverse: it is one conversation now versus a data migration across 13 columns later.
3. **The C2PA trust-list certificate (§4, row 3).** Blocks any externally-valid manifest, has the longest lead time, is owned by nobody in this plan, and is advanced by no task in it. Start it in parallel with task 1.
4. **P-10 / P-11 — baseline ownership and D-3 enforcement.** Blocks task 23, which is Studio's entire §3/§4 story and the reason WO-05 nominated Studio as the first integration to fully meet the Standard.
5. **Task 8's feasibility (UNVERIFIED).** Can a `web_run`-class container enumerate the canvas container's `custom_nodes/`? If not, `ai.scruple.machine` needs a canvas image change and a full re-baseline, and the "toolchain pinning at git-SHA granularity" claim stays aspirational for Studio. **This is the largest estimate risk in the plan** and a one-day spike answers it.
6. **P-5 — the SCR_ID.** Blocks task 19 completely. Three derivations, one lock, and the shipped one cannot round-trip.
7. **P-7 — the C2PA disclosure default.** Blocks shipping tasks 14–15 to users; does not block building them.
8. **P-8 — is the watermark shippable as measured?** Blocks external presentation and any regulator-facing claim. Does not block tasks 9–12.
9. **P-3 — surrogate-signed artifacts in front of customers.** Blocks copy, not code.
10. **P-9 — watermark automatic or opt-in.** Blocks a default.
11. **Attestation survival across stop/start (§4, row 4).** Blocks planning, not building; answered only by the real machine, and it should be answered before anyone commits to "bring it up per batch."
12. **P-13 — does the floor bind the client side?** Reprioritises task 21; changes nothing about it.
13. **P-6 — `pinned_hint`.** Blocks tier 5 only.
14. **P-12 — training lineage.** Scopes task 22.
15. **P-2 and P-14** — both change how this work is *described* rather than what it is. Ranked last because they block no task, which is not the same as unimportant: P-2 could reorder this entire list overnight.

---

## 7. What I could not verify

- **Whether a `web_run` container can reach the canvas container's `custom_nodes/`.** Phase 3 marks it UNVERIFIED; I did not test it either. Task 8's size depends on it.
- **Whether SEV-SNP attestation survives a stop/start.** `L2_FLOOR.md` §5, unchanged. Only the real machine answers.
- **The real OCI KMS RAW-message limit.** Phase 3 §3b cites 4 KB from memory and marks it UNVERIFIED. The measured 1931-byte TBS leaves a wide margin either way, so it does not drive any decision here.
- **Whether the deployed witness would accept a derivative leaf in production.** I verified the *git* copy's `handleWitness` logic (`server.js:545-614`) and read the deployed copy only via `grep -c`. Per §1(a) I believe the derivative leaf works unmodified, but the deployed binary is six weeks stale and I did not exercise it — deliberately, because exercising it means writing to a live audit log.
- **Latency of `signLeaf` under real load.** `leaf_signer.js:75` defaults `TIMEOUT_MS` to 4000 and `vault-py` mode spawns a subprocess per leaf, which `leaf_signer.js:55-58` acknowledges. `ingestIteration` awaits the witness call (`ingest.ts:294`), so this lands directly in `/api/generate` and in the canvas proxy's `/view` handler. Headroom exists (`app/api/generate/route.ts:33` sets `maxDuration = 300`), but for a batch of many outputs the added seconds are real and unmeasured. Worth measuring before enabling `vault-py` on a high-volume path.
- **Whether `modal/canvas_app.py` could surface fingerprints to the proxy at all.** Phase 1 left the cause UNVERIFIED; Phase 3 established that the canvas path never calls `run_workflow`, which explains the absence. Whether a fix is available without an image change remains the task-8 spike.

---

**Nothing in this report was applied.** No file was edited, created, deleted, committed, or pushed; `docs/canon/studio-l2/04-PLAN.md` remains 0 bytes. The production witness at `127.0.0.1:5799` was not contacted. The only network verification performed in this phase was reading local files and inspecting `/opt/scruple-witness/server.js` on disk.
