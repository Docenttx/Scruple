# WO series G — the existing app, updated; then Blender

_2026-09-10. Read `docs/G-SERIES-REPORT.md` first. It records why the D5 rewrite
was wrong and what the legacy app actually contains._

## The rule that governs every work order here

🔴 **The interaction model is fixed; only what is underneath changes.** Same tabs,
same main-window actions (checkpoint / lock / mint on the currently tracked
project), same sidebar role (a directory of projects). **A UI change happens only
if a user understands something better** — "our architecture prefers it" is not a
reason, and it is the reason D5 went wrong.

**The UI is the hardest part because it is user friction and understanding.** The
legacy interface is years of that, discovered and removed. Treat it as the spec,
not as old code.

⚑ **"One UI, served" governs PANELS, not the SHELL.** Electron owns the tab bar,
the webview containers and the project directory. `/studio`'s capability regions
become a panel inside Workspace — not the application.

## Standing rails — unchanged

🔴 Never modify `/opt/scruple-witness`; never contact `127.0.0.1:5799` or `:3001`.
The surrogate is SOFTWARE-backed: `passthrough`/`stale`, never `verified`. Do not
flip `CHECKPOINT_VECTORS_SETTLED`. Verify by side effect; every gate names an
observable AND a control that must not fire; controls RED before and green after;
**an inconclusive control is never a pass**. If a gate does not pass, say so and
KEEP THE WORK. Do not edit a shell script while bash is running it.

⚑ **Check claims against the standard, do not re-derive them.** Required reading
before any C2PA or watermark work: `/data/scruple-web/docs/architecture/SCRUPLE_STANDARD_v1_7.md`
§9 and §12, and `/data/scruple-web/docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md`
§4–§5. Watermarking is **§9.2, EU AI Act Article 50 Code of Practice** — it is the
PEER of C2PA §9.1, not part of it, and must never borrow C2PA's conformance.

---

## WO-G1 — the legacy app runs again, on Electron 38

`app-legacy/` is the app. Make `main-modular.js` render it — the real tab bar,
the real webview containers, the real project sidebar — instead of pointing one
bare window at a served page.

The Electron 38 port is expected to be small and **that expectation is a
hypothesis you test first**: the legacy app already has `nodeIntegration: false`,
`contextIsolation: true`, **zero** uses of the removed `remote` module, and
`webviewTag` already enabled for its 2 `<webview>` tags. It declares
`electron ^29.1.0`; we run 38.

**Gate:** the app opens and the tab set is **exactly** ComfyUI · Kohya_ss ·
Workspace · Wallet(fiat) · Wallet(blockchain), the sidebar lists projects, and the
main window shows the tracked project with checkpoint / lock / mint.
**Controls:** (a) **enumerate every difference from the legacy set and justify
each one** — a silent drift is what D5 was, and an unexplained difference fails
this gate; (b) a tab whose app is not running is **absent, not empty** — the
`comfyUIEnabled` / `kohyaEnabled` gating is existing behaviour, preserve it;
(c) the D-series scenarios (`ping`, `vault-capture`) still pass, so the shell
change did not break the capture path.

Report what the port actually required. If it was more than console fixes, say so
plainly — the estimate above is mine and it may be wrong.

## WO-G2 — L2 C2PA and EU watermarking, live in the app, to the current standard

Wire the app's existing checkpoint / lock / mint actions to the **current** L2
path. The buttons do not change; what happens underneath them does.

**C2PA (§9.1):** signing through `Signer.from_callback` with the Vault Sign API
and `certs=` the **production cert chain** (`CANONICAL_L2 §5.1`). WO-E1's guard
must hold — the certificate's public key is proved to be the signing key by an
`es256-challenge`, and a mismatch is a **refusal with a code**, never a warning.

**Watermarking (§9.2):** the imperceptible mark whose payload encodes a signing
timestamp. `lib/watermark/apply.ts` already runs at lock time in the web flow
(watermark → witness each derivative → build the Merkle → finalize). Bring the
desktop lock path onto the same implementation. **Verify the payload against
§9.2.4 rather than assuming it** — that check has not been done.

🔴 **Also close what `CANONICAL_L2 §5.2/§5.3` require and the tree does not have:**
no `sign_daemon.py`, no `scruple-c2pa-signer.service`, no dedicated
`scruple-signer` user or Unix socket — so the Node user can reach what §5.3 exists
to put out of its reach. Also missing: the pre-commit hook rejecting PEMs under
`services/c2pa-signer/keys/`, and `SCRUPLE_C2PA_CERT_CHAIN` (zero references;
the code uses `SCRUPLE_C2PA_CERT`). If §5.3 is too large for this WO, **build the
socket daemon and say what is left**, rather than silently scoping it out.

**Gate:** a lock performed **from the app's own UI** produces (i) a C2PA
credential that reads valid via `get_validation_state()` — never `is_valid`,
which is unreliable — and (ii) a watermarked derivative whose payload the
detector recovers from the pixels alone. **Controls:** (a) with the certificate
and signing key mismatched, the sign is REFUSED and no output asset is written;
(b) with the surrogate stopped the signature FAILS with no fall back to a local
key; (c) an unwatermarked artifact must be distinguishable from a watermarked one
by the detector — a detector that always says "found" proves nothing.

## WO-G3 — the travel laptop tests it

Hand G1+G2 to the Windows rig. This work order is **not ours to execute** — it is
the handoff, and the founder authorizes the laptop directly.

Provide: what to install, what to click, and what each button should do. **The
laptop is the first human use of this app.** Everything before it was driven by
scripts, which is exactly how D5's missing tabs survived seven work orders.

**Gate:** a person completes pick-a-project → work in a tab → checkpoint → lock →
see the root, on Windows, without reading source. **Control:** every point where
they had to ask what something meant is a finding, recorded in
`docs/FINDINGS-WIN.md`. **User friction IS the finding here**, not a distraction
from it.

## WO-G4 — the Blender tab

Add Blender alongside ComfyUI and Kohya. **Copy the existing pattern exactly**: a
view-toggle button, a container, and the same enabled-gating. No new interaction
concept — a new concept is new friction, and the user already knows this shape.

**Gate:** the Blender tab appears when Blender is present and the container loads
it. **Controls:** (a) absent when Blender is not installed, matching
`comfyUIEnabled` behaviour — **absent, not greyed**; (b) the other tabs are
unchanged, asserted by diff, not by eye.

## WO-G5 — the new Scruple Blender plugin

The current addon (`/data/scruple-blender`) was built for the standalone product.
Rebuild it for the tab: it runs inside a Blender the app launched, alongside a
gate the app owns.

⚑ **Read `project_scruple_vendor_standard_strategy_2026_08_29` first.** The
plugins are a **different market from Studio**: *proof that something was created
WITHOUT AI*. That changes the design — **proving absence is harder than proving
presence, a sparse record proves nothing, and continuity is the evidence.**
Fusion's `auto_witness` is the correct pattern; **Blender's manual triggers are a
known weakness.** Standard **§4** ("changing an integration is itself a witnessed
event") becomes load-bearing: the baseline must cover **the host app's plugin
set**, not just ours.

🔴 The addon currently names **no `digitalSourceType` anywhere**, and
`sign.py` now requires it with no default. For a plugin whose claim is *no AI*,
that field IS the claim: `digitalCapture` / `humanEdits` /
`compositeWithTrainedAlgorithmicMedia` as appropriate — never
`TRAINED_ALGORITHMIC_MEDIA`.

**Gate:** a human-made Blender render is signed asserting a non-AI
`digitalSourceType`, and the baseline records the host's full plugin set.
**Control:** installing any other addon changes the baseline and is itself
witnessed — demonstrate it, because that is the mechanism the no-AI claim rests on.

## WO-G6 — how a user modifies a `.blend` by hand, and how likely that is

**Investigation, not a build.** Before the bridge claims to witness objects
entering a scene, establish what a person can do to a `.blend` outside our view.

Answer with evidence: what can be edited by hand or by script (`bpy` from the
console, the Text Editor, drivers, linked libraries, `--python-expr`, appending
from another file, packing/unpacking images)? Which of those change an artifact
without passing any handler our addon hooks? Which are **normal artist workflow**
versus **deliberate evasion** — and how would a record distinguish them?

**Gate:** a written enumeration with a worked example of each class, and for each
one whether the current addon would notice. **Control:** at least one case must be
found that the addon does NOT notice, or the investigation is not finished — a
survey that concludes "we see everything" has not looked hard enough.

## WO-G7 — witness every object ported from ComfyUI into Blender

Finish the bridge **through the Electron plumbing**. Today the correlation is
ComfyUI's `prompt_id` and nothing else (E4-5), an unmodified bridge never
announces (E6-1), and the id does not exist until `/prompt` answers.

`docs/E6-1-INVERT-THE-ANNOUNCEMENT.md` is the design: **the gate already parses
`prompt_id` out of the buffered `/prompt` response** (`http-gate.ts:227-234`)
before the bridge is handed it, so the gate can ASK the adapter rather than wait
to be told. Now that the app owns both ends, the app is the natural asker.

**Gate:** an image generated in the ComfyUI tab and brought into the Blender tab
produces a leaf binding **that** artifact's bytes to **that** scene object —
`imported_datablocks` (WO-F3) is the field; the app supplies the link the wire
cannot. **Controls:** (a) an object imported from **outside** the app is recorded
as imported with **no** claim about its origin — the honest case must stay
honest; (b) two different generations produce two different bindings; (c) a
generation whose artifact never reaches Blender leaves no scene binding at all.

⚑ **This is where "we witness every object ported from ComfyUI to Blender" becomes
true or is shown to be false.** If some transfer path cannot be witnessed, that is
the finding, and it belongs in the report rather than outside the claim.
