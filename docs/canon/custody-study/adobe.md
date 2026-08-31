# Adobe — what the mechanisms actually are

_Custody study for the `asset-custody` capability class. 2026-08-31._
_Binds: `CUSTODY_LOCUS.md`, `CAPABILITY_CLASSES.md`, `PLACEMENT_AND_SURFACES.md`._
_Subject: Photoshop's History panel and History Log, Lightroom/Camera Raw
non-destructive edit stacks, Creative Cloud version history, and Content
Credentials (C2PA) — measured against `/data/scruple-adobe/` and
`services/c2pa-signer/`._

## Bottom line

Adobe has three separate edit records and **not one of them is a history that
survives a dispute**: the History panel is ordered and rich but dies on close
and exposes only localized UI labels with no timestamp; the History Log is
persistent, off by default, plain text, and deletable in three lines of public
API; and Content Credentials — verified from Adobe's own signed samples — reduce
a whole Photoshop session to three category-level actions whose `parameters`
carry a *UI icon URL* rather than the crop rectangle. Lightroom is the one
genuine exception, emitting `crs:Exposure2012 = -21` style values, but that is
the **final settings state dressed as an action list**, replayable only inside
Adobe's own binary at a pinned `crs:ProcessVersion` — a recipe in a closed loop,
a log to everyone else. Every Adobe control points at the creator's convenience
— they choose what goes in the credential, they can withdraw the cloud copy, the
version window is 30 days — because Adobe's adversary is a third party stripping
the credential downstream, never the creator revising their own record. Which
means the strongest sentence in this market is sitting unclaimed: **nothing in
Adobe's stack says anything about the interval between two saves**, and the one
surface that could — the `ActionDescriptor` event stream, the only place real
operation parameters exist — Adobe neither persists nor signs.

---

## 0. What we already have in the Adobe hosts

Read before the research, so the comparison is against reality rather than the
work order.

- `/data/scruple-adobe/` — a UXP monorepo, three apps (`photoshop`,
  `illustrator`, `indesign`) over a shared `lib/scruple-common.js`. Built
  2026-07-09; **never run against a real Photoshop** (Phase 7 of
  `docs/wo/2026-07-06-scruple-photoshop.md` is blocked on an Adobe dev account).
- The entire Photoshop capture surface is **one event listener**
  (`/data/scruple-adobe/apps/photoshop/main.js`, 34 lines including the panel
  label glue):

  ```js
  action.addNotificationListener(['save'], async () => {
    const doc = app.activeDocument;
    const summary = { width, height, resolution, layer_count, mode };
    await window.scruple.witnessSave(doc, summary);
  });
  ```

  In canon vocabulary: hook `document.save`, surface `host-api-callback`,
  placement `unattested-client`, locus `tenant-custody`.
- `witnessSave()` re-reads the saved file off disk
  (`fs.getEntryWithUrl('file:' + doc.path)`), SHA-256s the bytes, and POSTs
  `{output_hash, file_size, filename, structural_summary, client_timestamp}`.
  **On read failure it falls back to `output_hash: null` and still records the
  event** — a leaf that asserts a save happened and nothing about what was
  saved.
- `app/api/scruple/witness/adobe/route.ts` allocates a monotonic
  `run_sequence` per project, calls the witness server for an HMAC-sealed
  `leaf_hash`, and inserts an `iterations` row. That per-project ordered chain
  of sealed leaves is the one thing in this whole study that is a **history**
  rather than a description of one artifact.

So today we witness *saves*, not *edits*, and the gap between two saves is
exactly the custody gap `CUSTODY_LOCUS.md` names.

---

## 1. Photoshop's History panel and History Log

### 1.1 The History panel is session-only, and Adobe says so unqualified

[VERIFIED, https://helpx.adobe.com/photoshop/desktop/get-started/set-up-toolbars-panels/history-panel-overview.html]

> **Closing the document clears all history states and snapshots.** The initial
> state snapshot appears first in the History panel. Dimmed states show edits
> that will be lost if you continue from a selected state.

and the panel is framed throughout as *"recent states of your image **during the
current session**"*. There is **no exception carved out for saving as PSD** —
the PSD image-resource block list has nowhere to put history states [NOT
VERIFIED by a direct read of the full resource-ID table; consistent with the
unqualified help text and with the file-format spec's structure].

So: the richest-looking edit record in the product **does not survive File →
Close.** It is not in the file, it is not in the catalog, it is in RAM and
scratch.

Other verified panel mechanics:

- **The default depth is documented twice, differently, by Adobe.**
  history-panel-overview.html: *"By default, the History panel lists **20**
  states. You can increase it to 1,000 states"*. performance-preferences.html:
  *"Photoshop can store up to 1,000 history states, and the **default is 50**."*
  Both pages are current. Max is 1,000 in both. **We should not quote a default
  at all** — Adobe's own docs disagree.
- Oldest states roll off once the limit is exceeded [VERIFIED via a Photoshop
  Elements help page reached only through a search summary — paraphrase, not a
  verbatim quote].
- *"Allow Non-Linear History — Allows you to edit a selected state without
  deleting subsequent states."* [VERIFIED] The list is therefore **not
  guaranteed to be a linear sequence** even within the session.
- *"Automatically Create New Snapshot When Saving — Generates a snapshot every
  time you save the document. **It is off by default.**"* [VERIFIED]
- Snapshots are cleared on close along with everything else [VERIFIED, same
  sentence as above].

### 1.2 What UXP exposes — read directly from the API reference

[VERIFIED, https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/document/]
`Document` carries:

| Member | Type | Access | Min ver | Doc text |
|---|---|---|---|---|
| `historyStates` | `HistoryStates` | R | 22.5 | "History states of the document." |
| `activeHistoryState` | `HistoryState` | R W | 22.5 | "Currently active history state of the document." |
| `activeHistoryBrushSource` | `HistoryState` | R W | 22.5 | "The history state that history brush tool will use as its source." |
| `suspendHistory(...)` | `Promise<void>` | — | 23.0 | "Creates a single history state encapsulating everything that is done in the callback, only for this document." |

So **a plugin can read the ordered history list.** Now look at what one entry
contains [VERIFIED,
https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/historystate/]
— this is the *complete* property set:

| Property | Type | Access | Doc text |
|---|---|---|---|
| `docId` | number | R | "The ID of the document of this history state." |
| `id` | number | R | "…can be used to represent this history state **for the lifetime of this document**." |
| `name` | string | R | "The name of this history state **as it appears on history panel**." |
| `parent` | Document | R | "Owner document of this history state." |
| `snapshot` | boolean | R | "Whether this history state is a snapshot or an automatically generated history state." |
| `typename` | string | R | `"HistoryState"` |

**There is no timestamp. There are no parameters. There is not even a stable
identifier.** An entry is a localized UI label plus an integer valid only while
the document stays open. `HistoryStates` offers `length`, `parent`, and
`getByName(name)`. The old ExtendScript/CEP DOM was the same minus `docId`/`id`
[VERIFIED against the Photoshop CC 2015 JavaScript Scripting Reference,
pp. 90–91, 122–123] — **neither DOM has ever exposed a time.**

That is the ceiling on history *scraping*: an ordered list of localized display
strings, valid until close.

`suspendHistory` deserves a note of its own. It lets a plugin **collapse** its
own operations into a single history state. Any host API that can merge states
is an API that can make the record coarser — and the plugin holding it is us.

### 1.3 The event stream is much richer than the history list — with a catch

[VERIFIED, https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/photoshopaction/]

> **addNotificationListener** — Attach a callback function to one or more
> Photoshop events. The callback has the form
> `(eventName: string, descriptor: ActionDescriptor) => void`.

**The callback receives the full `ActionDescriptor`** — the same descriptor
structure `batchPlay` and ExtendScript's `executeAction` use, carrying the
operation's actual parameters (a Levels command's input/output values, and so
on) [VERIFIED,
https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/batchplay].
Adobe even ships a recorder: *"Plugins > Development > Record Action
Notifications… will save both commands and change notifications to the selected
destination file."*

**This, not `historyStates`, is the only recipe-grade surface in Photoshop.**

The catch is the wildcard. A true `['all']` subscription exists but is
gated [VERIFIED, batchplay page]:

> Another option is to create a listener function in JavaScript. This is done by
> providing the global event hook to a low level API. **This call only works when
> developer mode is enabled.**
> ```js
> action.addNotificationListener(['all'], (event, descriptor) => { … });
> ```

So a **shipping** plugin cannot subscribe to everything. It must enumerate
concrete event names from the official Event Codes table [VERIFIED, hundreds of
rows, https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/eventcodes/].

That is a coverage problem of exactly the shape `PLACEMENT_AND_SURFACES.md` §2.2
describes: **an un-enumerated event produces no leaf for something that
happened, and a missing leaf is invisible.** A hand-maintained allowlist of
Photoshop event codes is a permanent gap-accounting liability, and it drifts
every time Adobe ships a tool.

Two smaller notes: there is **no `historyStateChanged` in Adobe's Event Codes
table** (zero hits for "history") though community code uses that string [NOT
VERIFIED — undocumented or version-specific]; and `validateReference` officially
supports a `historyState` reference class, with history navigation done through
the `select` event targeting `_ref: "historyState"` [VERIFIED].

### 1.4 History Log — an unsigned, user-editable free-text string

The preference pane is now **Preferences > History & Content Credentials**
[VERIFIED,
https://helpx.adobe.com/photoshop/desktop/get-started/set-up-toolbars-panels/history-log-preferences.html]:

> Select the History Log checkbox to turn it on. … Select **Metadata**, **Text
> File**, or **Both** to specify where the history log should be saved.

Granularity, quoted exactly [VERIFIED, same page]:

> From the Edit Log Items menu, select the level of detail:
> - **Sessions Only**: Tracks when Photoshop is opened or closed.
> - **Concise**: Adds History panel entries along with session information.
> - **Detailed**: Includes Actions panel entries for complete edit tracking.

Where it goes in metadata [VERIFIED, Adobe's own XMP docs repo,
https://github.com/adobe/xmp-docs/blob/master/XMPNamespaces/photoshop.md]:

> `photoshop:History` — "The history that appears in the FileInfo panel, if
> activated in the application preferences." Type: **Text**.

Namespace `http://ns.adobe.com/photoshop/1.0/`. **Type Text — a single appended
free-text string, not an array of structured events.** It is *not* the
structured `xmpMM:History` / `stEvt` ResourceEvent array; do not confuse the two.

And now the part that decides everything:

- **Off by default and user-toggleable** — the same checkbox.
- **Trivially deletable.** A working community snippet clears it with the public
  XMP library: `XMPUtils.removeProperties(xmp, XMPConst.NS_PHOTOSHOP, "History",
  XMPConst.REMOVE_ALL_PROPERTIES)` [VERIFIED,
  https://community.adobe.com/t5/photoshop-ecosystem-discussions/delete-history-log-in-metadata/m-p/14735024].
  Nothing prevents rewriting `xmp.rawData` outright.
- **The text-file variant is an ordinary text file with no protection at all.**
- **Nothing signs it.** Adobe's own page carries the advisory *"Note: Save the
  edit log in metadata and sign it digitally to ensure your log file security."*
  — an instruction to the user, not a description of automatic behaviour, and
  Adobe does not say how. Given the pane is now "History & Content Credentials"
  this most plausibly means attaching a Content Credential on export [INFERRED].
  **No documentation states the History Log is signed by default or protected
  against tampering** [NOT VERIFIED — flagged as an open question].
- A UXP plugin can read *and write* it: UXP gained an XMP module
  (`require('uxp').xmp`, `XMPMeta` / `XMPFile`) at UXP 7.2 / Photoshop 25.0
  [reported by search, method signatures not directly read — treat as
  NOT FULLY VERIFIED].

**Summary of §1:** Photoshop has three edit records and none of them is
evidence. The History panel is rich, ordered, and dies on close. The History Log
is persistent and is an unsigned string anyone can edit or delete. The event
stream is the only one carrying real parameters, and a shipping plugin can only
see the events it thought to name in advance.

---

## 2. Non-destructive edit stacks — recipe or log?

### 2.1 Where the settings live

- **Catalog.** `.lrcat` is a SQLite 3 database (~116 tables) holding development
  history, metadata and folder structure [VERIFIED via community
  reverse-engineering, https://github.com/hfiguiere/lrcat-extractor/blob/main/doc/lrcat_format.md
  — **Adobe has never published a `.lrcat` schema**].
- **Sidecar / embedded XMP.** "Lightroom supports storing metadata in external
  sidecars for Raw images and a few non-raw image formats… in the form of an XMP
  sidecar file" — sidecars for proprietary raw, embedded for DNG/JPEG/TIFF
  [VERIFIED, https://helpx.adobe.com/lightroom-classic/help/create-xmp-acr-files.html,
  read via a Wayback snapshot; helpx refused direct fetches all session].
- **A second sidecar as of Lightroom Classic v15.0.** `.ACR` now holds "heavy
  edits, masks, or AI settings like Super Resolution, Distraction Removal, and
  Denoise", while "the XMP sidecar stays lightweight" [VERIFIED, same page].
- **And some of it never leaves the catalog.** From 14.4, Denoise data and
  AI-generated masks live in `.lrcat-data` beside the catalog, reaching the file
  only if "Automatically write changes into XMP" is on [NOT VERIFIED against an
  Adobe page; consistent across community sources].

**The portable-XMP story is decaying, not improving.** The newest and most
consequential edits — the AI ones, which are exactly the ones a "made without
AI" claim cares about — are the ones moving *out* of the open, plain-text
sidecar into proprietary blobs and catalog-local state.

### 2.2 The format, and what it is not

The `crs:` namespace (`http://ns.adobe.com/camera-raw-settings/1.0/`) carries
`crs:Exposure2012`, `crs:Contrast2012`, `crs:Highlights2012`, `crs:Shadows2012`
[VERIFIED, darktable maintainers parsing real Adobe XMP,
https://github.com/darktable-org/darktable/issues/20953], plus
`crs:Temperature`, `crs:ToneCurvePV2012`, `crs:ProcessVersion`,
`crs:CameraProfile` [corroborated across sources; **Adobe has never published a
formal `crs` schema reference** the way it has for Dublin Core / EXIF / IPTC].
Masks appear under `crs:MaskGroupBasedCorrections` with normalized coordinates
[NOT VERIFIED — third-party write-ups only].

**The XMP carries the current parameter set, not the ordered Develop History.**
The History panel is catalog-only and is never written to the sidecar [NOT
VERIFIED against a first-party Adobe statement; very well corroborated and
uncontradicted across community sources]. That is the crux and it should be
stated plainly: *Lightroom has an ordered edit history and deliberately does not
export it.*

This makes sense of something in the signed manifest in §4.4. Lightroom's C2PA
actions assertion emits one `c2pa.color_adjustments` per slider —
`Blacks2012: 18`, `Contrast2012: 27`, `Exposure2012: -21`, `Highlights2012: 38`,
`Shadows2012: -21`, `Whites2012: -38`. Those are the six non-default Basic-panel
tone values. **Lightroom is serialising the final settings *state* and labelling
each entry an "action".** [INFERRED from the value shapes plus the
history-stays-in-the-catalog finding — but it explains why the assertion has no
`when` fields, and it is consistent with §18.15.1's "the order of actions in
this array is unspecified".] A reader who takes that manifest as an edit
*sequence* is reading it wrong. It is a state vector wearing a log's clothes.

### 2.3 `crs:ProcessVersion` — Adobe's own admission that the render drifts

[VERIFIED, Adobe Camera Raw help via Wayback,
https://helpx.adobe.com/camera-raw/using/process-versions.html]:

> Process version is the technology that Camera Raw uses to adjust and render
> photos. Depending on which process version you use, different options and
> settings are available to you in the Basic tab and when you make local
> adjustments.

Five process versions (PV1 2003 → PV5); each changes the math behind the
sliders; images stay pinned to their original PV unless the user clicks "Update
to Current Process". **Process Version exists because the same slider values
under different versions do not produce the same pixels.** That is the vendor
telling you, in their own documentation, that the recipe is engine-dependent.

### 2.4 Verdict: a recipe inside a closed loop, a log outside it

Re-derivation by an independent third party is **not** achievable:

- DNG's spec is open, but "any settings stored in the DNG file by software from
  one company are unlikely to be recognized by a product from a different
  company" [VERIFIED, https://en.wikipedia.org/wiki/Digital_Negative].
- The DNG SDK renders the *baseline* image — demosaic and color-managed
  conversion per the DNG spec. Camera Raw's Process-Version tone curves, dehaze,
  texture/clarity, masking and denoise networks are closed and undocumented
  [VERIFIED via Adobe DNG SDK page + LibRaw docs].
- The camera profile is referenced **by name** (`crs:CameraProfile="Adobe
  Standard"`), not embedded; the `.dcp` ships and updates separately [NOT
  VERIFIED against an Adobe primary source].
- **No open-source implementation claims bit-identical ACR output.** darktable
  parses `crs:` tags and matches *itself*; RawTherapee's tracker discusses
  adopting the Adobe DNG SDK precisely because its dcraw-derived pipeline does
  not match Adobe's rendering [https://github.com/Beep6581/RawTherapee/issues/1982].

So: **deterministic replay requires the same raw, the same ACR version family,
the same Process Version, the same profile version, and Adobe's binary.**
Inside that loop it behaves like a recipe. Outside it, it is a *statement of
what was applied* — a log, and a good one, but a log.

For a receipt this is the whole ballgame. A receipt may honestly say *"these
develop settings were witnessed at this time"*. It may **not** say *"anyone can
reproduce this image from the original plus these settings"*, because nobody
outside Adobe can, and Adobe only can while the Process Version pin holds.

### 2.5 PSD internals — how much survives in the file

Verified against the Photoshop File Formats Specification [VERIFIED via the
long-standing community mirror at
https://paulbourke.net/dataformats/psdpsb/psdpsb.html — Adobe's own
`devnet-apps.com/photoshop/fileformatashtml/` URL is effectively dead]:

- **`SoLd`** (CS3+) / **`PlLd`** (legacy) — placed/smart-object layer
  descriptors; `PlLd` stores a unique ID, a placed-layer type
  (`0 unknown / 1 vector / 2 raster / 3 image stack`) and an 8-double transform.
- **`FMsk`** — smart filter mask (colour space, opacity).
- **`lrFX`** — legacy layer effects; "Effects count: may be 6 … or 7".
- Adjustment layers: **`brit`** (brightness/contrast), **`blwh`** (black &
  white, descriptor-based), **`vibA`** (vibrance, descriptor-based); `levl` and
  `curv` also present.

**Embedded smart objects contain the original bytes.** They have "no connection
with the original source image once it's placed" and are "embedded within the
Photoshop document" — recoverable via Edit Contents [VERIFIED,
https://helpx.adobe.com/photoshop/desktop/create-manage-layers/smart-objects/embed-linked-smart-objects.html].
**Linked** smart objects store only a path, and can go missing.

That is genuinely useful for `asset-custody`: an embedded smart object is a
**hashable ingredient that travels inside the working file**, and a Scruple
receipt could bind it as a real ingredient rather than a claim.

**And destructive operations leave nothing.** A brush stroke, a clone stamp, a
healing pass — the PSD stores the resulting pixels and no record of the
operation. [NOT VERIFIED against a single Adobe doc; consistent across community
answers, and consistent with the format spec having no such structure.] A
flattened JPEG/PNG export carries pixels plus whatever metadata is written at
export, and none of the layer structure, adjustment parameters, smart-object
sources or masks.

**So the PSD is a partial recipe for the non-destructive half and a pure
artifact for the destructive half — and Photoshop's real work is largely the
destructive half.**

---

## 3. Cloud document version history

Adobe's own docs were the hardest sources in this study to read — `helpx.adobe.com`
is JS-rendered and repeatedly timed out or 404'd against the fetchers available
here. Claims below are tagged accordingly: **[VERIFIED]** = quoted from a page we
actually read; **[SNIPPET]** = a search engine's rendering of the page, consistent
across independent queries but not a first-hand read.

### 3.1 What a version is

- Versions are **auto-saved**, not save-triggered: Photoshop and InDesign both
  describe the timeline as "auto-saved versions of your cloud document"
  [VERIFIED, https://helpx.adobe.com/indesign/using/view-manage-versions.html;
  https://helpx.adobe.com/photoshop/using/manage-cloud-documents-photoshop.html].
  **The autosave interval is nowhere stated** [NOT VERIFIED].
- A version is identified by **timestamp + optional user-assigned name +
  thumbnail**. Search/filter is "based on the time they were created, marked
  status, etc." [VERIFIED, same]. **No page we reached mentions a content hash,
  digest or checksum per version** — absence of evidence rather than evidence of
  absence, but four help pages never raise it.

### 3.2 Retention is per-app, and unmarked versions are deleted

- Photoshop: "any un-marked states are deleted after **30 days**" [SNIPPET].
- Fresco: "Versions that are not bookmarked are deleted after **60 days**"
  [SNIPPET].
- InDesign: "Versions that are not marked are deleted periodically" — no number
  [VERIFIED].
- Deleting the whole document is a separate 30-day trash window [SNIPPET]. Do
  not conflate the two.
- Marked versions count against the storage quota; unmarked history does not
  [VERIFIED, https://helpx.adobe.com/photoshop/using/cloud-documents-workflow-faqs.html].

**Any single "Adobe keeps versions for N days" claim is false for some Adobe
app.** The number is per-product.

### 3.3 Is it append-only?

Mostly, and by an interesting mechanism. **Revert appends rather than
truncates**: "Select Revert to this version. The chosen version will move to the
top of the version stack" [VERIFIED,
https://helpx.adobe.com/photoshop/using/manage-cloud-documents-photoshop.html].
The intervening timeline survives.

There is **no "delete this version" action**. The only removal paths are
(a) unmark and let it age out — "Click the Mark version icon again to remove a
saved cloud document version from the Marked Versions section" [VERIFIED] — or
(b) delete the whole document.

So: append-only in the forward direction, with a **passive, time-based
deletion** at the tail. That is a genuinely different shape from "the user can
rewrite the record", and it is better than we might have assumed. But the
retention window means **the history is a sliding window, not an archive** — an
un-marked state older than 30 days is gone, which is fatal for a custody claim
made months later, which is exactly when disputes happen.

### 3.4 What any API exposes: nothing

This is the strongest negative finding in the study.

- **UXP**: `Document` exposes only `cloudDocument` (read-only boolean, "Check
  whether this a Photoshop cloud document") and `cloudWorkAreaDirectory`
  [VERIFIED,
  https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/document/].
  **No `versionHistory`, no version list, no restore call, no ETag or hash
  accessor.** A plugin can tell that a document is a cloud document and nothing
  else about its timeline.
- **Photoshop API (Firefly Services)**: a stateless render/manipulate service
  operating on a URL you hand it, writing to a caller-supplied pre-signed output
  URL. Its overview page makes no mention of cloud documents, `.psdc`, or
  version history [VERIFIED, https://developer.adobe.com/firefly-services/docs/photoshop/].
- **CC Libraries API**: has `libraryVersion` and `etag` / `if-none-match` — but
  these are **cache-invalidation tokens for the current state**, plus an
  archive/trash for deleted elements. There is no way to list or fetch a prior
  content state [VERIFIED, raw OpenAPI at
  https://github.com/AdobeDocs/cc-libraries-api-spec].
- No public "CC Storage API" exposing `.psdc` history appears to exist
  [NOT VERIFIED — searched, not found].

**Creative Cloud Files** (the old sync folder) is being discontinued —
"Starting February 1, 2024 (now extended through February 3, 2025), Adobe will
begin to discontinue Creative Cloud Synced files for all free and paid personal
users" [VERIFIED, https://helpx.adobe.com/creative-cloud/kb/eol-creative-cloud-synced-files.html].
Not worth designing against.

### 3.5 Integrity posture

**No Adobe documentation claims the version-history feature is signed, hashed,
or tamper-evident.** Every description reads as server-side storage under
Adobe's control with a UI over it. The topic is never raised — which is itself
the answer.

Version history and Content Credentials are **two disjoint systems**. C2PA is
cryptographic and applies to exported assets. Version history is the project
timeline and carries no integrity guarantee. Adobe has never joined them, and
the join is precisely the `asset-custody` problem.

---

## 4. Content Credentials (C2PA) — the closest thing to our problem, solved by a large vendor

### 4.1 What the standard lets an editor record

The actions assertion (`c2pa.actions.v2`, deprecated v1 `c2pa.actions`) is the
only place edits are described. Spec §18.15.1 [VERIFIED,
https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html]:

> An actions assertion provides information on edits and other actions taken
> that affect the asset's content. There will be an array of actions - each
> action declaring what took place on the asset and (optionally) when it took
> place, along with possible other information such as what software performed
> the action. **Except where noted in Section 18.15.2 …, the order of actions in
> this array is unspecified, and does not imply the order in which actions were
> performed.**

Read that last clause twice. **A C2PA actions assertion is an unordered set, not
a sequence.** Only the inception action (`c2pa.created` or `c2pa.opened`) has a
mandated position — first. Everything after it is a bag of things that happened.
The panel's ordered History list has no C2PA representation at all.

The v2 CDDL for one action [VERIFIED, same URL]:

```cddl
action-item-map-v2 = {
  "action": $action-choice ,
  action-common-map-v2,          ; softwareAgent / softwareAgentIndex /
                                 ; description / digitalSourceType
  ? "when": tdate,               ; time-stamp of when the action occurred
  ? "changes": [1* region-map],  ; regions of interest that were changed
  ? "related": [1* action-item-map-v2],
  ? "reason": $action-reason,
  ? "parameters": parameters-map-v2
}

parameters-map-v2 = {
  ? "redacted": $jumbf-uri-type,
  ? "ingredients": [1* $hashed-uri-map],
  ? "relatedAssertions": [1* $hashed-uri-map],
  ? "sourceLanguage" / "targetLanguage": tstr,
  ? "multipleInstances": bool,   ; was this action performed multiple times
  parameters-common-map-v2,      ; * tstr => any
}
```

Two fields decide the honesty question:

- **`multipleInstances: bool` — "was this action performed multiple times".**
  The standard *anticipates* collapsing N brush strokes into one
  `c2pa.drawing` with a flag. Repetition is explicitly not counted.
- **`parameters` is `* tstr => any`.** There is no schema for the *values* of an
  edit. A generator may put the exact Levels input/output pairs there, or
  nothing. Nothing in the standard requires it. So the standard permits a
  recipe and requires only a label.

The pre-defined action vocabulary (Table 8, §18.15.1) is 30-odd names, all at
tool-*category* granularity, not operation granularity [VERIFIED]:
`c2pa.addedText`, `c2pa.adjustedColor`, `c2pa.color_adjustments` [DEPRECATED],
`c2pa.converted`, `c2pa.created`, `c2pa.cropped`, `c2pa.deleted`,
`c2pa.drawing` ("Changes using drawing tools including brushes or eraser"),
`c2pa.edited` ("Generalized actions that would be considered editorial
transformations"), `c2pa.edited.metadata`, `c2pa.enhanced`, `c2pa.filtered`,
`c2pa.opened`, `c2pa.orientation`, `c2pa.placed`, `c2pa.published`,
`c2pa.redacted`, `c2pa.removed`, `c2pa.repackaged`, `c2pa.resized`,
`c2pa.resized.proportional`, `c2pa.transcoded`, `c2pa.trimmed`,
`c2pa.unknown` ("Something happened, but the claim_generator cannot specify
what"), `c2pa.watermarked.bound` / `.unbound`, plus audio and `font.*` sets.
Entity-specific names are allowed (`com.fabrikam.gaussianBlur`), and §18.15.4.1
suggests the free-text `description` field for detail — the example given is
literally `a c2pa.edited action could have a description that says "Paintbrush
tool"`.

### 4.2 The one field that carries the completeness claim

§18.15.3 "All actions included" [VERIFIED, quoted verbatim]:

> The generator should set the actions-map-v2 field, `allActionsIncluded`, which
> has a boolean value. If `allActionsIncluded` has a value of true, then the
> claim generator is stating that all actions performed on the asset are
> described in the actions assertion(s). If `allActionsIncluded` has a value of
> false, then the claim generator is stating that additional, unrecorded actions
> may have been performed. **Validators should interpret an omitted
> `allActionsIncluded` field as indicating that additional, unrecorded actions
> may have been performed.**

This is C2PA's version of our locus axis, compressed into one bit, and it
fails closed by omission. It is the single most important field in this whole
study for `asset-custody`: it is the standard's own admission that *an actions
list is not a history unless someone asserts that it is*, and that the assertion
is unverifiable — it is a claim by the generator about its own completeness,
with no mechanism behind it.

C2PA 2.4 added exactly one place where it is mandatory: *"the claim generator
shall set allActionsIncluded to true"* when opening an asset and immediately
re-saving without other changes.

### 4.3 Chains and breaks

The chain is built from **ingredients**, not from actions. `ingredient-map-v3`
[VERIFIED] carries `relationship` ∈ `{parentOf, componentOf, inputTo}`,
`activeManifest` (a hashed-uri to the ingredient's own manifest),
`claimSignature`, `validationResults`, and — new in 2.4 — a `digitalSourceType`
that *"Cannot be combined with `activeManifest`"*. `c2pa.opened` means "An
existing asset was opened and is being set as the `parentOf` ingredient", and
2.4 now *requires* a `c2pa.opened` action to reference the corresponding
ingredient assertion.

So the shape of the chain is: manifest N embeds a hashed reference to manifest
N−1, which is embedded in the bytes that were opened. It is a real
cryptographic chain **while every tool in the path is C2PA-aware**.

**What happens across an edit that strips the manifest:** nothing is recorded.
There is no break representation. A stripped file is indistinguishable from a
file that never had a credential — the spec's own Security Considerations,
§4.3.1.1 "Threat: Stripping C2PA Manifests" [VERIFIED,
https://spec.c2pa.org/specifications/specifications/2.4/security/Security_Considerations.html]:

> **Impact analysis** — It is possible for an attacker to remove metadata as
> described. Depending on the context, this could cause a user agent not to
> display provenance information associated with the asset.
> **Security guidance** — The impact of this threat scenario could be mitigated
> through use of *manifest repositories*, e.g., by making C2PA Manifests
> available to user agents when embedded manifests are missing.

The break is only ever representable **forward**, and only voluntarily: the next
C2PA-aware tool that opens the file can record an ingredient with a
`digitalSourceType` and no `activeManifest` (i.e. "I opened something that had
no provenance"), or an ingredient whose `validationResults` failed. If the next
tool is not C2PA-aware — which is every tool by default — the gap is silent.
**C2PA detects tampering with a manifest; it does not detect the absence of
one.** That is precisely the completeness-across-time hole `asset-custody`
exists for.

Adobe's answer is the "durable Content Credential", built on three pillars
[VERIFIED, https://contentauthenticity.org/blog/three-pillars-of-provenance]:
metadata ("cryptographically secure but easily stripped"), an invisible
watermark (**TrustMark**) that "can survive processing by content platforms in a
way that metadata cannot", and a "cryptographically signed image fingerprint"
to counter watermark spoofing. The spec formalises the vocabulary: §2.4.1
*Durable Content Credential* = "a Content Credential for which there exists one
or more soft bindings that enable its discovery in a manifest repository";
§2.4.2 *Fingerprint*; §2.4.3 *Invisible Watermark*; and `ingredient-map-v3` gets
`softBindingsMatched` / `softBindingAlgorithmsMatched` so a manifest can say
*"I found my parent by lookup, not by reading it out of the file."*

Note what this buys and what it does not. Soft binding restores **availability**
of a manifest that was stripped. It does not restore **continuity** — recovering
manifest N−1 by fingerprint tells you nothing about what happened to the pixels
between N−1 and N. And the CAI's own writeup is candid that distributed lookup
"across multiple providers" is aspirational [VERIFIED, same URL]: today the
repository is Adobe's.

### 4.4 What Adobe actually emits — read from real signed manifests, not from marketing

The CAI publishes signed sample assets with their extracted manifests at
[`contentauth/example-assets`](https://github.com/contentauth/example-assets).
Everything below is **VERIFIED** — read out of those JSON files, which are the
output of Adobe's own signers. This is the most load-bearing evidence in the
study, because it is the only place where the granularity question gets a
non-marketing answer.

#### Photoshop 26.11 — `images/manifests/car-es-Ps-Cr.json`

`claim_generator: "Adobe_Photoshop/26.11.0 adobe_c2pa/0.14.2 c2pa-rs/0.43.0"`,
signed `Ps256`, issuer `Adobe Inc.` / CN `Adobe C2PA`. The complete
`c2pa.actions.v2` assertion, verbatim:

```json
{ "actions": [
  { "action": "c2pa.opened",
    "parameters": { "description": "Opened a pre-existing file",
                    "com.adobe.tool": "open",
                    "com.adobe.icon": "https://cai-assertions.adobe.com/icons/import-dark.svg",
                    "instanceId": "xmp:iid:73f1d577-2d17-46ec-908a-09f2380df77c" } },
  { "action": "c2pa.cropped",
    "parameters": { "com.adobe.tool": "crop",
                    "com.adobe.icon": "…/crop-dark.svg",
                    "description": "Used cropping tools, reducing or expanding visible content area" } },
  { "action": "c2pa.resized",
    "parameters": { "com.adobe.tool": "image_size",
                    "description": "Changed dimensions or file size",
                    "com.adobe.icon": "…/resize-dark.svg" } } ],
  "metadata": { "reviewRatings": [], "dateTime": "2025-10-23T19:19:17.218Z", "localizations": [] } }
```

Six things to take from those thirty lines:

1. **Three actions for an entire editing session.** Tool *category* granularity,
   confirmed from bytes.
2. **No parameter values.** `c2pa.cropped` carries no crop rectangle;
   `c2pa.resized` carries no dimensions. What `parameters` carries instead is
   `com.adobe.tool` (the internal tool id), `com.adobe.icon` (a *URL to a UI
   icon*), and an English sentence. **The parameters field is populated with
   display material, not with the operation's inputs.** This is a log. It is
   not close to a recipe.
3. **No `when` on any action.** There is one `metadata.dateTime` for the whole
   assertion. There is no per-action time and therefore no evidence of order —
   consistent with §18.15.1's "the order of actions in this array is
   unspecified".
4. **No `allActionsIncluded`.** Per §18.15.3 a validator shall therefore read
   this manifest as *"additional, unrecorded actions may have been performed."*
   Adobe's flagship editor does not claim its own edit list is complete.
5. **No `changes` regions.** Nothing says *where* the crop happened.
6. The ingredient (`car-es.jpeg`) is `relationship: componentOf` with
   `active_manifest: null` — the source had no credential of its own, so the
   chain is one link long and terminates.

#### Lightroom / Camera Raw 8.5.1 — `images/manifests/crater-lake-cr.json`

This one is materially different, and it is the most interesting artifact in the
whole study:

```json
{ "actions": [
  { "action": "c2pa.opened", "parameters": { "ingredients": [ { "url": "self#jumbf=c2pa.assertions/c2pa.ingredient.v2", "hash": "clku0Iw7…" } ] } },
  { "action": "c2pa.color_adjustments", "parameters": { "com.adobe.acr": "Blacks2012",     "com.adobe.acr.value": "18" } },
  { "action": "c2pa.color_adjustments", "parameters": { "com.adobe.acr": "Contrast2012",   "com.adobe.acr.value": "27" } },
  { "action": "c2pa.color_adjustments", "parameters": { "com.adobe.acr": "Exposure2012",   "com.adobe.acr.value": "-21" } },
  { "action": "c2pa.color_adjustments", "parameters": { "com.adobe.acr": "Highlights2012", "com.adobe.acr.value": "38" } },
  { "action": "c2pa.color_adjustments", "parameters": { "com.adobe.acr": "Shadows2012",    "com.adobe.acr.value": "-21" } },
  { "action": "c2pa.color_adjustments", "parameters": { "com.adobe.acr": "Whites2012",     "com.adobe.acr.value": "-38" } } ] }
```

**One action per develop slider, carrying the `crs:` property name and its
numeric value.** `Blacks2012`, `Contrast2012`, `Exposure2012` are literally the
Camera Raw settings property names — the same identifiers that live in the XMP
sidecar. Adobe has taken the non-destructive edit stack and serialised it into
C2PA actions with the values intact.

That is the difference between a log and a recipe, in one repo, from one vendor,
signed by the same certificate on the same afternoon. **Photoshop emits a log.
Lightroom emits (a subset of) the recipe.** Any Scruple claim wording about
"Adobe records edits" has to distinguish the two or it is false about one of
them.

Still absent from the Lightroom manifest: `when`, `allActionsIncluded`, and
`changes`. And still only the *global* Basic-panel sliders — no masks, no local
adjustments, no tone curve, no crop values.

#### Adobe Content Authenticity web app — `images/manifests/cloudscape-ACA-Cr.json`

The durable-credential path in real bytes. Assertions: `c2pa.actions.v2`
(just `c2pa.opened` + `c2pa.watermarked`), `cawg.training-mining`,
`c2pa.training-mining`, **`c2pa.soft-binding`**, **`c2pa.soft-binding__1`**,
**`cawg.identity`**. The two soft bindings:

```json
{ "alg": "com.adobe.trustmark.P",  "blocks": [ { "scope": {}, "value": "2*0010011110000111…" } ] }
{ "alg": "com.adobe.icn.dense",    "blocks": [ { "scope": {}, "value": "000347ca21ad685add…" } ] }
```

— i.e. TrustMark (the invisible watermark) and a dense image-content fingerprint,
both **vendor-proprietary algorithm identifiers in the `com.adobe.*` namespace**,
not open C2PA algorithms. The `cawg.identity` assertion is a W3C
`IdentityClaimsAggregationCredential` issued by
`did:web:connected-identities.identity.adobe.com`, listing verified Instagram /
Behance / LinkedIn / X handles with per-provider `verifiedAt` timestamps.

#### Firefly — `images/manifests/Firefly_tabby_cat.json`

```json
{ "actions": [ { "action": "c2pa.created", "softwareAgent": "Adobe Firefly",
                 "parameters": { "com.adobe.firefly.version": "4.0.0-release-firefly_v4-main_78135.80468",
                                 "com.adobe.firefly.operation": "text_to_image" },
                 "digitalSourceType": ".../trainedAlgorithmicMedia" } ],
  "allActionsIncluded": true }
```

**`allActionsIncluded: true` appears in the Firefly manifest and in none of the
human-editing manifests.** Adobe asserts completeness exactly where the pipeline
is a closed machine it fully controls, and declines to assert it where a human
was driving. That is a correct and quite disciplined choice — and it is the same
distinction our own `inference-host` / `authoring-application` class split
makes, arrived at independently. (It is Adobe-specific discipline, not a
generative-tool convention: OpenAI's `ChatGPT_Image.json` in the same repo emits
`c2pa.created` with `softwareAgent: {name: "GPT-4o"}` and
`trainedAlgorithmicMedia` but **no `allActionsIncluded`**.)

#### One real chain, for contrast — `images/manifests/ChatGPT_Image.json`

None of the four Adobe samples contains a multi-manifest chain: in every one the
parent ingredient has `active_manifest: null`, i.e. the source had no credential.
The OpenAI sample does have one — two manifests, both signed
`Es256 / issuer OpenAI / CN "Truepic Lens CLI in Sora"`, where the active
manifest's ingredient is `relationship: parentOf` with
`active_manifest: urn:c2pa:ec8fd500-…`, resolving to the first. That is what an
intact C2PA chain looks like, and it is worth noting that we had to leave the
Adobe samples to find one.

### 4.5 The rest of what Adobe controls

- **The user chooses what to include.** *"You can select which attribution and
  edit history actions to include using the Content Credentials (Beta) panel,
  and decide whether to share your name, connected accounts, and your edits and
  activity."* [VERIFIED via indexed helpx copy — helpx.adobe.com is JS-rendered
  and refused every fetch attempt from this host, so the exact wording is
  second-hand]. A creator may suppress the edit list and still ship a signed
  credential.
- **The user can withdraw the cloud copy.** Since ~Feb 2026 there is a
  self-serve page at `contentauthenticity.adobe.com/manage` for removing work
  from the Content Credentials cloud [PARTIALLY VERIFIED — Adobe community
  announcement, not a helpx doc].
- **PSD cannot carry a manifest.** Spec Appendix A.1's embeddable-format list
  [VERIFIED] covers JPEG, JPEG-XL, PNG, SVG, HTML, FLAC, MP3, GIF, DNG,
  TIFF-based, WAV/BWF, AVI, WebP, fonts, text, PDF, EPUB, OOXML, ODF, OpenXPS,
  ZIP-based and MP4/BMFF — **and not PSD**. Independently, Photoshop attaches
  Content Credentials only on export to **JPG and PNG** [VERIFIED via indexed
  helpx copy]. So in Photoshop the C2PA chain *begins at export*: the working
  document, which is the thing that has a history, is structurally outside C2PA.
- **Adobe is not a conforming Generator.** On the C2PA Conforming Products List,
  Adobe appears only as a **Validator** ("Adobe Content Authenticity Inspect",
  conformed 2025-08-05); Firefly and Adobe's signing pipeline are not filed as a
  conforming Generator Product at any assurance level [VERIFIED — our own
  registry pull, `docs/c2pa-conformance-evidence/2026-07-30/c2pa-l2-peer-landscape.md`].

### 4.6 Where Adobe is richer than we are, plainly

Our emitter is `lib/c2pa/signAsset.ts` → `services/c2pa-signer/sign.py`; the
label allowlist is `config/c2pa-assertions.json`.

| | Adobe Content Credentials | Scruple today |
|---|---|---|
| Inception action + `digitalSourceType` | yes | yes — and **required, no default** (`signAsset.ts` refuses without it) |
| Per-edit actions | yes — **category-grained in Photoshop** (tool id + icon URL, no values), **parameter-grained in Lightroom** (`crs:` name + value) | **no.** `buildSupplementaryActions()` returns exactly one entry: `{ action: 'c2pa.published', softwareAgent: { name: 'Scruple', version: '0.1' } }` |
| `allActionsIncluded` | **absent** from the Photoshop and Lightroom manifests; `true` in Firefly's | **never set** — so a validator correctly reads our manifests as "additional, unrecorded actions may have been performed" |
| Ingredients / `parentOf` chain | yes | **none.** `c2pa.ingredient` is on the created-assertion allowlist but nothing constructs one; no `add_ingredient` call exists |
| Soft binding (watermark + fingerprint recovery) | yes (TrustMark + cloud) | no |
| Identity binding | CAWG identity / connected accounts | `cawg.training-mining` opt-out only |
| Cross-save chain | **no** — each export is an independent manifest | **yes** — `ai.scruple.provenance` carries `leaf_hash`, `merkle_root`, `chain_position`, backed by monotonic `run_sequence` per project and an HMAC-sealed witness leaf (`app/api/scruple/witness/adobe/route.ts`) |
| Signer assurance | not a conforming Generator | filed L2, SEV-SNP CVM + in-CVM HSM |

**Adobe is richer on everything that describes a single artifact. We are richer
on the only thing that describes a project over time.** That is not flattering
framing; it is the actual split, and it is why the two are complementary rather
than competing.

One concrete defect this study surfaced: our Adobe witness route stamps
`output_content_type: 'image/vnd.adobe.photoshop'`
(`app/api/scruple/witness/adobe/route.ts`), a MIME that appears in neither
`GENERATE_MIMES` nor `VALIDATE_MIMES` in `services/c2pa-signer/formats.py`. A
witnessed PSD save can therefore never be promoted to a C2PA manifest. That is
correct behaviour — PSD is not embeddable — but it means the plugin's C2PA
button is only ever meaningful on an exported JPG/PNG, and nothing in the
plugin says so.

---

## 5. Mapping to Scruple

### 5.1 What we could witness directly instead of reimplementing

| Adobe mechanism | Witness it? | Why |
|---|---|---|
| `action.addNotificationListener(events, cb)` → `ActionDescriptor` | **Yes — this is the one that matters** | The only Photoshop surface carrying real operation *parameters*. Richer than Adobe's own Content Credentials, which throws the parameters away and keeps an icon URL. |
| Embedded smart objects (`SoLd` / `PlLd`) | **Yes** | The original source bytes are inside the PSD and recoverable. Hashable → a real ingredient, not a claim about one. |
| Lightroom/ACR `crs:` settings in XMP / `.ACR` sidecar | **Yes, as a state hash** | Already serialised, already portable, already the vendor's own canonical form. Hash it at `document.save`; never re-derive it. |
| **Adobe's own signed C2PA manifest on export** | **Yes — bind it, don't compete with it** | Adobe signs it (`Ps256`, issuer Adobe Inc.). Take the manifest hash into our leaf as an ingredient. Their claim about the artifact plus our claim about the timeline is strictly stronger than either. |
| Photoshop History panel (`historyStates`) | **Only as a weak corroborator** | Labels with no time, no parameters, no stable id, gone on close. Hashing the label list is honest but says very little. |
| Photoshop History Log (`photoshop:History`) | **No** | Off by default, plain text, and deletable in three lines of public XMP API. Witnessing it would launder a user-editable string into a receipt. |
| CC cloud document version history | **Cannot** | No public API of any kind. UXP knows only `cloudDocument: boolean`. |
| `Document.suspendHistory()` | **Hazard, not asset** | It collapses states. We hold it. Any capture design that reads `historyStates` must account for the fact that plugins — including ours — can coarsen the very record they are reading. |

Two coverage consequences to declare rather than discover later:

1. **The `['all']` wildcard is developer-mode only.** A shipping plugin must
   enumerate event codes from Adobe's table. That is a hand-maintained allowlist
   that goes stale every Photoshop release, and by `PLACEMENT_AND_SURFACES.md`
   §2.2 an un-enumerated event yields **no leaf for an event that happened** —
   invisible, not degraded. This belongs in the class's gap accounting from day
   one, not as a footnote.
2. **PSD cannot carry a C2PA manifest** (spec Appendix A.1; Photoshop attaches
   only on JPG/PNG export). The working document is structurally outside C2PA.
   Whatever continuity claim exists for a PSD is ours or it is nobody's.

### 5.2 Recipe or log — and therefore what a receipt may say

| Artifact | Verdict |
|---|---|
| Photoshop C2PA actions | **Log.** Verified from Adobe's own signed sample: `com.adobe.tool`, an icon URL, an English sentence. No crop rectangle, no resize dimensions, no `when`. |
| Photoshop History panel / History Log | **Log**, and an unauthenticated one. |
| Photoshop `ActionDescriptor` stream | **Recipe-grade input**, but only as *captured by us* — Adobe does not persist or sign it. |
| Lightroom/ACR `crs:` settings (in XMP or in the C2PA actions) | **Recipe inside a closed loop.** Deterministic given the same raw, same ACR version family, same `crs:ProcessVersion`, same `.dcp` version, Adobe's binary. Not re-derivable by a third party — no OSS implementation claims bit-identical ACR output, and Process Version exists *because* the render drifts. |
| PSD non-destructive layer stack | **Partial recipe** — adjustment-layer parameters and embedded smart-object sources survive. |
| PSD destructive work (brush, clone, heal) | **Neither.** Pixels only. And this is most of the actual work in Photoshop. |
| Flattened JPEG/PNG export | **Nothing** beyond pixels and export-time metadata. |

The permitted wording follows directly, and it is narrower than the marketing
instinct wants:

- ✅ *"These states were witnessed at these times, in this order, sealed."*
- ✅ *"These declared develop settings accompanied the file at the moment of
  witness."*
- ❌ *"Anyone can reproduce this image from the original plus these settings."*
  Nobody outside Adobe can, and Adobe only can while the Process Version pin
  holds.
- ❌ *"This is the complete edit history."* Not from any Adobe surface. Adobe's
  own editors decline to assert it — `allActionsIncluded` is absent from every
  human-editing manifest we read.

This is `CUSTODY_LOCUS.md`'s two honest sentences arriving from the other
direction. Adobe holds `tenant-custody` and correctly claims only the notarial
sentence. Where they stop short is that they do not claim even *that* — nothing
in Adobe's stack asserts continuity between two saves, because nothing in
Adobe's stack is looking between two saves.

### 5.3 Does Adobe's design reflect the inverted threat model?

**Yes, unmistakably, and the tell is that every control points at the creator's
convenience rather than at an adversary.**

- The creator **chooses what goes in**: "You can select which attribution and
  edit history actions to include… and decide whether to share your name,
  connected accounts, and your edits and activity."
- The creator can **withdraw the cloud copy** after publishing
  (`contentauthenticity.adobe.com/manage`).
- The History Log is **off by default** and deletable with public API.
- Identity is **opt-in social proof** — the `cawg.identity` credential in the
  ACA sample lists Instagram / Behance / LinkedIn / X handles, issued by
  `did:web:connected-identities.identity.adobe.com`. That is an assertion of
  *who I am*, aimed at attribution and credit, not at binding a suspect.
- Retention is a **sliding window** (30 days unmarked in Photoshop, 60 in
  Fresco) — sized for "undo last week's mistake", not for "answer a dispute in
  two years".

**What they chose not to protect against, stated plainly: the creator.** Every
mechanism in the Adobe stack is creator-controlled and creator-revocable. There
is nothing that binds a creator to a record they later wish were different —
which is the correct design for attribution and the wrong design for evidence.
The adversary Adobe models is a **third party who strips or spoofs** the
credential downstream, and the whole durable-credential apparatus (TrustMark
watermark `com.adobe.trustmark.P`, dense fingerprint `com.adobe.icn.dense`,
cloud repository) is aimed squarely at that one. It is good work on that
adversary.

They also chose not to protect against **the gap**. There is no mechanism
anywhere in the stack that says anything about the interval between two saves,
because the two systems that could — the cloud version timeline and the C2PA
manifest — are disjoint and one of them has no integrity claim at all.

That leaves the strongest available sentence in this market unclaimed: *"this
project passed through these states and nothing happened in between that we did
not see."* We cannot say the second half at `tenant-custody` either — but we can
say **"these states, in this sealed order, with this declared coverage, and here
is where the gaps are"**, and nobody in the Adobe stack says any of it.

### 5.4 Proof it was made WITHOUT AI

**Easier, in three specific ways:**

- The vocabulary exists and we already require it. IPTC `digitalCreation` =
  "Media created by a human using non-generative tools", and `signAsset.ts`
  refuses to sign without an explicit `digitalSourceType` — no default, no
  inference from `product`.
- C2PA 2.4 §18.28.3 makes the mapping explicit: `digitalSourceType:
  digitalCreation` ⇒ `humanOversightLevel: not applicable` ⇒ **"No trained model
  invoked; AI Model Disclosure assertion is not attached"** [VERIFIED].
- Adobe *does* label its own generative work honestly and specifically — the
  Firefly manifest carries `com.adobe.firefly.operation: "text_to_image"`,
  `trainedAlgorithmicMedia`, and `allActionsIncluded: true`. When Firefly is
  used inside Photoshop and Content Credentials are on, that is a positive
  signal we can witness rather than infer.

**Harder, in four ways that matter more:**

1. **It is an absence claim, and C2PA's own structure says absence is not
   evidence.** §18.15.3: an omitted `allActionsIncluded` means "additional,
   unrecorded actions may have been performed." Every Adobe human-editing
   manifest we read omits it. So "no AI action is listed" is, by the standard's
   own reading rule, worth nothing on its own.
2. **The record starts at export.** PSD carries no manifest. All the AI a user
   could apply in a PSD session is invisible until an export they control.
3. **Lightroom's newest AI edits are moving out of the readable formats.**
   Denoise, AI masks and generative features live in `.lrcat-data` and the new
   `.ACR` sidecar blob rather than plain-text `crs:` XMP. The signals we would
   most want to detect are the ones becoming least legible.
4. **The user can suppress the edit list** and still ship a valid signed
   credential.

So the honest form of the claim cannot rest on the artifact. It has to rest on
**coverage plus custody**: *"a capture with this declared coverage was running
across this interval and observed no AI-attributable event"* — which is exactly
a `locus` × `placement` statement, and exactly why this is a class and not a
feature. And it means the weakest link is not cryptography; it is the
enumerated event-code allowlist from §5.1, because that list is what "declared
coverage" actually means in Photoshop.

### 5.5 Concrete follow-ups

1. **`lib/capture/surface.ts` has no Adobe profile at all.** Nine
   `CANON_HOST_PROFILES` and not one of them is Photoshop, though the plugin has
   existed since 2026-07-09. Add `photoshop_uxp`: hooks
   `['attach','detach','document.open','document.save','idle.tick']`, surfaces
   `['host-api-callback']`, `declaredPlacement: 'unattested-client'`,
   `enforcement: 'none'`, `attestation: 'none'`,
   `capabilityClasses: ['authoring-application','asset-custody']`,
   `custodyLocus: 'tenant-custody'`.
2. **`idle.tick` is already half-built and pointed at the wrong thing.**
   `lib/scruple-common.js:129` runs a `setInterval` that pings
   `/api/scruple/handoff/heartbeat` — auth liveness, witnessing nothing. That
   timer is the natural dirty-poll for custody (the pattern
   `CANON_SKELETON.md:283` already names for Inventor and SolidWorks at 300s).
3. **The witness has a silent-degradation path.** `witnessSave()` falls back to
   `output_hash: null` on a file-read failure and still records the event. A
   leaf that asserts a save happened and nothing about what was saved should be
   marked as a gap, not stored as a witness.
4. **The C2PA MIME mismatch.** The Adobe witness route stamps
   `output_content_type: 'image/vnd.adobe.photoshop'`, which appears in neither
   `GENERATE_MIMES` nor `VALIDATE_MIMES`. Correct behaviour, undocumented
   consequence: the plugin's "Sign C2PA" button can only ever apply to an
   exported JPG/PNG.
5. **Emit `allActionsIncluded` deliberately.** We never set it, so validators
   read our manifests as incomplete — which today is *true* and therefore fine.
   The moment we ship event-stream capture, setting it becomes a decision with
   an evidentiary basis, and it should be tied to declared coverage rather than
   to a hardcoded literal.
6. **Bind Adobe's manifest as an ingredient.** When a Photoshop export already
   carries an Adobe-signed Content Credential, hash it into our leaf. We
   currently construct no `c2pa.ingredient` at all despite allowlisting the
   label.

---

## Appendix — sourcing notes

`helpx.adobe.com` is JS-rendered and refused essentially every direct and
proxied fetch from this host (60s timeouts, HTTP/2 stream resets). Adobe
first-party claims below are therefore tagged one of three ways:

- **[VERIFIED]** — quoted from a page we actually read, including Wayback
  snapshots (`web.archive.org/web/<ts>if_/<url>`), which worked where the live
  site did not.
- **[VERIFIED via indexed helpx copy]** — a search engine's rendering of the
  page, consistent across independent queries, but not a first-hand read.
- **[NOT VERIFIED]** — community sources, or absence of evidence.

The strongest evidence in this study is not Adobe prose at all. It is
`github.com/contentauth/example-assets`, the CAI's repository of signed sample
assets with their extracted manifests — the actual output of Adobe's own
signers, fetched and parsed directly:

| File | Generator | Signer CN |
|---|---|---|
| `images/manifests/car-es-Ps-Cr.json` | `Adobe_Photoshop/26.11.0 adobe_c2pa/0.14.2 c2pa-rs/0.43.0` | Adobe C2PA |
| `images/manifests/crater-lake-cr.json` | `lightroom/8.5.1` | Adobe C2PA |
| `images/manifests/cloudscape-ACA-Cr.json` | Adobe Content Authenticity web app | Adobe Content Authenticity |
| `images/manifests/Firefly_tabby_cat.json` | `Adobe_Firefly` | Adobe Firefly C2PA |
| `images/manifests/ChatGPT_Image.json` | ChatGPT (contrast case — the only real chain) | Truepic Lens CLI in Sora |

Two Adobe documentation defects worth recording, both found while trying to
answer simple questions:

- The History panel default depth is **20** on
  `history-panel-overview.html` and **50** on `performance-preferences.html`.
  Both pages are current.
- Unmarked cloud-document version retention is **30 days** for Photoshop and
  **60 days** for Fresco. There is no platform-wide number.
