# Scruple Web

Web port of SCRUPLE Studio — the Electron desktop AI provenance middleware
that captures, hashes, and Merkle-anchors every iteration of an AI-assisted
creative session, then optionally seals the chain to RVN + IPFS + Arweave.

The desktop app talks to local ComfyUI / Kohya_ss installations on the
user's machine. The web port talks to **hosted GPU providers** instead:

- **fal.ai** — direct prompt API + ComfyUI workflow execution
- **ComfyDeploy** — bring-your-own-account; user pays ComfyDeploy directly,
  Scruple Web witnesses every generation

Same Merkle / lock / SCR-ID pipeline, same witness server (the existing
Node service at `:5799`). New ingestion path, new UI, no Electron.

## Status

Pre-flight only. No code yet. This directory contains:

- `research/electron-source/` — the entire SCRUPLE Studio v3 codebase
  (45 files, exported from Google Drive Apr 8 2026)
- `research/sessions/` — four Stooges council research outputs covering
  spec, integration architecture, strategy decisions, market & pricing
- `research/specs/` — the original `scruple-studio-overview.md` and the
  `dashboard-technical-questions.md` integration brief
- `research/api-research/` — provider strategy memo, witness-server
  integration plan, patent filing context, infrastructure notes
- `research/prior-art-ai-council/` — the canvas + fal API gateway routes
  already shipped in ai-council; reusable as a starting point
- `WORK_ORDERS.md` — phased build plan, ~30 WOs from scaffold to lock
- `memory/` — STATE / DECISIONS / WO_LOG following the same protocol as
  ai-council

## Reading order

1. `research/specs/scruple-studio-overview.md` — what the product is
2. `research/sessions/03-strategy-decisions.md` — the integration verdict
3. `research/sessions/01-complete-spec.md` — the consolidated build spec
4. `research/api-research/01-provider-strategy.md` — fal.ai + ComfyDeploy
5. `WORK_ORDERS.md` — execute in order, top to bottom
