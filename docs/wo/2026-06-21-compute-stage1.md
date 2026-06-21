# WO 2026-06-21 — Compute Stage 1: Settings → Compute (tier-gated GPU picker)

**Origin:** the canvas/Modal node parity overnight pass (`docs/wo/2026-06-21-canvas-node-parity.md`) surfaced that today GPU selection is a deploy-time `SCRUPLE_MODAL_GPU` env var — no per-user choice, no tier mapping, no UI. User asked "what do we have for users to pick their GPU version?" — answer: nothing. This WO ships the answer.

**Comparison anchor:** ComfyDeploy's "Machine" abstraction (closed-source, but observable). They bundle GPU class + custom-node set + cached models + autoscaling into a "Machine"; users pick machines (not per-request GPU). The Stage-1 below is the ~80% value subset that fits inside Scruple's existing Settings shell without committing to a full Machine-builder.

## Goal

Every Scruple Web user has a transparent **active machine**: a named bundle of GPU class + trust tier + included node set + monthly cost estimate. Free users see one read-only machine. Paid tiers can pick from their allowed list. Receipts cite the machine that produced each iteration. The data flows from Settings → resolver → `/api/generate` → Modal endpoint → iteration row → receipt — single source of truth.

## Non-goals (Stage 1)

- **User-created machines.** Stage 2.
- **Per-workflow override.** Stage 3.
- **Live image rebuild.** Stage 2.
- **Custom-node selection per machine.** Stage 2.

Stage 1 ships a small fixed menu (4 machines), tier-gated, with the plumbing all the way through to provenance.

## The 4 machines (Stage 1 fixed catalog)

| ID | GPU | Trust tier | Allowed plans | Monthly est (8h/day) | Notes |
|---|---|---|---|---|---|
| `t4-free` | NVIDIA T4 (16GB) | L1+L2 | free, starter, pro, enterprise | ~$143 | Default for everyone. Cold-start ~30s. |
| `a10g-pro` | NVIDIA A10G (24GB) | L1+L2 | pro, enterprise | ~$264 | Bigger models, faster sampling, warm pool optional. |
| `a100-premium` | NVIDIA A100 (40GB) | L1+L2 | enterprise | ~$743 | Full-precision FLUX, large LoRAs. |
| `h100cc-enterprise` | NVIDIA H100 with Confidential Computing | **L1+L2+L3** | enterprise | ~$1095 | TEE-attested execution; closes T1/T2 in threat model; receipt carries attestation. |

The plan-list comes from the existing `getEffectiveTiers` resolver (task 3.1). Trust tiers `L1+L2` and `L1+L2+L3` already exist in `lib/compute/backends.ts`.

## Architecture

```
Settings → Compute               UI: read or pick a machine_id
        │
        ▼
user_settings.settings.compute   { machine_id: "a10g-pro" }
        │
        ▼
getActiveMachine(userId)         tier-validates; falls back to tier default if invalid
        │
        ▼
/api/generate                    resolves machine BEFORE dispatching to Modal
        │
        ▼
modalRunner.runWorkflow({ workflowApiJson, machine })
        │
        ▼
lib/compute/modal.ts             picks endpoint URL from MODAL_RUNNER_ENDPOINT_<MACHINE_ID>
                                 OR falls back to MODAL_RUNNER_ENDPOINT (legacy single endpoint)
        │
        ▼
Modal HTTP endpoint per machine  one Modal function per GPU class
        │
        ▼
ingestIteration                  persists machine_id alongside workflow_hash / model_fingerprints
        │
        ▼
Receipt page                     renders machine_id + gpu_class + trust tier
```

**Why per-machine endpoint env vars** (`MODAL_RUNNER_ENDPOINT_T4_FREE`, `..._A10G_PRO`, etc.) rather than passing a GPU param to one endpoint: Modal HTTP endpoints have a fixed GPU class set at function-definition time. To support multi-GPU, the Modal app has to deploy multiple functions, each with its own GPU + its own HTTP endpoint URL. The env vars decouple the deploy from the code.

**Graceful degradation:** if `MODAL_RUNNER_ENDPOINT_A10G_PRO` is unset, the resolver logs a warning and falls back to the existing `MODAL_RUNNER_ENDPOINT`. Code can land without breaking anything; the picker becomes real once the user runs `modal deploy` with the new multi-function `scruple_runner.py`.

## Scope (in detail)

1. **`lib/compute/machines.ts`** — the 4-entry catalog. Pure constants, no DB. Every machine declares: `id`, `name`, `gpuClass`, `trustTier`, `allowedTiers`, `monthlyEstimateCents`, `coldStartSeconds`, `endpointEnvVar`, `description`. The catalog is the source of truth — UI, resolver, receipt, and audit all read from it.
2. **Migration 019** — no new column; the `settings` TEXT blob on `user_settings` already exists. Migration is just documentation of the new JSON path (`settings.compute.machine_id`).
3. **`lib/compute/getActiveMachine.ts`** — `getActiveMachine(userId) → Machine`. Reads user_settings, looks up the configured machine, validates against the user's tier (via `getEffectiveTiers`), and returns the validated machine. On validation failure (tier downgrade) falls back to the tier's default. Pure read.
4. **`app/api/settings/compute/route.ts`** — `GET` returns `{active: Machine, allowed: Machine[]}`. `PATCH` accepts `{machine_id: string}`, tier-validates, writes to user_settings. Returns 403 if the chosen machine isn't in the user's allowed list.
5. **`lib/compute/modal.ts`** — `runWorkflow` now accepts an optional `machine: Machine` (default: legacy single endpoint behavior). Picks `process.env[machine.endpointEnvVar]` if set, else falls back to `MODAL_RUNNER_ENDPOINT`. Logs the choice.
6. **`app/api/generate/route.ts`** — at the top of the handler, after auth, calls `getActiveMachine(userId)` and passes it down to `modalRunner.runWorkflow`. Persists `machine_id` to the iteration row.
7. **Iterations schema** — Migration 019 adds `compute_machine_id TEXT` column to `iterations`. (One column-add migration, idempotent via the same `_migrations` pattern.) The column is NULL on legacy rows; new rows always populate it.
8. **`app/settings/compute/page.tsx`** — server component. Fetches `getActiveMachine` + `getMachineCatalog`. Renders:
   - Free: read-only card + "Upgrade" CTA pointing at `/account/redeem`.
   - Paid: dropdown over `allowedTiers`-filtered catalog. Submits PATCH on change.
9. **Settings nav** — add `Compute` entry between `Storage` and `Model Library`.
10. **Receipt page (`app/receipt/[scrId]/page.tsx`)** — surface `machine_id`, `gpu_class`, and `trust_tier` in the "Hardware" block. If `machine_id` is NULL (legacy row), render "T4 (legacy)" so receipts don't break.
11. **Audit script (`scripts/audit-receipts.py`)** — accept `compute_machine_id` as a new field; no validation rule yet beyond "if present, must match catalog."

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Legacy iteration rows have NULL `compute_machine_id`, breaks receipt rendering | high | Render fallback "T4 (legacy)" string when NULL; covered in #10 above |
| User picks A10G but the new Modal endpoint isn't deployed yet, falls back silently | medium | Log the fallback at WARN level; surface a banner on the Compute settings page when the env var is missing for the currently-active machine |
| Tier downgrade leaves user pointing at a machine they can no longer use | medium | `getActiveMachine` tier-validates on every read; falls back to default. UI reflects the actual resolved machine, not the stored choice |
| Multi-machine Modal deploy increases the user's Modal bill | high | This is a real trade-off, not a bug — Stage 1 doesn't FORCE multi-deploy. User decides when to add endpoints |
| Audit script breaks on the new column | low | Field is additive; missing = NULL; no validator rule depends on it |

## Success criteria

- [ ] `docs/wo/2026-06-21-compute-stage1.md` exists (this file)
- [ ] `lib/compute/machines.ts` exports 4 machine constants and `getMachineCatalog()`
- [ ] `lib/compute/getActiveMachine.ts` exports the resolver with tier-validation
- [ ] Migration 019 applied; `iterations.compute_machine_id` column present
- [ ] `app/api/settings/compute/route.ts` GET + PATCH work; PATCH tier-gates
- [ ] `lib/compute/modal.ts` picks per-machine endpoint with graceful fallback
- [ ] `app/api/generate/route.ts` resolves machine, passes to Modal, persists on iteration
- [ ] `app/settings/compute/page.tsx` renders correctly for free + paid users
- [ ] Settings nav shows "Compute" entry
- [ ] Receipt page renders machine_id + gpu_class + trust tier (with legacy fallback)
- [ ] `tsc --noEmit` clean
- [ ] `next build` clean
- [ ] Commit on `feature/pivot`
- [ ] Modal-side deploy step documented as the post-merge follow-up (not done in this WO)

## Deferred follow-ups for daytime user approval

1. **Update `modal/scruple_runner.py`** to define multiple functions (one per machine), each with its own `gpu=` decorator + image. `modal deploy` registers all 4 HTTP endpoints. Set the resulting URLs in `.env.local`:
   ```
   MODAL_RUNNER_ENDPOINT_T4_FREE=...
   MODAL_RUNNER_ENDPOINT_A10G_PRO=...
   MODAL_RUNNER_ENDPOINT_A100_PREMIUM=...
   MODAL_RUNNER_ENDPOINT_H100CC_ENTERPRISE=...
   ```
2. **H100 with Confidential Computing** is a real product spend. Skip the H100CC endpoint until you have a paying enterprise customer who needs L3 trust attestation.
3. **`min_containers` per machine** to mitigate cold start on paid tiers. Trade-off: continuous burn. Default to 0 in Stage 1; revisit when usage data exists.
