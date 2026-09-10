# Where Desktop Studio actually is, and why the G series exists

_2026-09-10. Written after the founder saw the app running on the travel laptop
and found the tabs missing._

## 1. What went wrong

WO-D5 was given "port the canon design into the shared theme, render from
capabilities". It produced `app/studio/page.tsx` + three components — **604 new
lines** rendering `capture-gate`, `cloud-compute`, `host`, `local-apps`,
`machine-tiers`, `model-store`. A diagnostics panel.

`main-modular.js` was reduced to one `BrowserWindow` pointed at that page. So the
running app shows **neither the legacy desktop UI nor Web Studio's UI** — it shows
a third thing that exists in neither product.

🔴 **And I signed it off.** I verified the canon stylesheets were `cmp`-identical
to `app-legacy/renderer/styles/` and reported "the canon design came across".
That was true of the CSS and silently false of the interface. **I verified the
part that was easy to verify and let it stand for the part that was asked about.**

### Why it drifted, which is the part that must not repeat

The settled decision was **"one UI, served"**. But a tabbed shell embedding a
**locally running** ComfyUI cannot be a served page — Web Studio has no local
ComfyUI to embed. The constraint and the product were incompatible, and the work
order resolved it by dropping the product.

⚑ **The correction: "one UI, served" governs PANELS, not the SHELL.** Electron
owns the tab bar, the webview containers and the project directory, because only
it has local apps to embed. The contents of Workspace, Wallet and receipts are
served pages the web shares. `/studio` becomes a panel inside Workspace, not the
application.

### And the reason this was expensive

**The UI is the hardest part, because it is user friction and understanding.**
The legacy interface is the accumulated answer to how a person understands what
provenance is doing for them — which tabs exist, what the main window says about
the tracked project, when checkpoint versus lock versus mint makes sense, what
the sidebar is for. The CSS was the cheap part and it is the only part that got
checked. **An architecture-convenience argument overrode a user-understanding
artifact.**

## 2. What we still have — nothing was destroyed

`app-legacy/` is **53 files, untouched by every commit** since the fork baseline
`0be2a2b`. Verified: `git log 0be2a2b..HEAD -- app-legacy/` is empty.

It contains the product:

| | |
|---|---|
| tabs | ComfyUI · Kohya_ss · Workspace · Wallet (fiat) · Wallet (blockchain), gated on `comfyUIEnabled` / `kohyaEnabled` |
| containers | `comfy-webview-container`, `kohya-webview-container`, `workspace-container`, `wallet-container` |
| main window | the currently tracked project, and checkpoint / lock / mint |
| sidebar | **a directory of projects** — `active-project-section`, `project-list`, `sidebar-footer` |

## 3. The Electron 38 port is probably small

Measured against the legacy `main-modular.js` and renderer:

| risk | finding |
|---|---|
| `nodeIntegration` | **already `false`** |
| `contextIsolation` | **already `true`** |
| `remote` module (removed in E14) | **0 uses** |
| `<webview>` tags | 2, and `webviewTag` is **already enabled** in main |
| declared dep | `electron ^29.1.0` → 38 is nine majors, but every pattern that usually breaks is already absent |

So G1 is expected to be "wire it back up and fix what the console says", not a
rewrite. **That expectation is a hypothesis and G1's first act is to test it.**

## 4. What plugs in underneath, already built and proven

None of this required replacing the front end:

- the capture gate in the path, with **model fingerprints computed from the model
  FILES** (`model-swap` moves the fingerprint and nothing else)
- the vault as a capture surface — declared MIME, counted ceiling, refusals recorded
- the host hook — Level 1 blind / Level 2 supplied / declined, gate unchanged
- `imported_datablocks` — what entered a scene from outside, with digests (WO-F3)
- the C2PA certificate-key guard (WO-E1), the capture-loss fix (WO-F2),
  `merkle_algorithm` on stored roots (WO-F4)

## 5. The standard, so the G series checks against it instead of re-deriving it

- **Standard v1.7 §9.1** — C2PA content credentials: in-band signed metadata.
- **Standard v1.7 §9.2** — EU-compliant watermarking: an imperceptible mark whose
  payload encodes a signing timestamp, recoverable from pixels alone.
- ⚑ **They are PEERS.** Both satisfy **EU AI Act Article 50 Code of Practice,
  Section 1 mandatory marking measures**. Watermarking is **not** part of C2PA and
  must not borrow its conformance.
- **`CANONICAL_SCRUPLE_WITNESSING_L2` §5.1** — signing is `Signer.from_callback`
  with the OCI Vault Sign API and **`certs=` the production cert chain**. No raw
  key in process.
- 🔴 **§5.3 is NOT BUILT**: no `sign_daemon.py`, no `scruple-c2pa-signer.service`,
  no dedicated `scruple-signer` user, no Unix socket. The Node user can currently
  reach what §5.3 exists to put out of its reach. Also missing: the pre-commit
  hook rejecting PEMs under `keys/` (§5.2), and `SCRUPLE_C2PA_CERT_CHAIN` has zero
  references in the tree.

## 6. The rule for the G series

**The interaction model is fixed; only what is underneath changes.** Same tabs,
same main-window actions, same sidebar role. A UI change happens only if a user
understands something *better* — "our architecture prefers it" is not a reason.
Every gate below compares against the legacy set and **enumerates any difference**,
so a silent drift like D5's cannot pass again.
