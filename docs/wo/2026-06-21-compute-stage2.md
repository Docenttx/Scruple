# WO 2026-06-21 — Compute Stage 2: User-created machines (Premium tier)

**Predecessor:** `docs/wo/2026-06-21-compute-stage1.md` ships the tier-gated fixed-catalog picker. Stage 2 adds the ability for Premium tier users to **create their own machines** — pick GPU, declare a custom node set, declare custom models, set scaling parameters. That's the ComfyDeploy "Machines page" feature, scoped to power users.

Do not start Stage 2 until Stage 1 is live and you have real signal that paying users want this. ComfyDeploy's UI is rich because *production users* need it; if Scruple's paying users are content with the 4-machine catalog, Stage 2 may never be necessary.

## Goal

A Premium-tier user can:
1. Open Settings → Compute → "+ Create Machine"
2. Pick GPU class (T4 / A10G / A100 / H100 / H100-CC)
3. Pick base ComfyUI image (track Stage-1 catalog as starting points)
4. Add custom nodes by URL or by search (from ComfyUI-Manager's `extension-node-map.json`)
5. Add custom models (HF or Civitai URL, or upload via gdrive sync)
6. Set `min_containers` / `max_concurrent` / `scaledown_window`
7. Name + save
8. Submit → Modal image builds + deploys behind the scenes (async; polling)
9. Once ready, the machine appears in their picker and they can route workflows to it

The provenance receipt now carries the machine's `image_digest` (sha256 of the built Modal image), so a third-party can verify which exact node + model set produced an output.

## Architecture additions to Stage 1

```
machines (new DB table)
   id TEXT PK                "machine_<nanoid>"
   owner_user_id TEXT FK     NULL for catalog (Stage 1) machines
   name TEXT                 user-given
   gpu_class TEXT            T4 | A10G | A100 | H100 | H100-CC
   trust_tier TEXT           L1+L2 | L1+L2+L3 (only H100-CC qualifies)
   custom_nodes JSON         [{ url, ref, commit_sha }]
   models JSON               [{ source, url, dest_path, sha256 }]
   min_containers INT
   max_concurrent INT
   scaledown_window INT
   modal_endpoint_url TEXT   populated when deploy completes
   image_digest TEXT         sha256(modal_image_id) — for receipt provenance
   build_status TEXT         pending | building | ready | failed
   build_log TEXT            tail of last build
   build_started_at TIMESTAMP
   build_completed_at TIMESTAMP
   created_at TIMESTAMP
```

```
Stage-1 fixed catalog moves out of lib/compute/machines.ts
   and into 4 rows in the machines table with owner_user_id=NULL.
   Resolver semantics change:
     getActiveMachine(userId) → machine row by id from settings
     getMachineCatalog(userId) → fixed-catalog rows UNION the user's owned rows
```

## Scope (in detail)

1. **DB migration 020** — `machines` table.
2. **Seed migration** — backfill the 4 Stage-1 catalog entries into `machines` with `owner_user_id=NULL`.
3. **`lib/compute/machineBuilder.ts`** — given a machine config, generates a `modal_image` definition (Python source string), uploads via Modal's image build API, returns the resulting image digest + endpoint URL. Background-job pattern; persists progress to `build_status`.
4. **Build worker** — long-running cron/queue worker that polls for `build_status=pending` machines and processes them one at a time. Modal build can take 5-15 minutes; the worker handles polling Modal's build status and updating the row.
5. **`app/api/settings/compute/machines/route.ts`** — `GET` lists user's owned machines + catalog. `POST` creates a new pending machine. `DELETE` archives an owned machine (sets `deleted_at` — never hard-delete because receipts may reference it).
6. **`app/api/settings/compute/machines/[id]/build-status/route.ts`** — SSE or polling endpoint for the build-status UI.
7. **`app/settings/compute/page.tsx`** — adds:
   - "Your machines" section (owned-by-user rows) — cards with build status, edit, delete
   - "+ Create Machine" button → opens `<MachineWizard>` modal
   - `<MachineWizard>` — multi-step form: GPU → image base → nodes → models → scaling → review → submit
8. **Node search** — pull from ComfyUI-Manager's `custom-node-list.json`. Render a search box with results. Picking a node adds it to the machine config with a pinned commit sha (resolved via GitHub API).
9. **Model fetcher** — for HF/Civitai URLs, validate the model exists + record the sha256. Reuse the existing `lib/models/fetch.ts`.
10. **Build runner — Modal-side** — `modal/machine_builder_app.py` is a Modal app that accepts a machine config, builds the Image, deploys it as a new function, returns the endpoint URL. Scruple Web's worker calls this.
11. **Image digest in receipt** — at iteration time, the runner returns `image_digest`. `ingestIteration` persists it. Receipt renders. Audit script validates.
12. **Quota** — Premium tier has a cap on owned machines (suggested: 3). Enforce in the POST route.

## Cost trade-offs to surface in the UI

- Modal builds have a per-build cost (~$0.05 worst case).
- Each owned machine that's idle still costs $0 (no min_containers).
- A machine with `min_containers=1` is the warm-pool option — burn = GPU-rate × 24 × 30 / month.
- The wizard should show a live cost preview as the user changes settings.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Modal image build fails — node deps conflict | high | Surface the build log on the machine card; offer "rebuild" with one-click |
| User burns budget by leaving warm pools on | medium | Hard cap on `min_containers`; daily-cost preview; weekly email if a machine is costing >$X |
| Machine deletion breaks historical receipts | high | NEVER hard-delete; tombstone with `deleted_at`; receipt renders with "Machine archived" badge |
| Malicious node URLs | medium | Only allow URLs from the ComfyUI-Manager catalog whitelist initially |
| `image_digest` not chained into v2 leaf | medium | Add to record fields in a v2.2 leaf scheme migration; legacy rows verify under v2.1 fallback |
| Build worker is a new failure point | medium | Idempotent; retries on Modal API errors; alerts after 3 consecutive failures |

## Success criteria

- [ ] Migration 020 applied
- [ ] Catalog seeded
- [ ] Resolver updates to read from machines table
- [ ] Machine wizard ships
- [ ] Build worker ships + a Premium user can create a machine end-to-end
- [ ] Receipt renders `image_digest`
- [ ] Audit validates `image_digest`
- [ ] No regression on Stage-1 catalog machines

## Dependencies

- Stage 1 fully shipped + at least one Premium user.
- Modal SDK Python access from the Scruple Web server.
- A worker process / cron in addition to the Next.js server (the existing PM2 cluster doesn't have a worker tier yet).
