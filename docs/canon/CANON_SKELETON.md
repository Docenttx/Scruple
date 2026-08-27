# The Canon Skeleton

**Status:** Design, for review. Nothing below is implemented.
**Version:** 0.1 · 2026-08-26
**Grades against:** `SCRUPLE_STANDARD_v1_7.md`, GPSA v3 (2026-07-30 bundle)
**Companion documents:** `openapi-v2.yaml` (machine-readable surface),
`STANDARD_v1.7_FULFILMENT.md` (clause-by-clause coverage),
`L2_FLOOR.md` (the assurance floor every decision below is bound by)

---

## 1. Why this exists

A conformance sweep on 2026-08-26 graded eleven Scruple integrations
against Standard v1.7 and GPSA v3. None had ever produced a content
credential. Four exposed a control claiming they did, each broken
differently — a stub `alert()`, a relabelled local lock, a wrong
endpoint, and a payload shape the API rejects. A fifth took payment and
wrote a placeholder.

Those were not five bugs. Both Python shells carry the identical nine
files by name — `auth`, `capture`, `manifest`, `payment`, `preferences`,
`queue_store`, `scruple_client`, `state`, `witness_flow` — with no shared
import and no common package. `queue_store.py` is 93% identical text
between them; `auth`, `payment` and `scruple_client` run 75–85%.
Meshroom's own commit message calls it a "lib port."

The skeleton already exists. It has been written six times, and each copy
drifted its own way on MIME handling, on what "sign" means, and on what
"paid" delivers. This document names it once.

**The window matters.** Nothing is in a customer's hands yet. There is no
compatibility burden today: `/api/v1/*` can be deleted rather than
deprecated, five auth mechanisms can collapse into one without breaking
anyone, and no integration needs a migration path. Every integration
shipped before this skeleton exists is one that has to be migrated
afterwards, with someone's production work depending on it. The cost of
this work is at its minimum now and rises monotonically.

---

## 2. Four layers

```
HOST ADAPTERS      hook bindings + native UI, one per application
                   the genuinely per-host work — keep what exists
─────────────────────────────────────────────────────────────────
CLIENT SDK         auth · capture · manifest · queue · state
                   witness_flow · payment · preferences
                   currently copy-pasted six times — build once
─────────────────────────────────────────────────────────────────
CANON HTTP (/v2)   session · baseline · witness · mark
                   receipt · capabilities — build once
─────────────────────────────────────────────────────────────────
SERVICES           c2pa-signer (CVM) · watermark · witness · chain
                   these mostly work
```

Only the two middle layers are missing. The adapters are largely correct
and the services largely function; the estate has no waist.

---

## 3. Design decisions

Numbered so review can accept or reject them individually. Each cites the
clause that forces it, or says plainly that it is a judgment call.

### D-0 · Every signed artifact clears the C2PA L2 bar. **This binds all others.**

Founder, 2026-08-26: *"we can't have an evidence standard below a simple
compliance standard."*

Scruple upgraded from C2PA Level 1 to Level 2 for the Conformance
Program. That upgrade landed on the C2PA signing path only. The witness
leaf — the substrate the Standard sells as sitting *beneath* C2PA — is
HMAC-sealed by a secret in a systemd env var on the application host,
from a service that is not in git and therefore cannot be measured.

Any artifact Scruple offers as evidence must be signed by a key held to
at least GPSR C.2.2 custody, inside the attested TOE, and be verifiable
by a third party without Scruple's cooperation.

No decision below may be satisfied by a mechanism that fails this. In
particular D-3 (baseline-or-refuse) is worth little if the baseline is
sealed by a key Scruple can forge and nobody else can check.

Analysis, per-family grading and the cost this implies: `L2_FLOOR.md`.

*Founder-set constraint, and the reason the CVM stops being optional.*

### D-1 · `/v2` is the only surface. `/api/v1/*` is deleted, not deprecated.

Four API generations coexist today: `/api/v1/*` (best documented, newest,
**zero production callers**), `/api/scruple/*` + `/witness/cad` +
`/lock/*` (what all eight integrations actually call), the bespoke
`/api/scruple/witness/{adobe,photoshop}` pair, and `/api/apps/kohya/witness`
with its own scheme. With no customers, deprecation machinery buys
nothing. Delete.

*Judgment call, not clause-forced.*

### D-2 · One auth model: bearer API key with enforced scopes.

Five mechanisms exist. `lock/local` accepts session cookies only, while
Blender's and Fusion's clients both document and assume bearer works
everywhere — a silent 401. `auth/keys` stores and returns scopes it never
checks.

Canon: every `/v2` route takes `Authorization: Bearer sk_...`. Scopes are
enforced, not decorative. Session cookies authenticate the browser UI
only and are never an alternative on a plugin route. Public read routes
(`/v2/receipt`, `/v2/verify`) take no credential at all, deliberately.

*Judgment call. Enforcing scopes may narrow what existing dev keys can
do — that is the point, but it is a behavioural change worth knowing about.*

### D-3 · Every leaf carries a baseline reference. No baseline, no witness.

§3: the baseline "is the tenant's genesis leaf", and "every subsequent
workflow leaf references the baseline." §2 says the integration itself is
witnessed, not merely the work it produces.

Not one integration establishes a baseline. The server has a baseline API
(`/api/v1/tenants/[tenant]/baseline/*`) that nothing calls, and re-baseline
never produces a witnessed leaf — `witness_leaf_id` is a permanent null,
so §4 is unimplemented end to end.

Canon: `POST /v2/witness` **rejects** a leaf whose `baseline_ref` is absent
or unknown. This is the single largest behavioural change in the skeleton
and the one most likely to be contentious: it makes baselining a
precondition for witnessing rather than an optional extra. §5 leaves no
room for a leaf that is witnessed-but-unbaselined — that is precisely the
"running unbaselined code" case the Standard calls *not Scruple-witnessed*.

*Clause-forced (§2, §3, §4, §5).*

### D-4 · The leaf records which modalities the user selected.

§9.5, verbatim: "The user's modality selection is itself recorded in the
event's leaf, so a downstream verifier can distinguish 'the user chose not
to attach C2PA' from 'C2PA was attached and later stripped.'"

Nothing records this today. It cannot be reconstructed after the fact —
absence of a credential is evidence of nothing unless the selection was
committed at signing time.

Canon: `modalities_requested` and `modalities_applied` are both leaf
fields. They differ when a modality was selected and failed, which is
itself the §7 signal that a Phase-3 operation is outstanding.

*Clause-forced (§9.5).*

### D-5 · Local lock is implicit in every event, not a modality you pick.

§9.4: "Every Scruple event produces a local lock; the other modalities
are attached alongside it, not instead of it."

Today local lock is one paid button among four, and three integrations
route their mislabelled "C2PA" control to it.

Canon: `POST /v2/mark` always finalizes a local lock. `modalities` selects
what is attached *alongside* it. There is no request that produces no
local lock.

*Clause-forced (§9.4).*

### D-6 · Chain lock auto-attaches the SCR_ID watermark on image, video, audio.

§9.3: the SCR_ID watermark "is the in-band component of the chain-lock
modality." It is coded and never invoked.

Canon: selecting `chain` on signable media attaches it without a separate
request. On media where it cannot be embedded, the response says so
rather than silently omitting it.

*Clause-forced (§9.3).*

### D-7 · `GET /v2/capabilities` declares applicability. Clients stop guessing.

C2PA and §9.2 watermarking are genuinely inapplicable to `.ipt`, `.iam`,
`.sldprt`, `.sldasm` — the GPSA's claim-generation MIME list excludes
them, and §9.2 is defined as a pixel or audio-sample transform with
nothing to embed into in a parametric file. Today each shell hides
buttons by hand, and the CAD shells inherited Fusion's assumptions
wholesale: every CAD upload is sent with a `.f3d` extension and a
`fusion-` job prefix regardless of host.

Canon: the client asks what applies to this host and this MIME, and
renders from the answer. Applicability becomes a server fact with one
place to correct it.

*Judgment call, but it is what stops the CAD trio from being permanently
mis-graded.*

### D-8 · `witnessed` is always explicit. `ok` never implies it.

§5 makes compliance binary. `ingest.ts` returned `ok:true` over a failed
witness with no `witnessed` field in the schema at all, while the Adobe
routes wrote `witnessed=1` unconditionally. The truth signal was broken
at both ends simultaneously. *(Both repaired 2026-08-26 — `bff1fd8`,
`45b8b89`.)*

Canon: every `/v2` response that touches a leaf carries `witnessed` as a
boolean and `leaf_scheme`. Capture remains non-blocking — that is a
deliberate design choice and it stays — but a caller can always tell.

*Clause-forced (§5).*

### D-9 · Attestation results carry `verified` or `passthrough`, never bare.

§12.4, verbatim: "A passthrough attestation MUST NOT present identically
to a root-verified one. 'Stored' MUST NOT read as 'verified.'"

All six hardware-attestation verifier plugins are structural-only — they
never chain to a vendor root — and present as verified. This is a direct
MUST violation and it also bears on the GPSA.

Canon: the attestation block is `{status: "verified" | "passthrough",
verifier_reference?}`. There is no shape that omits status.

*Clause-forced (§12.4).*

### D-10 · A failed Phase-3 operation queues and surfaces. It is never dropped.

§7: "Under no circumstances is a failed Phase-3 operation silently
dropped." Six integrations built an offline retry queue, tested it, and
never wired it into the failure path. The queue is not a nice-to-have
the shells each invented — it is a Standard requirement none of them met.

Canon: the SDK's queue sits in the failure path by construction, not by
remembering to call it. See §5 below.

*Clause-forced (§7).*

### D-11 · Continuity events can be marked retroactively.

§9.6 describes something the audit conflated with the offline queue, and
they are different. The queue retries *Scruple* witnessing. Continuity is
the customer's integration signing with **its own C2PA credentials,
outside Scruple's witness path**, during a Scruple outage — and those
events "are marked as such in the audit chain when the customer's
integration recovers connectivity."

Canon: `POST /v2/witness` accepts `continuity: {produced_at, external_manifest_hash}`
for an event that already happened outside the witness path. It becomes a
leaf that is explicitly *not* Scruple-witnessed but is recorded.

*Clause-forced (§9.6). Note this is a capability nothing has today and
nobody has asked for — flagged for review as possible scope to defer.*

---

## 4. Host hook contract

Every hook below was observed in at least two shells under a different
name. An adapter's entire job is mapping its host's vocabulary onto these
and rendering native UI. Nothing else belongs in an adapter.

| Hook | Fires when | SDK does | Seen as |
|---|---|---|---|
| `attach` | addon enabled / loaded | establish or verify baseline; emit §4 integration event | Blender `register()`, Fusion add-in `run`, ToonBoom startup |
| `detach` | addon disabled / host quitting | flush queue, close session | Fusion `stop`, Blender `unregister()` |
| `document.open` | a document becomes active | bind project context | Fusion `documentActivated`, Inventor `OnOpenDocument`, SolidWorks `FileOpenNotify2`, ToonBoom `onSceneChanged` |
| `document.close` | document closed | release context | Inventor `OnCloseDocument`, SolidWorks `DestroyNotify2` |
| `document.save` | user saves | **witness** — the universal trigger, present in all eight | Blender `save_post`, Fusion `documentSaved`, Inventor `OnSaveDocument`, SolidWorks `FileSavePostNotify`, ToonBoom `onSaveComplete`, Adobe UXP `save`/`documentSaved`/`afterSave` |
| `artifact.produced` | render/export finished | **mark** — an artifact now exists on disk | Blender `render_complete`/`render_write`, ToonBoom `onFinishedRender`/`onFinishedExport` |
| `graph.execute` | pipeline node/graph runs | witness the graph, not only the output | ComfyUI `/prompt` intercept, Meshroom `Node.processChunk` |
| `model.write` | checkpoint written | witness checkpoint + dataset root + hyperparameters | Kohya `safetensors.torch.save_file` monkey-patch |
| `idle.tick` | timer, host has no save event | dirty-poll fallback | Inventor `Document.Dirty` @300s, SolidWorks `GetSaveFlag` @300s |

Two hooks have no second implementation yet and are specified from a
single integration: `graph.execute` (the live ComfyUI proxy is the only
thing that captures a workflow graph) and `model.write` (Kohya). They are
in the contract because the shape of what they carry differs from
`document.save` — a graph and a training config are not a file.

---

## 5. Client SDK contract

One package. The six forks are deleted, not maintained alongside it.

**Modules** — the same nine that were copy-pasted, now with one owner:
`auth`, `capture`, `manifest`, `queue`, `state`, `witness_flow`,
`payment`, `preferences`, `client`.

**Three properties the SDK owns, because six shells each got them wrong
privately:**

1. **MIME is declared, never guessed.** Blender hardcodes
   `application/octet-stream` for every upload; Meshroom uses
   `mimetypes.guess_type()`, the exact extension-based auto-detect GPSA v3
   flagged for breaking `.flac` and `.jxl`; ToonBoom and both CAD shells
   send `octet-stream` always, which silently gates the server's
   image-only watermarker shut. `capture()` requires an explicit MIME and
   refuses without one.

2. **An unknown modality fails closed.** Matching the Signer's own
   `assertion_partition` posture: refuse rather than guess. A client
   asking for a modality this build cannot perform gets an error, never a
   silent downgrade to something cheaper that looks similar.

3. **The queue is in the failure path by construction.** Every network
   call goes through one `submit()` that enqueues on failure. There is no
   code path that can fail without enqueuing, so the queue cannot be
   built-and-forgotten a seventh time. §7 requires this; six independent
   implementations proved that leaving it to discipline does not work.

**What an adapter may not do:** construct HTTP requests, handle payment,
decide MIME, decide applicability, or write its own retry. If an adapter
needs one of these, the SDK is missing something and the SDK is where it
gets added.

---

## 6. Endpoint surface

Full request and response shapes are in `openapi-v2.yaml`. Summary:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v2/session/handoff` | desktop → web auth. **Only Fusion has one today**; Adobe's was never written, which is why no Adobe plugin has ever authenticated |
| POST | `/v2/session/heartbeat` | liveness, scope refresh |
| POST | `/v2/baseline` | establish at attach (§3) |
| GET | `/v2/baseline/current` | what the server believes is installed |
| POST | `/v2/baseline/rebaseline` | **must emit a witnessed leaf** (§4) — today `witness_leaf_id` is a permanent null |
| POST | `/v2/witness` | supersedes `/witness/cad`, `/scruple/witness/{adobe,photoshop}`, `/apps/kohya/witness`. Returns `witnessed` explicitly |
| POST | `/v2/mark` | one call, `modalities: []`. Always finalizes a local lock (D-5) |
| GET | `/v2/receipt/{leaf}` | what the user was actually given. Public |
| GET | `/v2/verify/{hash}` | third-party verification. Public |
| GET | `/v2/capabilities` | which modalities apply to this host and MIME (D-7) |

**Deliberately absent:** per-modality endpoints (`/v2/mark/c2pa` and
friends). An earlier draft had them. They are dropped because §9.5
requires modality selection to be recorded atomically in the leaf, and
separate calls make that a multi-step transaction with no natural commit
point. One `mark` call, one leaf, one recorded selection.

**Dead surface being retired with `/v1`:** `/api/workflow/validate` (zero
callers), `/api/audit/iteration/[id]` (zero callers), `/api/v1/log/.../batch`,
`/api/v1/streams`, `/api/v1/registry/baselines/*`, and `apps/forge`, which
is wired through four files and always 503s.

**Missing surface this adds:** a watermark endpoint. `services/watermark`
runs no HTTP server at all; the only path is a subprocess call buried in
`lock/local`, scoped to already-stored image iterations. Standard v1.7
promotes watermarking to a mandatory peer of C2PA under EU AI Act
Article 50 — and today no plugin can reach it. This is the largest
capability gap in the estate.

---

## 7. What this does not solve

- **CAD marks nothing.** C2PA and §9.2 are inapplicable to parametric
  files, so `capabilities` will correctly report that Fusion, Inventor and
  SolidWorks have no marking modality available. Whether a thumbnail or a
  drawing-sheet export should become the marked artifact is a product
  decision, not an engineering one, and the skeleton does not make it.
- **The signer still has to run.** `/v2/mark` with `c2pa` requires the
  Signer CVM, deliberately powered down pre-launch.
- **Adapters remain unverified.** Nothing here can be tested against
  Harmony, Inventor, SolidWorks or the Adobe hosts without those
  applications. The skeleton reduces how much untestable code exists; it
  does not make it testable.
- **`/api/scruple/c2pa/sign` takes an `asset_path` on the signer host**,
  which no desktop client can supply. `/v2/mark` takes bytes or a storage
  handle. This is a real interface change, not a rename.

---

## 8. Sequence

1. **`/v2` server surface** — routes, one auth model, the watermark
   endpoint, `capabilities`. Retire `/v1`.
2. **Client SDK** — extracted from Blender's `lib/`, the healthiest of the
   six and the only one with a real headless run behind it.
3. **Merge one integration at a time.** Blender first: it has real tests
   and can be verified without a GUI, a Windows box, or an Adobe account.
4. **Then** Fusion, ToonBoom, Meshroom, Adobe — each merge is its own
   work order, each ends with that integration meeting the Standard.
5. **Inventor and SolidWorks are built fresh on the skeleton.** Their C#
   add-ins are labelled STARTING TEMPLATE; there is nothing underneath to
   preserve, and they become the proof that a new host is cheap.

The ComfyUI node pack and standalone `scruple-photoshop` are deleted
rather than merged — one has not loaded since May, the other is
superseded by the monorepo copy.
