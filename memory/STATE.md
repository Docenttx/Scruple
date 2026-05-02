# Scruple Web — Current State
_Last updated: 2026-05-02T05:40:00Z_

## Phase: PRE-FLIGHT (no code)

Project directory created at `/data/scruple-web/`.
Research materials collected from:
- `/tmp/scruple-{code,complete}.json` — Electron source (45 files)
- `sessions/scruple-*` in ai-council — 4 council research outputs
- `scruple-dashboard-technical-questions.md` — integration brief
- ai-council `app/api/{canvas,fal}/*` — prior-art gateway routes
- Memory entries on provider strategy, witness server, infrastructure

No `package.json` yet. No git repo yet. No code written.

## Witness server (already live, will be reused)
- `/opt/scruple-witness/` — running on `:5799`, systemd unit
- All hashing / Merkle / SCR-ID conventions must remain byte-compatible
  with the desktop client (see `research/specs/dashboard-technical-questions.md`)

## Existing prior art in ai-council (refactor/partition-prep branch)
- `app/api/canvas/{prompt,view,upload,history,auth,artifact}` — ComfyUI
  intercept gateway with witness wiring (commit 9e312e5)
- `app/api/fal/{generate,status,result}` + `lib/group/fal.ts` — fal.ai
  adapter (commit 4fc818d)
- nginx vhost `canvas.scruple.ai` proxies port 80 → 8188 with selected
  routes intercepted via 3000

## Next
Execute `WORK_ORDERS.md` from WO-01 (scaffold).
