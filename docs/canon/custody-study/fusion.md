# Custody Study: Autodesk Fusion — what its native tracking actually is

_Study for the `asset-custody` capability class. Frame: `CUSTODY_LOCUS.md`,
`CAPABILITY_CLASSES.md`, `PLACEMENT_AND_SURFACES.md` §7.4 and DEFECT-3.
Follows the `oss-study/` house style: bottom line first, cite or admit._

**Bottom line.** Fusion's "native project tracking" is two disjoint systems, and
only one of them supports the founder's claim: the **parametric timeline** — the
rich one, ordered, readable, and carried inside the `.f3d` — has **no timestamp,
no author and no stable per-operation id**, is fully rewritable through Fusion's
own published scripting API, and `design.designType = DirectDesignType` destroys
the entire history in one assignment, documented by Autodesk in those words and
recorded nowhere. The **cloud version history** is the real guarantee and it is
stronger than we assumed — the Data Management API v2 contains **no `DELETE` verb
anywhere**, and Autodesk states outright that for Fusion Team files a version
cannot be removed even by the soft-delete route BIM 360 has — but it is still
Autodesk's ordinary mutable database: a version's `name` is `PATCH`-able, its
description is editable after the fact, and there is no hash, no signature and no
customer-verifiable log. So *"tampering means hacking Fusion"* is **false of the
timeline and false of the local file** (a plain store-compressed ZIP with no
integrity field anywhere in it) and **true of the cloud version sequence only in
the sense that you would have to be Autodesk.** The payoff is that the timeline
*is* a readable recipe — `TimelineObject.entity` exposes each feature's full
parametric definition — which is a far better artifact than the ephemeral blob we
hash today, and Autodesk's Fusion Automation API (GA 2025-05-19) runs that same
read **server-side against cloud-held designs**, which is the only path that
retires our `induced` fidelity problem, since `DataFile.download` — *"Only
DataFiles that represent non-Fusion data can be downloaded"* — makes the obvious
fix impossible from inside the add-in.

---

## 0. Method, and what "verified" means here

**VERIFIED** = fetched from a live page and quoted. Autodesk's static API
reference at `help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/*.htm`
responds; the GUID-routed `help.autodesk.com/view/fusion360/ENU/?guid=…` portal
404s to a fetcher; `aps.autodesk.com/en/docs/**/reference/http/**` is a JS SPA
that returns chrome only; `forums.autodesk.com` and much of
`autodesk.com/support` return 403 / Cloudflare challenges.

The APS reference was worked around by pulling the **source OpenAPI YAML**
Autodesk publishes for it:
`raw.githubusercontent.com/autodesk-platform-services/aps-sdk-openapi/main/datamanagement/datamanagement.yaml`
(8,289 lines, fetched in full) and the sibling `oss/oss.yaml`. Those are
Autodesk-hosted primary sources for the same API and are the basis of §2.

Forum material arrives via search snippets and is marked **third-party**.
**Nothing below was run against a live Fusion** — there is no seat in this
environment — so every runtime claim is a documentation claim, and §5's
DEFECT-F1 in particular needs one live session to confirm.

---

## 1. The design timeline (`adsk.fusion.Timeline`)

### 1.1 What it is

`Design.timeline` — VERIFIED, `Design.htm`: *"Returns the timeline associated
with this design."* `Timeline.htm`'s class doc: *"A collection of TimelineObjects
in a parametric design."*

**Ordered:** yes. `TimelineObject.index` — *"Returns the position of this item
within the timeline where the first item has an index of 0."*

**Complete**, in the sense of "every modelling operation": yes, for a parametric
design — every feature, sketch, construction entity and joint lands as a node.
**Not** complete in the sense a custody class means: it holds the operations that
*survive*, not the operations that *happened*. A feature created and then deleted
leaves nothing behind.

**Addressable:** only weakly, and this is the first hard finding. `Timeline`
exposes `count`, `item(index)`, `markerPosition`, `timelineGroups`, `isValid`,
`objectType` — and **no `itemByName`** (VERIFIED by absence from `Timeline.htm`).
Index is positional and shifts under reorder. The nearest thing to a stable
handle is `Feature.entityToken`, reached via `timelineObject.entity`, and
Autodesk explicitly disclaims it as an identity (VERIFIED,
`Feature_entityToken.htm`):

> "The token string returned for a specific entity can be different over time…
> you should never compare entity tokens as way to determine what the token
> represents."

So: **an ordered list with no primary key.**

### 1.2 What an add-in can read

VERIFIED — the complete member list from `TimelineObject.htm`, nothing elided:

| | |
|---|---|
| **Methods** | `canReorder`, `classType`, `reorder`, `rollTo` |
| **Properties** | `entity`, `errorOrWarningMessage`, `healthState`, `index`, `isGroup`, `isRolledBack`, `isSuppressed`, `isValid`, `name`, `objectType`, `parentGroup` |

**There is no timestamp. There is no author. There is no id.** Confirmed
independently by a second researcher walking the same reference tree.

Operation *type* and *parameters* are readable, but through `entity`, not through
the timeline node. VERIFIED, `ExtrudeFeature.htm`: `profile` (*"the profiles or
planar faces used to define the shape of the extrude"*), `extentOne`/`extentTwo`
(typed as `DistanceExtentDefinition` / `ToEntityExtentDefinition` /
`ThroughAllExtentDefinition`), `taperAngleOne`/`taperAngleTwo`, `operation`
(join/cut/intersect/new-body), `participantBodies`, `extentType`, plus the
`timelineObject` backlink and an `attributes` collection. Every feature class
follows this shape. **The construction recipe is fully readable.**

Two details worth carrying: `entity` returns `null` for a `TimelineGroup`, and
`TimelineObject.name` is *settable* — *"Gets and sets the name of this timeline
object. This name is shared by the object the timeline object represents."*

### 1.3 Does it survive save/reopen? Where does it live?

In the design, and therefore in the file. The `.f3d` archive carries it —
Autodesk support staff, via forum (**third-party**, direct fetch 403'd):

> "STEP files will not include design history, but you can maintain the design
> history by exporting a local archive copy in .f3d format and uploading it to
> the data panel."

Corroborated by several independent secondary sources: F3D "is the only file type
that preserves Timeline information"; "Generic file types (IGES, STEP, STL, etc)
do not contain timeline information."

Caveat, **third-party**: an export archives *the current state of the timeline
only* — "the Autodesk Fusion export feature archives only the latest version of a
design, and if all previous versions… need to be archived locally, it is required
to open each instance of a version and export it one by one."

### 1.4 The crux: can it be edited after the fact, and is that recorded?

**It can be edited freely, and nothing records it.** Every one of the following is
a documented public API member (VERIFIED):

- **Roll back:** `Timeline.markerPosition` (get *and set*), `moveToBeginning`,
  `moveToEnd`, `movetoNextStep` (Autodesk's own casing — lowercase `t`),
  `moveToPreviousStep`; `TimelineObject.rollTo(rollBefore)`.
- **Bulk delete:** `Timeline.deleteAllAfterMarker` — *"Deletes all objects in the
  timeline that are after the current position of the marker."* Two calls —
  set `markerPosition = k`, then `deleteAllAfterMarker()` — truncate the history.
- **Delete one node:** not on `TimelineObject` (it has no `deleteMe` — VERIFIED by
  absence) but via `timelineObject.entity` → `Feature.deleteMe()`, *"Deletes the
  feature. This works for both parametric and non-parametric features."*
  `TimelineGroup.deleteMe` takes a keep-or-delete-contents option.
- **Suppress:** `TimelineObject.isSuppressed`, get **and set**.
- **Reorder:** `TimelineObject.reorder(index)`, gated by `canReorder`. (There is
  no `dragTo` — that is the UI verb, not the API.)
- **Re-parameterise any feature at any index:** `ExtrudeFeature.profile`,
  `.extentOne`, `.taperAngleOne`, `.operation` are all get/set.

**And the nuclear option is a single assignment.** VERIFIED verbatim,
`Design_designType.htm`:

> "Changing an existing design from ParametricDesignType to DirectDesignType will
> result in the timeline and all design history being removed and further
> operations will not be captured in the timeline."

`design.designType = adsk.fusion.DesignTypes.DirectDesignType` — one line, in the
scripting console Fusion ships with, no add-in install, no signature bypass, no
exploit. **The entire design history is gone and the API records nothing about
it.**

Searched for and **not found** anywhere on `Timeline`, `TimelineObject`,
`TimelineGroup`, `Feature` or `Design`: any `modifiedBy`, `editHistory`,
`lastEditedDate`, change-log member, or timeline audit object. Searched for and
**not found**: any timeline-scoped lock — no `Timeline.isReadOnly`, no
`TimelineObject.isLocked`. What exists instead is document- or component-scoped
and user-reversible: "Read-Only for Me" (a per-user collaboration reservation the
same user toggles off) and component "Lock components" (**third-party**, neither
independently fetched, neither surfaced as an API property).

**Conclusion for §1.** The timeline is the richest provenance artifact in the
product *and* it is ordinary, unsigned, undated, unattributed application state
with a documented one-call destructor. Witness it because it is rich. Never
because it is trustworthy on its own.

---

## 2. Document version history

This is where the founder's instinct is right, and it is right for a more
specific reason than "Fusion tracks things."

### 2.1 Identity — VERIFIED, with real URNs

Two URN shapes, differing by prefix and by the presence of `?version=N`:

| | Shape | Example (Autodesk's own) |
|---|---|---|
| **Item / lineage** | `urn:adsk.<env>:dm.lineage:<id>` | `urn:adsk.wipprod:dm.lineage:hC6k4hndRWaeIVhIjvHu8w` |
| **Version** | `urn:adsk.<env>:fs.file:vf.<id>?version=N` | `urn:adsk.wipqa:fs.file:vf.W3syIw1lQAW-5vWObMdYnA?version=2` |

Both examples are quoted from `DataFile_id.htm` and `DataFile_versionId.htm`,
which say in each case *"This is the same id used in the APS Data Management API…
in the unencoded form."* `wipprod` is the production Work-In-Progress environment
backing Fusion Team / Autodesk Docs. The lineage id and the version id share the
same base62 body — the same file, at a point in its sequence.

In the Data Management JSON there is no literal `lineageUrn` field; a version's
`relationships.item.data.id` **is** the lineage URN.

`versionNumber` is `integer/int32`, *"Version number of this versioned file"*,
observed as 1, 2, … in Autodesk's own example. **Monotonicity is inferred from the
example, not stated as a guarantee anywhere found.**

### 2.2 What the two APIs expose

**From inside Fusion** — VERIFIED, `DataFile.htm`. `adsk.core.DataFile` carries
exactly the identity and provenance the timeline lacks: `id` (lineage),
`versionId`, `versionNumber`, `versions`, `latestVersion`, `dateCreated` /
`dateModified` (*"as UNIX epoch time"*), `createdBy` / `lastUpdatedBy` (*"the User
that created / last updated this data file"*), `isMilestone` / `milestone` /
`milestones`, `promote()`, `createDataVersion()`, `deleteMe()`, `refresh()`.
`Document.creationId` is *"unique and remains constant for the life of the
document."*

Two traps. `Document.version` is *"the Fusion version this document was last saved
with"* — the **application** version, not the document's. And `Milestone` is
thinner than its name suggests (VERIFIED, `Milestone.htm`): `name` (settable),
`version`, `isValid`, `objectType` — **no date, no author, no `deleteMe`**.

**From outside** — VERIFIED against `datamanagement.yaml`. Endpoints:
`GET projects/:project_id/items/:item_id/versions`,
`GET projects/:project_id/versions/:version_id`,
`GET projects/:project_id/items/:item_id/tip`,
`GET projects/:project_id/versions/:version_id/refs`,
`GET|POST …/versions/:version_id/relationships/refs`, and —
noted for §2.4 — `PATCH projects/:project_id/versions/:version_id`.

Autodesk's own example `Version` object, quoted from the spec:

```json
{
  "type": "versions",
  "id": "urn:adsk.wipprod:fs.file:vf.b909RzMKR4mhc3O7UBY_8g?version=2",
  "attributes": {
    "name": "version-test.pdf",
    "createTime": "2016-04-01T11:12:35.000Z",
    "createUserId": "BW9RM76WZBGL",
    "createUserName": "John Doe",
    "lastModifiedTime": "2016-04-01T11:15:22.000Z",
    "lastModifiedUserId": "BW9RM76WZBGL",
    "lastModifiedUserName": "John Doe",
    "versionNumber": 2,
    "extension": { "data": {
      "storageUrn": "urn:adsk.objects:os.object:wip.dm.prod/9f8bdc3f-….pdf",
      "storageType": "OSS" } }
  },
  "relationships": {
    "item":    { "data": { "type": "items",   "id": "urn:adsk.wipprod:dm.lineage:b909RzMKR4mhc3O7UBY_8g" } },
    "storage": { "data": { "type": "objects", "id": "urn:adsk.objects:os.object:wip.dm.prod/9f8bdc3f-….pdf" } }
  }
}
```

`VersionAttributes` **required** fields: `name`, `displayName`, `versionNumber`,
`createTime`, `createUserId`, `createUserName`, `lastModifiedTime`,
`lastModifiedUserId`, `lastModifiedUserName`, `extension`. `fileType` and
`storageSize` are conditional (*"only present if this version represents a
file"*).

So **who and when do exist** — at whole-document save granularity, in Autodesk's
cloud, not in the timeline. The two systems are disjoint: the timeline knows the
operations and not the time; the version record knows the time and not the
operations.

### 2.3 Append-only — the strongest finding in this study

**There is no `DELETE` verb anywhere in the Data Management API v2.** VERIFIED by
grepping the full 8,289-line OpenAPI spec: zero `delete:` operations, zero
`operationId: delete*`. Deletion is not a capability of this API.

And for Fusion specifically, Autodesk says so directly. APS blog,
*"The way to delete file version through Forge DM API"* (fetched, quoted
verbatim):

> "if you want to delete the version, you CAN NOT achieve this by using DELETE
> buckets/:bucketKey/objects/:objectName API to delete content direct from OSS…
> Because if you do this way, it would be modifying the internal immutable data
> model of Autodesk SaaS application. Instead, you need to post a new version with
> 'versions:autodesk.core:Deleted' type… **Unfortunately, the way only apply for
> BIM360 Docs, for files in A360 Personal, BIM360 Team or Fusion Team, you can
> not delete the file version, this is a current limitation.**"

Even BIM 360's soft-delete — posting a tombstone version — is unavailable to
Fusion Team. **A Fusion version sequence is append-only in fact, not merely by
convention.** This is the mechanical core of the founder's claim and it survives
scrutiny.

What *is* removable is coarser and different in kind:

- **Item-level soft delete.** `ItemAttributes.hidden`, VERIFIED verbatim from the
  spec: *"`true`: The file has been deleted. `false`: The file has not been
  deleted."* That flags the whole lineage, not a version.
- **`DataFile.deleteMe()`** — *"Deletes this DataFile. This can fail if this file
  is referenced by another file or is currently open."*
- **Project deletion by an administrator** (**third-party**, Cloudflare-blocked
  on direct fetch): deleting an archived project *"irrevocably"* deletes its data.
  That is the only documented purge lever, and it is all-or-nothing.

`promote()` — *"Promotes this version to be the latest version. If this is the
latest version, nothing happens."* Whether that creates version N+1 or moves a
pointer is **not stated in any primary source found**. Given no `DELETE` verb and
`createDataVersion()`'s *"Creates a version of this DataFile at tip"*, N+1 is the
high-confidence inference — but it is an inference, and it matters, so it is open
question 3.

Version retention caps for Personal-use licences: **not verified.** The
well-documented personal-use limit is on *editable documents* (10), not on
version count or age; no version-retention policy was found either way.

### 2.4 Is it tamper-evident? No — and the metadata is mutable

Append-only rows are not the same as an immutable record, and this is where the
claim has to stop.

**Version metadata is editable after the fact.** `PATCH projects/:project_id/
versions/:version_id` exists in the spec — *"Updates the properties of the
specified version of an item. Currently, you can only change the name of the
version."* `DataFile.description` is *"Gets **and sets** the description
information."* `DataFile.createDataVersion(versionDescription)` (added November
2025) documents that *"The versionDescription is visible in the History Panel"* —
so the human-readable story attached to a version is authored, and re-authorable,
by the user. Note too that Autodesk's `Version` object carries
`lastModifiedTime` / `lastModifiedUserId` / `lastModifiedUserName` as **required**
fields: a genuinely immutable version record would not need them.

**There is no cryptography anywhere in it.** VERIFIED as an absence across the DM
spec, the OSS spec, and the Fusion API reference: no signature, no hash chain, no
Merkle structure, no notarisation, no customer-verifiable log. Autodesk's own
most authoritative statement, the *Autodesk Fusion 360 Security Whitepaper*
(trust.autodesk.com, 2018-09-25), goes exactly this far and no further:

> "For every design, Autodesk Fusion 360 maintains a version history. Versioning
> protects the integrity of data by allowing users to roll back to earlier
> versions and providing an auditable list containing information about each file
> modification."

> "All Fusion 360 designs are saved in the cloud on encrypted storage. The
> storage solution uses 256-bit Advanced Encryption Standard (AES-256) to encrypt
> data."

> "Locally, cached designs rely on the Operating System user-level permissions
> for access control."

"Integrity" there means **rollback**, not tamper-evidence. A customer cannot
verify that version 7 today is byte-identical to version 7 last year; they can
only ask Autodesk.

**The one hash that exists, and whether we can reach it.** OSS's
`GET buckets/{bucketKey}/objects/{objectKey}/details` returns a `sha1` —
*"A hash value computed from the data of the object"* (VERIFIED in `oss.yaml`,
with a worked example). A Fusion version's `storage` relationship resolves to an
OSS object in an **Autodesk-owned** system bucket (`wip.dm.prod`). The *download*
path through that scoped link is documented as working; whether the sibling
`/details` endpoint — the one that returns `sha1` — succeeds for a customer's
3-legged token against a bucket they do not own is **NOT VERIFIED**, and search
evidence surfaced "Only the bucket creator is allowed to access this api" in
adjacent 403 contexts. Treat "a customer can obtain a hash of their own Fusion
version's bytes" as **unproven**. No `x-ads-*` hash header exists anywhere in the
OSS spec (searched exhaustively); `ETag` appears only inside the signed-S3 upload
completion flow.

**Audit log.** The Data Connector / activities API (`GET projects/:project_id/
activities`) is described throughout as BIM 360 / ACC / Forma — all `b.`-prefixed
hubs. The `a.` / `b.` split is real and structural (VERIFIED in the spec: *"To
convert a BIM 360 or ACC Account ID to a hub ID, prefix the Account ID with
`b.`"*, and `pimCollection` is *"available only for Fusion Team hubs and A360
Personal hubs"*). No evidence was found that any open/download/edit audit log
covers Fusion Team hubs. **Working conclusion: Fusion Team has no activity audit
API. Not confirmed by an explicit Autodesk negative.**

---

## 3. The file format

**`.f3d` is a plain ZIP.** VERIFIED to the extent that a `file(1)` output posted
in public counts — a Prusa3D forum thread (fetched directly) reports:

> "f3d: Zip archive data, at least v1.0 to extract, compression method=store"

and "f3d is **regular ZIP file** and preview is already there in form of png
image" — the preview living at `FusionAssetName[Active]/Previews/small.png`. Note
**`compression method=store`**: member entries are uncompressed, so the internal
parts are individually addressable and individually hashable.

**Contents** (**third-party**, from the Autodesk Community thread *"File format
specification for .f3d?"*, which 403'd on direct fetch): a folder tree of `.dat`,
`.irondoc`, `.messagelog`, `.png`, `.protein`, `.smb`, `.smbh`, `.toolpath` and
`.tsm` parts. The same thread reportedly carries Autodesk's own answer that the
format is "closed and constantly evolving" and that developers should use the
API. **No public specification exists.** No Kaitai Struct definition exists
(VERIFIED by searching `kaitai-io/kaitai_struct_formats`). FreeCAD documents no
native `.f3d` import and tells users to route through STEP/IGES; Blender has none.

**`.f3z`** is a ZIP bundle of `.f3d` parts plus JSON manifests, used when a design
carries external references — VERIFIED via Autodesk's own APS blog
(`aps.autodesk.com/blog/download-fusion-360-archives`), where a Model Derivative
download job produces `{"format": {"fileType": "f3z"}}`.

**Does the file carry the history, or is history cloud-side? Both, differently —
and the split is the answer to the `tenant-custody` question.** The **timeline**
ships in the file (§1.3). The **version history** does not: it is an
Autodesk-side record keyed by lineage and version URN with no file-resident
counterpart. Autodesk's whitepaper draws the same line — cloud designs get AES-256
and a version history; *"locally, cached designs rely on the Operating System
user-level permissions."* The local cache is a working copy, not the record.

**So a Fusion deployment can carry its own *recipe* offline — the timeline is in
the bytes — but it cannot carry its own *continuity*.** Version identity,
ordering, authorship and timing are all Autodesk-held. Cut the cloud and Fusion is
a rich snapshot format with no history of its own.

**Model Derivative** can take F3D as a source, but every documented target — DWG,
FBX, IGES, OBJ, STEP, STL, SVF/SVF2, thumbnail — is a history-free format, and its
manifest is described (**third-party**, AI-synthesised wiki, low confidence) as
exposing a geometric object tree for the derived viewable. **Whether Model
Derivative can surface the parametric feature tree is NOT VERIFIED in either
direction; the circumstantial evidence says no.**

---

## 4. Tamper-evidence, honestly

Take the founder's sentence — *"to tamper with it, you would have to hack Fusion
itself"* — and test it at each locus.

| Locus | Is tampering hard? | Evidence |
|---|---|---|
| **The live timeline, in-session** | **No.** Trivially rewritable. | `deleteAllAfterMarker`, `Feature.deleteMe`, `isSuppressed`, `reorder`, get/set feature parameters, and `designType = DirectDesignType` which deletes all history in one assignment. Fusion ships a scripting console; no install, no signature, no exploit. Nothing is logged. |
| **The `.f3d` on disk** | **No, in principle.** | Plain store-compressed ZIP. No signature, MAC or checksum found anywhere — including in Autodesk's own security whitepaper. What actually protects it is *obscurity*: the `.smb` / `.protein` / `.irondoc` parts are undocumented, so a naive hex edit corrupts rather than forges. Nobody has published a successful hand-edit; nobody has published a detection mechanism either. **Not verified in either direction — assume no tamper-evidence.** |
| **The cloud version sequence** | **Yes, and better than expected — but not by cryptography.** | No `DELETE` verb exists in the whole DM API, and Autodesk states a Fusion Team version *cannot* be deleted at all. A user genuinely cannot excise version 5. But a version's `name` is `PATCH`-able, its description is re-authorable, `promote()` and item-level `hidden` exist as legitimate mutation paths, and there is no hash, no signature and no verifiable log. You would have to be Autodesk. |

The honest form of the claim is therefore:

> **Fusion's cloud version *sequence* is append-only and outside the user's reach,
> so a user cannot forge or excise a state in it. Fusion's *timeline* and *file*
> are ordinary application data the user can rewrite with Fusion's own published
> API. And Autodesk offers no cryptographic evidence of any of it — the
> corroboration is an operator's word, not a proof.**

That is still a materially better position than Blender, which has **no**
tenant-inaccessible record at all. But it is a claim about **Autodesk as a
witness**, not about Fusion as tamper-proof. It supports `tenant-custody` plus a
corroborating third party. It does not support *"this is the complete history of
the project"* in `CUSTODY_LOCUS.md`'s sense, and nothing we build can make it.

---

## 5. What our own plugin does today — and three defects

Read: `/data/scruple-fusion/ScrupleFusion.py`, `/data/scruple-fusion/lib/witness.py`,
`/data/scruple-fusion/lib/auto_witness.py`, `/data/scruple-fusion/lib/palette_host.py`.

**Hooks installed** (`ScrupleFusion.py`, around lines 1923–2016):
`app.documentSaved`, `app.documentActivated`, a 300 s dirty-poll
(`lib/auto_witness.py`, `DEFAULT_INTERVAL_SECONDS = 300`, gated on
`app.activeDocument.design.isDirty`, marshalled onto the API thread via
`fireCustomEvent`), and a `commandTerminated` handler that compares
`design.timeline.count` against a remembered value.

**What it hashes** (`lib/witness.py::export_and_witness`): tempfile path →
`design.exportManager.createFusionArchiveExportOptions(...)` →
`exportManager.execute()` → streamed SHA-256 → inline base64 (≤ 25 MB) →
`client.witness_cad(...)` → `os.unlink` in a `finally`. Exactly the `induced`
pattern DEFECT-3 names.

**What it writes back into the document** (`lib/witness.py::write_lock_attributes`
and `ensure_project_bound`): Fusion `Attributes` in group `"Scruple"` —
`project_id`, `scr_id`, `merkle_root`, `locked_at`, `lock_record_json`. This is
underrated. Attributes are part of the design, so they are saved into the cloud
version and travel inside the `.f3d`. **We already have a write channel into
Autodesk's append-only record.**

### DEFECT-F1 — the per-edit witness is registered on the wrong object and has almost certainly never fired

`ScrupleFusion.py`:

```python
cmd_handler = _CommandTerminatedHandler(app)
app.commandTerminated.add(cmd_handler)     # ← app, not ui
```

wrapped in a bare `except: pass`.

`commandTerminated` is a **`UserInterface`** event, not an `Application` event.
VERIFIED three ways: `Application.htm`'s event list does not contain it;
`Events_UM.htm` says *"the UserInterface object supports the
activeSelectionChanged, commandCreated, commandStarting, and several other
events"*; and the reference pages themselves —

```
UserInterface_commandTerminated.htm  → HTTP 200
Application_commandTerminated.htm    → HTTP 404
UserInterface_commandStarting.htm    → HTTP 200
Application_commandStarting.htm      → HTTP 404
```

If `Application` does not alias the property, `app.commandTerminated` raises
`AttributeError` straight into the swallow, the handler never attaches, and
`_diag_ping("timeline_grew", …)` has never once been emitted. The "witness every
edit" behaviour claimed in `SESSION_REPORT_2026-07-03.md` would then be, in
production, save-and-timer witnessing only. **Not runtime-verified — there is no
Fusion seat here.** One character changes `app` to `ui`; the real fix is to stop
swallowing registration failures silently.

### DEFECT-F2 — `timeline.count` as a change detector misses every interesting edit

Even once F1 is fixed, the handler fires only when `count` changes. It therefore
misses, silently:

- editing a feature's parameters (count unchanged) — the commonest real edit;
- `reorder` (count unchanged);
- suppress / unsuppress (count unchanged);
- roll back *k* and rebuild *k* (net zero);
- `designType = DirectDesignType`, which wipes the timeline through a path that
  is not a UI command at all when scripted.

A count is not a state. Witness a **digest of the timeline** instead (§6.1).

### DEFECT-F3 — we never bind the leaf to Fusion's own version identity

We read `dataFile.id` (the lineage URN) for project dedupe and nothing else. We do
not record `versionId`, `versionNumber`, `dateCreated` / `dateModified`,
`createdBy` / `lastUpdatedBy`, or `Document.creationId` — all VERIFIED-available,
and `documentSaved` fires *"after the save operation has been completed"*, so the
new version's identity is readable at exactly the moment we witness. **The one
mechanism in Fusion that genuinely resists the user is the one our leaf does not
reference.** Related, and smaller: `build_machine_manifest` still ships
`DEFAULT_FUSION_VERSION = "unknown"`.

---

## 6. Mapping to Scruple

### 6.1 What we could witness directly instead of reimplementing

**Witness the timeline, not the blob.** The timeline is ordered, fully readable
and semantically meaningful; the exported `.f3d` is an opaque proprietary ZIP we
can only hash. A canonical serialization — for each `TimelineObject` in index
order: `entity`'s `objectType`, `name`, `isSuppressed`, `isRolledBack`,
`healthState`, and the feature's typed parameters — is a JSON document we
canonicalize and hash the way we already canonicalize a ComfyUI graph. That
gives:

- a **digest that changes on parameter edits, reorders and suppressions**, which
  `timeline.count` does not (closes DEFECT-F2);
- a **human-readable, disclosable** artifact, unlike a `.f3d` blob;
- a per-witness record of **what the design was made of**, so a later deletion
  shows up as a diff between two witnessed timelines rather than as silence.

**Give the timeline the primary key Autodesk didn't.** `Feature.attributes` exists
on every feature (VERIFIED, `ExtrudeFeature.htm`). On each new feature we can
stamp a `Scruple` attribute carrying a monotonically increasing ordinal and the
witness time. Fusion supplies no per-operation id or timestamp; **we can mint
both**, and they persist in the design and travel inside the `.f3d`. A **gap in
our ordinal sequence is then positive evidence that a feature was deleted** —
which is exactly the "continuity between witnessed events" `CUSTODY_LOCUS.md`
asks for, and is not obtainable any other way.

**Witness Autodesk's version record as a co-signature.** At `documentSaved`, bind
`versionId`, `versionNumber`, `dateCreated` / `dateModified`, `createdBy` and
`lastUpdatedBy` into the leaf (closes DEFECT-F3). We are not reimplementing
Autodesk's history — we are *notarising a pointer into a record that is provably
append-only for Fusion Team* (§2.3). A version number that skips, or a
`lastUpdatedBy` that changes, then becomes checkable later.

**Do not reimplement:** version ordering, lineage, or authorship. Autodesk holds
these, holds them outside the user's reach, and does not let them be deleted —
which is more than our plugin can achieve on the user's own machine.

### 6.2 Is the timeline a recipe, the way a ComfyUI graph is?

**Yes in kind, no in degree, and the difference should be written down.**

A ComfyUI graph plus seeds and model hashes re-derives the artifact **on
independent hardware**. A Fusion timeline re-derives the model **only inside
Fusion**, because the geometry kernel is the interpreter and it is proprietary,
versioned and unavailable to a third party. Nor is the timeline self-contained: it
references profiles and entities by handles whose tokens Autodesk explicitly says
are unstable (`entityToken`, §1.1). A timeline export is a *description* of the
recipe, not an executable one.

What it does give is real: a third party can read the ordered operations and their
parameters, check them for consistency with the delivered geometry, and diff two
witnessed timelines to say precisely **which feature changed**. Stronger than a
hash comparison; weaker than re-execution. In `oss-study` terms it sits closer to
an in-toto *link* than to a reproducible build.

**One caveat that must not get lost:** the timeline is a recipe for the
*surviving* design, not a log of the *session*. Deleted experiments, rolled-back
branches and abandoned features are not in it. It answers *how was this built*,
never *what happened while it was being built*.

### 6.3 Honest assurance ceiling at `tenant-custody`

Fusion is `tenant-custody` by construction — the design opens on the artist's
machine and the cache is on their disk — but it is the **only** integration we
have whose state sequence is *also* held somewhere the tenant cannot reach and
cannot delete. That deserves a name, and the class should carry one.

Proposed: `tenant-custody` with a **third-party-corroborated** modifier, defined
as *files rest in tenant custody, and an independent operator holds an
append-only, non-tenant-writable record of the state sequence.* Its permitted
sentence sits between the two in `CUSTODY_LOCUS.md`:

> **These states were witnessed at these times, and an independent operator's
> append-only version record corroborates the sequence.**

It stops short of `vendor-custody`'s *"this is the complete history"* for three
reasons, each a finding above, each of which should be written into the class as a
stated limit:

1. **The gaps are real and unclosable.** Between two saves the user may roll back,
   delete, reorder, re-parameterise, or destroy the timeline outright. Autodesk
   records *that a save happened*, never *what happened between saves*. No amount
   of engineering in this locus produces a complete history.
2. **The corroborator is uncheckable.** No hash, no signature, no verifiable log —
   only Autodesk's assertion (§2.4), over rows whose `name` and description are
   editable after the fact. Corroboration means "a second party would have to lie
   too", not "the record is provable".
3. **The corroborator is intermittent.** Fusion has an offline cache and a
   last-save-wins sync (**third-party**; sources conflict between a two-week and a
   360-day offline window — unresolved). Work done offline reaches the version
   record as a single save on reconnect. Corroboration is only as dense as the
   connection.

And the class must state plainly that the modifier is earned by the **host's**
architecture, not ours. We did not build this guarantee, Autodesk did, and the
right posture is `STUDIO_IS_AN_EXEMPLAR.md`'s: say so, and say exactly how far it
goes.

### 6.4 Does any of this fix the `induced` fidelity problem?

**Not by itself — and one specific finding makes it worse before it makes it
better.** `DataFile.download` is documented as *"Only DataFiles that represent
non-Fusion data can be downloaded"* and `DataFile.dataObject` likewise fails for
F3D (§2.2 sources). So DEFECT-3's obvious repair — "move the observation to
`as-written` over the user's actual saved file" — **is not available from inside
the add-in.** Fusion will not hand us the bytes it saved. `ExportManager`
manufacturing a fresh serialization is not a shortcut we took; it is the only
door Autodesk left open.

Three routes out, ascending in strength:

1. **Retain and address the induced artifact.** We already inline the `.f3d` as
   base64 up to 25 MB. Populating `inducedArtifactRef` with the stored object's
   address makes the leaf checkable by anyone we hand the artifact to. That is the
   minimum the `ObservedBytes` interface already demands, and it is satisfiable
   immediately. It does not make the hash *re-derivable*; it makes the artifact
   *retrievable*, which is what the interface actually requires.
2. **Witness the canonical timeline (§6.1) as a second observation.** A timeline
   digest is not `induced` in the harmful sense — it is not a serialization we
   caused a black box to emit, it is a canonicalization **we** define over data we
   read. A third party running the same canonicalizer over the same design gets
   the same digest, subject only to the API returning the same values, which is a
   far weaker assumption than byte-determinism of Autodesk's archive exporter.
   **That determinism is unverified and must not be assumed in either direction —
   nobody has published a test.**
3. **Re-derive server-side. This is the real fix.** Autodesk's **Fusion Automation
   API is generally available** (VERIFIED, `aps.autodesk.com/blog/design-automation-api-fusion-now-generally-available`,
   GA 2025-05-19): it *"includes the Fusion Scripting API"* and runs it *"in the
   cloud using the data you already store on Fusion Team."* If the same
   canonicalizer can be submitted as a cloud job against a **specific version
   URN**, a third party — with the customer's authorization and no Fusion seat —
   can recompute the digest we witnessed, from Autodesk's own copy. That converts
   Fusion from `induced` to genuinely third-party-checkable and is the single most
   valuable thing to prototype out of this study. Whether a job can target a
   *specific historical version* rather than tip is **not verified**, and is
   question 1 below. Note `BUILD_PLAN.md` Phase 6 already anticipated this API
   while it was in beta; it is GA now.

One consequence to record while it is in view: `fusion_attested`'s declared
`fidelity: 'as-written'` in `lib/capture/surface.ts` is **wrong**. Signing the
add-in changes *placement*, not *fidelity*; the export path is `induced` whether
or not the host verified our signature. That field should read `induced` until
route 2 or 3 actually ships.

---

## 7. Open questions, ranked

1. Can a **Fusion Automation API** job target a **specific historical version
   URN**, and can it read `Design.timeline`? — decides §6.4 route 3, the highest-
   value item in this study.
2. Does `GET buckets/wip.dm.prod/objects/<key>/details` return `sha1` for a
   customer's own Fusion version under a 3-legged token? — decides whether §2.4's
   "uncheckable corroborator" can be upgraded to a checkable one.
3. Does `DataFile.promote()` create version N+1 or move the tip pointer? — decides
   whether append-only holds through the restore path.
4. Is `ExportManager`'s Fusion-archive output byte-deterministic for an unchanged
   design? — decides whether `induced` is recoverable without routes 2/3.
5. Does `app.commandTerminated` exist as an alias for `ui.commandTerminated`? —
   DEFECT-F1; one live session answers it, and the answer decides whether per-edit
   witnessing has ever run.
6. Version-retention policy on Personal-use licences, and whether any admin path
   short of project deletion can purge.
7. Offline window: sources conflict (two weeks vs 360 days). How long can the
   corroborating record be absent while work continues?
