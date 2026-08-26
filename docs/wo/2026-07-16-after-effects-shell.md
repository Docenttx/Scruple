# WO-AFTEREFFECTS — Scruple for Adobe After Effects (UXP plugin)

## Status
- **Started:** TBD
- **Owner:** claude
- **Prereq:** **BLOCKED** on Adobe Creative Cloud developer account (same blocker as
  WO-PHOTOSHOP P7). Once that unblocks, this WO ships in ~2-3 days.
- **Target end state:** installable `.ccx` (or manual `.zxp` for pre-Marketplace) UXP
  plugin that panels into After Effects, hooks composition renders and Media Encoder
  exports, hashes the output, and produces a signed leaf. Same offline-first, off-session
  payment shape as the Blender addon.

## Why this target

- HIGHEST direct-hit for EU AI Act Article 50(4) — deepfake disclosure applies to every
  AI-manipulated video output. AE is where a huge fraction of that content is finished.
- DSA cascade — every video shipped to social platforms inherits VLOP labelling requirements.
- Buyer profile: ad agencies, political-comms shops, broadcast studios. Companies with
  active general counsel who have read the AI Act carefully. Willing-to-pay is high.
- Same UXP infrastructure as the shipped Photoshop plugin — enormous code reuse.

## What's in vs. out of scope

**In (once Adobe account unblocks):**
- Fork the existing `/data/scruple-adobe/apps/photoshop/` UXP plugin.
- Update manifest to target Adobe After Effects.
- Rewire save/export hooks: AE fires `app.onQueueRender`, `app.onRenderComplete`,
  composition save events. Different API surface than Photoshop but same shape.
- Panel UI adjusted for AE dimensions.
- Full mock-UXP test suite.

**Out:**
- Live testing in real AE (requires user's Adobe subscription).
- Marketplace submission (weeks of Adobe review after upload).
- Motion Graphics Templates support (out of shell scope; add-on).

## Reference patterns

- `/data/scruple-adobe/apps/photoshop/` — full UXP plugin shipped. Manifest, panel, save
  hooks, auth handshake, HTTP client — all port with minimal surgery.
- `/data/scruple-adobe/apps/illustrator/`, `/data/scruple-adobe/apps/indesign/` — sibling
  ports, same pattern.
- `/data/scruple-blender/` — the canonical scruple-web integration reference (auth flow,
  price catalog, payment flow).

## After Effects UXP surface

- Target **After Effects 24+** (UXP is the modern surface; ExtendScript is legacy).
- Manifest declares host: `AEFT`, min version.
- Event hooks in scope:
  - `app.onQueueRender` — batch render start.
  - `app.onRenderComplete` — a render finished.
  - Composition save via `app.onDocumentDidClose` and `app.onDocumentBeforeSave` (verify
    exact names in Phase 0).
  - Media Encoder AME queue events for encoded output hashing.
- Panel: same HTML/CSS/JS pattern as our Photoshop panel.

## Phase map

### Phase 0 — Discovery + fork

- [ ] Fetch UXP for AE docs (`developer.adobe.com/photoshop/uxp/2022/`, After Effects section).
      Confirm event API surface and any AE-specific gotchas.
- [ ] Fork `/data/scruple-adobe/apps/photoshop/` into `/data/scruple-adobe/apps/after-effects/`.
- [ ] Update `manifest.json`: host = `AEFT`, entrypoint, min version.
- [ ] Rename plugin id per Adobe convention.

### Phase 1 — Event hooks

- [ ] Replace Photoshop save-hook with AE render/queue/composition hooks.
- [ ] Confirm output path capture for both direct render and AME-piped exports.

### Phase 2 — Panel UI adjustments

- [ ] Adjust panel dimensions for AE's Panel container.
- [ ] Add composition-selector dropdown (AE-specific; not needed in Photoshop).
- [ ] Reuse the same payment / settings / status components from the Photoshop plugin.

### Phase 3 — Client + auth (reuse)

- [ ] Port the auth handshake + HTTP client verbatim.
- [ ] Confirm CSP / permissions in the manifest match Photoshop's shipped values.

### Phase 4 — Mock harness + tests

- [ ] `tests/mocks/uxp_aeft_mock.js` — fake `app`, `Composition`, `RenderQueue`.
- [ ] Coverage: render-complete hash, composition-save leaf, panel state, payment flow.
- [ ] Aim for ≥50 tests green.

### Phase 5 — Packaging

- [ ] `build/build_plugin.sh` produces `dist/scruple-after-effects-<version>.zxp` (for
      manual install) and `.ccx` skeleton (for Marketplace submission).
- [ ] Include signing step if the user provides an Adobe cert; otherwise dev-signed with
      a warning.

### Phase 6 — Docs + morning handoff

- [ ] `docs/install-quickstart.md` — either UXP Developer Tool sideload OR manual `.zxp`
      via ZXPInstaller.
- [ ] `docs/architecture.md`, `README.md`.
- [ ] Session report with morning smoke procedure once user has Adobe account.

### Phase 7 — Session report + memory + commit

- [ ] Commit sweep. Session report. Memory entry + MEMORY.md link.

## Non-goals

- Marketplace submission (weeks of Adobe review; deferred).
- Motion Graphics Templates provenance (add-on for later).
- Live smoke in AE (blocked on Adobe account; documented as morning task).

## Effort estimate

**~2-3 days autonomous** once unblocked. Roughly 60% code reuse from Photoshop plugin.

## Blocker

Adobe Creative Cloud developer account with an active Photoshop / AE subscription. Same
gate as WO-PHOTOSHOP P7. When either resolves, this WO can execute immediately.
