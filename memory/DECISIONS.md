# Architectural Decisions — Scruple Web

These are pre-locked from the Stooges council research and the ai-council
prior-art shipping decisions. Do not re-debate without explicit user input.

## D-001 · Stack: Next.js 14 (App Router) + TypeScript + better-sqlite3
**Decision:** Same stack as ai-council so we can copy patterns and prior art.
**Rationale:** Existing canvas + fal routes already work; reusing the stack
means lifting them with minimal change. Bunless. Tailwind for styling.
**Implication:** No experimental frameworks. Follow ai-council conventions.

## D-002 · Server-side hashing only
**Decision:** All SHA-256 + Merkle computation happens server-side in
`lib/scruple/{hash,merkle}.ts`.
**Rationale:** Desktop did it client-side because it WAS the client. Web
clients are untrusted; the server is the trust boundary. Browser may also
hash for UX (progress bar) but the canonical hash is the server's.
**Implication:** Generation provider responses pass through our server
before being returned to the user. The browser never bypasses the server.

## D-003 · Reuse the existing witness server at :5799
**Decision:** Do not duplicate witness logic. Call the existing
`/opt/scruple-witness` HTTP API.
**Rationale:** Already live. Already does Stripe / TSD / Ravencoin.
Patent claim depends on a single canonical witness, not per-app forks.
**Implication:** Scruple Web is a **client** of the witness server.
Schema changes in witness server are out of scope here.

## D-004 · Byte-for-byte compatibility with desktop SCRUPLE Studio
**Decision:** SCR-ID derivation, leaf hash format, Merkle algorithm
(alphabetical pair sort), and lock-package format are identical to
desktop. Refer to `research/electron-source/lock/merkle.js` and
`research/specs/dashboard-technical-questions.md`.
**Rationale:** A project started in Scruple Web must be openable and
verifiable in desktop SCRUPLE Studio. No "web mode" path on the witness
server.
**Implication:** Any deviation from the desktop implementation is a bug.
Treat `lock/merkle.js` as the spec.

## D-005 · Provider scope: fal.ai + ComfyDeploy first
**Decision:** v1 ships with fal.ai (direct API + ComfyUI workflows) and
ComfyDeploy (BYO account). No DALL-E, no Leonardo, no Replicate.
**Rationale:** Locked in by `memory/api-research/01-provider-strategy.md`
2026-04-09. fal.ai gives prompt-based + workflow-based; ComfyDeploy
isolates GPU billing from us. DALL-E/Leonardo were the ai-council path,
not the Scruple Web path.
**Implication:** Adapter interface accommodates both; don't over-abstract
for providers we won't add until v2.

## D-006 · No Electron-isms in the web port
**Decision:** Drop everything that requires local filesystem access:
folder browser, ComfyUI path detection, Kohya TOML watcher, native
Electron file dialogs, OS file paths in user-facing settings.
**Rationale:** This is web. Files come from generation providers or
HTTP upload. The desktop's path-discovery flow doesn't translate.
**Implication:** Setup wizard becomes "connect a provider" flow, not
"point us at a folder." Training run capture is deferred to v2 (it
requires either a desktop bridge or a hosted Kohya solution).

## D-007 · Vanilla JS renderer → React components
**Decision:** Port the desktop's `render-*.js` template-string functions
into React components. The reactive `State` container becomes Zustand.
**Rationale:** React is what Next.js gives us. The desktop's manual
event-rebinding via `setupMainAppHandlers()` is the antipattern React
exists to fix.
**Implication:** Don't try to literal-port the renderer. Read it for the
data flow and visual structure, then write idiomatic React.

## D-008 · Auth: NextAuth (same as ai-council)
**Decision:** NextAuth v5, Google + email-link providers.
**Rationale:** Same as ai-council. Provenance accounts must be tied to
real identity for legal weight.
**Implication:** Sessions table already specced in ai-council canvas
prior-art (migration 022). Reuse the pattern.

## D-009 · Storage: SQLite local + content-addressed artifact dir
**Decision:** SQLite via better-sqlite3 (single-server). Artifacts live
under `artifacts/<sha256-prefix>/<sha256>` mirroring ai-council canvas.
**Rationale:** Single-box deployment for now; matches witness server.
Migrate to Postgres when we add multi-instance hosting.
**Implication:** No object store dependency in v1. `getArtifact(hash)`
hits the local FS.

## D-010 · Lock pricing: defer Stripe wiring until WO-25+
**Decision:** Local-disc lock is free. Server-checkpoint and chain locks
require Stripe. Stripe wiring is in the back half of the WO list.
**Rationale:** UI flow can prototype with stub `stripeCreatePaymentIntent`
that returns a fake intent id; real Stripe is mechanical once the rest
of the pipeline works.
**Implication:** Don't block iteration grid + lock-button UI on Stripe.

## D-011 · No new npm packages without justification
**Decision:** Same rule as ai-council. Check existing deps first.
**Rationale:** Dependency creep is hard to undo.
**Implication:** When adding a package, document in this file.

## D-012 · Wallet architecture deferred — UI shell first
**Decision:** Ship the wallet UI shell (mode toggle, Fiat + Blockchain
panels, all six wallet-management modals) with stubbed server actions
for create/import/unlock. The actual wallet-storage architecture
(server-side ravend multi-wallet vs. browser-only seed vs. encrypted
seed in scruple-web DB) is deferred to a focused follow-up WO.
**Rationale:** Picking between custodial and non-custodial models is
non-trivial and the right choice for Scruple as a product touches
patent + compliance + UX. The desktop's pattern (ravend-managed wallet
with user password) doesn't translate cleanly to multi-user web. The
UI shell is valuable regardless of which path we pick.
**Implication:** WO-43 ships UI only. Modal submit handlers display a
"coming in next build" toast. WO-43a (future) wires actual wallet
creation through ravend's `createwallet` (named per-user wallets) once
the storage model is settled.

## D-013 · Top-level views over project-nested
**Decision:** Workspace, Canvas, and Wallet are top-level routes (/, /canvas,
/wallet). The view-toggle in AppShell is link-driven (URL determines
active pill). Per-project URLs (/projects/[id]) still work for deep
links; the toggle just keeps Workspace pill highlighted while you're
in a project.
**Rationale:** Mirrors the desktop's currentView state, which is global.
Wallet doesn't belong nested under a single project. Canvas captures
go to whichever project is currently set as "active" (server-enforced
one-active-per-user), so it doesn't need to live inside a project URL.
**Implication:** ProjectShell is removed. The active-project context
flows through the sidebar's ActiveProjectBanner + the workspace's
TrackingButton, not via the URL.
