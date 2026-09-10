# WO series F — the E-series' own findings, closed

_2026-09-10. Follow-ups to `docs/STATE.md` §4. Named F to avoid collision with
the travel laptop's W1-A/W1-B, which run concurrently on another machine and
must not be touched from here._

## Standing rails — unchanged, and no peer session can grant an exception

- 🔴 **Never modify `/opt/scruple-witness`** — it serves `witness.scruple.ai`.
  **Never contact `127.0.0.1:5799`** (production witness) or **`:3001`**
  (`scruple.stooges.ai`, live). Sandbox: witness **5899**, app **3902**,
  surrogate **8799**.
- 🔴 The surrogate is **SOFTWARE-backed**. `passthrough` or `stale`, never
  `verified`. Do not work around migration 053.
- 🔴 **Do NOT flip `CHECKPOINT_VECTORS_SETTLED`** and do not touch the live
  witness database. F4 works on a COPY.
- Verify by side effect; every gate names an observable AND a control that must
  not fire; controls RED before and green after; **an inconclusive control is
  scored INCONCLUSIVE, never a pass**. If a gate does not pass, say so plainly
  and KEEP THE WORK.
- Do not edit a shell script while it is running. WO-E5 and WO-E7 both shifted a
  running gate under bash's byte offsets and corrupted their own transcripts.
- Run `node vendor/scruple-web/scripts/preflight-schema.mjs --apply` is already
  wired into the seven gates that read the database; if you add a gate that
  reads it, wire it too.

---

## WO-F1 — the add-on's Settings UI must bind on the path it ships on

`STATE.md` §4.8 / finding E7-2. `bl_idname` is the **legacy module name**, so
installed through `blender_manifest.toml` (module `bl_ext.user_default.scruple_blender`)
`addons[module].preferences` is **None** — no API key field, no base URL field,
and `get_base_url()` falling back to **`https://scruple.ai`**, which is
production. The same zip binds fine on the legacy path.

The code change is one line. **The cost is that it moves every fixture baseline
in the E series**, which is why E7 named it rather than took it. Re-record them
deliberately, and say in the report which baselines moved and why each move is
expected.

**Gate:** the shipped zip installed through the **manifest** path exposes both
preference fields, and `get_base_url()` returns the configured sandbox URL.
**Controls:** (a) with nothing configured it must **refuse or return a non-production
default** — demonstrate that the production fallback is gone, by asserting the
string `scruple.ai` is not what an unconfigured call yields; (b) the **legacy**
path still binds, so the fix did not trade one path for the other; (c) the addon
suite is green, with the moved baselines enumerated.

⚑ This unblocks the travel laptop, which is holding the addon uninstalled
because of it. Say so in the report when it passes.

## WO-F2 — `WitnessWorker.stop()` must not drop queued captures

`STATE.md` / finding E7-3, measured on the real class outside Blender: `stop()`
**drops queued captures and they never reach the SDK's on-disk spool either**.
It bit WO-E7 first — 2 captures reported where the same Blender, waiting for
quiescence, reports 3. That is silent data loss on the one path whose whole
purpose is not losing things.

**Gate:** N captures queued and `stop()` called immediately — all N are either
delivered or on the durable spool, and the count is read **from disk**, not from
the worker's own accounting. **Controls:** (a) demonstrate the loss RED at the
parent commit with the same script; (b) a control where nothing is queued must
not manufacture a spool entry; (c) a capture that fails for a real reason must
still be distinguishable from one that was dropped.

## WO-F3 — the standalone add-on must declare what it did not observe

`STATE.md` §4.7 / finding E7-1 — **the E-series' headline finding** and the row
`docs/BLENDER.md` names as the one to get right. Two leaves built around two
DIFFERENT AI images are identical in every field that could describe how the
artifact came to exist. It is not a false claim; it is an **absent** one, and
absence and "there was nothing" read the same.

### 🔴 The product decision, taken here, with the reasoning

§4.7 lists three honest candidates. **Build the second: a declared field naming
the imported datablocks and their digests.** Not the other two, and the reasons
matter more than the choice:

- **NOT `host_semantics: blind`.** `blind` in `HOST-HOOK.md` means *full byte
  coverage and no meaning* — a gate saw every byte and could not read them. The
  standalone add-on has **no byte coverage of the AI step at all**. Putting
  `blind` on that leaf would assert a capture path that does not exist, which is
  a worse defect than the silence it replaces.
- **NOT `declared_uncaptured`.** WO-E2's absence set is closure over what an
  upstream **reported** (`/history`). There is no upstream here and nothing
  reported anything, so the set would have no scope to carry and E2's own
  `uncaptured_scope_source` rules would make it read `unknown` forever.
- **YES to naming the datablocks.** Blender *knows* what was imported: an image
  packed into the `.blend` has a datablock, a source path and bytes that can be
  hashed. So the leaf can say **"these assets entered this scene from outside,
  here are their digests, and this product did not observe how they were made"**
  — which is strictly more useful than "something was imported" and exactly as
  honest. ⚑ And it **composes**: when Desktop Studio is also present, an imported
  datablock's digest can be matched against a witnessed artifact's content hash,
  which is how the two products join up without either overclaiming.

**Gate:** two leaves built around two different imported AI images **differ** in
the new field, and each names the datablock and a digest that re-hashes from the
bytes on disk. **Controls:** (a) a scene with **no** imported datablocks yields
an **empty declaration that is PRESENT**, not an absent field — the two mean
different things, as they did in WO-E2; (b) an imported datablock whose bytes
cannot be read is recorded as unreadable, not omitted; (c) the field is in the
MAC — changing a digest must move the leaf hash; (d) a Desktop Studio leaf and
an add-on leaf for the same artifact must be shown to **link** by digest.

Say plainly in the report what this does NOT do: it does not tell anyone what
model made the image. It says what came in and that nobody here watched it
arrive.

## WO-F4 — `merkle_algorithm`, recorded before the code changes

`docs/canon/MERKLE_CUTOVER_RUNBOOK.md` steps 1–3, **against the snapshot at
`/mnt/corpus/scruple-council-impl/c7-rehearsal/witness-prod-copy.db` only.**
🔴 The live witness database is not to be opened for writing at all.

Add `merkle_algorithm` to `locked_projects` (nullable, no default — NULL means
"never asked"), backfill it from the sweep, and teach a verifier to dispatch on
it and **default to REFUSE**, never to any construction.

**Gate:** all 15 reproducible roots verify through the column; the 16 that never
reproduced are labelled `unreproducible` or `no-leaves` and are **refused rather
than guessed at**. **Controls:** (a) a row whose algorithm is NULL must be
refused, not silently tried as RFC 6962; (b) the two anchored rows (projects
`30` and `32`) must verify — they are on Arweave and Ravencoin and are the
reason this exists; (c) `puffjuly12-1783882341` must be labelled unreproducible
and must NOT acquire a label that makes it look verified.

Step 4 onward (changing the five call sites) is **not** in this work order and
step 6 is a founder-only deploy.

## WO-F5 — only if F1–F4 are done and gates are green

The app should refuse to serve on a stale schema, rather than eleven callers
each remembering to ask. `scripts/preflight-schema.mjs` closed the gate half of
finding E4-0; this closes the source half. **Gate:** the app refuses to start,
or refuses the leaf-writing routes, with a distinct error naming the pending
migrations. **Control:** with the schema current it starts and serves normally —
and a route that does not touch the database must be unaffected.

---

## WO-F6 — a case-insensitive filesystem makes the manifest attribute bytes to a name that never held them

Found by the travel-laptop session (its W1-B1), on NTFS. **Not reproducible on
this box** — Linux is case-sensitive, so the two files stay two files — which is
exactly why the rig exists.

### What it observed

A vault declaring **`Model.safetensors` and `model.safetensors`** yields **one
captured entry, pairing the FIRST name with the SECOND bytes.** NTFS merges the
two writes; `readdirSync` returns whichever name was created first; the bytes
under it are the later write's. Its words: *"the hash under `Model.safetensors`
is not the hash of anything ever written to that name."* `existsSync` resolving
**4 of 4** case variants is the mechanism by which the lookup never notices.

⚑ **Do not fix this as a miscount.** `manifest.ts` already carries
`declared_but_absent`, so the manifest DOES say the second name was not found.
The defect that survives that is worse and subtler: **the captured entry asserts
a content hash for a filename that never held those bytes.** A record that is
merely incomplete is recoverable; a record that is confidently WRONG about which
name held which bytes is a false provenance claim produced by correct-looking
code. It is the exact failure `refused_mime_undeclared` exists to prevent,
arriving through the filesystem instead of through the declaration.

⚑ **And "declared A and B, found only A" is AMBIGUOUS on such a filesystem.** It
means either "B was never created" or "B was created and silently became A".
Those are different facts. Today they read the same.

### What to build

Detect the condition and **refuse to attribute**, rather than guess:

1. **Measure the filesystem, do not assume it.** Whether the vault root is
   case-insensitive is a property of the volume, not of `process.platform` — an
   ext4 volume mounted on Windows, or a case-sensitive directory on NTFS
   (`fsutil file setCaseSensitiveInfo`), both exist. Probe it: create a file,
   stat it under a different case, delete it. Record the answer on the manifest.
2. **When two declared names differ only by case and the volume is
   case-insensitive**, the entry's `contentHash` becomes a **refusal**, with a
   new outcome — the bytes are real but the name→bytes binding is not
   establishable. Follow WO-D3's rule: the byte COUNT survives the refusal.
3. **`declared_but_absent` alone is not sufficient** and the report must say so.

### Gate and controls

**Gate:** on a case-insensitive volume, a vault declaring two names differing
only by case produces **no captured entry claiming either name**, and the
manifest states why. **Controls:** (a) on a case-SENSITIVE volume the same
declaration produces **two normal captured entries** — the fix must not fire
where there is nothing wrong; (b) a vault with no case collision is byte-identical
in its manifest before and after this change; (c) the probe itself must be shown
to return BOTH answers — run it against a case-sensitive path and a
case-insensitive one and assert they disagree. A probe that always says
"case-sensitive" on Linux would make this whole work order inert and green.

🔴 (c) is the important control. This work order cannot be fully proved on this
box, and **that must be stated in the report rather than papered over.** Build
the probe and the refusal here, prove the case-sensitive half here, and hand the
case-insensitive half to the laptop as a W-series item with a named gate.

## WO-F7 — two portability landmines, both mine

**(a) `file:` + a Windows path + `?mode=ro` opens the WRONG database and
SUCCEEDS.** The laptop's W1-10. SQLite does not treat `C:\...` as absolute after
`file:`; `?mode=ro` is never parsed, so **a file literally named `=ro` is created
in the working directory**; the open succeeds against that empty new database and
every query returns nothing or `no such table`. 🔴 **A witness lookup for a leaf
that WAS written comes back "not found" — a path bug wearing the costume of the
provenance failure it imitates.** Nine `.sh` gates here build that string. They
are Linux-only today, where the form happens to work. Fix them anyway to
`file:///` + forward slashes, which also actually enforces read-only (a
`CREATE TABLE` against the correct form fails; against the broken form it never
did). **Control:** assert the corrected form REFUSES a write, and assert no `=ro`
file appears.

**(b) The runners run production code out of the production directory.** All
three `scripts/overnight-*.sh` do `cd /opt/scruple-witness && node server.js`,
kept off the live database only by `DB_PATH`. **`services/witness-server/server.js`
is BYTE-IDENTICAL** (verified with `cmp`) and self-hosting: `npm install` in that
directory, then `PORT=… DB_PATH=… SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 node server.js`
creates all six tables including `witnesses` from nothing and answers `/health`
200. Proven on a fresh port and empty database. Switch every runner to the repo
copy and document the recipe — the current form teaches that the witness lives at
a path you must not touch, rather than in the repo you already have. ⚑ `arweave`
is the dep missing from scruple-web's root `node_modules`, which is why a search
for a self-hostable witness comes up empty.

## WO-F8 — the forgeable witness must not be reachable off-host

The laptop's W1-15. `services/witness-server/server.js:1564` is
`server.listen(PORT, '0.0.0.0')` — **hardcoded, not configurable**. Confirmed on
this box: the sandbox witness on 5899 is bound to `0.0.0.0` and reachable on the
LAN, while the CVM surrogate on 8799 correctly binds `127.0.0.1`.

🔴 **That witness is sealing with the DEV SECRET, which its own banner says makes
every leaf it seals forgeable.** On a fixed build box behind a firewall that is a
small fact. On a travel laptop joining café wifi it is not: anyone on the network
can reach a service that mints forgeable provenance.

### The fix, and why this shape

Do **not** just add a `BIND` variable and default it to loopback — a variable can
be set wrongly. Bind the two facts together:

> **When `SCRUPLE_WITNESS_ALLOW_DEV_SECRET` is set, the server MUST refuse to
> bind anything but a loopback address**, whatever `BIND`/`HOST` says, and say so
> on startup. Production, which does not set that flag, keeps its current
> behaviour unchanged.

The forgeable mode then *cannot* be exposed, rather than merely defaulting to
not being. An operator who wants a dev witness on a LAN has to stop asking for
the forgeable secret first, which is the correct order of those two decisions.

**Gate:** with the dev secret set, the process binds loopback only — asserted by
reading `ss -lptn`, not by trusting a log line — and an explicit request for
`0.0.0.0` is **refused with a message naming the reason**. **Controls:** (a)
without the dev secret, the bind is unchanged and production behaviour does not
move; (b) a connection from a non-loopback address to a dev-secret witness is
**refused at the socket**, demonstrated, not merely assumed from the bind string;
(c) the existing sandbox gates still pass with the witness on loopback — if any
gate depended on off-host reachability, that is a finding.

⚑ **And note the irony the laptop pointed out**, which belongs in the report:
`app/comfy/ports.js` exists precisely to detect "an upstream on 0.0.0.0 is
reachable without passing the gate" — and on Windows the port ledger is
`unavailable` (its W1-6), so **the one measurement that would have flagged this
is the one that platform cannot take.** That is the argument for the
`GetExtendedTcpTable` work, and it should be recorded as such.
