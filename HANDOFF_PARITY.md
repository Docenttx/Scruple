# Electron Parity Overnight — Morning Hand-off

_Authored 2026-05-11. Branch: `feature/electron-parity`._

## What landed

11 commits since the parity branch was cut. The web app's top-level
shell now mirrors the Electron app's view-toggle pattern:

- **Top-level views**: Workspace / Canvas / Wallet pills in the
  AppShell header (link-driven; URL determines active pill)
- **Sidebar**:
  - Active-project TRACKING banner with thumbnails + Stop button
  - Connection-status pills (Witness ● / RVN ● / Stripe ●), 10s poll
  - Project list (unchanged from the original 30-WO build)
- **Wallet** (`/wallet`):
  - Mode toggle: Fiat / Blockchain
  - Fiat panel: payment methods, fee schedule, TSD balance + Add buttons,
    IPFS config card
  - Blockchain panel: live RVN status (chain, block height, balance,
    SCR_ asset list), network selector (mainnet/testnet w/ 🧪 banner)
  - 6 wallet-management modals (Create / Import / Unlock / Save Phrase
    / Settings / IPFS Config) — UI complete, handlers stubbed (D-012)
- **Lock flow**:
  - LockConfirmModal — action-aware copy, fee display, RVN password
    gate (blockchain) or TSD tier picker (fiat)
  - LockResultModal — success/error with SCR-ID, Merkle, RVN/IPFS/Arweave
    per-network status
  - LockProgressModal — step-by-step status (ready for WO-47 wiring)
- **Global UX**:
  - InterlockOverlay — full-screen spinner during any lock op
  - DebugConsole — collapsible bottom drawer, last 100 log entries
- **Canvas** (`/canvas`): iframe of canvas.stooges.ai (top-level, no
  longer nested in project workspace)

## Live server connections — all green

| Service | Status | Notes |
|---|---|---|
| Witness server :5799 | ✅ | `/health` 200; `/api/stripe-config` 200 |
| Stripe (via witness) | ✅ | Reachable via `/api/stripe-config` |
| ravend-mainnet | ✅ | RPC :8766, height **4,362,452** (was 4,362,441 at start) |
| ravend-testnet | ⚠️ | Configured for :18766 but listening on :18770 — see ERRORS.md |

Verified by `curl http://localhost:3001/api/health` returning
`witness.ok / rvn.ok / stripe.ok = true`.

## Architectural decisions logged

- **D-012** — Per-user wallet storage architecture deferred. Modal
  handlers stub to "next build" toast. UI is complete. Picking between
  ravend multi-wallet (server-custodial) and browser-only seed
  (non-custodial) deserves more thought than an overnight sprint.
- **D-013** — Top-level views over project-nested. ProjectShell
  removed; Workspace/Canvas/Wallet are all top-level routes. Captures
  bind to the user's currently-active project regardless of which view
  is on screen.

Full text in `memory/DECISIONS.md`.

## What you can do in the browser right now

1. Hit `https://scruple.stooges.ai` and sign in (existing OAuth)
2. Sidebar shows the **status pills row** at the top — confirm green dots
3. **Activate a project** by clicking Start Tracking on its workspace —
   the TRACKING banner appears in the sidebar with thumbnails
4. Switch to **Canvas** tab — iframe loads canvas.stooges.ai
5. Switch to **Wallet** tab — mode toggle works, RVN panel shows live
   mainnet block height, balance (0 RVN since this is a fresh box),
   network selector flips to testnet (and back)
6. Click **Create New Wallet** — modal opens (handler stubbed)
7. Click **Configure IPFS** in either panel — modal opens, saves to
   `user_settings.settings` JSON (Pinata fields encrypted at rest)
8. From any project's workspace, click **Finalize / Checkpoint / Chain
   Lock** — confirmation modal opens with the right fee + tier picker,
   confirms route through the existing lock executor
9. Click the **🐛 Debug** pill in the bottom-right corner — drawer opens
   with empty log state

## What's deferred (not in this overnight)

- **WO-38..40 Stripe Payment Element** — requires `@stripe/react-stripe-js`
  + `@stripe/stripe-js` deps and real Stripe keys. The TSD endpoint is
  wired; Element mounting can be a focused 1-2 hr follow-up.
- **WO-44 ElectrumX testnet client** — testnet block lookups + asset
  verify call. Mainnet RPC is working; testnet RPC port mismatch (see
  ERRORS.md) needs a 2-min config investigation.
- **WO-47 Persistent lock executor** — server-side RVN + IPFS + Arweave
  with SSE step progress. The LockProgressModal is ready to consume the
  events; the executor itself is the missing piece. Witness server's
  chain-lock already does RVN + Arweave for the standard chain lock;
  persistent-lock would add the IPFS pin step.
- **WO-43a Wallet handler wiring** — once D-012's storage architecture
  is picked, the 6 modal handlers each get ~30 lines.

## File map for the morning revision

| Concern | File |
|---|---|
| Top-level layout | `components/AppShell.tsx` |
| View-toggle pills | `components/ViewToggle.tsx` |
| Active-project sidebar banner | `components/ActiveProjectBanner.tsx` |
| Connection status pills + endpoint | `components/StatusPills.tsx`, `app/api/health/route.ts` |
| Wallet shell + panels | `components/wallet/{WalletView,FiatPanel,BlockchainPanel}.tsx` |
| Wallet modals | `components/wallet/WalletModals.tsx` |
| Lock flow modals | `components/wallet/{LockConfirmModal,LockProgressModal,LockResultModal}.tsx` |
| Wallet endpoints | `app/api/wallet/rvn/route.ts`, `app/api/wallet/tsd/route.ts` |
| RVN RPC client | `lib/scruple/ravend.ts` |
| Wallet UI state | `lib/store/wallet.ts` |
| Logs / Interlock state | `lib/store/{logs,interlock}.ts` |
| User settings (IPFS) | `app/api/settings/ipfs/route.ts`, migration 005 |
| Parity plan | `PARITY_PLAN.md` |

## Quick start

```
cd /data/scruple-web
git status                          # should be clean, on feature/electron-parity
git log --oneline main..             # see all 11 parity commits
npm run dev                         # already running at :3001 / scruple.stooges.ai
```

Or just navigate to `https://scruple.stooges.ai` in your browser.

## Suggested morning revision sequence

1. **5 min**: walk the wallet view, note what feels off (spacing,
   copy, button colors). Most cosmetic stuff is one-line edits.
2. **15 min**: decide D-012 — per-user wallet storage path. Either
   - ravend createwallet "scruple_user_<id>" (server-custodial, easy)
   - browser-only seed via bip39 (non-custodial, brand-true)
   - Encrypted seed in scruple-web DB (middle ground)
3. **Rest of session**: WO-43a (wire wallet handlers) + WO-38..40
   (Stripe Element) + WO-47 (persistent lock SSE).

## Errors / surprises logged

See `memory/ERRORS.md` and `memory/DISCOVERIES.md`.
