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

## WO-F6 — `declared_but_absent` is correct, and nothing reads it

🔴 **THIS WORK ORDER WAS WRONG WHEN FIRST WRITTEN AND IS REPLACED.** It claimed
the vault "attributes bytes to a name that never held them" on a case-insensitive
filesystem, sourced from the travel laptop's first report, and I called it the
most serious thing found that night. **The laptop then ran the vault and
retracted it**; its original section had said in its own words that it measured
the platform and made *no claim about the vault*, and the claim was made anyway.
The original text is left in git history rather than being quietly overwritten.

### What is actually true

**The vault keys on ENUMERATION, not on the declaration** — verified here at
`app/vault/vaultSurface.ts:257`:

```ts
declaredButAbsent: declaration.declaredPaths().filter((p) => !present.has(p)),
```

Entries come from what was walked; the declaration is used only to compute what
is missing. So on NTFS, a vault declaring `Model.safetensors` and
`model.safetensors` produces:

```
2 files, 2 captured, 0 refused, 1 declared-but-absent
entries[0] path=Model.safetensors  content_hash=ec0499dc…  captured
declared_but_absent: ["model.safetensors"]
```

and `ec0499dc…` is exactly what `Get-FileHash` reads off that file. **It hashes
what is there, attributes it to the name it actually has, and separately records
the declared name it could not find.** That is right on a hostile filesystem, and
the design does not have the hole the earlier version of this WO described.

### What survives, and it is narrower and still real

⚑ **A declared file can vanish and every gate stays green.** `declared_but_absent`
is written and never read. Five references exist in the entire desktop tree —
`manifest.ts:69` and `:133`, `vaultSurface.ts:104`, `:257` and a log line at
`:264` — and **no scenario, gate script or assertion kind consumes it**. All four
refusal counters read 0, so anyone watching refusals sees a clean run. The
laptop's scenario passes, controls included, with a declared file silently
missing from the capture.

**It is not a forged record. It is an ungated one: the vault says the true thing
and nothing is listening.**

### What to build

An assertion kind — `declared-absent-is` or similar — so a scenario can require
`declared_but_absent` to be empty, or to be exactly the set it expects. The field
is already correct; **it needs a reader.**

**Gate:** a scenario declaring a file that is not present FAILS, naming the
missing file. **Controls:** (a) the same scenario with every declared file present
PASSES — the assertion must not fire where nothing is wrong; (b) a scenario that
*expects* a declared absence (a deliberately missing file) passes when it occurs
and fails when it does not, so the kind can express both; (c) the existing
`vault-capture.json` is unchanged in outcome, or the change is explained.

⚑ **Cross-platform note worth keeping**: the same declaration yields 3 files /
3 captured / 0 absent on Linux and 2 / 2 / 1 on NTFS. Honest on both, and
invisible to every gate on both.

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

## WO-F9 — `portLedger` returns a well-formed EMPTY measurement when called wrongly

Found 2026-09-10 by making the mistake. `portLedger` destructures an object —
`{gatePort, gatePid, upstreamPort, upstreamPid}` — and was handed an **array**.
Every field came out `undefined`, `listenersOn([undefined])` matched nothing, and
it returned a **complete, well-formed ledger reading `state: measured` with zero
listeners**. That was reported to the travel laptop as a weakness in the Linux
port ledger and had to be retracted; called correctly against the same sockets it
finds both listeners and their pids.

🔴 **Empty-because-nothing-is-listening and empty-because-you-asked-wrong are the
same object today**, and the second one reads as a successful measurement. This
is precisely the defect the laptop's W1-17 fixed one level up — it separated
`measured/count=0` ("looked, found none") from `unavailable/count=null` ("could
not look") — arriving one level down, in the argument handling.

**Build:** `portLedger` refuses a malformed argument instead of measuring
nothing. A missing or non-numeric `gatePort`/`upstreamPort`, or an argument that
is not an object, yields a **refusal with a reason code**, never a ledger.

**Gate:** the wrong call that started this returns a refusal, and the right call
still returns two measured listeners with their pids. **Controls:** (a) a correct
call against ports where genuinely nothing listens must still return
`measured` with zero listeners — the fix must not turn "nothing there" into
"you asked wrong"; (b) the two outcomes must be shown to be distinguishable by a
caller without reading prose.

⚑ No sweep is required for existing gates: `portLedger` is called from exactly
two places, both in `app/ipc-comfy.js`, both inside the main process, both with
the correct object form. This is a latent trap for the next caller, not an
active defect.
