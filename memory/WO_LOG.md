# Work Order Log — Scruple Web

[2026-05-02T05:40:00Z] PROJECT-INIT | created /data/scruple-web/ + research bundle + memory protocol + WORK_ORDERS.md (30 WOs) | no code yet
[2026-05-02T05:43:00Z] WO-01 | scaffolded Next.js 14 + TS + Tailwind + better-sqlite3 + NextAuth, dev :3001 | build green
[2026-05-02T05:46:00Z] WO-02 | 6 desktop tables + NextAuth tables, scripts/migrate.ts | applied + verified 11 tables
[2026-05-02T05:48:00Z] WO-03 | lib/types.ts — ProjectRow/IterationRow/MerkleNodeRow/LockState/GenerationSpec/LockPackageManifest | typecheck clean
[2026-05-02T05:51:00Z] WO-04 | NextAuth v5 + SqliteAdapter + /login + Google provider conditional | build green; google OAuth env required
[2026-05-02T05:53:00Z] WO-05 | AppShell (sidebar 260 + topbar 48) + auth-gated home | render placeholder; sign-out works
[2026-05-02T05:55:00Z] WO-06 | project server actions: getProjects/get/getActive/getIterations/getMerkleNodes + createProject/archive/unarchive/activate/deactivate/delete | userId-scoped; activate is transactional
[2026-05-02T05:57:00Z] WO-07 | Sidebar wired to getProjects with status badges, archive on hover | server component
[2026-05-02T05:59:00Z] WO-08 | /projects/new route with name + type form; training disabled with v2 tooltip | works end-to-end
[2026-05-02T06:02:00Z] WO-09 | WorkspaceView (header, stats, IterationGrid, LockButtons) at /projects/[id] | mirrors render-workspace.js
[2026-05-02T06:03:00Z] WO-10 | interlock store (Zustand) wired into TrackingButton + LockButtons | global busy flag
[2026-05-02T06:06:00Z] WO-11/12/13 | provider interface + fal.ai + ComfyDeploy adapters bundled | typecheck clean; live calls deferred
[2026-05-02T06:11:00Z] WO-14+16 | iteration ingest endpoint + Merkle library + content-addressed artifact store | byte-compatible with desktop merkle.js
[2026-05-02T06:13:00Z] WO-15 | iteration grid render with /api/artifact/[hash] | already covered in WorkspaceView
[2026-05-02T06:15:00Z] WO-17 | local-disc lock + checkpoint endpoints | atomic Merkle build + SCR-ID + status flip
[2026-05-02T06:17:00Z] WO-18 | lock-package builder — deterministic JSON + SHA-256 package_hash | second-precision builtAt
[2026-05-02T06:20:00Z] WO-20 | witness server client + integration smoke test | passed: 3 iterations witnessed, lock returned root + signature
[2026-05-02T06:22:00Z] WO-19 | chain-lock endpoint — witness all + lock + record package hash | uses sw:<user>:<id> namespace
[2026-05-02T06:24:00Z] WO-21+22 | Stripe routes proxy witness + chain-lock executor consolidated into WO-19 | pricing tier helpers
[2026-05-02T06:26:00Z] WO-23 | public receipt page at /receipt/[scrId] | unauth, full provenance receipt
[2026-05-02T06:27:00Z] WO-24 | POST /api/verify — recompute Merkle from manifest | mismatch detection
[2026-05-02T06:29:00Z] WO-25 | ZIP export — manifest + merkle-tree + artifacts | desktop-import compatible
[2026-05-02T06:31:00Z] WO-26 | /settings — provider keys with AES-256-GCM at-rest encryption | tail-only display
[2026-05-02T06:33:00Z] WO-27 | sidebar search + pagination | page size 50
[2026-05-02T06:35:00Z] WO-28 | global toast + LockButtons routes through it | success toast links to receipt
[2026-05-02T06:38:00Z] WO-29 | SSE iteration stream | EventSource client wrapper; only when active
[2026-05-02T06:40:00Z] WO-30 | telemetry table + log per ingest + monthly spend rollup | migration 003 applied
[2026-05-02T06:42:00Z] FINAL | seed script + dev-server smoke test | /login 200, / 307→/login, /api/verify detects tamper
[2026-05-11T22:30:00Z] PARITY-START | created feature/electron-parity branch; landed 3 pre-parity commits | gear icon, ComfyDeploy bridge, Canvas tab Scruple Shell, PARITY_PLAN.md
[2026-05-11T22:42:00Z] WO-31 | components/ActiveProjectBanner.tsx + StopTrackingButton.tsx; wired into Sidebar | TRACKING banner with thumbnails + Stop button
[2026-05-11T22:47:00Z] WO-32 | app/api/health/route.ts + components/StatusPills.tsx | witness/rvn/stripe pills, 10s poll
[2026-05-11T22:52:00Z] WO-42 | lib/scruple/ravend.ts + /api/health wired with live RVN probe | mainnet RPC scruple/scruplerpc2026main@:8766 returning height 4362441
[2026-05-11T22:55:00Z] WO-33 | ViewToggle.tsx + /canvas + /wallet routes; removed ProjectShell | top-level Workspace/Canvas/Wallet pills in AppShell
[2026-05-11T22:58:00Z] WO-34+35 | InterlockOverlay.tsx + DebugConsole.tsx + lib/store/logs.ts | global overlay + bottom drawer log panel
[2026-05-11T23:15:00Z] WO-36+37+43 | components/wallet/{WalletView,FiatPanel,BlockchainPanel,WalletModals,ModalShell}.tsx; /api/wallet/{rvn,tsd} | full wallet shell with mode toggle, 6 modals stubbed
[2026-05-11T23:28:00Z] WO-45+46 | components/wallet/{LockConfirmModal,LockProgressModal,LockResultModal}.tsx; refactored LockButtons | confirmation→execute→result flow
[2026-05-11T23:35:00Z] DISCOVERY | scruple-witness service has Stripe test keys loaded via /etc/systemd/system/scruple-witness.service.d/override.conf | sk_test_/pk_test_ active; /api/stripe-config returns live publishableKey
[2026-05-11T23:45:00Z] WO-38+40 | npm install @stripe/{stripe-js,react-stripe-js}; StripePaymentModal.tsx + /api/stripe/confirm route; LockButtons refactored for fiat-mode Stripe routing | end-to-end PaymentElement → confirmPayment → confirm-and-execute
