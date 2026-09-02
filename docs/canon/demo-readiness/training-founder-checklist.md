# The first captured training receipt — the founder-gated remainder

_WO-30, 2026-09-02. Everything in this file costs money or needs a browser;
everything that did not is already done and is proven by
`test/v2/training-receipt.test.ts`._

**Read `training.md` first.** This is its §5 "shortest credible path", reduced
to the steps that could not be taken without spend, with the two the survey got
wrong marked as such.

---

## 0. What is already true, so nobody redoes it

| Survey step | State |
|---|---|
| 3. Give the job API a caller | **DONE.** `app/apps/kohya/JobSubmitPanel.tsx` renders when `SCRUPLE_KOHYA_SURFACE=job-api`; the form is generated from `PARAMETER_WHITELIST`, so it has no control that can carry a command. It POSTs `/api/apps/kohya/jobs`, which now also **forwards** the canonical spec to the pod's `:8899/jobs` and reports whether that landed. |
| The leaf itself | **DONE and proven without a GPU.** `test/v2/training-receipt.test.ts` produces a stored leaf with `witnessed = 1`, `leaf_kind = 'training'`, and `input_hash` + `workflow_hash` + `model_fingerprints_hash` + `content_hash` all populated, against a stub witness. |
| 1. Build `Dockerfile.jobapi` | **NOT DONE — and the file was broken.** See step 1 below. |
| 2. `SCRUPLE_KOHYA_SURFACE=job-api` | Not done. One line, and it must come *after* step 1. |
| 4. Run one small job | Not done. This is the only step that spends. |
| 5. `header_hash` | Deliberately not done. Leaf-scheme bump; gates nothing. |

---

## 1. Build the image — **the Dockerfile was missing three copies, now fixed**

The survey called this "cheap". It was cheap and it was also **wrong as
written**: `Dockerfile.jobapi` copied `services/scruple-capture`,
`lib/apps/kohya` and `lib/capture`, and the entrypoint's transitive imports also
reach `lib/leaf/hashes.ts`, `lib/leaf/canonicalJson.ts`, `lib/scruple/hash.ts`
and `lib/ratchet/ratchet.ts`. `node --import tsx` would have died on the first
import — before the port bound, before a placement resolved. Nothing had ever
noticed because nothing had ever built it.

WO-30 added the three `COPY` lines and a guard
(`test/v2/training-receipt.test.ts` → "Dockerfile.jobapi copies every tree the
entrypoint imports") that walks the import closure and fails if the set falls
behind again. **Verified by must-fire control**: deleting the three lines makes
the test fail with the file list.

```bash
# FROM THE REPOSITORY ROOT — the component is TypeScript run through tsx and
# imports lib/, so the build context is the repo, not the research directory.
cd /data/scruple-web
docker build -f research/scruple-kohya-image/Dockerfile.jobapi \
             -t <registry>/scruple-kohya-jobapi:latest .
docker push <registry>/scruple-kohya-jobapi:latest
```

Two things the build itself checks, so read its output rather than assuming:

- the `RUN for f in /start.sh …` line **fails the build** if the RunPod base
  image still ships an init. That is deliberate (`placement.ts` obligation 5:
  the component must be PID 1). If it fires, remove the base's launcher
  deliberately and record why — do not delete the check.
- `npm ci` installs devDependencies on purpose; `tsx` is one, and the component
  is run through it.

Then confirm what a *running* container actually exposes — this is enforcement
obligation 1, `needs_probe` today purely because nothing has ever run:

```bash
docker run --rm -p 8899:8899 \
  -e SCRUPLE_API_URL=... -e SCRUPLE_API_KEY=... \
  -e SCRUPLE_CAPTURE_PROVISIONING_TOKEN=... \
  <registry>/scruple-kohya-jobapi:latest
# in another shell:
curl -s localhost:8899/health | jq       # placement, findings, needs_probe
curl -s localhost:8899/                  # must be 404
curl -s localhost:7860/                  # must be refused — there is no GUI
docker exec <id> ps -o pid,comm          # PID 1 must be node, not bash
```

## 2. Register the RunPod template

- Image: the tag from step 1
- **Expose HTTP: `8899`. Not 7860.** An image whose component listens on 8899
  reached through a pod exposing 7860 is a broken deployment; the reverse is a
  worse one.
- Volume mount `/workspace`
- Env: `SCRUPLE_USER_ID`, `SCRUPLE_APP_ID`, `SCRUPLE_SESSION_ID`,
  `SCRUPLE_SESSION_TOKEN`, `SCRUPLE_WITNESS_URL`, `SCRUPLE_PLACEMENT`,
  `SCRUPLE_CAN_WITNESS`, `SCRUPLE_API_URL`, `SCRUPLE_API_KEY`,
  `SCRUPLE_CAPTURE_PROVISIONING_TOKEN`, `SCRUPLE_CAPTURE_BASELINE_REF`, and the
  four `SCRUPLE_KOHYA_*_ROOT` paths (defaulted in the image).

Save the template id:

```bash
echo 'RUNPOD_KOHYA_JOBAPI_TEMPLATE_ID=<id>' >> .env.local
```

**`SCRUPLE_CAPTURE_BASELINE_REF` is not optional.** `/v2/witness` refuses a leaf
with no baseline (D-3): "an event from unbaselined code is not
Scruple-witnessed." Establish one with `POST /api/v2/baseline` and put its
64-hex `tamper_surface_hash` here, or the run produces a checkpoint, a queued
submission, and no leaf.

## 3. Flip the surface

```bash
echo 'SCRUPLE_KOHYA_SURFACE=job-api' >> .env.local
```

No code change. The spawn **fails rather than downgrading** if step 2 was
skipped — that refusal is the point, not a bug.

## 4. Run one job — the only step that spends (~$0.05)

Upload a five-image dataset through Studio's upload path so it has a
`dataset_id`, then open `/apps/kohya`. In `job-api` mode the page renders the
job form instead of Gradio. Suggested first job — 5 images, 100 steps, rank 4,
one 4090-minute:

```
dataset_id       <from the upload path>
base_model_id    sdxl-base-1.0
training_type    lora
output_name      first-captured-lora
network_dim      4
network_alpha    4
learning_rate    0.0001
optimizer        adamw8bit
lr_scheduler     cosine
max_train_epochs 1
train_batch_size 1
mixed_precision  bf16
resolution       1024,1024
```

**What to check afterwards, in this order** — verify by side effect, not by the
receipt the form drew:

```sql
-- the leaf, on the /v2 surface
SELECT witnessed, leaf_kind, output_kind, leaf_scheme,
       input_hash, workflow_hash, model_fingerprints_hash, component_verified
  FROM iterations
 WHERE output_kind = 'checkpoint'
 ORDER BY id DESC LIMIT 1;
-- witnessed must be 1. leaf_kind 'training'. All three hashes non-NULL.
-- component_verified 1 — the ratchet MAC verified.

-- the run, on the job-API surface
SELECT status, started_at, source, params_hash FROM training_runs
 ORDER BY id DESC LIMIT 1;
-- status 'running' means the pod's component ACCEPTED it, not that we hoped so.
-- source must be 'kohya_ss'. Until this run, there has never been such a row.
```

If `input_hash` is NULL, the dataset directory was not where the component
looked — check the runner's log line, which says so explicitly rather than
silently committing nothing. The leaf is still issued; that is deliberate.

## 5. Then, and only then, decide `header_hash`

One registry entry, one Zod field, one column, three `component_preimage`
implementations plus the shared vector file. **It should not gate steps 1–4**: a
leaf carrying dataset, recipe and base-model commitments is already far stronger
than anything the estate has, and `header_hash` rides uncovered on
`capture.header_hash` meanwhile from both components.

---

## Two things in the survey's shortest path that turned out to be wrong

1. **"Build the image … cheap."** The image could not have started — three
   missing `COPY` trees, §1 above. Cheap once found; it was never going to be
   found by reading the Dockerfile, only by walking the imports.
2. **"`training_recipe()` + `hash_training_recipe()` handle the float
   problem."** Superseded. WO-21 put both languages on RFC 8785, whose
   §3.2.2.3 mandates ECMA-262 `Number::toString`; quoting floats via Python
   `repr` now *reintroduces* the divergence inside the string. The Kohya
   component commits its recipe raw and `test/v2/training-receipt.test.ts` pins
   that.

## One thing outside this WO that still bites the demo

`training.md` §6 item 1 stands untouched: the July bundle's `README.md` and the
MCC filing hand a reviewer the **base model's** SHA-256 as the trained
artifact's, so following our own verification instructions produces a mismatch.
That is a prose fix on an artifact already outside the building, and it ranks
above everything here.
