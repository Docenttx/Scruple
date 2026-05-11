# Scruple Web — Electron Parity Plan

_Authored 2026-05-11. Maps every Electron-app feature to a port status
and a Work Order. Companion to WORK_ORDERS.md (which covered WO-01 → WO-30,
the original 30-WO build)._

Feature catalog derived from a full sweep of `/data/scruple-web/research/electron-source/`
(4,724 lines of renderer source + the full ipc/, executors/, server/,
lock/, nodes/ trees).

Legend: ✅ shipped · 🟡 partial · ❌ missing · ⏭ deferred (Electron-only or out-of-scope)

---

## Phase 0 — already in scruple-web (no work)

| Feature | Status | Where |
|---|---|---|
| Auth (Google OAuth + sessions) | ✅ | `lib/auth/auth.ts` |
| Sidebar — project list + search + pagination | ✅ | `components/Sidebar.tsx` |
| Sidebar — archive on hover | ✅ | `components/Sidebar.tsx` |
| Workspace — header (name + status badge + tracking pill) | ✅ | `components/WorkspaceView.tsx` |
| Workspace — stats cards (iter count / Merkle / SCR-ID / witnessed) | ✅ | `components/WorkspaceView.tsx` |
| Workspace — iteration grid (+ SSE live updates) | ✅ | `components/IterationGridLive.tsx` |
| Workspace — tracking activate/deactivate (one-active enforcement) | ✅ | `lib/projects/actions.ts` |
| Workspace — lock buttons (Finalize / Checkpoint / Chain Lock) | ✅ | `components/LockButtons.tsx` |
| Local-disc lock | ✅ | `app/api/lock/local/route.ts` |
| Checkpoint lock | ✅ | `app/api/lock/checkpoint/route.ts` |
| Chain lock (via witness server) | ✅ | `app/api/lock/chain/route.ts` |
| Lock-package builder (deterministic JSON) | ✅ | `lib/scruple/lock-package.ts` |
| Verify endpoint (recompute from manifest) | ✅ | `app/api/verify/route.ts` |
| Public receipt page | ✅ | `app/receipt/[scrId]/page.tsx` |
| Project export ZIP | ✅ | `app/api/projects/[id]/export/route.ts` |
| Settings — provider keys (AES-GCM at rest) + monthly spend rollup | ✅ | `app/settings/page.tsx` |
| Witness server client (record / fetch / lock / verify) | ✅ | `lib/scruple/witness.ts` |
| Stripe — config + payment-intent proxy (no Element on client yet) | 🟡 | `app/api/stripe/*` |
| Canvas tab — Scruple Shell (iframe canvas.stooges.ai with Scruple/Manager nodes) | ✅ | `components/ProjectShell.tsx`, ComfyUI custom nodes |
| ComfyDeploy adapter + per-project workflow id | ✅ | `lib/providers/comfydeploy.ts`, `/api/generate` |
| New-project page (name + type) | ✅ | `app/projects/new/page.tsx` |
| Telemetry table + per-month spend rollup | ✅ | `lib/db/migrations/003_telemetry.sql` |
| Global toast | ✅ | `components/Toaster.tsx` |
| Gear-icon settings link in topbar | ✅ | `components/AppShell.tsx` |

**~25 features, all of Phase 0.** Pretty close to feature parity on the "workspace + lock pipeline + canvas" surface already.

---

## Phase 1 — Electron-shell parity (top-level layout + connection-state)

These bring the web version's chrome up to desktop expectations.

| # | Feature | Status | WO |
|---|---|---|---|
| 1.1 | Active-project sidebar banner (TRACKING + thumbnails) | ❌ | **WO-31** |
| 1.2 | Sidebar status row (Witness ● / RVN ● / Stripe ●) — heartbeat poll | ❌ | **WO-32** |
| 1.3 | Top-level view-toggle (Workspace / Canvas / Wallet) in AppShell | 🟡 | **WO-33** (currently project-scoped) |
| 1.4 | "Viewing: <project>" label in main-content header | ❌ | **WO-33** |
| 1.5 | Interlock overlay (greyed "Generating…" full-screen blocker) | ❌ | **WO-34** |
| 1.6 | Debug console (collapsible bottom drawer, last 100 log entries) | ❌ | **WO-35** |
| 1.7 | Session-id display in sidebar footer | ❌ | **WO-31** (folded into sidebar refactor) |
| 1.8 | `+ New project` inline form in sidebar (vs full-page) | 🟡 | **WO-31** |

---

## Phase 2 — Wallet surface (the big ticket)

The desktop's render-wallet.js (1012 lines) + render-wallet-testnet.js (928 lines) covers two payment modes — **fiat (Stripe)** and **blockchain (RVN native wallet)** — with sub-tabs for mainnet/testnet.

### 2A. Wallet shell

| # | Feature | Status | WO |
|---|---|---|---|
| 2.1 | `/wallet` route + Wallet shell layout | ❌ | **WO-36** |
| 2.2 | Mode toggle (Fiat / Blockchain) — purple Fiat / chain-link Blockchain | ❌ | **WO-36** |
| 2.3 | Network selector (Mainnet / Testnet) inside Blockchain mode | ❌ | **WO-37** |

### 2B. Fiat mode (Stripe-driven)

| # | Feature | Status | WO |
|---|---|---|---|
| 2.4 | Payment method card panel (Stripe ACTIVE + grey-out for PayPal/Apple/Google) | ❌ | **WO-38** |
| 2.5 | Fee schedule display ($5 checkpoint/finalize, $50 basic chain, $65 pinned) | ❌ | **WO-38** |
| 2.6 | TSD balance display (Test SCRUPLE Dollar) + Add TSD button | ❌ | **WO-39** |
| 2.7 | TSD fund/pay endpoints (proxy to witness `/api/tsd/*`) | ❌ | **WO-39** |
| 2.8 | Stripe Payment Element (mounted in modal during paid action) | ❌ | **WO-40** |
| 2.9 | Stripe processing / success / error modals | ❌ | **WO-40** |
| 2.10 | IPFS configuration panel (gateway + Pinata key) + save modal | ❌ | **WO-41** |

### 2C. Blockchain mode (Ravencoin native wallet)

| # | Feature | Status | WO |
|---|---|---|---|
| 2.11 | RVN RPC client (`lib/scruple/ravend.ts`) — JSON-RPC, cookie auth | ❌ | **WO-42** |
| 2.12 | Wallet panel — address + balance + unlock state + 🧪 testnet banner | ❌ | **WO-43** |
| 2.13 | Create-wallet modal (password + confirm) | ❌ | **WO-43** |
| 2.14 | Import-wallet modal (12-word mnemonic + password) | ❌ | **WO-43** |
| 2.15 | Unlock-wallet modal (password only) | ❌ | **WO-43** |
| 2.16 | Save-recovery-phrase modal (mnemonic display + confirm checkbox) | ❌ | **WO-43** |
| 2.17 | Wallet-settings modal (delete-wallet danger zone) | ❌ | **WO-43** |
| 2.18 | TSD/RVN asset list (Scruple's SCR_ assets, with [Verify] button) | ❌ | **WO-44** |
| 2.19 | ElectrumX testnet client (`lib/scruple/electrumx.ts`) for balance lookups | ❌ | **WO-44** |
| 2.20 | Send-RVN flow (address + amount + password modal) | ⏭ deferred (post-launch) | — |

### 2D. Lock-flow modals (paid-action UX)

The desktop has ~14 distinct lock-related modals depending on (payment mode × project state × action). We need them all to match the desktop UX.

| # | Feature | Status | WO |
|---|---|---|---|
| 2.21 | Finalize warning modal (fiat) — $5 fee | ❌ | **WO-45** |
| 2.22 | Finalize-clone modal (fiat) — checkpointed-project clone | ❌ | **WO-45** |
| 2.23 | Checkpoint-confirm modal (fiat) — $5 fee | ❌ | **WO-45** |
| 2.24 | Blockchain variants of 2.21–2.23 (no fee) | ❌ | **WO-45** |
| 2.25 | Chain-lock RVN-password modal (blockchain mode, ~500 RVN) | ❌ | **WO-45** |
| 2.26 | TSD chain-lock modal (fiat — Basic 50 / Pinned 65) | ❌ | **WO-45** |
| 2.27 | Chain-lock progress modal (animated hourglass) | ❌ | **WO-46** |
| 2.28 | Chain-lock success modal (Asset ID / TX / IPFS / Arweave) | ❌ | **WO-46** |
| 2.29 | Chain-lock error modal (per-network status) | ❌ | **WO-46** |
| 2.30 | Persistent-lock success / error modals | ❌ | **WO-46** |
| 2.31 | TSD insufficient-balance modal | ❌ | **WO-46** |

### 2E. Persistent lock (the third lock tier)

| # | Feature | Status | WO |
|---|---|---|---|
| 2.32 | Persistent-lock executor — RVN + IPFS + Arweave (via witness) | ❌ | **WO-47** |

---

## Phase 3 — Generation surface enrichment

The desktop generates *via the embedded ComfyUI*. We're going further (ComfyDeploy cloud GPU), but a few features carry over:

| # | Feature | Status | WO |
|---|---|---|---|
| 3.1 | Pre-SCR-ID display on workspace (checkpointed→clone flow tracking) | ❌ | **WO-48** |
| 3.2 | Iteration drawer (click iteration → side panel with full prompt + params) | ❌ | **WO-49** |
| 3.3 | Generate panel — workflow JSON upload (alongside the prompt-only form) | ❌ | **WO-50** |
| 3.4 | Canvas → ComfyDeploy queue intercept (Scruple JS extension) | ❌ | **WO-51** |
| 3.5 | `/api/generate` workflow-JSON mode (forwards to ComfyDeploy ad-hoc run) | ❌ | **WO-52** |
| 3.6 | postMessage bridge (active-project → canvas iframe; capture → workspace) | ❌ | **WO-53** |

---

## Phase 4 — Deferred (Electron-only or post-launch)

| Feature | Why deferred |
|---|---|
| Setup wizard (folder pickers) | Electron-only; D-006 |
| Kohya/training capture | Requires local FS + Kohya bridge; D-006 |
| Pre-flight checklist (training) | Same; D-006 |
| Training run cards / lineage tree | Same; D-006 |
| Send-RVN flow | Not on launch path |
| Native file dialogs | Browser uses `<input type=file>` for the cases that survive |
| ComfyUI/Kohya port auto-detect + retry overlays | Web canvas is the canvas.stooges.ai URL; not localhost-discovery |

---

## Summary

| Phase | WOs | Features |
|---|---|---|
| 0 — already done | (covered by WO-01..30) | ~25 features ✅ |
| 1 — Electron shell parity | WO-31..35 | 8 missing |
| 2 — Wallet (the big one) | WO-36..47 | ~32 missing |
| 3 — Generation enrichment | WO-48..53 | 6 missing |
| 4 — Deferred | — | ~10 (won't port for launch) |

**Total new WOs: 23 (WO-31..53).**

---

## Overnight Execution Plan

What I'll commit to over a single overnight session, in execution order:

**Block A — Shell parity (highest UX leverage)** — WO-31..35
- Active-project sidebar banner + status pills + interlock overlay + debug console + view-toggle promotion
- ~4 hrs

**Block B — Wallet shell + blockchain mode (most user-visible "missing thing")** — WO-36, WO-37, WO-42, WO-43
- `/wallet` route, mode toggle, RVN RPC client, wallet management modals
- ~4 hrs

**Block C — Fiat-mode wallet + Stripe Element** — WO-38..40
- Payment-method card, fee schedule, TSD client, Stripe Element mounted in payment modal
- ~3 hrs

**Block D — Lock-flow modals + Persistent lock** — WO-45..47
- All 14 lock modals (lots of UI; reuse a generic ModalShell)
- ~3 hrs

**Block E — Connection wiring + smoke** — WO-32 wiring, WO-41 IPFS, WO-44 ElectrumX
- Witness health endpoint, RVN cookie auth, Stripe heartbeat, IPFS config panel
- Smoke-test all four services with documented results
- ~2 hrs

**Deferred from this overnight** (not enough hours):
- WO-48..53 (Generation enrichment — drawer, JSON upload, Queue intercept) — next session
- Phase 4 deferred items — out of scope per D-006

**Memory protocol**: per scruple-web's CLAUDE.md, I'll update `memory/STATE.md`, `memory/WO_LOG.md`, `memory/DECISIONS.md`, `memory/DISCOVERIES.md`, `memory/ERRORS.md` as I go. Commits per WO on branch `feature/electron-parity`.
