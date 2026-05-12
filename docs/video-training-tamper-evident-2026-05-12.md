# Proposal — txt2video, img2video, training, and tamper-evident BYOS

_Authored 2026-05-12 morning. Companion to PIVOT_WORK_ORDERS.md._

## TL;DR

| Capability | Effort | Storage destination | Tamper-evidence story |
|---|---|---|---|
| txt2video | ~2 days | Same BYOS (Drive/OneDrive/GitHub) | Same as image — content hash + Merkle chain |
| img2video | ~1 day on top of txt2video | Same BYOS | Same; the source image hash gets chained as a parent |
| Lora training | ~3-5 days | BYOS (Loras land in user's Drive AND user's Modal Volume namespace) | Training dataset hash + base model hash + config hash → output Lora hash |
| **Tamper-evident audit sweep** | ~1-2 days | (verifies existing storage) | Periodic re-fetch + re-hash + diff vs. ledger |

All four are additive to the architecture we already have. No structural rewrite.

---

## 1. txt2video

### Models in scope

| Model | License | VRAM (FP16) | Recommended GPU | Per-clip time (5s @ 720p) |
|---|---|---|---|---|
| **HunyuanVideo** | Open (custom) | 80 GB | H100 80GB | 4-8 min |
| **LTX-Video** | Open (Apache 2.0) | 24 GB | A100 40GB / H100 | 30-90 s |
| **Mochi-1** | Apache 2.0 | 60 GB (with tricks) | H100 80GB | 3-5 min |
| **Wan2.1** | Open | 32 GB | A100 80GB / H100 | 1-3 min |
| **AnimateDiff** (SD 1.5-based) | Open | 12 GB | A10G / A100 | 30-60 s for 16-frame clip |

**Recommended initial catalog**: LTX-Video (fast + open + 24 GB fits A100). Plus AnimateDiff for SD 1.5 users who want quick animations on smaller GPUs.

### Workflow integration

ComfyUI already supports all of these via their respective custom nodes (ComfyUI-LTX-Video, ComfyUI-AnimateDiff, etc.). Adding to the Scruple catalog is the same flow as image models:

1. Add the model file to the `scruple-models` Modal Volume via `fetch_to_volume`
2. Add the required custom node repo to the Modal image build (`run_commands("git clone <node-repo> /opt/ComfyUI/custom_nodes/<name>")`)
3. Stub-sync to canvas → dropdowns populate
4. User builds a video workflow → hits Queue → same scruple-web pipeline forwards to Modal → returns video bytes

### Output handling

Video bytes are heavier than images. A 5-second 720p clip is typically 3-20 MB (mp4) or 80-200 MB (PNG-sequence intermediate). The pipeline:

1. Modal function returns video bytes via the same `image_bytes_b64` field (we'd rename internally to `content_bytes_b64`; field works regardless)
2. `ingestIteration` hashes the bytes (same SHA-256 leaf)
3. Storage provider uploads to user's BYOS — `Scruple Projects/<project>/iterations/<hash>.mp4`
4. Iteration row gets `metadata.contentType = 'video/mp4'`
5. Iteration grid displays a `<video>` element instead of `<img>` (already trivially conditional on the contentType)

### Provenance Terminal additions

New row categories for video workflows:
- `Frames` — total frame count
- `FPS` — frame rate
- `Duration` — clip length
- `Motion model` — which video model node was used
- `Init image` (for img2video) — hash + filename of the source

The extractor (`lib/provenance/extract.ts`) gets a couple more `class_type` cases. ~30 lines.

### Cost shape

LTX-Video on A100 40GB at our pricing:
- Per generation: ~$0.04 (compute only)
- Plus storage: ~$0.0001 per clip-month
- Subscription pricing: same model as image — Free tier = cold-start every generation; Pro = warm cache; Premium = TEE H100

---

## 2. img2video

Extension of txt2video. The workflow differs only in the input — instead of a pure prompt, it takes a still image (typically rendered earlier by the SAME chain) plus an optional motion prompt.

### Architecture

Two clean variants:

**A. Sibling iteration** — img2video output is its own iteration, with the source image's hash recorded as `parent_iteration_id` (new schema field) or as a node in the workflow_api_json.

**B. Chain-continuation** — img2video output is the next iteration in the same chain (run_sequence + 1), with the input image being the previous iteration's output. Merkle root incorporates both.

Variant **B** is cleaner provenance-wise — it preserves "this video was animated from THIS specific earlier image in this project's chain." That's exactly the kind of derivation story Scruple's chain model is designed for.

### Schema changes

```sql
-- migration 010_iteration_lineage.sql
ALTER TABLE iterations ADD COLUMN source_iteration_id INTEGER;  -- the still that became this video
ALTER TABLE iterations ADD COLUMN content_type TEXT;            -- 'image/png' | 'video/mp4' | ...
CREATE INDEX idx_iterations_source ON iterations(source_iteration_id);
```

The workflow JSON's image-input node references the source iteration's leaf_hash (already deterministic). We resolve that at ingest time → set source_iteration_id.

### UX

In the canvas, the user wires a `LoadImage` node pointed at the source iteration. The Scruple JS extension on Queue intercepts the workflow, sees the LoadImage references a Scruple-known iteration hash, and pre-fetches the image from BYOS into Modal's container so the workflow runs.

Time impact: one extra ~5-10s download from user's storage to Modal at Queue time. Acceptable.

---

## 3. Lora training

The most patent-interesting one. Training has a richer provenance story than generation:

- **Inputs**: training dataset (multiple images + captions), base model, training config (learning rate, steps, etc.), trigger words
- **Output**: a Lora .safetensors file
- **Chain**: every input is hashed and recorded. The output Lora has a deterministic ancestor chain.

### Models / frameworks in scope

| Framework | License | What it trains | VRAM | Per-Lora time |
|---|---|---|---|---|
| **ai-toolkit** | MIT | Flux, SDXL, SD 1.5 Loras | 24 GB (Flux) | 30 min — 4 hr |
| **kohya_ss** | Apache 2.0 | SDXL, SD 1.5 Loras (most popular) | 16-24 GB | 1-3 hr |
| **OneTrainer** | AGPL | Same | 16-24 GB | 1-3 hr |

**Recommended**: ai-toolkit for Flux Loras (modern, fast), kohya_ss for SDXL (industry standard). Both wrap cleanly as Modal functions.

### Architecture

Training is fundamentally a long-running job (30 min — 4 hr), not a request/response. The pipeline:

```
[ User uploads dataset to Scruple Projects/<proj>/training-dataset/ ]
  via Drive picker or direct upload — bytes land in user's BYOS
                ↓
[ User configures training in Scruple UI: base model, trigger word, steps, etc. ]
  config JSON + dataset folder pointer
                ↓
[ scruple-web spawns Modal training function (async) ]
  POST /api/training/start → modal training function .spawn()
  training run row inserted with status='running'
                ↓
[ Modal function pulls dataset from user's BYOS → trains → uploads Lora ]
  Output destinations:
    1. User's BYOS (Scruple Projects/<proj>/loras/<lora-name>.safetensors)
    2. Modal Volume user namespace (models/loras/user-<id>/<lora-name>.safetensors)
       so the Lora is immediately usable in subsequent canvas generations
                ↓
[ scruple-web webhook from Modal: training complete ]
  training row status='complete', records output Lora hash
                ↓
[ Sidebar Provenance Terminal shows "Lora ready: <name>" ]
[ Stub-sync picks it up; user's canvas dropdown lists the new Lora ]
```

### Schema additions

Already in our migration set (training_runs + training_checkpoints from migration 001). We'd need a few more columns for the training-specific metadata:

```sql
-- migration 011_training.sql
ALTER TABLE training_runs ADD COLUMN base_model_hash TEXT;
ALTER TABLE training_runs ADD COLUMN dataset_merkle_root TEXT;  -- merkle over the dataset images
ALTER TABLE training_runs ADD COLUMN config_hash TEXT;          -- hash of the training config JSON
ALTER TABLE training_runs ADD COLUMN output_lora_hash TEXT;     -- hash of the produced Lora file
ALTER TABLE training_runs ADD COLUMN output_storage_pointer TEXT; -- where the Lora lives in BYOS
```

### Patent angle

Training provenance is where Scruple becomes uniquely defensible:

- "This Lora was trained on dataset whose Merkle root is X, using base model whose hash is Y, with config whose hash is Z. The resulting Lora bytes have hash W. All four facts witnessed and chained."
- Any image produced using this Lora can be traced back through: image → workflow JSON (references Lora by hash) → Lora hash W → trained from {X, Y, Z}.
- This is forensic provenance for AI-generated content at a level no competitor offers.

### Cost

Training on A100 40GB: $2.20/hr × 1-3 hr = $2.20 — $6.60 per Lora. Pass-through pricing makes sense; flat $10-15 per training run gives Scruple margin.

---

## 4. Tamper-evident BYOS — the audit story

### What we already have

Today's BYOS records on every iteration:
- `leaf_hash` — SHA-256 of the output bytes (canonical fingerprint)
- `storage_pointer` — JSON `{provider, fileId, path, url?}` — where the bytes live
- Witness server signs the leaf_hash + timestamp at chain-lock time

**Tamper after the fact** = user (or an attacker) modifies the file in their Drive after the iteration was witnessed. Today we can detect this if anyone re-runs the hash and compares to the witnessed value, but we don't proactively check.

### What's missing for proactive tamper-evidence

Three layers, in order of strength:

#### Layer 1 — On-demand verification (we already have this)

`POST /api/verify` with a manifest already re-fetches and re-hashes. Anyone with the receipt can press "Verify" and we re-pull from BYOS → re-hash → compare. Catches tampering instantly when verification is requested.

**Gap**: it requires someone to ask. Files could be modified for months without detection.

#### Layer 2 — Periodic audit sweep (~1-2 days to build)

A cron job (Modal function or scruple-web background task) that walks every iteration with a storage_pointer, re-fetches the bytes, re-hashes, compares to the recorded leaf_hash. Any mismatch becomes a tamper event:

```sql
-- migration 012_tamper_audit.sql
CREATE TABLE tamper_audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id    INTEGER NOT NULL,
  user_id         TEXT NOT NULL,
  audited_at      TEXT NOT NULL,
  expected_hash   TEXT NOT NULL,
  observed_hash   TEXT NOT NULL,
  storage_pointer TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'mismatch', 'missing', 'unreachable')),
  detail          TEXT,
  FOREIGN KEY (iteration_id) REFERENCES iterations(id)
);
CREATE INDEX idx_tamper_audit_status ON tamper_audit_log(status, audited_at);
CREATE INDEX idx_tamper_audit_iter ON tamper_audit_log(iteration_id);
```

A nightly job:
1. Pick N iterations to audit (e.g., 100 per night, oldest-audited first)
2. For each: read storage_pointer → fetch bytes via the user's provider → SHA-256 → compare
3. Row → audit log
4. On mismatch: status='mismatch', detail = old vs new hash. Notify user via email + dashboard banner.

UI: A "Tamper Audit" tab in /settings or a banner on the Receipt page:

```
✓ Verified 2026-05-09 03:14 — hash matches
⚠ Last verified 2026-04-01 — file modified externally
✕ File no longer found in storage
```

Cost: trivial. ~$1/month of bandwidth at small scale.

#### Layer 3 — Continuous signature (~2-3 days to build, premium tier)

For high-stakes content, the witness server signs a **"file-still-here" attestation** at intervals: "as of 2026-05-12T08:00Z, hash X was confirmed at storage location Y." This becomes a chain of timestamps, anchorable to RVN/Arweave like a regular chain lock. Premium users get continuous attestation; tamper attempts get caught within the attestation interval.

### Observation surface

What the user actually SEES:

1. **Per-iteration verification status** on the Receipt page:
   - ✓ green — last audit confirmed match
   - ⚠ amber — audit pending (no fresh check in 30+ days)
   - ✕ red — last audit detected mismatch
2. **Aggregate sidebar pill**: "Audit ●" — like the Witness/RVN/Stripe pills, but reflects the latest audit pass for this user's content
3. **Tamper notifications**: email + in-app banner when a mismatch is detected
4. **Manual verify button** on every iteration (uses Layer 1)

### Architecture for the audit job

Three plausible homes:

**A. Modal scheduled function** — `@app.function(schedule=modal.Period(hours=24))`. Runs in Modal, pulls iteration rows from scruple-web via API, fetches from user's storage (using the user's tokens proxied through scruple-web), reports back.

**B. Oracle box cron** — node script run hourly that picks the next batch of iterations to audit. Lives next to scruple-web.

**C. Witness server cron** — keeps audit logic close to the chain logic that signed the hash originally.

**Recommendation: B (Oracle box cron)** for simplicity. It already has access to the scruple-web DB and the user's encrypted storage tokens. Modal is overkill for periodic light work.

---

## 5. Sequence of work

If we wanted to ship all four:

| Pass | What | Effort | Unlocks |
|---|---|---|---|
| **video-1** | LTX-Video model in catalog + ComfyUI-LTX node in image + video MIME handling in storage layer | ~1 day | First txt2video end-to-end |
| **video-2** | img2video lineage (source_iteration_id) + the LoadImage Scruple intercept | ~0.5 day | img2video with chain |
| **train-1** | Migrations 011 + training_runs UI section + Modal training function (ai-toolkit) + dataset upload via Drive | ~2 days | First Lora training end-to-end |
| **train-2** | Output Lora lands in user's BYOS + user Modal Volume namespace + stub-sync picks it up | ~0.5 day | Train-then-use loop closed |
| **train-3** | Training receipt page + provenance chain over {dataset, base, config, output} | ~0.5 day | Patent-worthy training receipt |
| **audit-1** | Migration 012 + nightly audit cron + tamper audit log table | ~1 day | Layer 2 tamper evidence |
| **audit-2** | Receipt page status badges + Settings audit tab + email notifications | ~0.5 day | Visible observation surface |
| **audit-3** (premium) | Continuous attestation (Layer 3) — witness server signs periodic confirmations | ~2 days | Continuous tamper evidence |

Total for all of it: ~8 working days. The most valuable ROI by ratio is **audit-1+2** — minor effort, huge trust upgrade, central to the patent story.

---

## Recommended sequence

1. **Land Pass 1A + 1B** (today's work — model catalog + canvas stub-sync) — already in flight
2. **audit-1 + audit-2** (1.5 days) — gives BYOS its proper trust posture before any of the video/training work piles on
3. **video-1** (1 day) — visible product expansion
4. **train-1 + train-2 + train-3** (3 days) — patent-anchoring training story
5. **video-2 + audit-3** (1.5 days) — polish

That's ~2 weeks for a public-ready v2 with all four capabilities. Each pass is shippable in isolation.
