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

## D-014 · Scruple Python custom nodes deprecated for the cloud product
**Decision:** The four Scruple ComfyUI nodes are removed from
Scruple-managed cloud machine recipes. JS Queue intercept captures
workflow JSON; the cloud-side response carries output bytes.
**Rationale:** Python nodes were a desktop-era pattern. Don't fit
TEE-attested execution (we don't control the runtime), add machine-
build complexity, are invasive (users had to drop them in workflows).
**Implication:** Optional cosmetic JS-only "SCRUPLE" badge nodes may
exist purely as menu decoration. The existing scruple_nodes Python
package remains deployed on local canvas.stooges.ai for development
only.

## D-015 · One product (Scruple Web) — Desktop sunset for cloud path
**Decision:** Scruple Web is the only Scruple-managed product. The
cloud execution backend is TEE-attested NVIDIA H100. Local GPU tunnel
("Scruple Agent") is a planned future capability — out of scope for
the v1 pivot.
**Rationale:** Two products fork the codebase. Local tunnel adds a
second compute path with a different trust ceiling needing separate
marketing + pricing. Punt until after single-product launch.
**Implication:** Scruple Desktop becomes archive code. No new
releases. Future local-GPU support ships as a thin tunnel agent, not
a full second app.

## D-016 · TEE-attested cloud only — no non-attested middle tier
**Decision:** The cloud backend runs exclusively in TEE-attested mode
(NVIDIA H100 CC via Modal or Phala). No "Standard" non-attested
fallback.
**Rationale:** Every cloud run on the patentable path. Pricing and
positioning don't have to explain two cloud tiers. CC mode premium
is ~10–20% over plain H100 — small enough that per-lock pricing
absorbs it.
**Implication:** Custom nodes incompatible with CC mode are fixed
(CC-built) or documented as unsupported. The compatibility envelope
becomes part of the trust story.

## D-017 · BYOS (Bring Your Own Storage) — no scruple-web content store
**Decision:** Scruple Web does not persist user images, workflow JSON,
or any content beyond ephemeral working storage for an in-progress
run. Persistent home for every artifact is the user's Drive /
OneDrive / GitHub.
**Rationale:** Privacy by architecture, not by promise. Mirrors
Stooges' "no user data on Stooges" architecture (D-046–D-054 over in
ai-council). Same legal/compliance posture.
**Implication:** New `lib/storage/` subsystem (Drive + OneDrive +
GitHub providers + dispatcher). Iteration ingest writes to user
storage immediately; local copy purges within N minutes. Scruple-web
holds only the hash + pointer + chain metadata.

## D-018 · Tiered warm-cache as subscription strategy
**Decision:** Cloud GPU offering ships as three Modal function deployments
(same code, different decorators): cold (idle=10s, free tier), warm
(idle=600s, pro tier), attested (H100 CC + idle=600s, premium tier).
User's plan → which function `/api/generate` calls.
**Rationale:** Cold-start every Queue is acceptable for occasional/
hobbyist use; warm cache is the actual product for active creators;
hardware attestation is the premium differentiator. Three real
products, one codebase, clean economics.
**Implication:** plan_subtiers gains a compute_function field once
shipped. Default backend stays the warm tier (current MODAL_RUNNER_ENDPOINT).

## D-019 · BYO Modal as escape hatch
**Decision:** Power users / privacy-first users can bring their own
Modal account. Settings → Compute Backend lets them paste a token id +
secret + workspace + endpoint URL. scruple-web's /api/generate
dispatches to their endpoint instead of the Scruple-managed one.
**Rationale:** Same pattern as BYO ComfyDeploy (already supported).
Removes lock-in concerns. The runner code is public-ish (~150 lines,
no patent IP). Users still pay Scruple for the provenance chain;
Modal compute bills go to them directly.
**Implication:** lib/compute/backends.ts ComputeBackend already
accepts optional endpointUrl in context for this case. UI scaffolding
in Settings is a clone-8 follow-up.

## D-020 · BYOS audit policy
**Decision:** Three layers of tamper-evidence over BYOS:
  L1 (live today) — on-demand /api/verify accepts {contentHash,
                   fetchUrl} for ad-hoc verification by any caller
  L2 (scaffolded, cron pending) — tamper_audit_log table + manual
                   POST /api/audit/iteration/:id; nightly sweep
                   to be wired when Drive is connected end-to-end
  L3 (premium tier) — witness server signs periodic "still-here"
                   attestations of every iteration. Becomes a
                   timestamped chain anchorable to RVN/Arweave.
**Rationale:** Layer L1 is cheap and useful immediately. L2 catches
silent file modification within the audit interval. L3 is the
patent-anchoring continuous-attestation feature for high-stakes content.
**Implication:** Migration 010 ships the audit log. UI badges + cron
+ email notifications are clone-9 follow-ups.

## D-021 · Cloud GPU is exclusive scruple-managed compute path; no scruple server storage
**Decision (records what's been built): ** No user content ever
persists on scruple-web beyond the ephemeral local artifact cache
(default 15 min purge). All content writes flow through BYOS via the
StorageProvider abstraction. Lock-package builds, exports, audits all
pull from BYOS. The scruple-web server is reduced to: chain logic,
provenance computation, witness-server proxy, BYOS dispatcher, and
the UI surface.
**Rationale:** Privacy by architecture (D-017). Tamper-evidence works
because the chain logic lives outside the user's reach (D-013/L1
trust layer). This is the patent-worthy "Scruple holds nothing,
verifies everything" posture.
**Implication:** Settings page must show the user where their content
actually lives. Receipt page must surface storage_pointer (and tamper
status as L2/L3 lands). PRIVACY.md needs to capture this verbatim.

## D-022 · Dual-hash model fingerprint (content + structural)
**Decision:** Every training output (Lora, checkpoint) is fingerprinted
with two independent SHA-256s:
  contentHash    — full file bytes; canonical authenticity anchor,
                   binds the SCR-ID, same scheme as image iterations.
  structuralHash — safetensors JSON header bytes only; ~1 KB.
                   Instant to compute and verify. Confirms the model's
                   tensor topology (names, shapes, dtypes) is unchanged.
Plus a structural_summary JSON capturing tensor count, parameter total,
dtypes, shape patterns, and a model-type guess (FluxLora / SDXLLora /
SD15Lora / Unknown).
**Rationale:** Patent-novel dual-anchor provenance. Bit-exact verify
is provably tight but slow on multi-GB checkpoints. Structural verify
is instant and meaningful — confirms architecture without paying the
full hash cost. Receipts can render the structural fingerprint live;
content verify is a click-through. Sampling-based hashes are
cryptographically weak (a sample-aware attacker preserves the
sampled offsets) and explicitly rejected.
**Implication:** Migration 011 added structural_summary column;
existing model_hash/header_hash/header_size/tensor_count cols already
present from migration 001. lib/scruple/safetensors.ts + lib/scruple/
model-fingerprint.ts wire it. Training-completion handler (Modal-
side, deferred) must call fingerprintModelFile() before BYOS upload
and stamp all four columns on the training_runs row. Receipt page
already renders ModelFingerprintCard when training_runs.model_hash
or header_hash is non-null.

## D-023 · No sampled hashing for any artifact
**Decision:** No deterministic-offset sampling, no chunked-Merkle for
model files in v1. Authenticity hashes are always SHA-256 over the
complete byte stream.
**Rationale:** Sampling weakens tamper-evidence — an attacker who
knows the sample pattern preserves those bytes and substitutes the
rest. The patent claim hinges on bit-exact verification being
mathematically tight. Multi-GB SHA-256 cost is amortized over
training time (minutes-to-hours) and only paid once.
**Implication:** Future BLAKE3 migration (5-10x faster, internally
Merkle-based, same cryptographic strength) revisitable once we have
multi-TB model libraries. Per-tensor Merkle for forensic analysis
documented in lib/scruple/model-fingerprint.ts comments as a
deferred enhancement.
