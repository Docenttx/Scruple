# Research bundle

Everything you need to understand what Scruple Web is supposed to be.
Read in this order on first visit.

## 1. specs/
- `scruple-studio-overview.md` — what the product *is*. Start here.
- `dashboard-technical-questions.md` — the integration brief that
  preceded this project (originally proposed building a "Scruple
  Workspace Tab" inside ai-council; we chose a standalone web app).

## 2. sessions/
Stooges council outputs from 2026-04-08, in increasing depth:
- `01-complete-spec.md` (45 KB) — definitive build spec
- `02-integration-architecture.md` (39 KB) — IPC → HTTP mapping, manifest
  schema, sidecar detection, web-native vs Electron tradeoffs
- `03-strategy-decisions.md` (13 KB) — integration vs standalone verdict;
  data model; council-in-the-loop image flow
- `04-market-pricing.md` (12 KB) — paying-user counts, pricing tiers,
  EU AI Act forcing function

## 3. api-research/
- `01-provider-strategy.md` — fal.ai + ComfyDeploy chosen as launch
  providers (2026-04-09)
- `02-witness-server-integration.md` — full Leonardo + witness flow,
  copyright human-approval gate
- `03-patent-filing-context.md` — provisional filing dates
- `04-infrastructure.md` — DNS, hosting, scruple.ai vs stooges.ai

## 4. electron-source/
The complete SCRUPLE Studio v3 desktop app source, exported from Google
Drive on 2026-04-08. **This is the ground truth for the port** — every
WO references files here.

Subdirectories:
- `scruple-studio/` — Electron main process (main-modular.js, preload.js,
  database.js, context.js, package.json)
- `renderer/` — UI (vanilla JS, NOT React): state.js, render-main.js,
  render-workspace.js, render-wallet.js, render-wallet-testnet.js,
  handlers.js, api.js
- `ipc/` — IPC handler modules: lock, project, settings, training, wallet
- `lock/` — Locking pipeline: merkle.js, lock-local-lock.js,
  lock-chain-lock.js, lock-package-builder.js, lock-barrel.js
- `executors/` — Lock executors: blockchain, fiat, server
- `Scruple Server/` and `server/` — Witness/Stripe/TSD client modules
  (duplicated; pick one)
- `nodes/` — Python ComfyUI custom nodes (studio_terminal.py,
  studio_training_terminal.py, input_capture.py, output_capture.py)
- `ComfyUI-Scruple/` — Python plugin packaging
- `config/` — testnet config
- `js/` — scruple_display.js (legacy ComfyUI workflow display)

## 5. prior-art-ai-council/
Routes that already shipped in ai-council and can be lifted with minor
edits:
- `canvas/` — ComfyUI intercept gateway (prompt, view, upload, history,
  auth, artifact[hash], migration 022)
- `fal/` — fal.ai adapter (generate, status, result, lib-fal.ts)
