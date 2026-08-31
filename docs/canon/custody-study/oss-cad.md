# Custody Study: open-source CAD — where the recipe hypothesis holds

_Study for the `asset-custody` capability class. Frame: `CUSTODY_LOCUS.md`,
`CAPABILITY_CLASSES.md`; sibling to `custody-study/fusion.md`. Follows the
`oss-study/` house style: bottom line first, cite or admit._

**Bottom line.** The recipe hypothesis holds more widely than expected — FreeCAD
persists a complete, ordered feature tree *with its dependency graph as data*,
Solvespace stores constraints and solved parameters together, and even Blender,
the tool we call untracked, stores an 8-vertex cage and a modifier stack rather
than the 386-vertex result — but it breaks in three named ways: the recipe has
no floor (destructive edits below it are unrecorded), it names its inputs
instead of containing them (the same OpenSCAD script produced a 12-facet and a
6-facet STL depending on `$OPENSCADPATH`, **exit code 0 both times**), and some
work is simply not derivational (a KiCad layout is irreducible human labour, and
grading it against re-derivability would be nonsense). **Determinism is the
crux, and every failure found was of one kind: the model is reproducible and the
file is not** — OpenSCAD's STL permutes facet order under ASLR but is identical
as a sorted multiset, and a `.blend` differs in 2,065 heap addresses on a no-op
resave, while in both cases the geometry is bit-stable. That splits the claim in
two: **stability** (re-serialising an unchanged document yields the same digest)
is achievable everywhere via a canonical form — demonstrated here for Blender in
~140 lines of Python reading only the `DNA1` catalogue the file already carries,
turning three different SHA-256s for one unchanged document into one — whereas
**re-derivability** is earned by nobody in this study, so `workflow_hash` should
keep never claiming it and we should write down why. KiCad is the teacher on
format design (integers as the canonical value, pinned float notation, an
explicit total order with a UUID tiebreak, and layout as a separate text pass)
and it also ships `.history`, an always-on libgit2 repo committed on every save
— which records *when* and *what* and, because the commit signature is
hardcoded to `"KiCad" <noreply@kicad.org>`, **never records who**.

---

## 0. Method, and what VERIFIED means here

Sources were read, not documentation. Full trees at
`/data/oss-study/cad/`: `FreeCAD-main`, `openscad-master`,
`solvespace-master`, `kicad-source-mirror-master`. Blender's C source was
fetched per-file at tag `v3.0.1` to match the binary in this environment.

Four of the five tools were also **run**: `blender 3.0.1`, `openscad 2021.01`,
`solvespace-cli 3.0~rc2`, `freecadcmd 0.19.2`. Where a source citation is from a
`master` tree newer than the binary tested, it is flagged. **VERIFIED** means
read in the cited file or observed in a run recorded under
`/data/oss-study/cad/`; anything else says **inferred** or **not verified**, and
"not verified" appears where it is the truthful answer.

Licences, since we may borrow structure and never code: FreeCAD LGPL-2.1+,
OpenSCAD GPL-2.0-or-later (CGAL linking exception), Solvespace GPL-3.0, KiCad
GPL-3.0-or-later, Blender GPL-2.0-or-later.

---

## 1. FreeCAD — the strongest recipe in the study, stored next to its own result

LGPL-2.1-or-later. Source read at `/data/oss-study/cad/FreeCAD-main` (`main`
branch, i.e. 1.x); everything **run** used the packaged `freecadcmd 0.19.2`, so
line numbers are master and empirical results are 0.19. Artefacts under
`/data/oss-study/cad/fclab/`.

### 1.1 What is in a `.FCStd`

It is a plain zip written by `Document::saveToFile()`
(`src/App/Document.cpp:1956-2039`): a `Base::ZipWriter` with the comment
`"FreeCAD Document"` (`:2019`), deflate at a user-settable level defaulting to 7
(`:1961-63`), `Document.xml` **always the first member** (`:2021`), then
`signalSaveDocument(writer)` (`:2036`) — the hook the *Gui* document uses to add
`GuiDocument.xml` — then `writer.writeFiles()` (`:2039`), which drains a deferred
queue in a `while` loop because saving a file may enqueue more
(`src/Base/Writer.cpp:369-382`).

Member names are **derived from the property's own name, not from its content**:
`Property::getFileName()` (`src/App/Property.cpp:94`) builds
`<Object>.<Property>`, and `Writer::addFile()`
(`src/Base/Writer.cpp:294-312`) de-duplicates through
`FileNameManager.makeUniqueName()` — which is where the `PartShape`,
`PartShape1`, `PartShape2` numbering comes from. Other members seen in the wild
(VERIFIED in source, not in my headless run): `GuiDocument.xml`,
`StringHasher.Table` (`Document.cpp:1135`), and per-shape element-map
`*.Table` / `*.Map` files (`PropertyTopoShape.cpp:409,418`).

A minimal PartDesign document — sketch, four constrained line segments, a Pad —
produced exactly five members (VERIFIED):

```
Document.xml      27221 bytes
PartShape.brp      1655
PartShape1.brp     7057
PartShape2.brp     4957
PartShape3.brp     5180
```

`Document.xml` opens with a version stamp written at `src/App/Document.cpp:1120-1124`:

```xml
<Document SchemaVersion="4" ProgramVersion="0.19R" FileVersion="1">
```

**The recipe is there, and it is complete and explicitly ordered.** The file
carries, in this order: document properties (including `CreationDate`,
`LastModifiedDate`, and a `PropertyUUID` `Uid`); an
`<Objects Count="10" Dependencies="1">` block that persists **the dependency
graph as data** —

```xml
<ObjectDeps Name="Pad" Count="2">
    <Dep Name="Sketch"/>
    <Dep Name="Body"/>
</ObjectDeps>
```

— then `<Object type="PartDesign::Pad" name="Pad" id="3126"/>` identity rows, then
an `<ObjectData>` section holding every object's properties: the sketch's
`Sketcher::PropertyConstraintList` with each constraint, the four
`LineSegment`s with their `GeoExtensions`, and the Pad's `Profile` link and
`Length`. A third party reading this file can state exactly what was built and
from what.

**And the baked result is stored right next to it.** `PropertyPartShape::Save`
(`src/Mod/Part/App/PropertyTopoShape.cpp:365-393`) does not inline the shape; it
writes a reference and defers —

```cpp
writer.Stream() << " file=\"" << writer.addFile(getFileName(binary ? ".bin" : ".brp").c_str(), this) << "\"/>\n";
```

— so `Document.xml` gets `<Part file="PartShape3.brp"/>` and the bytes arrive
later through `SaveDocFile` (`:712`) as OCCT ASCII BRep, or binary under the
`SaveBinaryBrep` preference. An empty shape is a zero-length member
(`:715-717`).

So FreeCAD, like Solvespace, persists **recipe and result together** — which
makes the recipe checkable rather than merely descriptive: a verifier can
recompute and compare.

**But nothing in the format performs that check.** FreeCAD opens a document by
restoring the stored `.brp` into each `Shape` property and only re-executes the
recipe for objects marked stale. A `.FCStd` carrying `Length="5"` beside a
`.brp` that is 7 mm thick opens silently and renders the lie. The one mitigation
is that staleness *is* recorded: `writeObjectType` (`Document.cpp:1428`) emits
`Touched="1"` and `Invalid="1" Error="…"` attributes, so the file can say its own
shape is out of date — it just is not obliged to be right about it.

### 1.2 Determinism — much better than Blender, and the residue is instructive

Two `saveCopy()` calls in one session produced **byte-identical files**
(VERIFIED) — a real contrast with `.blend`, and a consequence of `Document.xml`
being generated text rather than a memory image.

Open the document and re-save, and the differences are tiny and nameable
(VERIFIED, 8 differing lines in a 27 KB XML):

- two `status=` attribute bits on `App::PropertyMap` properties and one on
  `App::PropertyLinkHidden` — internal property flags;
- **one floating-point value drifted by 1 ulp**:
  `Q0="0.7071067811865475"` → `Q0="0.7071067811865476"` in a
  `PropertyPlacement` quaternion.

That last one is the finding worth carrying: **the recipe survives a round trip
exactly; a derived placement does not, to the last bit.**

The `.brp` members are almost as stable. After a **forced full recompute of
every object**, three of four `.brp` files changed — and the entire diff is five
lines, each a seven-character topology flag string, `0111000` → `0101000`
(VERIFIED). Position 2 in OpenCASCADE's `TopoDS_TShape` flag order is the
`Checked` bit (**inferred** from the flag ordering; the OCCT source was not read
here). **No coordinate, curve or surface value changed.** So FreeCAD's recompute
is deterministic in geometry and differs only in a validation housekeeping bit —
by far the best determinism result in this study.

Two **independent constructions** from the same script are a different matter,
and the split inside them is the interesting part. The `.brp` members came out
**byte-identical across two separate processes** — same FreeCAD, same OCCT, same
inputs, same B-rep bytes. **The container did not** (VERIFIED, 26 differing lines): `CreationDate` and `LastModifiedDate` are
wall-clock ISO strings; `Uid` is a fresh random UUID per document; and every
object's `id=` counts up from a **random** starting point. `Document.cpp:127-135`:

```cpp
static std::random_device rd;  static std::mt19937 rgen(rd());
static std::uniform_int_distribution<> rdist(0, 5000);
lastObjectId = rdist(rgen);
```

— a deliberate random offset in `[0,5000]` per document, to reduce id collisions
when copying between documents. The same script produced `id="3117"…"3126"` in
one run and `id="96"…"105"` in the next. Zip member
timestamps are wall-clock too.

So FreeCAD lands in an unusual place: **its geometry is re-derivable and its
container is not.** It is the only tool in this study that comes close to C2
(§6.2) and misses on packaging rather than on geometry. Two caveats keep it from
being C2 outright. `Document::Save` stamps `SchemaVersion`, `ProgramVersion`,
`FileVersion` and `StringHasher` (`Document.cpp:1121-1125`) — but **no OCCT
version anywhere**, so the file records the version of what wrote the recipe and
not the version of what wrote the geometry, and cross-OCCT reproducibility is
unverifiable from the file alone (not verified here — it needs two OCCT builds).
And derived quantities are not exact: a 10×10×5 pad reports `Volume ==
499.9999999999999`.

The practical instruction is therefore sharp: **hash the `.brp` members, never
the container.** A whole-file `.FCStd` digest changes on every save from
timestamps, UUID and the random id offset alone, with zero geometric change.

### 1.3 History, backups, tamper evidence

**No edit history is persisted, and FreeCAD refuses it explicitly.**
`App::Transaction` and `App::TransactionObject` (`src/App/Transactions.h:61,193`)
both derive `Base::Persistence` and both declare `Save`/`Restore` — and both
implementations are:

```cpp
void Transaction::Save(Base::Writer&) const       { assert(0); }
void TransactionObject::Save(Base::Writer&) const { assert(0); }
```

They inherit the persistence interface and abort if anyone calls it. Undo lives
in `Document::mUndoTransactions`, a heap-allocated in-memory list
(`src/App/Document.cpp:182-255, 342`), and nothing transaction-related is
written by `Document::Save`. **FreeCAD holds the complete named edit history in
memory and throws it away at save time.**

**Backups are one deep by default**, exactly like Blender: `CountBackupFiles`
defaults to 1 (`src/App/Document.cpp:2063`), and `BackupPolicy`
(`Document.cpp:2079-2086`) offers `Standard` or `TimeStamp`. `saveToFile` writes
to `<path>.<uuid>` first (`:2007-2013`) and `BackupPolicy::apply` renames;
`applyStandard` (`src/App/BackupPolicy.cpp:68`) scans for the target name plus a
pure-digit suffix and, once the count is at the limit, **deletes the oldest by
mtime** before renaming into its slot. It is a rolling window of whole-file
copies with no linkage to what changed. Saving three times over one path left
`proj.FCStd` and `proj.FCStd1` and nothing else (VERIFIED).

**No tamper evidence.** The only cryptographic primitive anywhere near the save
path is `QCryptographicHash::Sha1` at `Document.cpp:1099`, and it hashes a
**filename to build a transient-directory name**
(`{ExeName}_Doc_{UUID}_{HASH}_{PID}`), not the document. Beyond that there is
zip CRC-32 per member, which is corruption detection and forges trivially.

### 1.4 The hook surface is the best in this study

`src/App/DocumentObserverPython.h` exposes **29 callbacks** to a Python addon,
including the ones nobody else offers:

```
slotOpenTransaction(Doc, str)   slotCommitTransaction(Doc)   slotAbortTransaction(Doc)
slotUndoDocument   slotRedoDocument   slotUndo   slotRedo
slotBeforeChangeObject(Obj, Prop)    slotChangedObject(Obj, Prop)
slotBeforeRecomputeDocument   slotRecomputedObject   slotRecomputedDocument
slotStartSaveDocument(Doc, path)     slotFinishSaveDocument(Doc, path)
```

`slotOpenTransaction` carries **the transaction's name** — the command the user
invoked. So FreeCAD hands an add-on a live, *named* edit stream plus explicit
save start/finish boundaries (`signalStartSave` at `Document.cpp:1957`,
`signalFinishSave` at `:2095`), and that stream is **exactly the history the
file format discards** (§1.3).

One limit, VERIFIED: a pure-Python add-on **cannot inject a zip member**.
`Writer::addFile` is reachable only from a C++ `Base::Persistence` subclass, and
the two save slots bracket `saveToFile` rather than running inside it. So a
Python integration witnesses by reading the finished `.FCStd` in
`slotFinishSaveDocument` and writing a **detached** manifest — which is the
right shape for us anyway, but it means the receipt cannot ride inside the
document without a compiled extension. Of every tool studied, FreeCAD is the one where
Scruple could build a complete and legible edit journal with the least
invention: the events are named, the dependency graph is in the file, and the
recipe recomputes deterministically.

---

## 2. OpenSCAD — the model *is* source, and that buys less than it looks like

GPL-2.0-or-later with a CGAL linking exception (`COPYING`; header at
`src/io/export_stl.cc:1-15`). Source read at `/data/oss-study/cad/openscad-master/`;
empirical runs against the packaged `openscad 2021.01`. Where a citation is
master-only it is flagged.

**The recipe is perfect and the inputs are not.** A `.scad` file is the complete
authoring history in the only sense that matters — there is no other state. But
it is **not self-contained**, and the failure is silent. `find_valid_path_()`
(`src/core/parsersettings.cc:80-104`) resolves `include <>` against the source
directory and then against a global library path seeded from `$OPENSCADPATH`
(`search_libs()`, :31-40). The resolved path is recorded nowhere. VERIFIED: the
same `.scad` produced a **12-facet STL with `OPENSCADPATH` set and a 6-facet STL
without it, exit code 0 both times** — a warning on stderr, then it continues
with the symbol undefined. A pipeline gating on exit status ships the wrong
model and signs it. Customizer parameters are a second unrecorded input: `-p
params.json -P big` / `-P small` / neither gave three different STL hashes from
one script. `text(font=…)` resolves through fontconfig by name.

`openscad -d out.deps` emits a Makefile-style list of **resolved absolute paths**
for includes and `import()`ed meshes (`handle_dep()`, `src/core/ImportNode.cc:87`).
It is the ready-made dependency capture — but it lists paths, not hashes, and
VERIFIED it does **not** include the customizer JSON.

**Determinism: the STL is not byte-reproducible, and the cause is ASLR.**
VERIFIED: three runs of one 12,856-facet model gave three SHA-256s with
identical file sizes and identical facet counts. Hashing the facets as a
**sorted multiset gives one identical hash across all three runs.** Isolation:

| condition | result |
|---|---|
| `cube([10,20,30])`, no boolean | deterministic |
| any CSG boolean (CGAL Nef) | 3 distinct hashes |
| `OMP_NUM_THREADS=1 TBB_NUM_THREADS=1` | still nondeterministic — not threading |
| `setarch -R` (ASLR disabled) | **fully deterministic** |

CGAL's Nef→PolySet traversal iterates pointer-keyed containers. Upstream knows:
`Feature::ExperimentalPredictibleOutput` (`src/Feature.cc:40-43`) — *"Attempt to
produce predictible, diffable outputs (e.g. sorting the STL…)"* — consumed at
`src/io/export_stl.cc:122` (`createSortedPolySet`). It is **experimental and off
by default.**

Other verified hazards: `rands()` is seeded `std::time(nullptr) + process_id`
(`src/core/builtin_functions.cc:68`) despite the variable being named
`deterministic_rng`; an explicit seed argument (:188) fixes it. Binary STL
headers are clean — fixed `"OpenSCAD Model\n"`, no timestamp
(`src/io/export_stl.cc:271-272`). **3MF and PDF are unconditionally
non-reproducible**: `add_meta_data(…, "CreationDate", get_current_iso8601_date_time_utc())`
at `src/io/export_3mf_v2.cc:393`, `export_3mf_v1.cc:441`, `export_pdf.cc:285`.
Never hash a 3MF for equality.

**`.csg` is the canonical recipe artifact.** VERIFIED byte-stable across three
exports: the fully evaluated, flattened CSG tree with `$fn/$fa/$fs` resolved and
transforms as explicit `multmatrix`. Two caveats: it **inlines includes and
erases their identity**, and it emits `import(file="run1.stl", …,
timestamp=1788134598)` — the imported file's **mtime**, which is forgeable and
changes without the content changing.

**Backend split — structural VERIFIED, geometric INFERRED.** master added
`--backend` (CGAL | Manifold), branched at 7+ sites in
`src/geometry/GeometryEvaluator.cc:183-876`, and upstream keeps **separate
expected-output trees** (`render-cgal` vs `render-manifold`). 32 of 32 common
expected files differ; 0 are identical. They are PNGs, so "the geometry differs"
is inferred — but upstream demonstrably does not expect the backends to agree.
**A hash is meaningful only when pinned to a version *and* a backend.**

No checksum, no signature, no embedded history — VERIFIED. No plugin API at all:
grepping for plugin surfaces finds only `src/gui/OctoPrint.cc`. A Scruple
integration hooks the CLI plus a file watch.

**On "the history is a git history."** Git buys content-addressed chaining, so
an undetected single-commit edit is hard. It does not buy an anchor: the chain
root is attached to nothing external and the author owns the repository, so
`rebase`/`filter-branch` rewrites the chain and every downstream hash
*consistently*. Git proves internal consistency, never when or by whom. That gap
is exactly Scruple-shaped, and it is the strongest argument in this study for
anchoring a recipe hash rather than trusting a VCS.

## 3. Solvespace — recipe *and* result in one diffable text file

GPL-3.0 (`COPYING.txt`). Line-oriented `key=value` records, blank-line
separated, each closed by a bare `Add*` token; magic
`"\261\262\263" "SolveSpaceREVa"` (`src/file.cpp:10`, written at :308). One
declarative table drives load and save — `SolveSpaceUI::SAVED[]`
(`src/file.cpp:89-211`): Group (34 fields), Entity (32), Constraint (20),
Style (15), Request (11), Param (2).

Two deliberate diffability choices, both VERIFIED: zero-valued fields are
**omitted** (`SaveUsingTable`, :230-236), and one map is explicitly sorted with
the comment *"Sort the mapping, since EntityMap is not deterministic"* (:260) —
upstream hit the ordering problem and fixed it in one place.

**It stores both recipe and result.** Requests and Constraints (the recipe) and
`Param.val` plus derived `Entity.actPoint.*` (the result). That redundancy is
checkable, and it makes Solvespace the only tool in this study with a working
integrity check today: `solvespace-cli regenerate` reloads links, re-solves and
re-saves. VERIFIED on four sketches: pass 1 left 3 of 4 **byte-identical**; the
fourth changed by exactly two inserted `Group.scale=1.000…` lines — default-field
normalisation, not numeric drift. Passes 2-6 were bitwise stable on all four.
**`regenerate` is an idempotent fixed point after one pass.**

**But the reason is not that the constraints determine the answer.** The
solver's starting point *is* the saved params — `System::NewtonSolve()`
(`src/system.cpp:354-400`) mutates `p->val` in place against
`CONVERGE_TOLERANCE = LENGTH_EPS/1e2` (:18). VERIFIED: perturbing every
`Param.val` by +0.37 and re-solving, **the perturbation survived on all four
sketches** (`-5.0` → `-4.62999999999999989342`), with `actPoint` following,
because those degrees of freedom are free. So `.slvs` is deterministic *because
the answer is cached in the file*. Hashing the constraints alone is insufficient
— a verifier re-solving from scratch lands elsewhere on any underdetermined DOF.
The honest verification move is **load → regenerate → compare**, not re-derive.

No history in file: undo is an in-memory ring, `MAX_UNDO = 100`
(`src/solvespace.h:451-458`), never serialised. Links are relative paths —
`Group.impFileRel`, format `'P'` (`src/file.cpp:123`, relativised at :252-259) —
nothing embedded. Better than OpenSCAD in one respect: a missing link **prompts**
(`LocateImportedFile`, :929) rather than silently yielding zero geometry. No
checksum, CRC, or digest anywhere in `src/file.cpp`.

---

## 4. KiCad — the format-design lesson, and a native history nobody signs

GPL-3.0-or-later (`LICENSE`, `copyright.h:12-30`). Tree read at
`/data/oss-study/cad/kicad-source-mirror-master/`, `KICAD_SEMANTIC_VERSION
"10.99.0-unknown"` (`cmake/KiCadVersion.cmake:36`).

### 4.1 Four separable decisions that make it diffable

**(1) The canonical value is an integer.** Board geometry is `int` nanometres;
decimal text is a *rendering* produced at write time. Floats cannot disagree if
floats are not the source of truth.

**(2) Where a float must be rendered, the notation is pinned** —
`EDA_UNIT_UTILS::FormatInternalUnits`, `common/eda_units.cpp:190-221`:

```cpp
if( engUnits != 0.0 && fabs( engUnits ) <= 0.0001 ) {
    buf = fmt::format( "{:.10f}", engUnits );
    while( !buf.empty() && buf[buf.size()-1] == '0' ) buf.pop_back();
    if( buf[buf.size()-1] == '.' ) buf.pop_back();
} else { buf = fmt::format( "{:.10g}", engUnits ); }
```

Fixed notation in exactly the small-magnitude band where `%g` would emit
`1e-05`; trailing zeros stripped; `fmt` rather than `snprintf` to bypass the C
locale. `include/string_utils.h:421-440` states the intent: *"We want to avoid
scientific notation in S-expr files… it ignores locale."* **This is WO-21's bug,
pre-solved, and solved more strongly than we can solve it** — we cannot make our
inputs integers, they arrive as JSON doubles.

**(3) Serialization order is an explicit total order with a stable identity
tiebreak — never container or pointer order.** The board writer re-buckets every
collection into a comparator-ordered `std::set` before emitting
(`pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp:827-842`). Every comparator
ends in the UUID: `pcbnew/board_item.cpp:370-380`, `pcbnew/pcb_track.cpp:2822-2837`,
`pcbnew/footprint.cpp:4919-4960`. `pcbnew/board.cpp:3903-3915` says why: *"Callers
keep these in a std::set, so any branch reporting equality for two distinct items
loses one of them. Every branch has to fall through to the uuid."*
`eeschema/sch_item.h:748-749` treats it as a contract: *"…or you will break the
sorting using the symbol library file format."* This is the fix that Blender and
OpenSCAD both lack, made deliberately, at the writer.

**(4) Layout is a separate, pure-text pass.** `KICAD_FORMAT::Prettify()`
(`include/io/kicad/kicad_io_utils.h:71-94`, impl `common/io/kicad/kicad_io_utils.cpp:97+`)
re-indents a dense token stream after the fact; every save runs through
`PRETTIFIED_FILE_OUTPUTFORMATTER` (`include/richio.h:506-536`). Consequence:
**a third party can canonicalise a KiCad file without a model round trip**, and
KiCad can byte-golden-test its formatter independently of its writer.

No wall-clock timestamp is ever written into a design file — grepping both
writers for `wxDateTime`/`Now()` returns nothing. Files carry `(version …)`,
`(generator …)`, `(generator_version "10.99")`.

### 4.2 UUIDs: the double-edged thing

`common/kiid.cpp:74-98` mints a random `KIID` per object from a thread-local
`boost::mt19937`, persists it as `(uuid "…")`, and restores it on load — so a
load/save round trip preserves identity, but **creating an object is
nondeterministic by construction**. Library files sidestep it:
`CTL_FOR_LIBRARY` includes `CTL_OMIT_UUIDS` (`pcb_io_kicad_sexpr.h:235-236`), so
`.kicad_mod` and `.kicad_sym` are fully deterministic while `.kicad_pcb` and
`.kicad_sch` are not.

`KIID::SeedGenerator()` exists (`include/kiid.h:85-94`) with a warning that is
worth quoting to any vendor who asks us to make their format reproducible:
*"WARNING: Do not call this function from within KiCad or via a Python action
plugin… Resetting the UUID generator in the middle of a KiCad GUI run will
potentially have harmful effects on file integrity."* It has zero callers in
this checkout.

And KiCad's own engineers do not treat the UUID as an axiom.
`include/diff_merge/identity_reconciler.h:151-159`: *"Primary key is
`KIID_PATH`… Items that exist only on one side are then candidates for
similarity matching — useful when **UUIDs churn from imports, copy-paste, or
third-party tools rewriting identifiers**"*, falling back to weighted geometric
matching (position 0.40 / bbox 0.20 / keyProps 0.40, threshold 0.85). **A stable
identity claim is evidence, not an axiom.**

### 4.3 Round-trip stability: weaker than the headline, but production leans on it

The `qa/` tree in this mirror is stripped — 0 `.cpp` files — so no test
assertion can be quoted (VERIFIED absent). What the surviving fixtures show:
the byte-golden pairs in `qa/data/pcbnew/prettifier/` feed **file text** through
`Prettify` and string-compare; they never re-serialise a model. Board
round-trip fixtures ship version-suffixed variants and there is **no
`*_expected.kicad_pcb` anywhere**. Documented *lossy* round trips exist
(`common/netclass.cpp:132-137`, `common/eda_text.cpp:334-338`).

But production depends on save determinism, which is stronger evidence than a
test. `common/local_history.cpp:92-126` defines `filesContentEqual()` — a 64 KB
`memcmp` — used at `:617` to gate the crash-recovery prompt, comparing a
**freshly re-serialised autosave** against a file written by the manual-save
path. If serialising an unmodified model were not byte-stable, every user would
get spurious recovery prompts. Scope of that claim: **same process, same
in-memory model, same build, same `kicad_advanced` config** — and the last one
matters, because `ADVANCED_CFG::m_CompactSave` (`include/advanced_config.h:278`)
silently switches format mode at `common/richio.cpp:672-673`. **A determinism
claim must name its scope.**

### 4.4 The recipe hypothesis fails here, and plainly

There is no recorded derivation from schematic to layout. What exists is
*identity linkage* — each footprint stores `(path "/uuid/uuid")`, the
`KIID_PATH` of its schematic symbol instance (`pcb_io_kicad_sexpr.cpp:1445-1452`).
Sync is bidirectional and human-driven (`BOARD_NETLIST_UPDATER`,
`eeschema/tools/backannotate.cpp:205`); neither direction records what it did.
Placement and routing are irreducible human work; the netlist constrains
connectivity only. KiCad even caches a derived result *inside* the result — zone
fills persist as `(filled_polygon …)` (`pcb_io_kicad_sexpr.cpp:3435-3452`)
rather than being recomputed.

**For CAD-of-record, provenance is attestation over artifacts, not
reproducibility of a pipeline.** That should be said in the standard.

### 4.5 `.history` — a real git repo, always on, and unsigned

The most valuable artifact in this study. KiCad ships a **libgit2 local-history
repository inside the project directory** (`include/local_history.h:67-71`),
on by default: `auto_backup.enabled=true`, `format=INCREMENTAL`,
`location=PROJECT_DIR`, `limit_total_size=100 MiB`, 5 s debounce
(`common/settings/common_settings.cpp:130-140`). It commits on **every manual
save** (`pcbnew/files.cpp:1098`, `eeschema/files-io.cpp:1474`), on the autosave
timer (`common/eda_base_frame.cpp:566-569`) and at project close; manual saves
are git-**tagged** `Save_<type>_N` with a floating `Last_Save_<type>`
(`local_history.cpp:1311-1349`) and the manual path **blocks** until the commit
and tag land (`:388-406`). It exposes `GetHeadHash`, `GetSnapshots`,
`TreeFingerprint`, `ExtractAllFilesAtCommit`.

And the commit signature is hardcoded — `git_signature_now( &rawSig, "KiCad",
"noreply@kicad.org" )` at `local_history.cpp:894, 1096, 1477`.

> **`.history` records when and what. It never records who.**

That is the cleanest statement of the Scruple-shaped hole found anywhere in this
study, in the one tool that already built the history.

Two cautions against treating it as sufficient: it is unsigned and locally
rewritable (`EnforceSizeLimit` rebuilds the repo, `local_history.cpp:1681+`),
and the separate `-backups/` zip comparison
(`PROJECT_ARCHIVER::AreZipArchivesIdentical`, `common/project/project_archiver.cpp:80-108`)
collects entry **CRC-32s into a `std::set`** — order-blind, name-blind, trivially
forgeable. Note also that with stock defaults **no `-backups/` zip is ever
produced** (`TriggerBackupIfNeeded` returns early unless `format == ZIP`,
`settings_manager.cpp:1635-1638`), and that `PROJECT_ARCHIVER::Archive` excludes
hidden directories (`:288-290`), so `.history` is never inside the zip.

`.kicad_prl` is pure view state (`common/project/project_local_settings.cpp:58-257`)
and is excludable from a witness scope — with the caveat that it carries
`git.{repo_username,ssh_key,repo_type}`. Library tables (`fp-lib-table`,
`sym-lib-table`) are the external dependency edges: `(nickname, uri)` rows
resolved by path and env-var at load, **not** in the witnessed file.

No checksum, digest or signature over any design file. The only `(checksum …)`
token covers embedded binaries (`common/embedded_files.cpp:262,299`).

### 4.6 There is no save event to hook

Decisive, and VERIFIED. SWIG is deleted (no `pcbnew/swig/`, no `scripting/`, no
`KICAD_SCRIPTING`). Modern plugins are external processes launched from a
toolbar button (`include/api/api_plugin.h:90-94`); `PLUGIN_ACTION_SCOPE`
(`include/api/plugin_action_scope.h:25-34`) names *which toolbar*, not an event
type, and the manifest schema `api/schemas/api.v1.schema.json` has an `actions`
array and **no `events`/`hooks`/`triggers` key**. Grepping every `.proto` under
`api/proto/` for `Event|Notification|Subscribe|stream|service`: **zero hits.**
It is a hand-rolled request/reply envelope
(`api/proto/common/envelope.proto:57-80`) over an nng **REP** socket with no
PUB/PUSH counterpart (`libs/kinng/include/kinng.h:31-68`). `SaveDocument`
(`project_commands.proto:220`) *tells* KiCad to save; it does not report that a
user did. The save paths never touch the API server, and the server is **off by
default** (`common/settings/common_settings.cpp:500-501`).

One trap if we ever do witness through the API: `SaveDocumentToString`
(`editor_commands.proto:435-445`) is handled by `CLIPBOARD_IO`
(`pcbnew/api/api_handler_board.cpp:1095-1116`), which prettifies with
`COMPACT_TEXT_PROPERTIES` rather than the `NORMAL` mode used for files.
**Hashing the API string will not match hashing the file.**

So on stock KiCad, Scruple witnesses on a button press, or it watches the
filesystem, or — best — it reads `.history`. And KiCad ships the canonicaliser a
third party needs: `kicad-cli pcb upgrade` / `fp upgrade`
(`kicad/cli/command_pcb_upgrade.cpp:28-42`) is a headless load→save pass that can
be run before hashing.

---

## 5. Blender — the tool that tracks nothing, and the file that is a memory dump

**Everything in this section is VERIFIED by running Blender 3.0.1
(`/usr/bin/blender`, Ubuntu `3.0.1+dfsg-7`) headless in this environment**, with
the C source for the same tag fetched from `blender/blender` at `v3.0.1` to
confirm mechanism. Scripts and artefacts are under
`/data/oss-study/cad/blendlab/`. Blender is GPL-2.0-or-later; the add-on API
(`bpy`) is used, not linked-and-shipped, so nothing here changes our licensing
posture — but we may borrow **structure only**.

### 5.1 `.blend` is a memory dump, and that is not a figure of speech

`writefile.c:42` documents the block header field in Blender's own words:

```
 * `bh.old`        `void *` old pointer (the address at the time of writing the file).
```

Every block written to disk carries the heap address it occupied in the writing
process, and every pointer field *inside* a struct is written as that raw
address too (`writestruct_at_address_nr`, `writefile.c:668-700`). Blender
rebuilds the object graph on load by mapping old addresses to new ones.

The consequence is measurable. Constructing a cube with a Subsurf modifier and
saving the **same in-memory state twice, seconds apart, in one process**:

| | |
|---|---|
| file size | 414,852 bytes both times |
| sha256 | **different** |
| bytes differing | 11,428 |
| blocks | 778 in both; `code`/`size`/`SDNAnr`/`count` **identical for every block** |
| block-header `old` pointers differing | **777 of 778** |
| differing 8-byte payload words | 2,079, of which **2,065 are literally another block's `old` pointer** |

And the case that matters most for custody: **open a saved file, change nothing
(`bpy.data.is_dirty == False`), save two copies — three different SHA-256s.**

So the digest our add-on records today (`/data/scruple-blender/lib/capture.py:206`,
`sha256_file(blend_filepath)`) changes on every save whether or not the artist
touched anything. A chain of those receipts cannot distinguish *the project
changed* from *the project was saved*. That is precisely the discrimination
`asset-custody` exists to make, so on the blob-hash path **Blender's
`asset-custody` claim is currently empty** — not weak, empty.

### 5.2 A deterministic `.blend` digest is constructible today, from the file itself

`.blend` carries its own struct catalogue in the `DNA1` block: every type, every
field name, every offset. A field is a pointer exactly when its name begins with
`*`. **The file tells you where its own addresses are.**

`/data/oss-study/cad/blendlab/canon2.py` (~140 lines of Python, no Blender
required, 0.1 s for a 400 KB file) does three things:

1. replaces every pointer — block-header `old` and every in-struct pointer field
   — with the **index of the block it addresses**, the same old-to-new remap
   Blender performs at load but to a canonical numbering;
2. zeroes a **named, closed set of runtime fields**: `ID.session_uuid`,
   `ID.recalc_after_undo_push`, `ID.tag`, `ID.us`, `SessionUUID.uuid_`,
   `Mesh.face_sets_color_seed`, `CurveProfile.changed_timestamp`, plus two
   pointer-bearing aggregates my walker does not stride correctly
   (`CurveMapping.cm[4]`, `Link.*next`) — a real implementation would normalise
   rather than drop those;
3. excludes the window/workspace/screen datablocks (`WM`, `WS`, `SN`, `TEST`,
   `REND`, `GLOB` and the `bScreen`/`ScrArea`/`ScrEdge`/`View3D` family), which
   are UI layout, not document.

Results, all VERIFIED:

| case | raw `sha256` | canonical digest |
|---|---|---|
| save the same in-memory state twice | 2 values | **1 value** |
| **open a file, change nothing, save two copies** (the custody case) | **3 values** | **1 value** — original and both resaves agree |
| same, on a 261-block scene with materials, node trees, image, lamp, camera | 3 values | **1 value** |
| two independent processes running the same construction script (simple doc) | 2 values | **1 value** |
| two independent processes, rich scene | 2 values | **2 values** — see §5.3 |

And it stays **sensitive**, which a canonicaliser has to be checked for
separately: on the 261-block scene, moving one object by 0.001 m, raising a
Subsurf level from 2 to 3, and toggling a modifier's viewport visibility each
produced a different digest.

Nothing in the exclusion list is document content. It is session identity,
depsgraph recalc flags, a refcount, a change counter, and one wall-clock seed:
`blenkernel/intern/mesh.c:93` —

```c
mesh->face_sets_color_seed = BLI_hash_int(PIL_check_seconds_timer_i() & UINT_MAX);
```

a **wall-clock-seeded random number for sculpt face-set display colours**,
written into the document.

### 5.3 Where it stops: order is unstable even when geometry is not

The one case the canonical digest does not close is two *independent
constructions* of a rich scene. The residue is the 64×32 UV sphere's `MEdge`,
`MPoly`, `MLoop` and `MLoopUV` arrays — 28,459 of 96,768 UV bytes differ between
runs. That looked fatal. It is not, and the distinction is the most useful thing
in this study. Running the sphere alone three times:

| quantity | across 3 processes |
|---|---|
| vertex coordinates, in file order | **identical** |
| loop → vertex indices | different every run |
| UV values, in file order | different every run |
| face set, each face's vertices sorted, list sorted | **identical** |
| UV values as a sorted multiset | **identical** |

**The model is the same every time; the order of the arrays describing it is
not.** None of the nondeterminism is in the geometry. Evaluated geometry is
stable: Suzanne + Subsurf-2 gave identical evaluated vertex coordinates across
two processes, four evaluations of Subsurf-3 + Bevel gave one hash, and an STL
export of it was byte-identical.

It is address-dependent, and it is the same failure OpenSCAD has (§2). Running
the sphere six times each way: **ASLR on → 6 distinct loop orderings out of 6;
`setarch -R` (ASLR off) → 4 distinct out of 6.** Disabling ASLR collapses the
space without closing it, which rules out any environment tweak as a fix and
leaves canonical ordering at the writer — KiCad's decision (§4.1) — as the only
one available.
### 5.4 What Blender persists, and what it throws away

**Is the modifier stack a recipe? Yes, genuinely.** A cube with Subsurf level 3
stores **8 vertices and 6 faces**; the evaluated result is **386 vertices**. The
parameters are persisted, the result is not. Geometry Nodes goes further — the
node tree is written as an `NT` block, an explicit graph structurally identical
to a ComfyUI workflow. Evaluation is deterministic within a version: four
evaluations of Subsurf-3 + Bevel produced one hash, an STL export of it was
byte-identical, and Suzanne + Subsurf-2 gave identical evaluated vertices across
two processes.

**But the recipe has no floor.** The 8-vertex cage is itself the *result* of
destructive edit-mode work for which nothing is recorded. The recipe is only the
part of the history the artist happened to express as modifiers, and its inputs
are a mesh with no provenance. This is the hypothesis's real boundary in
Blender: it holds above the cage and fails below it.

**Undo is RAM only.** `blenloader/intern/undofile.c:59-122` — undo steps are
`MemFile` chunk lists, in-memory partial `.blend` images. Nothing reaches disk.
The block codes present in a saved file are `DATA WS SN REND TEST GLOB WM SC OB
ME NT DNA1 ENDB`; there is no history block of any kind.

**`.blend1` is one generation deep and it is a rename, not a copy.**
`writefile.c:1269-1305`:

```c
static bool do_history(const char *name, ReportList *reports)
{
  int hisnr = U.versions;
  if (U.versions == 0) return 0;
  while (hisnr > 1) { ...rename name+(n-1) -> name+n... }
  if (BLI_exists(name)) { ...rename name -> name1... }
```

`U.versions` defaults to 1 (confirmed: `preferences.filepaths.save_version == 1`).
Saving four times leaves `proj.blend` and `proj.blend1` and nothing else. It is
user-settable to 32, which is the cheapest custody lever available in Blender —
but it is still a fixed-depth ring the user can empty.

**Autosave is temporary by design.** Every 2 minutes to `bpy.app.tempdir`
(`/tmp/blender_XXXXXX/`), and `wm_files.c:2041-2056` *deletes* it on a clean quit
when global undo is on. It is crash recovery, not history.

**Linked content is by path, not by value.** A linked library is an `LI` block
holding `//lib/assets.blend`; an image texture holds `//textures/t.png` unless
packed. Hashing the `.blend` does not cover them. `bpy.data.use_autopack` /
`file.pack_all` closes this and defaults **off**.

**No tamper evidence of any kind.** No checksum, no digest, no signature
anywhere in the format. Compressed saves are Zstandard (`28 b5 2f fd`) with no
integrity field we could repurpose — and compression makes matters worse, since
two saves of one state differed even in *length* (77,175 vs 77,176 bytes).

### 5.5 What is reachable from an add-on

`bpy.app.handlers` in 3.0.1 exposes `save_pre`, `save_post`, `load_pre`,
`load_post`, **`undo_pre`, `undo_post`, `redo_pre`, `redo_post`**,
`depsgraph_update_pre`, `depsgraph_update_post`, and the `render_*` family.
`bpy.app.timers.register` supplies `idle.tick`. So the two hooks
`asset-custody` requires — `document.save` and `idle.tick` — both exist.

`depsgraph_update_post` hands the add-on a per-datablock change record:
`[('Scene', True, True), ('Sphere', True, True), ('Scene Collection', True, False)]`
— `(id.name, is_updated_geometry, is_updated_transform)`. That is a usable
change stream. `window_manager.operators` (the operator history that would name
*which* command ran) is empty in background mode and is **not verified** in a
GUI session.

Note also, for the `filesystem-watch` surface: Blender writes to a temporary
file and renames over the target (`writefile.c:1442`), so a watcher sees
create-then-rename, never a partial file.

---

## 6. Mapping to Scruple

### 6.1 Where the recipe hypothesis holds, and where it breaks

It holds, and more widely than expected — including inside Blender, the tool we
called our least-mature. It also breaks in three distinct ways, and the three
are worth separating because they need different answers.

| tool | is there a recipe? | is it complete? |
|---|---|---|
| OpenSCAD | the file **is** the recipe | complete for the *script*; **incomplete for its inputs** — includes resolve against `$OPENSCADPATH`, customizer JSON is a second unrecorded input, fonts resolve by name |
| Solvespace | requests + constraints, and the solved params alongside | **not complete**: free degrees of freedom are carried, not derived — a re-solve from scratch lands elsewhere |
| FreeCAD | feature tree + sketch constraints, **with the dependency graph persisted as data** | complete and ordered above the sketch; the sketch itself is the floor |
| Blender | modifier stack and geometry-node trees | complete **above the cage**; the base mesh is destructive work with no record |
| KiCad | **no** | placement and routing are irreducible human work; the schematic constrains connectivity, not layout |

**Break 1 — the recipe has no floor.** Blender's modifier stack is a genuine
recipe applied to a mesh with no provenance. FreeCAD's feature tree bottoms out
in sketches. The recipe describes the last N operations, not the history.

**Break 2 — the recipe names its inputs instead of containing them.** OpenSCAD
is the cleanest demonstration and the most alarming: the same script produced a
12-facet and a 6-facet STL depending on an environment variable, **exit code 0
both times.** Blender's linked libraries and unpacked images are paths.
Solvespace's links are relative paths. KiCad's library tables are `(nickname,
uri)` rows resolved at load. A recipe hash that does not cover its inputs is a
hash of a sentence with pronouns in it.

**Break 3 — some work is simply not derivational.** KiCad's board is the
important case, and it is not a deficiency: placement and routing *are* the
work. Where the artifact is the deliverable rather than the output of a
pipeline, provenance is attestation over artifacts, and the standard should say
so rather than grade those vendors against a re-derivability they can never
meet.

The hypothesis' real predictive power is narrower and more useful than "witness
recipes wherever they exist": **a recipe is worth witnessing when it is the
thing a human would argue about.** A FreeCAD feature tree, a Fusion timeline, a
geometry-node graph and a ComfyUI workflow are all disputable descriptions of
intent. A `.blend`'s 778 memory blocks are not.
### 6.2 Determinism is the crux, and it splits into two claims we keep conflating

Every determinism failure in this study is of one kind: **the model is
reproducible and the file is not.** OpenSCAD's STL permutes facet order under
ASLR but hashes identically as a sorted multiset. Blender's `.blend` differs in
2,065 heap addresses on a no-op resave, and its UV-sphere loop and UV arrays
permute run to run while the vertex coordinates and the sorted face set are
bit-identical. Two unrelated codebases, the same defect: **pointer identity
leaking into serialisation order.**

That splits "determinism" into two claims that are not the same and must not be
made with the same words:

| claim | what it needs | who passes |
|---|---|---|
| **C1 — stability**: re-serialising an unchanged document yields the same digest | a canonical form that excludes addresses, ordering and session state | FreeCAD and Solvespace natively (FreeCAD to within 8 XML lines and 1 ulp across a load/save cycle); KiCad by design; Blender and OpenSCAD **after canonicalisation** |
| **C2 — re-derivability**: a third party rebuilds the artifact from the recorded recipe plus inputs | C1, plus a pinned toolchain, plus every input captured by value | **nobody in this study, unconditionally** |

C1 is what `asset-custody` actually needs. "Is what I stored still what I
stored" is answered by a stable digest over a canonical form; it does **not**
require anyone to rebuild anything. C2 is the seductive claim the recipe
hypothesis invites, and it is the one that fails — though FreeCAD comes closer
than anything else here, with byte-identical `.brp` geometry across independent
processes and a failure confined entirely to the zip container (§1.2). It
fails — on library search paths
(OpenSCAD), on free degrees of freedom (Solvespace), on backend choice
(OpenSCAD CGAL vs Manifold), on per-document UUIDs and process-global object ids
(FreeCAD), on OCCT and Blender version, and on unrecorded destructive edits below
the recipe floor (Blender's base mesh).

**So: should `workflow_hash` claim re-derivability? No — and it is worth writing
down *why*, because right now we simply never say it.** Grepping the canon,
every use of "reproduce" refers to reproducing the **hash**, never the
**artifact** (`docs/canon/CANONICALIZATION.md` §5, `CONFORMANCE.md:381-393`).
That instinct was correct and this study supplies the argument for it: a
ComfyUI graph is the same shape of object as an OpenSCAD script — a complete
recipe whose inputs are named rather than contained (checkpoints by filename,
custom nodes by version, sampler kernels by CUDA build). We hash the recipe
because it **binds** the run to a description an expert can read and dispute.
That is worth a great deal and it is not re-derivability. The right upgrade is
not to promise re-derivation; it is to make the recipe hash *cover its inputs*
— which is what `model_fingerprints` already does for checkpoints and what a
`deps` capture would do for OpenSCAD.

Proposed wording discipline, in the same spirit as the class-level claim rules:

- **"Witnessed"** — we saw these bytes at this time. Available everywhere.
- **"Bound to a recipe"** — the receipt carries a canonical hash of the
  construction description. Available wherever a recipe exists.
- **"Re-derivable"** — reserved, and it requires a named toolchain pin, all
  inputs by value, and a demonstrated canonical form. **No tool in this study
  earns it today**, so no vendor should be able to say it.

### 6.3 Where we could witness cheaply, versus where we would be building the record

| tool | native history at rest | what Scruple would supply | cost |
|---|---|---|---|
| **KiCad** | **`.history`** — a libgit2 repo in the project dir, on by default, committed and tagged on every save | an author identity and an external anchor; the history already exists and is content-addressed | **cheapest overall** — the integration is "read a git repo", not "write a plugin" |
| FreeCAD | `.FCStd1`, depth 1 by default | the journal — but the events are already named | **cheapest per unit of claim**: 29 observer callbacks incl. named transactions with `slotStartSaveDocument`/`slotFinishSaveDocument` boundaries |
| OpenSCAD | none in-format; the artist's VCS is the history | anchor commit hashes; capture `-d` deps, `$OPENSCADPATH`, customizer JSON, version + backend | **cheap** — the history is already a sequence of files |
| Solvespace | none; but `regenerate` is a bitwise fixed point | witness the file; run `regenerate` as an integrity probe | **cheap**, and it is the only tool here with a native self-check |
| Blender | `.blend1`, depth 1 by default; autosave deleted on clean quit | **the entire record**: canonical digest, save journal, idle ticks | **expensive** |

The dividing line is not "parametric versus not". It is **whether prior states
survive on disk.** KiCad commits every save into a git repo it ships; OpenSCAD
in a VCS is already a sequence of files; FreeCAD at least announces every
transaction by name while the add-on is loaded. Blender leaves one previous save
and a temp file it deletes on a clean exit. That is the real reason Blender is
the hard case, and it has nothing to do with the modifier stack.

### 6.4 Blender: the minimum honest `asset-custody` claim

`lib/capture/surface.ts:793-802` grades the `blender` profile
`authoring-application` / `tenant-custody`. If it also declares
`asset-custody`, the honest claim today is:

> **"These document states were witnessed at these times."** Nothing about the
> interval between them, and nothing about completeness.

That is `tenant-custody`'s notarial sentence from `CUSTODY_LOCUS.md`, and
Blender cannot currently support even that well, because the digest we record
changes on a no-op save. Three steps, in order of value:

1. **Canonicalise the digest.** Pointer-normalise via `DNA1` and exclude
   `Mesh.face_sets_color_seed` and the UI/workspace blocks (`WS`, `SN`, `WM`,
   `TEST`). Demonstrated working, 0.1 s, ~120 lines, no vendor cooperation.
   Without it, "unchanged" is unrepresentable and the continuity claim is void.
   **Record the blob hash too** — it is what a court gets handed — but let the
   canonical digest carry the continuity argument.
2. **Journal the interval.** `save_post` alone yields moments.
   `depsgraph_update_post` supplies `(datablock, is_updated_geometry,
   is_updated_transform)` and `undo_post`/`redo_post` fire on edit
   granularity; `bpy.app.timers` supplies `idle.tick`. A signed, monotonic,
   counter-chained journal of those events upgrades the claim from *"these
   states"* to *"these states, and this many edits between them, none of which
   we failed to see **while the add-on was loaded**"* — and that last clause is
   not removable in `tenant-custody`.
3. **Close the by-reference holes.** Linked libraries and unpacked images are
   paths. Either hash the referenced files at save time or require
   `use_autopack`, and say which was done in the receipt.

And the honest sentence about the gap that remains: Blender's undo history is
`MemFile` chunks in RAM (`undofile.c:59-122`) and its previous-version ring is
one deep. **Anything we do not observe live is gone.** A Scruple journal is not
recovering a history Blender kept; it is the only copy.

### 6.5 What Fusion gets for free — and what we are not using

`CUSTODY_LOCUS.md` says Fusion "grades better than Blender" because of native
project tracking, and `custody-study/fusion.md` already establishes that the
timeline is a genuine recipe but is freely rewritable through Fusion's own API.
This study adds a narrower and more embarrassing point: **we are not reading
it.** `ScrupleFusion.py:1175-1190` uses `design.timeline.count` as a scalar
tripwire — witness when the integer grows or shrinks — and the timeline contents
never enter the leaf. The gap between Fusion and Blender that the founder is
paying for is a recipe we currently reduce to an integer.

The corollary for Blender is the encouraging one. Blender's modifier stack and
geometry-node trees are recipes of the same kind, reachable through `bpy`, and
`NT` node trees are structurally identical to a ComfyUI workflow — the object
`workflow_hash` was designed for. **The recipe gap between Fusion and Blender is
much smaller than the custody gap.** What Fusion actually has that Blender does
not is a cloud version record the user cannot silently rewrite. That is a
custody-locus difference, not a recipe difference, and the grading should say so.

### 6.6 What the Blender add-on should stop doing regardless

`/data/scruple-blender/lib/manifest.py:23-31` carries a **third, hand-rolled
canonical-JSON implementation** whose scalar rule is `json.dumps` — the exact
defect `docs/canon/CANONICALIZATION.md` was written about (`1e-5` is `0.00001`
in JavaScript and `1e-05` in Python), and whose key sort is Python code-point
order rather than JCS's UTF-16 order. Severity today is **observation, not
finding**: `machine_manifest_hash` is referenced nowhere outside the module and
its own tests, and every value the Blender manifest currently carries is a
string or an integer. But the docstring claims it "byte-for-byte matches the
server", which is now false, and the fix is to import
`packages/scruple-api/scruple_api/canonical.py` rather than keep a copy.
### 6.7 The format-design lesson from KiCad, as something we can ask vendors for

KiCad is the only tool in this study that treated serialisation as a contract
rather than an implementation detail, and the four decisions are separable and
copyable:

1. **Make the canonical value exact.** KiCad's board geometry is `int`
   nanometres; the decimal in the file is a rendering. We cannot do this for
   JSON graphs, but we can ask a vendor: *what is the exact value, and is the
   text a rendering of it or the value itself?*
2. **If text must render a float, pin the notation** — fixed below a magnitude
   threshold, trailing zeros stripped, locale bypassed
   (`common/eda_units.cpp:190-221`). FreeCAD reached the same place
   independently: `Base::Writer` sets `std::locale::classic()` and
   `precision(digits10+1)` in `fixed` notation
   (`src/Base/Writer.cpp:346-349, 355-357`), so its XML doubles are
   locale-stable and round-trip. **Two unrelated CAD projects arrived at the
   same rule; we arrived at it through a live incident (WO-21).** The
   requirement is that a vendor **name** the rule, not that they pick ours.
3. **Emit in an explicit total order with a stable identity tiebreak.** Never
   container order, never pointer order. This one decision is the difference
   between KiCad and every other tool here: OpenSCAD's STL and Blender's mesh
   arrays both permute because their writers iterate memory.
4. **Separate layout from serialisation.** KiCad's `Prettify()` is a pure text
   pass, which is why a third party can canonicalise a file without loading it
   into a model.

Turned into a vendor requirement, in the standard's own vocabulary:

> **CR-1 (canonical form).** A vendor whose class includes `asset-custody`
> declares a canonical form for each witnessed document type, and the **scope**
> over which its stability holds — same process / same build / same version /
> across versions. A canonical form without a declared scope is not a canonical
> form.
>
> **CR-2 (a tool that produces it).** The canonical form must be producible
> headlessly by a third party holding only the file. KiCad ships this as
> `kicad-cli pcb upgrade`; Solvespace ships it as `solvespace-cli regenerate`;
> OpenSCAD ships it as `-o out.csg`; FreeCAD ships it as a `freecadcmd`
> open-recompute-save, whose `.brp` members are the stable part and whose zip is
> not. Blender ships nothing, which is why we had to write `canon2.py`. Where no
> such tool exists, the vendor supplies one, or the class is graded on the blob
> and says so.
>
> **CR-3 (inputs by name are not inputs).** Every external reference the
> document resolves at load — library path, search path, font name, linked file
> — is either captured by value or **listed as an unwitnessed dependency in the
> receipt**. A silent path resolution is a provenance hole, and OpenSCAD proves
> it can change the geometry without changing the exit code.

CR-2 is the one that carries the most weight, and it is Sonobuoy's lesson from
`oss-study/SYNTHESIS.md` arriving again in a different costume: **make the claim
falsifiable by anyone.** A canonical form a third party can compute is a claim
they can check. A canonical form only the vendor can compute is a claim they are
asking us to take on faith, which is the thing the whole standard exists to
refuse.

---

## 7. Open questions, ranked

1. **Does the canonical `.blend` digest survive a Blender version change?** Only
   3.0.1 was available here. `DNA1` is versioned and struct layouts change, so
   the digest is almost certainly version-scoped — which is fine if we say so
   (KiCad says so), and fatal if we do not. Decides whether the digest is a
   custody primitive or a same-version convenience.
2. **Answered, and recorded here because it was the second question:** the
   Blender array-ordering nondeterminism *is* address-dependent, like
   OpenSCAD's, but disabling ASLR only reduces it (6 distinct orderings in 6
   runs → 4 in 6). Remaining question: what the other source is, and whether
   upstream would take a canonical-ordering patch at the writer.
3. **Can a Blender add-on read `window_manager.operators` in a GUI session**, and
   does it name the operator that ran? Verified empty in background mode. It is
   the difference between a journal that says *"geometry changed"* and one that
   says *"bevel, width 0.03"*.
4. **Should `asset-custody` require a canonical form, or accept a blob hash with
   a declared caveat?** CR-1/CR-2 in §6.7 assume the former. The counter-argument
   is that we would be requiring of vendors something we do not yet do ourselves
   for Blender — which `STUDIO_IS_AN_EXEMPLAR.md` says is exactly the wrong order
   to do it in.
5. **Is `.history` (KiCad) worth a first-class integration?** It is an always-on,
   content-addressed, tagged git repo that records everything except *who*. It is
   the closest thing to a native `asset-custody` substrate found anywhere, and
   the integration is "read a git repo", not "write a plugin".
6. **Does our Fusion leaf get upgraded to carry the timeline?** §6.5. This study
   found the gap; `custody-study/fusion.md` already established the timeline is
   readable and rewritable. The decision is whether a rewritable recipe recorded
   at witness time is worth carrying. (It is — a later rewrite then contradicts a
   signed record, which is the whole point.)
