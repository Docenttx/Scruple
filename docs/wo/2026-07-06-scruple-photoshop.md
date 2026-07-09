# WO-PHOTOSHOP — Scruple for Adobe Photoshop (Fusion pattern clone)

## Status
- **Started:** 2026-07-06 (overnight autonomous run, after WO-KOHYA)
- **Owner:** claude (autonomous)
- **Blocker for real signing + install:** user must provide Adobe Creative Cloud
  developer account + Photoshop subscription (for testing)

## Context
- Studio apps live: **Canvas** (ComfyUI on Modal), **Fusion** (Autodesk add-in)
- Photoshop = new local-tool app parallel to Fusion. Same value prop:
  every save produces a witnessed leaf; user gets a receipt for every
  significant edit or export.
- Fusion source at `/data/scruple-fusion/ScrupleFusion.py` is the reference:
  Python + palette + documentSaved handler + witness POST, disk-cached auth,
  session=latest fallback, URN dedupe, C2PA hook.
- **Photoshop extensibility today = UXP** (Unified Extensibility Platform).
  Replaces CEP. UXP plugins are JS + HTML, packaged as `.ccx` (Adobe
  Marketplace) or `.zxp` (legacy). Adobe requires signing for install.
- Photoshop's UXP API exposes `photoshop.core.documentAdded`, `document.save`
  callbacks, `photoshop.action.batchPlay` for scripting. Save-hook capture is
  the primary provenance surface.

## Phase map

### Phase 0 — Discovery + design

- [ ] Read `/data/scruple-fusion/ScrupleFusion.py` end-to-end. Enumerate every
      pattern that transplants: auth handshake, session=latest, disk cache,
      URN dedupe, active-project follow, checkpoint/lock/c2pa buttons.
- [ ] Fetch Adobe UXP for Photoshop docs (developer.adobe.com/photoshop/uxp).
      Confirm: file save event name, how panels are structured, how a UXP
      plugin persists a small config file across launches (`storage.localStorage`
      or `os` module writing to a known dir).
- [ ] Design doc `docs/architecture/scruple-photoshop.md`: divergences from
      Fusion (JS vs Python, panel HTML vs Neutron, PSD saves vs Fusion
      documentSaved).

### Phase 1 — UXP plugin skeleton

- [ ] `/data/scruple-photoshop/` — new sibling repo alongside `scruple-fusion`
- [ ] `manifest.json` — plugin metadata, entry points, requiredPermissions
      (`launchProcess`, `network`, `localFileSystem` = "plugin"),
      `manifestVersion: 5` (UXP 5.x)
- [ ] `index.html` — panel shell (matches Fusion palette shape)
- [ ] `main.js` — plugin entry, event registration, IPC to panel
- [ ] `panel.js` — the palette UI logic
- [ ] `styles.css` — reuse crimson wordmark + cyan accent from web Studio

### Phase 2 — Auth handshake (Fusion pattern port)

- [ ] Server-side: reuse `/api/scruple/handoff` and `/api/scruple/mint-api-key`
      endpoints (already exist for Fusion). Add
      `product='photoshop'` capable
      variants where product distinction matters.
- [ ] Plugin side: on first launch, spawn user's browser to
      `https://scruple.stooges.ai/auth/photoshop?session=<uuid>`. User signs
      in, server drops the API key into a handoff slot. Plugin polls
      `/api/scruple/handoff?session=<uuid>&product=photoshop&session=latest`
      for the slot (with `session=latest` fallback for cached-URL cases).
- [ ] Persist the API key to plugin storage. On subsequent launches, no
      handshake — just use the cached key.
- [ ] `heartbeat` similar to Fusion pings `/api/scruple/handoff/heartbeat`
      every 60s so we know the plugin is alive.

### Phase 3 — Save-hook provenance capture

- [ ] Register `photoshop.action.batchPlay` listener for the `save` command.
      Extract:
    - PSD file bytes (or PNG/JPG on export)
    - Layer count + layer names (structural summary)
    - Doc dimensions + color profile
    - Any embedded metadata (XMP, IPTC)
- [ ] Compute sha256 in-plugin (UXP has `crypto.subtle`).
- [ ] POST to `/api/scruple/witness/photoshop` with body:
    ```
    { fusion_data_id? (nope), product: 'photoshop', session_id,
      output_hash, structural_summary, file_size, filename }
    ```
- [ ] Server pipes to the existing witness server → leaf hash → signature →
      chain-prev-hash. Same v2.2 leaf scheme.

### Phase 4 — Palette UI

- [ ] Projects list (max-h scrollable, 6-visible pattern from Fusion palette)
- [ ] Active project pill (green when linked, grey when not)
- [ ] Recent witnessed edits list (last N)
- [ ] Buttons: **Checkpoint** (calls `/api/lock/checkpoint`), **Lock**
      (`/api/lock/local`), **Chain Lock** (`/api/lock/chain`), **Sign C2PA**
      (calls `/api/scruple/c2pa/sign` — button lives, wire up if picker exists)

### Phase 5 — File-tree helpers (nice-to-have)

- [ ] Auto-bind a PS document to a project by hashing the file path or a
      hidden metadata key. Similar to Fusion's URN dedupe.
- [ ] "Open in Scruple Web" button — deep-link to
      `https://scruple.stooges.ai/projects/<id>`.
- [ ] Import an image from Drive picker (reuse LinkagePicker infra) —
      creates the layer in Photoshop.

### Phase 6 — Packaging + signing

- [ ] Adobe UXP Developer Tool build config
- [ ] `.ccx` package for distribution
- [ ] Signing key config (Adobe cert or self-signed for dev)
- [ ] Adobe Creative Cloud Marketplace listing prep (later)

### Phase 7 — E2E smoke (BLOCKED on Adobe dev account)

- [ ] User installs UXP Developer Tool on their Photoshop machine
- [ ] Load the plugin as a dev extension
- [ ] Create a new PSD, save it — verify witness POST arrives at server,
      leaf hash returned, iteration row appears in the Scruple web project
- [ ] Chain-lock the project, view receipt

## Files touched (planned)

- `/data/scruple-photoshop/` (new repo)
  - `manifest.json`
  - `index.html`
  - `main.js`
  - `panel.js`
  - `styles.css`
  - `README.md`
  - `install-dev.md`
- `/data/scruple-web/app/api/scruple/witness/photoshop/route.ts` (new)
- `/data/scruple-web/app/auth/photoshop/page.tsx` (new — handshake page)
- Existing `/api/scruple/handoff` — teach it about `product='photoshop'`

## Sequencing note

Phases 0–4 can be built without an Adobe subscription (I can write the plugin
code, but not test it). Phase 5 is nice-to-have. Phase 6 needs signing. Phase 7
needs Adobe dev account. Progress until blocked, hand off with a working
"install as unsigned dev extension" doc.
