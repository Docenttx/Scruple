# Scruple Web — Current State
_Last updated: 2026-05-11T23:30:00Z_

## Phase: Electron parity overnight — Block A+B+D shipped

10 commits on `feature/electron-parity` since branch creation. Build
green (npx tsc --noEmit clean). Witness + RVN + Stripe pills all green
on live server.

## Branch
`feature/electron-parity` — 10 commits ahead of main (3 pre-parity,
7 parity WOs).

## Work orders status
| WO | Status | Commit |
|---|---|---|
| 31 — Active-project sidebar banner | ✅ | (parity) |
| 32 — Sidebar status pills | ✅ | (parity) |
| 33 — Top-level view toggle + /canvas + /wallet | ✅ | (parity) |
| 34 — Interlock overlay | ✅ | (parity) |
| 35 — Debug console | ✅ | (parity) |
| 36+37+43 — Wallet shell + Fiat/Blockchain + 6 modals | ✅ | (parity) |
| 38+39+40 — Stripe Payment Element + TSD wiring | 🟡 partial (TSD endpoint wired; Element pending) | — |
| 41 — IPFS config save endpoint | ❌ | — |
| 42 — RVN RPC client | ✅ | (parity) |
| 44 — ElectrumX testnet client | ❌ | — |
| 45+46 — Lock confirm + progress + result modals | ✅ | (parity) |
| 47 — Persistent lock executor | ❌ | — |

## System status
- [x] Workspace / Canvas / Wallet top-level view toggle
- [x] Active-project sidebar banner (TRACKING + thumbnails)
- [x] Connection status pills (Witness ● RVN ● Stripe ●)
- [x] Interlock overlay (chain lock blocks all UI)
- [x] Debug console drawer (last 100 entries)
- [x] Wallet view — Fiat (Stripe + TSD + IPFS) + Blockchain (RVN + IPFS)
- [x] 6 wallet management modals (Create/Import/Unlock/Save/Settings/IPFS)
- [x] Lock confirmation + result modals (success/error/per-network status)
- [x] RVN RPC client + live mainnet health probe
- [x] TSD balance + fund proxy through witness server

## Server connections verified
- `scruple-witness.service` (:5799) — `/health` 200, `/api/stripe-config` 200
- `ravend-mainnet.service` — RPC :8766, scruple/scruplerpc2026main, height 4,362,441
- `ravend-testnet.service` — RPC :18766 (config) / actual listen 18770
- All wallet endpoints respond with auth gate

## Notes
- D-012: per-user wallet storage architecture deferred. Modal handlers
  show "next build" toast; UI shell is complete.
- D-013: Workspace/Canvas/Wallet are top-level routes; ProjectShell removed.
- Stripe Payment Element wiring deferred — needs real Stripe keys + the
  @stripe/react-stripe-js + @stripe/stripe-js npm packages installed first.
  Replacement: when LockConfirmModal fires for a fiat chain lock, it should
  POST to /api/stripe/payment-intent, mount the Element in the modal with
  the returned clientSecret, then POST to /api/stripe/confirm. Current
  fiat-mode flow stubs through to the existing /api/lock/chain (which
  routes through the witness server's Stripe).
- Persistent lock (WO-47): the witness server's chain-lock executor
  already covers RVN + Arweave. WO-47 = add IPFS pin step + surface
  per-step progress via SSE so LockProgressModal can light up.
