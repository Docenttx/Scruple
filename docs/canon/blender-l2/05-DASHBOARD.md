# WO-B5 — The dashboard

_2026-09-07. `/data/scruple-blender`, on top of WO-B1…B4._

The panel was a sign-in gate, a project header that nothing ever
populated, four paid buttons and a receipt list — one `draw()` that read
four adapter modules inline and decided, while drawing, what each region
meant. It is now a project manager, a capture tracker and a lock/mint
dashboard, with the same information architecture as
`app/embed/fusion/FusionPalette.tsx` and none of its markup.

---

## 1. What was built

### The three-file split

| file | lines | what it is |
| --- | ---: | --- |
| `panels/model.py` | 242 | one read of everything, as a frozen snapshot. Every "is this region shown" question is a `show_*` property on it. |
| `panels/dashboard.py` | 440 | one function per region. No policy: each checks exactly one `show_*` property and returns `False`. |
| `panels/main.py` | 180 | the bpy classes, and nothing else. |

Two new adapter modules and one new operator module sit under them:

| file | lines | what it is |
| --- | ---: | --- |
| `adapter/projects.py` | 434 | the project index, the five connection states, switching, archiving, the server-side history. |
| `adapter/locks.py` | 230 | what a paid action costs, whether it can be asked for and **why not**, and what has already been applied to a leaf. |
| `operators/dashboard.py` | 190 | refresh / switch / archive / drill-down / dismiss. Everything `draw()` may not do. |

### The regions, and the Fusion feature each one answers

| region | FusionPalette | shown when |
| --- | --- | --- |
| `signin` | the sign-in card (:439-472) | not signed in |
| `header` | top bar: product, doc name, connection dot (:483-515) | signed in |
| `connection` | `ConnectionDot` disconnected/unauthorized (:822-845) | a fetch was **attempted and failed** |
| `projects` | sidebar project list + archive toggle (:536-591) | signed in |
| `edits` | "Witnessed edits" pane (:592-634) | a project is selected |
| `tracker` | the iteration list in `WorkspaceView` | there is at least one capture |
| `receipt` | — (new; Fusion has no per-leaf evidence view) | the selected capture reached the server |
| `locks` | the lock buttons + prices | signed in |
| `payment` | `PaymentSettingsPanel` + the amber warning (:520-525) | signed in and no card |
| `queue` | — (Fusion has no offline queue) | anything is spooled |
| `reconciliation` | — | settlement found something wrong |
| `error` | the red `errorMsg` banner (:672-676) | there is an error |

Blender's answer to "sidebar + workspace" is a parent panel with
collapsible children, so `SCRUPLE_PT_main` gained five sub-panels:
`_projects`, `_edits`, `_tracker`, `_receipt`, `_locks`. The queue,
reconciliation and error regions stay on the **parent**: an addon whose
spool is backing up must not be able to hide that inside a collapsed
sub-panel.

### What changed underneath the UI

* **The project switcher routes a leaf.** `adapter/flow.py` already sent
  `project_id=_state.get().active_project_id` on every witness; nothing
  ever set that field. `operators.scruple.select_project` sets it, and
  tells the server via `POST /api/projects/{id}/set-active` so the web UI
  agrees. Local first, then the server: the thing that actually routes a
  leaf is the field on the witness body, not the server's `is_active`.
* **Paid actions are recorded, not just reported.** `operators/c2pa.py`
  and `operators/chain_lock.py` now write a `locks.MarkRecord` into the
  state bag. Before, the `MarkOutcome` went into Blender's info bar,
  which the next report overwrites — so a minute later the panel could
  not say what state a leaf was in.
* **A capture is addressed by key, not by position.**
  `assurance.capture_key()`. The tracker is a bounded deque that new
  captures push onto the *front*, and `state.replace_assurance()` swaps
  the object when a settlement updates a row, so neither an index nor an
  identity survives. `scruple.verify_last` now resolves the **selected**
  capture (which is the newest when nothing has been clicked), so the
  receipt it fetches is the one the panel is showing.
* **`/api/stripe/config` is read through `http.submit`**, not through
  `payment.get_payment_config()`, which returns `{}` for a 401 and for an
  empty body alike. The status matters: see §5.

---

## 2. The gate — mock-bpy tests, each region in each state

`tests/test_dashboard.py`, 38 tests. The helper draws the **whole panel
tree** — the parent and every sub-panel whose `poll()` passes, exactly as
Blender does it — so an absence assertion covers the entire UI and not
one function.

`dashboard.HEADINGS` is the vocabulary, and
`test_no_heading_is_a_substring_of_another` is what makes `heading in
text` sound: if two headings overlapped, an absence assertion could pass
or fail for the wrong region.

| state | must fire | must NOT fire (the control) |
| --- | --- | --- |
| signed out | `signin` + `scruple.sign_in` | **every** other region, all eleven |
| signed out with a capture in the tracker | `signin` | `receipt` — see §4 |
| signed in | `header` | `signin` |
| never fetched | header says "Not checked" | `connection` banner; the word "Connected" |
| unreachable | `connection`, "Captures are still recorded and spooled" | — |
| reachable | "Connected" | `connection` banner |
| 401 | "The key this addon holds was refused" | the word "Offline" |
| projects listed | names, leaf counts, "2 tracked", `scruple.select_project` | — |
| locked project selected | `SCR …`, `root …`, "Anchored" | both, for an unlocked project |
| archived | "Archived (1)" | — |
| no project selected | — | `edits` |
| no payment method | `payment`, "No payment method on file" | `scruple.c2pa_sign`, `scruple.chain_lock` — **no operator is drawn at all** |
| card + a leaf | the three operators, `$10.00 / $50.00 / $100.00` | `payment` |
| card, no leaf | "Nothing to mark yet" | `scruple.c2pa_sign` |
| checkpoint | "No /api/v2 route for this" | `scruple.checkpoint` |
| payment read refused | "Could not read payment settings: HTTP 401" | "have not been read this session" |
| payment read ok | — | both of the above |
| unmarked leaf | "Not locked" | — |
| clean mark | "Applied: chain · SCR_ABC123" | "OUTSTANDING" |
| partial mark | "OUTSTANDING — chain: payment not verified" | — |
| queued mark | "Lock queued" | "Applied:" |
| no captures | — | `tracker` |
| captures | "1 witnessed 1 queued 1 refused locally" | — |
| refused capture selected | — | `receipt` |
| **verified** | "Assurance tier: verified" | "passthrough", "SOFTWARE surrogate" |
| **passthrough** | "Assurance tier: passthrough (software-signed)", "NOT hardware-backed" | "Assurance tier: verified" |
| undisclosed (today's server) | "Assurance tier: undisclosed" | "verified", "NOT hardware-backed" |
| /verify claim | "scruple.ai says…", "This addon has not checked that" | — |
| older row selected | "Receipt — leaf lf_old" | "Receipt — leaf lf_new" |
| 3 spooled | "3 capture(s) queued offline", `scruple.drain_queue` | — |
| queue drained | — | `queue` |
| error | `error`, the text, `scruple.clear_error` | `error`, after dismissal |
| project B selected | witness body carries `project_id: 2` | — |
| nothing selected | — | `project_id` on the body at all |
| five redraws | — | **any** HTTP attempt |

### The controls are proven, not asserted

A green test with no control proves only that it cannot fail. So sixteen
deliberate breakages were applied one at a time, the suite run against
each, and each reverted. **All sixteen were caught.**
`05-mutate.py` is the script; `05-mutation-sweep.log` is the output.

| breakage | caught by |
| --- | --- |
| panel draws everything signed out | `test_signed_out_draws_the_gate_and_NOTHING_else` |
| queue box always drawn | `test_an_empty_queue_shows_NOTHING` |
| offline banner fires on UNKNOWN too | `test_a_session_that_never_asked_says_so…` |
| surrogate warning drawn unconditionally | `test_a_verified_leaf_reads_verified_and_NOT_passthrough` |
| blocked lock still draws its operator | `test_signed_in_with_no_payment_method_blocks_every_paid_button` |
| capture addressed by position | `test_the_drilldown_follows_the_selection_not_the_newest` |
| witness stops carrying `project_id` | `test_switching_project_changes_where_the_next_leaf_is_witnessed` |
| drill-down shown for a refused capture | `test_the_drilldown_is_ABSENT_for_a_capture_with_no_leaf` |
| `draw()` fetches the project list | `test_drawing_the_whole_panel_makes_NO_network_call` |
| restore archives instead of restoring | `test_an_archived_project_is_listed_separately…` |
| receipt sub-panel ignores the sign-in gate | `test_signing_out_with_a_capture_in_the_tracker_draws_NO_receipt` |
| payment failure reported as "not read yet" | `test_a_refused_payment_read_says_WHY…` |
| project switch never told to the server | `test_the_project_list_renders_and_can_be_switched` |
| connection guessed instead of measured | `test_an_unreachable_server_raises_the_banner` |
| tracker shown with no captures | `test_the_tracker_is_ABSENT_before_the_first_capture` |
| error region never clears | `test_signed_in_draws_the_header_and_NOT_the_gate` |

---

## 3. The live run — real Blender, real renders, the scratch stack

`tests/live/dashboard_in_blender.py`, run under
`blender --background --factory-startup`. Evidence:
`05-dashboard-phases.jsonl`.

Three things the mock-bpy suite structurally cannot prove, and all three
are ways this WO could have shipped broken:

**1. The panel classes register.** `bl_parent_id` and `poll()` are
validated by `bpy.utils.register_class`, not by a mock that stores class
attributes; a sub-panel whose parent id is wrong registers **without
error** and is silently absent from the N-panel.

```
register_error: null
SCRUPLE_PT_main true   parent null
SCRUPLE_PT_projects true   parent SCRUPLE_PT_main
SCRUPLE_PT_edits    true   parent SCRUPLE_PT_main
SCRUPLE_PT_tracker  true   parent SCRUPLE_PT_main
SCRUPLE_PT_receipt  true   parent SCRUPLE_PT_main
SCRUPLE_PT_locks    true   parent SCRUPLE_PT_main
```

**2. Every operator property the panel sets is declared.**
`layout.operator(...).project_id = 2` works against the mock whether or
not `project_id` is a `bpy.props.IntProperty`, because the mock's
`OperatorProps` takes any attribute. In Blender it raises. So all six
were invoked through `bpy.ops`, with their properties:

```
select_project(project_id=3)      -> {'FINISHED'}
select_capture(capture_key='leaf:46') -> {'FINISHED'}
clear_error() refresh_config() refresh_projects() -> {'FINISHED'}
```

**3. A project switch changes where a leaf lands.** The observable is a
row in the scratch app's `iterations` table.

| | requested | landed in | leaf | bytes | sha256 on disk == recorded == `output_hash` | witnessed |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `b5-a.png` (torus) | 3 | **3** | 45 | 10 496 | ✅ | 1 |
| `b5-b.png` (Suzanne) | 4 | **4** | 46 | 10 496 | ✅ | 1 |

Both PNGs are real Cycles CPU renders at 160×120, re-hashed from disk
after the fact. Assurance tier on both: **`undisclosed`** — the honest
answer against today's server, unchanged by this WO (see WO-B3).

`poll()` was evaluated inside Blender before and after the captures, and
it moves:

```
before  projects true  edits true  tracker FALSE  receipt FALSE  locks true
after   projects true  edits true  tracker true   receipt true   locks true
```

The model built inside Blender:

```
signed_in true · connection online · document_name null (factory-startup, unsaved)
captures 2 · counts {witnessed: 2} · queue_depth 0
show {signin:false projects:true offline:false queue:false tracker:true
      receipt:true locks:true payment_setup:true reconciliation:false error:false}
lock_state "Not locked. Witnessed only — no paid modality has been applied."
locks finalize $10.00 blocked(no_payment_method)
      chain-lock-basic $50.00 blocked(no_payment_method)
      chain-lock-pinned $100.00 blocked(no_payment_method)
      checkpoint $5.00 blocked(no_route)
payment_ready false · payment_checked false · payment_error "HTTP 503"
```

### One bug the live run found that the mock suite did not

`signed_in: false` with `show_receipt: true` in the first run. Blender
evaluates a sub-panel's `poll()` **independently** of whether its parent
drew anything, so `SCRUPLE_PT_main` returning early at the sign-in gate
does not suppress its children — the receipt sub-panel drew a leaf id
under a signed-out panel. The signed-out mock test could not catch it
because it ran with an empty tracker.

Fixed (`show_receipt` now requires `signed_in`) and pinned by
`test_signing_out_with_a_capture_in_the_tracker_draws_NO_receipt`, whose
mutation is one of the sixteen above.

---

## 4. Honesty, where this panel could have flattered

* **`verified` is never computed from one half.** `assurance_tier`
  requires **both** an attestation the server verified **and** a
  signature this client can point at. Every leaf this addon produces
  today reads `undisclosed`, which is a statement about the API — no v2
  route returns the H-1 triple — and not about the leaf. The panel must
  not print "unsigned".
* **A software surrogate is named as one.** When
  `signature.signer_surrogate` is set *by the server*, the drill-down
  draws `Signed by a SOFTWARE surrogate key — NOT hardware-backed.`
  Never inferred from a key id this client pattern-matched.
* **`/api/v2/verify`'s claim is attributed, never asserted.** "scruple.ai
  says independently verifiable: yes … This addon has not checked that
  and holds no key with which to." That claim was observed to be `true`
  for a leaf with a NULL `leaf_signature` (WO-B3, `03-V2-WITNESS-L2.md`).
* **A blocked control draws no operator.** A greyed-out button a user can
  still press teaches them to press it and read the error; a sentence
  where the button would be is the honest version — and it makes the
  absence testable.
* **Three reasons a control is blocked, worded differently**: no card
  (fixable by the user), nothing witnessed yet (fixable by rendering),
  no route at all (fixable by nobody in Blender).
* **`OUTSTANDING` is rendered with the same weight as `applied`.** §9.5's
  point is that `outstanding` is the honest half of the response; a
  dashboard showing only `modalities_applied` turns a partial failure
  into a success.
* **The connection indicator has five states, not two.** `UNKNOWN` — no
  fetch attempted — renders as "Not checked", never as connected and
  never as offline. A green indicator on this panel always has one
  specific successful HTTP response behind it.
* **`None` reconciliation stays silent.** A settled session draws no
  "all clear" badge: a green badge is how a settlement stops being read.

---

## 5. Open items — for the server, not for the addon

1. **`/api/v2` has no project route.** `gap.json` endpoints rows 1-3 said
   `no_equivalent` and that is still true: the v2 surface has nine routes
   and none lists a project, while `/api/v2/witness` *does* take an
   optional `project_id` (`route.ts:115`) and auto-creates a per-tenant
   project when it is absent (`route.ts:376-399`). So the leaf surface is
   project-aware and the project surface is v1-only.

   This WO reads the list from `/api/projects`, which authenticates with
   the **same bearer key** (`requireUser`, `app/api/projects/route.ts:20`)
   and is what the Fusion palette uses. Every function in
   `adapter/projects.py` names its route. The alternative was a project
   switcher whose selection changed nothing, which is worse than no
   switcher. **A v2 project route would let this become v2-pure without
   touching the panel.**

2. **`/api/stripe/config` is unreachable from a bearer-key session.**
   Measured on the scratch app, 2026-09-07: `GET /api/stripe/config` with
   a valid v2 bearer key → **HTTP 503** (Stripe unconfigured on the
   scratch app; on a configured deployment it is the 401 that
   `scruple_host_sdk/payment.py`'s header describes — the route calls
   `auth()`, a session cookie). Either way the addon cannot read prices
   or a card, so **every paid button in Blender is blocked, correctly,
   and the panel now says why** rather than "not read yet".

   The prices shown come from `payment.DEFAULT_PRICE_CENTS` in that case,
   and they are the same numbers the confirm dialog would use — but they
   are the client's defaults, not the server's.

3. **No periodic refresh.** The Fusion palette polls every 15 s. This
   panel fills its caches at `register()` (on the worker thread) and on a
   button press. A timer refresh was considered and left out: the drain
   timer's contract is "never raise, always reschedule", and folding a
   second network call into it is a change to WO-B4's tested surface.
   The connection indicator is therefore as fresh as the last fetch, and
   says so.

## 6. What the Fusion palette has that this does not

* **Thumbnails and the Fusion cloud preview.** A bpy `UILayout` cannot
  draw an arbitrary image without loading it into `bpy.data.images`,
  which would put render output into the user's blend file. Deliberately
  omitted.
* **A busy state** (`witnessing…`, `locking…`). The addon's operators run
  synchronously on the main thread, so there is no interval during which
  a busy label could be drawn. Not a gap in the panel; a property of the
  operators.
* **Scrolling sub-lists.** An N-panel does not scroll a list, so the
  project list caps at 10 rows, the tracker at 8 and the edits list at 6,
  each with a stated remainder (`+N more`).

---

## 7. Suite state

```
289 passed, 2 failed
```

Baseline before this WO: **253 passed, 0 failed**. WO-B5 adds 38 tests
(`tests/test_dashboard.py`) and touches none of the existing ones except
by re-exporting `assurance_line` / `receipt_line` from
`panels.dashboard`, which the WO-B3 tests still address on `panels.main`.

**The two failures are not WO-B5's**, and re-running `vendor_sdk.sh`
would have hidden that rather than fixed it:

```
tests/test_sdk_adoption.py::test_every_vendored_file_hashes_to_what_the_manifest_says
tests/test_sdk_adoption.py::test_the_vendored_copy_matches_the_source_tree_it_came_from
```

Both report `source has changed since vendoring` for
`scruple_api/__init__.py`, `scruple_api/outcomes.py`,
`scruple_host_sdk/server_library.py` and
`scruple_host_sdk/witness_flow.py`. The **vendored bytes in this repo are
byte-identical to `vendor/VENDOR.json`** — checked directly, clean. What
moved is the *source*: a concurrent run in `/data/scruple-web` (commit
`79f5507`, "WO-S1: the two walls the Blender client hit are not in the
Blender client", plus uncommitted working-tree changes adding leaf
signature disclosure and migration `052`) is editing the SDK the addon
vendored at WO-B2.

Re-vendoring here would fold another WO's in-flight, partly uncommitted
work into this commit. Left alone, reported, and it is the right moment
for it: **WO-S1 appears to be closing exactly the disclosure gap that
makes every tier on this panel read `undisclosed`.** Re-vendor once that
work is committed, and the `verified` / `passthrough` branches this WO
already tests will start firing on real leaves.
