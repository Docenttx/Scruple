# Runtime integrity work orders — WO-40…WO-53

_2026-09-03. Source: eight council reviews of the generation runtime
(`review-eval/ground-truth/`, ten files, Modal → witness), plus the host survey
that produced `SERVER_ARCHITECTURE.md`._

## Status of the evidence, stated first

**Four findings I verified myself against the live code.** They are marked
**VERIFIED**. Everything else is marked **LEAD** — reported by a council,
plausible on inspection, and *not yet confirmed by running anything*. A lead is
a hypothesis with a file and line number, not a defect.

The estate's own rule applies to this document: **verify by side effect, not by
report.** No WO below is closed by reading the code and agreeing with it.

A second review round with tighter prompting is in flight; expect this list to
gain items and lose some.

## The pattern underneath almost all of it

One sentence, because it is the same defect fourteen times:

> **A measurement fails, the failure is caught, the run continues, and the leaf
> records a weaker claim while the caller is told `ok`.**

WO-27 already settled this for `input_hash` — *bind it, or decline; never
assert an empty set.* That rule was written once and applied in one place. Most
of what follows is the same rule applied where it was not.

This matters against the L2 floor specifically. H-5 — two-tier assurance,
implemented — says a record **declares what actually backed it**. A leaf that
substitutes a database descriptor for a container measurement, or an empty
fingerprint set for a failed read, is a record that does not.

---

## Group A — the append-only log. Nothing here may corrupt evidence.

### WO-40 · `run_sequence` is allocated outside the transaction — **VERIFIED**

`lib/iterations/ingest.ts:400`. `SELECT COALESCE(MAX(run_sequence),0)+1` with no
lock, and the comment says the risk is handled: *"a uniqueness violation would
surface as an INSERT failure below."* It would — but the witness call is line
444 and the transaction is line 485. The `UNIQUE(project_id, run_sequence)`
constraint fires **after the leaf is already signed and on the witness**.

Two concurrent runs in one project therefore leave an **orphan leaf on an
append-only log**: a signed record whose `run_sequence` no row holds, duplicating
a sequence number, and unretractable by construction.

**Green means:** two ingests racing on one project produce either two correct
sequential leaves or one leaf and one clean refusal — never a witnessed leaf
with no row. Proved with a concurrency harness, not by reading.

**Watch for:** the fix must reserve the sequence *before* the witness call, or
move the witness call inside the claim. Do not simply wrap the existing order in
a transaction — the witness call is remote and must not hold a write lock.

### WO-41 · `pollRunJob` is not idempotent — **LEAD**

`lib/runs/execute.ts:241`. Read-then-act with no atomic claim: two overlapping
polls can both see `running`, both fetch the finished Modal result, and both
ingest — two rows, two sequence numbers, two leaves, one GPU execution.

**Green means:** N concurrent polls of one finished job produce exactly one
iteration. **Watch for:** a stale `ingesting` lease must be reclaimable, or a
crashed ingest wedges the job forever.

---

## Group B — measurement honesty. Generalise WO-27's rule.

### WO-42 · A failed measurement must decline, not substitute — **VERIFIED (partly)**

Two sites, one rule.

- **Container manifest.** Fixed this morning for the *missing import* case
  (`97af9e4`, `0a9e9b0`), and the fix is incomplete: the `except` still turns a
  measurement failure into `None`, and ingest still walks its ladder down to the
  database descriptor's *claim* about the machine. A run whose measurement threw
  is indistinguishable from one whose machine was described.
- **Model fingerprints.** `scruple_runner.py:328` drops individual unreadable
  files silently; the outer handler at :451 collapses everything to `{}`. Ingest
  then sets `model_fingerprints_hash = null`, recording **"no models were
  loaded"** for a run that loaded models it could not read.

**Green means:** a distinct, recorded state for *measurement failed* that no
leaf can present as *measured*, at both sites. `container_machine_manifest_error`
and `model_fingerprints_error` sentinels, with ingest refusing to substitute.

**Watch for:** the honest states are three, not two — measured, genuinely empty,
and could-not-determine. Collapsing the last two is the original defect.

### WO-43 · Callers cannot see a degraded run — **LEAD**

`lib/runs/execute.ts:105` and `:305`. `ExecuteRunResult` and `RunJobStatus` drop
`witnessed`, `leafScheme`, `seal` and `storagePointer`, so a run that fell back
to `leafScheme v1`, `witnessed: false`, `seal.state: 'unchecked'` and no cloud
storage returns `ok: true` and looks identical to one that did everything.

**Green means:** those four fields reach the caller and the CLI prints them —
the same fix as this morning's `reportProvenance`, extended. **Keep `ok: true`**:
the run did happen. What changes is that its qualifications are visible.

---

## Group C — reproducibility. An outsider must recompute and agree.

### WO-44 · `input_hash` is hashed with raw `JSON.stringify` — **LEAD, high value**

`lib/leaf/hashes.ts:76`. `hashRunInputs` serialises the whole `spec` — which
contains `workflowApiJson` — uncanonicalized. V8 orders integer-like keys
ascending while Python preserves insertion order, and Python escapes non-ASCII
by default while V8 emits UTF-8. A verifier re-hashing the stored graph in the
other language gets a different answer, **which is indistinguishable from
tampering** — the exact failure `CANONICALIZATION.md` exists to prevent, in a
formula that document explicitly left alone.

**Green means:** either the preimage is canonicalized under `jcs-1`, or the exact
bytes hashed are persisted so a verifier re-hashes them rather than
re-serialising. Cross-language vectors, both languages, in the vector file.

**Watch for:** changing the formula changes every existing `input_hash`. This is
a **scheme bump** and needs a `canonicalization_profile` entry — migration 049
already gives rows somewhere to say which rule made them.

### WO-45 · Output selection depends on node completion order — **LEAD**

`scruple_runner.py:624` iterates `outputs.values()` in ComfyUI's insertion
order, which reflects *which node finished first*. A graph with a `SaveImage`
and a `PreviewImage` can bind a different artifact on two identical runs.

**Green means:** sort by node id, with a stated tie-break (terminal save over
preview; video container over `.gif`). Two runs of one graph select the same file.

### WO-46 · The manifest digest folds a transient error string — **VERIFIED**

`container_manifest.py:84`. The comment says folding the error in *"keeps the
hash deterministic."* It does the opposite: a momentarily unreadable file makes
an unchanged container measure differently, and the entry also omits the size
column. **Collect unreadable paths into an `unreadable` list and mark the
manifest incomplete** — do not put them in the preimage.

### WO-47 · Input binding compares bare filenames — **LEAD**

`ingest.ts:251` matches on `basenameOf`, so `dataset_a/frame.png` satisfies a
reference to `dataset_b/frame.png` and the leaf makes an affirmative claim over
bytes the graph never read. Compounded by `scruple_runner.py:530`: the input
directory is never cleared, so a warm container can serve a previous run's file.

**Green means:** full normalised relative-path comparison, duplicate
destinations refused before dispatch, and per-run input isolation. **Watch for:**
this is a decline case — an unresolvable reference must decline `input_hash`,
which is WO-27's machinery already present.

---

## Group D — do not lose paid work; do not mint weak leaves.

### WO-48 · A transient 502 becomes a permanent failure — **LEAD**

`lib/compute/modal.ts:182`. Any non-ok status from the poll endpoint returns
`failed`, and `pollRunJob` writes that to the row. A finished GPU run with a
real artifact is abandoned because the *status channel* hiccuped.

**Green means:** a non-terminal `unknown` state that leaves the row alone.

### WO-49 · Workflow recovery failure mints a weakened leaf — **LEAD**

`execute.ts:285`. A parse failure on `generation_jobs.run_workflow` falls back to
`null`, which makes `referencedInputs` empty, bypasses the decline branch, and
signs an affirmative *"no inputs"* claim with `workflow_hash` null. **Fail the
job.** A corrupt row must not produce a leaf.

---

## Group E — decisions, not patches.

### WO-50 · `mtime` is inside `model_fingerprints_hash` — **VERIFIED, deferred**

`scruple_runner.py:312` puts `st.st_mtime` in the dict; `hashes.ts:121` hashes it
verbatim. Identical model bytes with a different mtime give a different hash, so
one of the five headline hashes **cannot be recomputed by anyone outside this
box**. `hashes.ts:49` already notes mtime — but frames it as float *formatting*,
deferred as a scheme bump. **Re-record it under reproducibility**, which is the
larger claim, and fold it into the same bump as WO-44.

### WO-51 · Staged inputs — **custody decision before code**

Storing resolved input bytes durably at spawn (so a poll re-resolves nothing) is
right for provenance and is **a custody change**: `CUSTODY_LOCUS.md` makes where
files rest at rest the thing that decides the threat model. Route through the
custody argument, not straight to an implementation.

### WO-52 · The optimizations — **gated on WO-41**

Four, all one waste: multi-gigabyte artifacts base64'd and held whole in memory
on both sides, transferred once per *poll* rather than once per run. Fixing
WO-41 removes most of it for free. A streaming/tee variant must preserve
as-delivered fidelity — we hash the bytes we deliver.

**Two proposed optimizations were correctly refused** and should stay refused:
a checkpoint-hash sidecar (volume integrity), and computing the container
manifest at **build time** — which would replace a runtime measurement with a
build-time declaration, the `content` versus `declared` distinction the seal
manifest is built on.

---

## Group F — host hygiene, from `SERVER_ARCHITECTURE.md`

### WO-53 · Four items, all small

1. **`/opt/scruple-witness/arweave-key.json` is world-readable (0644)** while
   every other secret on the box is 0600. Fix first; it is one `chmod`.
2. **`/data` is at 93%** (11G free). Artifacts are content-addressed and
   gitignored; agree a retention or move policy before it bites during a run.
3. **`ravend-mainnet.service` is enabled and crash-looping past 61,000
   restarts** ("restart with -reindex"). Testnet — the live anchor target — is
   healthy. Either repair mainnet or disable it, but it must not sit enabled and
   broken where something could assume it is available.
4. **nginx carries a dead `canvas.scruple.ai` vhost** — no DNS record, and two
   routes proxy to `127.0.0.1:3000` where nothing listens. Superseded by the
   Cloudflare tunnel. Delete it rather than leave configuration that describes a
   topology we do not have.

Not in this WO, but the largest single fragility on the box and already recorded:
**`scruple.stooges.ai` is an unsupervised `next dev` process**, absent from both
systemd and pm2.
