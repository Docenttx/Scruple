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

# Pivot Overnight (2026-05-11 → 2026-05-12)
[2026-05-12T00:30:00Z] PIVOT-START | feature/pivot cut from feature/electron-parity; CONTEXT.md rewritten | starting test wrapper first
[2026-05-12T01:00:00Z] TOOLING | scripts/scrupel.mjs + app/api/dev/session + GET/POST /api/projects | dev session lookup via DB strategy; __Secure-authjs.session-token cookie name when NEXTAUTH_URL is https
[2026-05-12T02:00:00Z] PIVOT-SCHEMA | migrations 006 (execution_backend/attestation/storage_pointer) + 007 (storage_providers, sync_log) + 008 (gdrive_tokens per-user) applied
[2026-05-12T02:30:00Z] PIVOT-STORAGE | lib/storage/{types,gdrive,dispatch}; /api/auth/gdrive/{connect,callback,status,disconnect}; /api/storage/status | per-user Drive tokens AES-GCM encrypted; drive.file scope
[2026-05-12T03:00:00Z] PIVOT-COMPUTE | modal/scruple_runner.py deployed to aquanomous workspace; lib/compute/modal.ts adapter; /api/generate workflow-mode defaults to Modal when MODAL_RUNNER_ENDPOINT set
[2026-05-12T03:30:00Z] PIVOT-INGEST | ingestIteration now async, writes to user storage when connected, records storage_pointer + execution_backend + execution_attestation on the iteration row
[2026-05-12T03:50:00Z] SMOKE | full pipeline: project create → ingest synthetic 1x1 PNG → local lock → SCR_497790 issued | all green
[2026-05-12T04:00:00Z] PIVOT-UI | settings/StorageSection.tsx for Drive connect; receipt page BackendBadge + AttestationSummary; storage-purge.mjs retention sweep
[2026-05-12T04:00:00Z] PIVOT-HANDOFF | HANDOFF_PIVOT.md + STATE.md updated

# Pass 1A+1B + clone-7..n + non-Drive/Modal items (2026-05-12 morning)
[2026-05-12T05:30:00Z] PASS-1A | modal/scruple_runner.py — scruple-models Volume mount + fetch_to_volume + list_volume + delete_from_volume admin functions + scaledown_window=600 | redeployed
[2026-05-12T06:00:00Z] PASS-1B | scripts/sync-canvas-stubs.mjs | mirrors Volume filenames as 0-byte stubs in /data/reference/ui-inspire/ComfyUI/models
[2026-05-12T06:15:00Z] SEED | SD 1.5 base + VAE downloaded to scruple-models volume | ckpts dropdown live
[2026-05-12T06:30:00Z] PROPOSAL | docs/video-training-tamper-evident-2026-05-12.md | full design + effort estimates for txt2video / img2video / training / audit
[2026-05-12T07:15:00Z] CLONE-7 | lib/compute/backends.ts + modal.ts refactored | ComputeBackend interface
[2026-05-12T07:30:00Z] CLONE-8 | /api/verify external-bytes mode | SSRF guards + 200MB cap
[2026-05-12T07:45:00Z] CLONE-9 | UI phase 2 batch 1 — tailwind tokens + ActiveProjectBanner (red TRACKING) + LockButtons (per-kind hover) + WorkspaceView (max-w 1200) + IterationGrid (auto-fill) + ModalShell (animate-modal-in) + StatusPills (flag-bg + glow) | from desktop main.css ground truth
[2026-05-12T08:00:00Z] CLONE-10 | UI phase 2 batch 2 — SidebarList project rows (.project-item) + ProvenanceTerminal (full terminal aesthetic) | desktop-aligned
[2026-05-12T08:15:00Z] CLONE-11 | lib/provenance/validate.ts + /api/workflow/validate + WorkflowUploader.tsx | structural + model-file existence checks
[2026-05-12T08:25:00Z] CLONE-12 | migration 010 + lib/audit/tamper.ts + /api/audit/iteration/:id | tamper-audit Layer 2 scaffolding
[2026-05-12T08:30:00Z] CLONE-13 | /api/stripe/setup-intent + payment-method/:id (delete + default) + AddPaymentMethodModal | saved-card UX live
[2026-05-12T08:30:00Z] DECISIONS | D-018..D-021 appended to DECISIONS.md
[2026-05-12T10:30:00Z] train-1 | shipped lib/scruple/safetensors.ts | header parser + file streamer + dtype size table
[2026-05-12T10:30:00Z] train-1 | shipped lib/scruple/model-fingerprint.ts | dual-hash (content + structural) + model-type guess + kohya metadata reading
[2026-05-12T10:30:00Z] train-1 | shipped migrations/011_model_fingerprint.sql | structural_summary cols + 3 hash indexes
[2026-05-12T10:30:00Z] train-1 | shipped ModelFingerprintCard in receipt page | renders content/structural/tensors/params/dtypes per training_run
[2026-05-12T10:30:00Z] train-1 | shipped scripts/test-fingerprint.ts | synthetic safetensors smoke, all assertions pass
[2026-05-12T10:30:00Z] train-1 | logged D-022 (dual-hash fingerprint) + D-023 (no sampled hashing)
[2026-05-15T10:00:00Z] hotfix | killed/cleared/restarted scruple-web | corrupted .next vendor-chunks/@auth.js after today's HMR; pid 1094922
[2026-05-15T10:05:00Z] hotfix | login button → official Google Sign-In | dark variant per Google brand guidelines, inline 4-color G SVG
[2026-05-15T10:10:00Z] hotfix | db-adapter.ts updateSession dynamic SET | fixed SqliteError: NOT NULL constraint failed: sessions.user_id during rolling-expiry updates
[2026-05-15T10:30:00Z] ws-port | TrainingRunCard component | lineage indicator, status badge, parent connector, detail rows, locked footer
[2026-05-15T10:35:00Z] ws-port | PreflightPanel component | idle/running/complete states; SSE-ready, runtime endpoint deferred
[2026-05-15T10:40:00Z] ws-port | WorkspaceView training-vs-iter branching | type='training' → preflight + reverse-ordered cards; type='txt2img' → IterationGridLive
[2026-05-15T10:45:00Z] ws-port | TrainingRunRow extended + getTrainingRuns | actions.ts now exposes the query
[2026-05-15T11:30:00Z] pt | migration 012 — project types v2 (image|video|training), wiped existing data, dropped comfy_workflow_id
[2026-05-15T11:35:00Z] pt | type system + Zod schemas + NewProjectForm swap to image|video|training
[2026-05-15T11:40:00Z] pt | /api/generate prompt-mode branch removed (workspace observes; only workflow mode survives for Canvas)
[2026-05-15T11:45:00Z] pt | deleted GeneratePanel, WorkflowField, WorkflowUploader (all dispatched from project page)
[2026-05-15T11:50:00Z] pt | WorkspaceView 3-way branch — image/video/training, video shows placeholder card
[2026-08-26T22:00:00Z] WO-1 | config/c2pa-assertions.json + assertion_partition.py + signAsset.ts | signing unbroken; allowlist rejected all 4 Application-tier labels since 2026-08-04
[2026-08-26T22:00:00Z] WO-1 | services/c2pa-signer/tests/test_assertion_contract.py | drift guard, 9 tests; verified it fails on the pre-fix allowlist
[2026-08-26T22:00:00Z] WO-1 | sign.py | claim_generator stamped real c2pa-python 0.36.0; "0.89" never existed
[2026-08-26T22:15:00Z] WO-2 | .github/workflows/tests.yml | first CI job to run any test suite; witness parity tests invoked as scripts (pytest collects 0)
[2026-08-26T22:15:00Z] WO-2 | packages/scruple-attestation-verifiers/package.json | `dist/*.test.js` ran 21 of 44; now `dist/`
[2026-08-26T22:20:00Z] WO-1 | lib/iterations/ingest.ts + app/api/witness/cad | IngestResult carries witnessed + leafScheme
[2026-08-26T22:20:00Z] WO-1 | app/api/scruple/witness/{adobe,photoshop} | removed hardcoded witnessed=1 / leaf_scheme='v2.2'
[2026-08-26T22:40:00Z] WO-3 | components/LockButtons.tsx | Fusion C2PA button disabled with a reason; alert() removed
[2026-08-26T23:30:00Z] WO-4 | docs/canon/{CANON_SKELETON,openapi-v2.yaml,STANDARD_v1.7_FULFILMENT} | skeleton specified; 11 decisions, 10 paths, clause matrix
[2026-08-26T23:50:00Z] WO-5 | docs/canon/WO-05-studio-comfyui-kohya.md | plan only; Studio may deserve to go first — Scruple owns the substrate
