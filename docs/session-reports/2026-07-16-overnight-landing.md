# Session landing report — 2026-07-16 → 2026-07-17

## TL;DR

Seven substantive workstreams landed:

1. **C2PA Conformance response** — bundled, IP-scrubbed, entity-corrected, in Drive, ready to send
2. **EU AI Office response** — sent
3. **Fusion Stripe in-palette** — shipped + committed (2 repos)
4. **Blender addon** — shipped, tested in real Blender headless, ready for user smoke
5. **Toon Boom Harmony addon** — shipped, ready for user smoke on Harmony workstation
6. **Meshroom plugin** — shipped, ready to drop into `~/.meshroom/nodes/`
7. **NAVSEA NV059 SBIR** — strategic assessment complete, bid/no-bid decision needed

Two more plugin WOs on file (After Effects blocked on Adobe account; RealityCapture held pending demand).

---

## Substrate coherence

Every Scruple plugin now registers with a distinct host tag on the same canonical leaf schema. One signing substrate, five surfaces.

| Plugin | Host tag | Tests | Repo | Status |
|---|---|---|---|---|
| Fusion | (existing) | (existing) | `/data/scruple-fusion` | Shipped, in-palette payment landed tonight |
| Adobe (Photoshop / Illustrator / InDesign) | (existing) | (existing) | `/data/scruple-adobe` | Shipped, awaiting user's Adobe smoke |
| Blender | `blender` | 81 pytest + 16 real-Blender headless | `/data/scruple-blender` | Shipped tonight, real-host verified |
| Toon Boom Harmony | `toonboom` | 128 node | `/data/scruple-toonboom` | Shipped tonight, needs real-host smoke |
| Meshroom | `meshroom` | 98 pytest | `/data/scruple-meshroom` | Shipped tonight, needs real-host smoke |
| After Effects | `aeft` (planned) | — | `/data/scruple-adobe` (fork pending) | WO on file, blocked on Adobe account |
| RealityCapture | wrapper (planned) | — | `/data/scruple-realitycapture` (pending) | WO on file, held pending demand |

Each plugin ships an installable zip, an install script per OS, mock-host tests, a session report, docs, and a memory entry.

---

## What shipped tonight, by workstream

### 1. C2PA Conformance Program response

**Location:** `DevSpace / Scruple / C2PA Conformance — Evidence Bundle 2026-07-14` in Drive
- https://drive.google.com/drive/folders/14Vws005ZSqxEaDmsNp3bqjg0_GJ8T7F3

**Contents:**
- `scruple-c2pa-conformance-response-2026-07-16.zip` (1.08 MB, 120 files) — unified Part 1 (media samples) + Part 2 (GPSA + evidence)
- `00-cover-letter-EMAIL-BODY.md` + `.docx` — paste-as-email-body with attach-as-word alternative

**Iterations landed:**
- Merged Part 1 and Part 2 into a single walkthrough-structured zip matching Scott's ask
- Full IP-leak audit and rewrite: GPSA slimmed 1004→240 lines, WHAT-not-HOW throughout
- All runbooks removed; L2 evidence stripped to crypto artifacts only
- Entity naming fixed everywhere: "Docent LLC (dba Docent Technologies)"
- Every email address normalised to `scruple@docentechs.com`
- Next-steps softened per user (no live re-attestation commitment)
- Cover letter reads as an appendix, not a letter

**User action:** paste `00-cover-letter-EMAIL-BODY.md` into email, attach `.docx` or link Drive folder, send to `conformance@c2pa.org` addressing Scott Perry.

### 2. EU AI Office response

**Location:** `DevSpace / Scruple / EU AI Office — Provider Qualification Response 2026-07-16` in Drive
- https://drive.google.com/drive/folders/1GX5oMn_2CT-3UtZqwsQyUJfpfGQMFqIv

**Contents:**
- `scruple-eu-code-provider-qualification-2026-07-16.pdf` (196 KB) — appendix-format PDF
- `00-email-body.md` — short cover email

**Structure:** Section 1 provider qualification in dual capacity (third-party marking-technology vendor + provider of Scruple Studio as a generative AI system). Sub-measure 1.1.1/1.1.2/1.1.3 coverage table, 2 February 2027 interop commitment, SME/SMC proportionality invoked. Written after actually reading the Code text from the EU Commission PDF.

**Status:** SENT by user.

**Next:** await AI Office assessment. Follow-up questions likely; the fuller evidence bundle at `/data/scruple-web/docs/eu-ai-office/evidence-bundle-2026-07-14/` is on file if asked. Watch the 2 February 2027 interop deadline.

### 3. Fusion Stripe in-palette (WO-FUS-STRIPE)

**Commits:**
- `scruple-web` — `1573f17 feat(fusion): in-palette Stripe payment + shared price catalog`
- `scruple-fusion` — `5d99a52 docs: note in-palette payment pivot per WO-FUS-STRIPE`

**What landed:**
- `lib/pricing/actions.ts` — canonical action catalog (checkpoint $5 / C2PA $10 / chain-lock $100 basic $150 pinned)
- `app/api/stripe/config` — merges witness prices with catalog labels
- `app/api/lock/chain` — error message updated to new prices
- `components/fusion/PaymentSettingsPanel.tsx` (new) — card management (list / add / set-default / remove) using existing `AddPaymentMethodModal`
- `app/embed/fusion/FusionPalette.tsx` — Studio / Settings tabs; Settings mounts PaymentSettingsPanel with fee-gate warning
- `/opt/scruple-witness/server.js` — STRIPE_FEES bumped, `handleStripeConfig` returns actions

**Insight discovered mid-build:** payment collection was already in-palette (the Fusion palette IS scruple-web's React app in the Qt WebEngine, so `LockButtons` → `StripePaymentModal` already ran inline). This WO surfaced card management explicitly and centralised pricing rather than needing to build a new payment flow.

**User action required:** `sudo systemctl restart scruple-witness` (or equivalent) to load new prices. Then smoke by opening the Fusion palette and clicking the new Settings tab.

### 4. Blender addon (WO-BLENDER)

**Repo:** `/data/scruple-blender/` — 6 commits on `main`, local only.

**Ships:**
- `dist/scruple-blender-0.1.0.zip` (37 KB) — Blender Extensions format (4.2+) with `bl_info` fallback for 3.6/4.0/4.1
- N-panel in the 3D viewport sidebar (`SCRUPLE_PT_main`)
- Hooks `bpy.app.handlers.render_complete`, `render_write`, `save_post`
- 9 operators (auth, witness, witness_export, checkpoint, c2pa, chain_lock, open_receipt, payment_setup, resume_payment)

**Tests:**
- 81 pytest tests green (mock-bpy, hermetic, 4 sec)
- **16 real-Blender headless smoke checks green** via `xvfb-run -a blender --background --python tests/live/smoke_blender.py` on Blender 3.0.1 arm64 (`bd70309`)

**Session report:** `/data/scruple-blender/SESSION_REPORT_2026-07-17.md`

**User action required:**
1. `cd /data/scruple-blender && gh repo create Docenttx/scruple-blender --private --source=. --push`
2. Install zip in real Blender 4.2+ on user's x86_64 desktop
3. Walk 10-step smoke procedure in session report
4. Adobe Extensions catalog submission needs Blender ID (deferred)

### 5. Toon Boom Harmony addon (WO-TOONBOOM)

**Repo:** `/data/scruple-toonboom/` — 4 commits on `main`, local only.

**Ships:**
- `dist/scruple-toonboom-0.1.0.zip` (287 KB, 75 files) — filesystem-drop bundle
- Vendored OpenHarmony (trimmed to 1.3 MB) as ergonomic wrapper
- 12 lib modules + 4 UI modules + entry point in ES5 Qt Script
- HTTP client with pluggable transport (Qt / curl-shell / in-memory mock)
- Byte-for-byte identical canonical leaf as Blender / Fusion / Adobe (host tag = `toonboom`)
- Off-session Stripe with Qt-native confirm dialog + browser handoff for card entry
- Handlers for save / render / export / scene change
- Dockable panel, Scripts menu, toolbar spec
- Installer scripts for macOS + Windows

**Tests:** 128 pass in ~1 sec (`node tests/run.js`), hermetic mock-Harmony.

**Session report:** `/data/scruple-toonboom/SESSION_REPORT_2026-07-16.md`

**User action required:**
1. `cd /data/scruple-toonboom && gh repo create Docenttx/scruple-toonboom --private --source=. --push`
2. Copy zip to Harmony Premium 21+ workstation
3. Run installer script or drop `Scruple/` into scripts folder per OS
4. Restart Harmony, `Scripts → Scruple → Settings`, sign in, set up payment
5. Verify Harmony signal names on real Harmony (session report flags possible variance across versions)

### 6. Meshroom plugin (WO-MESHROOM)

**Repo:** `/data/scruple-meshroom/` — 3 commits on `main`, local only.

**Ships:**
- `dist/scruple-meshroom-0.1.0.zip` (29 KB, 24 files) — drops into `~/.meshroom/nodes/`
- Two nodes: `ScrupleWitness` (free) and `ScrupleC2PA` (paid; writes `<name>.c2pa.<ext>` sidecar)
- `lib/` ported line-for-line from Blender addon
- Three menu items via `CommandsManager` (guarded on UI presence): Sign in / Set up payment / Verify recent output

**Tests:** 98 pytest tests green (~4 sec), hermetic mock-Meshroom.

**Session report:** `/data/scruple-meshroom/SESSION_REPORT_2026-07-16.md`

**User action required:**
1. `cd /data/scruple-meshroom && gh repo create Docenttx/scruple-meshroom --private --source=. --push`
2. Extract zip to `~/.meshroom/nodes/`
3. Launch Meshroom, verify `ScrupleWitness` + `ScrupleC2PA` appear in node graph
4. Menu: Scruple → Sign in, then Scruple → Set up payment
5. Drop `ScrupleWitness` after any `Publish` / `Texturing` / `MeshFiltering` node, run pipeline (F5)
6. Test `ScrupleC2PA` with `autoConfirm=true` on JPEG/PNG input
7. Wire real C2PA signer via `SCRUPLE_C2PA_SIGNER=<module.callable>` env var (currently byte-copy placeholder)

### 7. NAVSEA NV059 SBIR strategic assessment

**Two-pass review:**

Pass 1 (literal audit): Not a fit as a lead proposal. 1 of 4 required components after a fork. Missing MFA, micro-segmentation, ML anomaly detection.

Pass 2 (concept-transfer reframe, per user's correction): **Viable if pitched as tamper-evident DDIL-resilient audit substrate** teamed with commercial best-in-class MFA / PDP-PEP / anomaly-detection. Scruple's IP is the cross-cutting integrity spine that makes all four required components auditable + disconnected-operable + cross-ship-verifiable.

**MTC-A/X deployment context confirmed:** afloat/expeditionary, contested comms, incumbent prime is Northrop Grumman.

**User decision required (5-day clock):**
- **Bid** with concept-transfer framing: ~2 days drafting proposal narrative, 1 day tightening, 2-3 days for user to secure teaming letter + credible sponsored-FCL path
- **No-bid** and save 6 days for other workstreams

**Deadline:** 22 July 2026.

### 8. Plugin roadmap WOs on file

- `docs/wo/2026-07-16-after-effects-shell.md` — After Effects UXP fork of Photoshop plugin, blocked on Adobe developer account
- `docs/wo/2026-07-16-realitycapture-wrapper.md` — Windows CLI wrapper + file-watcher (no in-app UI possible), held pending VFX-partnership demand
- `docs/wo/2026-07-16-toonboom-shell.md` — executed tonight
- `docs/wo/2026-07-16-meshroom-shell.md` — executed tonight
- `docs/wo/2026-07-16-blender-shell.md` — executed prior
- `docs/wo/2026-07-16-fusion-stripe-in-palette.md` — executed tonight

---

## What needs to happen for end-to-end success, per workstream

### C2PA — SEND IT

Only step: user pastes cover letter, attaches docx or links Drive folder, sends to `conformance@c2pa.org`. Then wait for Scott's assessment queue. Weeks of latency expected.

Downstream: when Trust List CA CSR clears (DigiCert Content Credentials or SSL.com C2PA Signer), swap the dev cert in the signer service for the production cert. No code change; single file swap.

### EU AI Office — ALREADY SENT

Await AI Office assessment. Expect at least one follow-up question. The fuller evidence bundle at `docs/eu-ai-office/evidence-bundle-2026-07-14/` is on file if asked. Watch the 2 February 2027 interoperability deadline for Sub-measure 3.4(c) cross-signatory detection.

### Fusion Stripe — SMOKE + DEPLOY

1. `sudo systemctl restart scruple-witness` on the Oracle host to load new STRIPE_FEES
2. Verify `curl http://127.0.0.1:5799/api/stripe-config` returns the new `actions` object
3. Open Fusion palette on a live install, click Settings tab, verify `AddPaymentMethodModal` mounts
4. Add card if none, verify fee-gate warning disappears
5. Trigger Checkpoint from WorkspaceView, confirm the price shows in `StripePaymentModal`
6. Deploy scruple-web changes to production `scruple.stooges.ai` when green

### Blender — PUSH + SMOKE + DISTRIBUTE

1. Push repo: `cd /data/scruple-blender && gh repo create Docenttx/scruple-blender --private --source=. --push`
2. Install `dist/scruple-blender-0.1.0.zip` in real Blender 4.2+ on user's x86_64 desktop
3. Enable "Scruple" addon, sign in via browser handshake
4. Set up payment on `scruple.ai/settings/payment`
5. Open a `.blend`, render, verify N-panel shows the render receipt
6. Click Checkpoint / C2PA / Chain-lock, verify charges + witness leaves land
7. If E2E green: submit to Blender Extensions catalog (needs user's Blender ID)

### Toon Boom Harmony — PUSH + SMOKE + DISTRIBUTE

1. Push repo: `cd /data/scruple-toonboom && gh repo create Docenttx/scruple-toonboom --private --source=. --push`
2. Copy `dist/scruple-toonboom-0.1.0.zip` to Harmony Premium 21+ workstation (macOS or Windows)
3. Run installer script per OS OR drop `Scruple/` into version-specific scripts folder
4. Restart Harmony, `Scripts → Scruple → Settings` for sign-in and payment setup
5. Save/export a scene, verify witness leaves land
6. Verify Harmony signal names on real Harmony (documented gap: names vary per version)
7. Distribute via GitHub release + docs page on `scruple.ai` (no marketplace exists)

### Meshroom — PUSH + SMOKE + WIRE REAL C2PA SIGNER

1. Push repo: `cd /data/scruple-meshroom && gh repo create Docenttx/scruple-meshroom --private --source=. --push`
2. Extract `dist/scruple-meshroom-0.1.0.zip` to `~/.meshroom/nodes/`
3. Launch Meshroom, verify both nodes appear
4. Sign in + set up payment via menu
5. Drop `ScrupleWitness` after any Publish/Texturing/MeshFiltering node, run pipeline
6. Test `ScrupleC2PA` with `autoConfirm=true` on JPEG input
7. Wire real C2PA signer (currently byte-copy placeholder): set `SCRUPLE_C2PA_SIGNER=<module.callable>` env var pointing at c2pa-rs or c2pa-python binding

### After Effects — WAITING ON ADOBE

WO on file. Blocked on Adobe developer account (same gate as WO-PHOTOSHOP P7). Once unblocked, ~2-3 days autonomous build via fork of Photoshop plugin. 60% code reuse.

### RealityCapture — HELD

WO on file. No in-app plugin API — wrapper only. Skip unless a specific VFX-house partnership demands it.

### NAVSEA NV059 SBIR — DECIDE

User decision. If bid, ready to draft Phase I proposal narrative (Objective, Technical Approach, Work Plan, Team & Facilities, Related Work, Commercialization) in a focused session. If no-bid, close the workstream.

### Adobe Photoshop — USER-DRIVEN DEBUG

User's stated next task. Plugin at `/data/scruple-adobe/apps/photoshop/` is ready for E2E smoke pending Adobe account access.

---

## Cross-cutting known gaps

### C2PA signer wiring (Meshroom)

Currently byte-copy placeholder + `.c2pa` sidecar marker. Real distribution requires wiring `c2pa-rs` or `c2pa-python` via `SCRUPLE_C2PA_SIGNER` env var.

### `scruple://` URL scheme registration

Not OS-registered for any plugin. Local HTTP callback fallback works everywhere but requires user to manually complete browser handoff. Auth installer polish TODO across all plugins.

### Live scruple-web integration tests

All plugin test suites are hermetic (mocked). No `pytest -m live` fixture yet. Cheap to add when the first plugin distributes publicly.

### Harmony signal name confirmation

Toon Boom signal names vary per Harmony version. Real-Harmony smoke needed to confirm we're hooking the right signals.

### Extensions catalog submissions

- Blender Extensions catalog — needs user's Blender ID
- Adobe Marketplace — weeks of review after upload (deferred until AE ships)
- Toon Boom — no marketplace, filesystem drop is ecosystem norm
- Meshroom — no marketplace, filesystem drop; distribute via GitHub release

### Witness server restart

`/opt/scruple-witness/server.js` STRIPE_FEES edited in-place tonight. Service restart required for new prices to take effect: `sudo systemctl restart scruple-witness`.

---

## Files that persist across compaction

All repository state on disk survives:
- `/data/scruple-web/`
- `/data/scruple-fusion/`
- `/data/scruple-blender/`
- `/data/scruple-toonboom/`
- `/data/scruple-meshroom/`
- `/data/scruple-adobe/`
- `/data/scruple-photoshop/`
- `/opt/scruple-witness/`

Memory files under `/home/ubuntu/.claude/projects/-data-ai-council-ai-council/memory/` are durable.

Per-repo session reports and this landing report at `/data/scruple-web/docs/session-reports/2026-07-16-overnight-landing.md` are durable.

WO files under `/data/scruple-web/docs/wo/2026-07-16-*.md` are durable.

Drive folder state (C2PA + EU response bundles) is durable.

---

## Morning priority order

1. **Send C2PA response** — user action, unblocks Scott's assessment queue (weeks of downstream latency)
2. **Restart witness server** — one command, unblocks Fusion Stripe live
3. **Push three plugin repos to GitHub** — three `gh` commands
4. **Decide NAVSEA bid/no-bid** — 5-day clock ticking
5. **Debug Photoshop plugin** — user's stated next task
6. **Smoke Blender addon on desktop Blender** — user-side x86_64 machine
7. **Smoke Toon Boom addon** on Harmony workstation
8. **Smoke Meshroom plugin** on user's Meshroom install

---

## Ready-to-execute WOs on file (no re-planning)

Both self-contained, can spawn autonomous agents identical to the Blender / Toon Boom / Meshroom pattern:

- `docs/wo/2026-07-16-after-effects-shell.md` (blocked on Adobe account)
- `docs/wo/2026-07-16-realitycapture-wrapper.md` (held, no-priority)
