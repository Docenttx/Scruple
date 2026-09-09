# Scruple Desktop Studio — state of the thing

_2026-09-09, end of the WO-D series. Written to be read by someone deciding
what to do next, so it separates what was measured from what was merely built,
and it separates "done" from "done against the surrogate"._

The rule this document is written under: **every claim names the observable that
established it.** Where there is no observable there is no claim, and the item
is under "built but unproven" instead.

---

## 0. The one sentence that matters most

⚑ **Blender is not installed in this app.** There is no Blender launcher, no
Blender adapter and no Blender scene in any leaf. `/usr/bin/blender` exists on
this box and this app has never spoken to it. What WO-D6 built is the
**host-agnostic hook** Blender will plug into, and what proves it is a host we
invented — `phantom-cam`, a fixture in `scripts/desktop-run.mjs` that writes the
two files a Level-2 host writes and nothing else. That was deliberate:
docs/DESIGN.md says "Blender is the first consumer of this hook, not a special
case", and a hook that could only be satisfied by the host we happen to have
would be testing the special case.

The app says so itself, where a user would look: `app/ipc-profile.js` reports
Blender as `available: false`, `detail: "not installed in this app yet"`, beside
Kohya's `"the legacy training IPC has not been rewritten onto the SDK yet"`. A
dashboard that quietly omitted them would be the failure mode.

Blender is the next series. This one is the floor it stands on.

> **AMENDED by the E-series** (2026-09-09). The paragraph above is the D-series
> close-out and is kept as written; here is what has since changed, and what has
> not.
>
> - **The first sentence is retired.** WO-E3 installed Blender 4.2.23 LTS into
>   this repo's own tree (`vendor/blender/bin/blender`), WO-E4 made the addon
>   the Level-2 adapter — a real leaf reads `host_semantics: supplied`,
>   `capture.host: blender` — and **WO-E5** made the app *measure* the Blender on
>   the box: `app/ipc-blender.js`, `scruple:blender`, and a dashboard region that
>   names the version out of the running binary, the addon's enabled state, and
>   whether a bridge is pointed at the gate. `app/ipc-profile.js` no longer says
>   `"not installed in this app yet"` anywhere; it reports what `resolveBinary()`
>   found, and reports having found nothing when there is nothing.
> - **The region is ABSENT on a machine with no Blender** — `count === 0` and
>   zero occurrences in the serialised document — and the *app* is still listed
>   as unavailable with the reason, because the sentence below about quietly
>   omitting things still binds. `scenarios/blender-absent.json`.
> - ~~**Still true, and still the honest sentence:** this app does not *launch*
>   Blender, no bridge inside Blender has yet sent a generation through the gate,
>   and no leaf in this repo has been produced by a render.~~ **All three of
>   those are now false, and each by a different work order.** WO-E6 gave the
>   app a channel that *launches* Blender and never generates
>   (`app/ipc-blender-generate.js`), ran `alexisrolland/ComfyUI-Blender` v3.3.4
>   inside it pointed at the gate by one string in its own preferences, and put
>   the graph, the model fingerprints and the scene on **one leaf**. WO-E7 then
>   ran Blender's **renderer** — Cycles, headless — and witnessed the file it
>   wrote, so a leaf in this estate has now been produced by a render.
> - **What is still true**, and it is the sentence the E series ends on:
>   ⚑ **the standalone add-on's leaf does not say what it did not see.** WO-E7
>   §9.1. It is not a false claim; it is an absent one, and the record cannot
>   tell it apart from a leaf about which the question was never asked.

---

## 1. What works, and the observable that showed it

Every row was established by a command in `scripts/`, against the sandbox
(witness `:5899`, app `:3902`, surrogate `:8799`), with a control that had to
fire. Re-run all of them with `npm run gate`, which chains D1 … D7; or
`bash scripts/d7-gate.sh` for the whole flow on its own.

| what | the observable | the control that must not fire |
|---|---|---|
| **It runs headlessly.** Electron 38.8.6 · Chromium 140.0.7339.249 · Node 22.22.0, under `xvfb-run -a -s "-screen 0 1280x900x24"` | a scripted `ping` round trip carrying the main process's pid and a nonce minted in main and never injected into a page | pointed at a dead port the run FAILS; a preload that answers in the renderer is caught by `fake-bridge` |
| **A headless driver.** `scripts/desktop-run.mjs` drives a named scenario through the real IPC handlers — the desktop mirror of `scruple-run.ts` | side effects only: bytes on disk re-hashed by the driver, rows in the witness's own sqlite file, an exit code | `--audit` breaks each run once per mutation and requires EXACTLY the declared assertions to redden; `assert-expectation` proves an assertion can fail at all |
| **The vault**, rebuilt on the SDK's `ObservationSink` — a directory enumerated, typed by DECLARED MIME, hashed as a unit | leaves in the scratch witness whose content hashes re-hash from the bytes on disk | an undeclared file is REFUSED with `refused_mime_undeclared` and has **no leaf**; over-ceiling is refused as a recorded outcome, not skipped; an ordinary file is still accepted |
| **The gate in the path**, with ComfyUI launched by this app under a base directory it owns | a generation's leaf carries `model_fingerprints` computed from the model FILES | `model-swap` changes the bytes and keeps the filename, and the fingerprint changes — the entire product claim |
| **The canon design on the shared implementation.** 21 tokens ported into `/data/scruple-web`'s theme; the dashboard renders from `GET /api/v2/capabilities` | `getComputedStyle` in the real window — the layout engine's own answer, after the cascade | a region that does not apply is ABSENT: `count === 0` **and** the string occurs zero times in the serialised document |
| **The ComfyUI hook, host-agnostic.** Level 1 free, Level 2 by registered adapter | three real leaves reading `supplied`, `blind` and `declined`, compared from the shell | a Level-1 leaf DECLARES its blindness rather than being a thinner leaf; a host that forges a grade on its declaration is refused and the refusal is recorded |
| **The whole flow** — launch · gate · generate · vault · witness · receipt · C2PA — in one app, one launch | `bash scripts/d7-gate.sh`; the table below | four controls, §3 |
| **Blender 4.2.23 LTS in this repo's own tree**, and the shipped zip installed through the **manifest** path — the one a 4.2+ user gets (WO-E3) | `blender --background --python-expr` reports the module as `bl_ext.user_default.scruple_blender`, the floor as `(4,2,0)` and the description as the manifest's `tagline` — all three read out of the RUNNING Blender | a manifest that cannot be parsed is refused with nothing left on disk and **no fall back to `bl_info`**; a manifest flooring above 4.2.23 is refused too. ⚑ The work order's *other* control — "the same zip must fail on 3.0.1" — **does not hold**, and E3 scores it as a failure rather than dropping it |
| **The add-on is the Level-2 host adapter** (WO-E4). `register()` declares it through the SDK's own `registerHost()`; `bpy.ops.scruple.host_announce` writes one document per generation out of `bpy` datablocks | a leaf reading `host_semantics: supplied`, `capture.host: blender`, with scene · frame · camera · engine · resolution · samples · format in the MAC | with the add-on absent the same generation reads **`blind`**; present but silent reads **`declined`**; a document failing the add-on's own schema is refused and the run continues at Level 1 |
| **The Blender region in the dashboard** (WO-E5), drawn only when the host announces a Blender it has | version from `blender --version`, the add-on's enabled state from a running Blender's own preferences, and a bridge address compared against the port the kernel gave the gate — all three in a real window, then re-taken from the shell | with no Blender the region is ABSENT — `count === 0` **and** zero occurrences in the serialised document — while the *app* stays on the list, unavailable, with the reason |
| **One generation, started inside Blender, through the gate** (WO-E6). A third-party bridge — `alexisrolland/ComfyUI-Blender` v3.3.4, its own release zip, unmodified — pointed at the gate by one string in its own preferences | ONE leaf carrying the graph the BRIDGE POSTed (recomputed from its own `client_id` with the SDK's `hashWorkflow`), the model fingerprints the DESKTOP hashed, and the scene out of `bpy` — read back with `sqlite3` and `sha256sum` from the shell | `model-swap` moves the fingerprint and **nothing else**; the bridge pointed AROUND the gate still leaves a witnessed artifact, with no graph and reading `declined` (E6-5); an announcement under an id nobody submitted reaches **no row in the whole table** |
| **The two products, side by side, field by field** (WO-E7). The add-on alone talking to the server with no gate; Desktop Studio alone; both | three leaves compared column by column with `scripts/e7-leaf-diff.py`, in which **every one of the 105 columns of `iterations` is in exactly one of five classes** and an unclassified column is a failure | the comparator fed the same leaf as A and as B goes red on 33 checks; `model-swap` moves the fingerprint that separates A from B and C; silencing the add-on moves the `host_semantics` that separates B from C |

### The flow, printed

One line per **leaf** — a generation makes two, because the gate observes the
graph and the output. Every column is measured by the driver: the digest from
the bytes on disk, the leaf from the witness's own file, the basis from the
app's database, the last two columns over the public HTTP routes.

```
STATION     ARTIFACT                  CONTENT       REHASH  LEAF  LEAFHASH      BASIS  PROFILE           SEM       RCPT  RESOLVE
generate    artifact                  0d4b5fe3db3a  ok      588   1632f0cc2d83  stale  isolated-sidecar  supplied  200   resolvable
generate    artifact                  0d4b5fe3db3a  ok      589   c09f322e0ca9  stale  isolated-sidecar  supplied  200   resolvable
credential  staged copy               0d4b5fe3db3a  ok      588   1632f0cc2d83  stale  isolated-sidecar  supplied  200   resolvable
credential  staged copy               0d4b5fe3db3a  ok      589   c09f322e0ca9  stale  isolated-sidecar  supplied  200   resolvable
vault       accepted.png              ed5370081ece  ok      590   b3932d31122b  stale  desktop           blind     200   resolvable
vault       config.toml               780e3586e6f1  ok      592   35289963ed51  stale  desktop           blind     200   resolvable
vault       captions.txt              c7d60a6c2b64  ok      591   d234e1a1991a  stale  desktop           blind     200   resolvable
vault       manifest                  d73d77c76b42  ok      593   a2501dc50f59  stale  desktop           blind     200   resolvable
vault       undeclared.png (refused)  265fbb1b9e92  ok      NONE                                         -
```

**6 leaves** (the work order asks for at least 5), every artifact re-hashes,
every receipt resolves, and every basis reads `stale` — never `verified`. The
last row is the one that is supposed to have no leaf.

The two `credential` rows are the same bytes as the two `generate` rows, and
that is the point: **the bytes that were signed are the bytes that were
witnessed.** They appear twice because the run store is content-addressed and
the signer types an asset from its path, so the artifact is staged under the
filename ComfyUI gave it and the copy is re-hashed before anything is signed.

---

## 2. Done, versus done against the surrogate

🔴 **The surrogate is SOFTWARE-backed.** Nothing below is hardware-protected,
and no leaf in this repo has ever read `verified`.

| station | done | done against the surrogate | what production would change |
|---|---|---|---|
| capture, MAC, ratchet, queue | ✅ real | — | nothing; this is the same code the server ships |
| witness leaf (HMAC seal) | ✅ real | — | nothing |
| **witness leaf ECDSA signature (H-1)** | ❌ **not exercised at all** | — | see §4.1 — the scratch witness runs with leaf signing `disabled`, so every leaf here reads `signature.state: unsigned` and `independently_verifiable: false` |
| **C2PA credential** | ✅ produced, and it validates | ⚠️ **signed by the surrogate** — `signing_mode: kms-http`, `signer_identity: … surrogate=true` | a real OCI Vault key with instance-principal credentials, and a certificate chain someone has reason to trust |
| C2PA trust | — | ⚠️ `signingCredential.untrusted` on every credential, correctly | a real cert chain. This status is the honest one for a dev root and it must not be papered over |
| attestation basis | ✅ recorded per leaf | `stale` on every leaf | see §4.2 — this is an estate-wide condition (WO-C6), not a desktop one |
| `verified` | 🔴 unrepresentable | 🔴 unrepresentable | unchanged, by design, on the desktop profile |

**What "signed by the surrogate" was proved to mean.** `scripts/d7-gate.sh`
stage 2 stops the surrogate and signs again: the signature FAILS. There is no
fall back to a local key. If it had succeeded, the surrogate was never the
signer and the phrase would be a label.

---

## 3. The four controls behind the WO-D7 gate

A green assertion with no control proves only that it cannot fail.

1. **`tamper-the-artifact`** — one byte of the stored artifact is flipped AFTER
   the run. `EVERY-ARTIFACT-REHASHES` goes red and **nothing else does**: the
   leaf, the receipt, the resolution and the basis all stay green, because the
   leaf recorded what the bytes WERE and the file on disk is now something
   else. That is the correct outcome, and it is why the re-hash is a separate
   assertion from the leaf's existence.
2. **An unissued leaf must not resolve** — leaf `99000000` answers
   `unresolvable` / 404 while a leaf this run made answers `resolvable` / 200.
   Both directions, from the shell.
3. **The database refuses `verified` on a desktop leaf** — demonstrated on a
   COPY of the scratch schema, and the same INSERT with an honest basis is
   ACCEPTED, so the refusal is the CHECK constraint and not a broken statement.
4. **The certificate control** — see §4.3. It was RED before this work order
   and is GREEN after, and it is the most useful thing WO-D7 found.

⚑ **Two of these controls were wrong on their first run, and the gate caught
its own.** Recorded because a gate that has never been wrong has probably never
been checked:

- The `verified` control (3) copied the newest leaf row verbatim, so both its
  INSERTs collided on `UNIQUE(project_id, run_sequence)` and the *honest* one
  came back REFUSED for a reason that had nothing to do with the constraint
  under test. A control that fails for the wrong reason is not a control. It
  now takes a fresh sequence per attempt, and the honest INSERT is ACCEPTED.
- The surrogate-down control (§2) waited a bounded number of seconds on `ss`
  and then signed regardless of what it found. On one run the surrogate had not
  finished dying, the signature succeeded against a live surrogate, and the
  control printed "it signed anyway" — scoring a FAIL for a run in which the
  control had never actually run. It now waits for `/health` to stop answering
  and, if the surrogate is still up, says **INCONCLUSIVE** rather than passing
  or failing. An inconclusive control must never be scored either way.

  It also means the very first version of this control — which truncated the
  signer's output before reading it — passed vacuously. That is the failure
  mode the whole audit-sweep discipline exists to catch, and it happened here.

---

## 4. What is honestly missing

### 4.1 The leaves in this sandbox are not independently verifiable

`GET /api/v2/verify/{hash}` reports `independently_verifiable: false` and
`signature.state: unsigned` for every leaf this flow makes. The reason is
configuration, not code: the scratch witness on `:5899` runs with H-1 signing in
its default `disabled` mode (`SCRUPLE_WITNESS_KMS_ENDPOINT` and
`SCRUPLE_WITNESS_KMS_KEY_OCID` are unset in its environment), so leaves carry
the HMAC transport seal alone — which Scruple can forge and nobody else can
check.

This was NOT fixed here, deliberately: the witness process runs from
`/opt/scruple-witness`, and the rails for this series forbid touching it.
Enabling H-1 on the sandbox means restarting that process with two variables
pointed at `:8799`; it is a five-minute job for whoever owns that box, and it
would make the desktop flow's leaves surrogate-signed in the same sense the
credential already is.

**Needs: a human with authority over the sandbox witness process.**

### 4.2 Every leaf reads `stale`, and that is not the desktop's fault

The gate's own log says why: *"the witness and the verifier do not pass shared
Merkle vectors (canonical preimage, domain separation, tree ordering, root
calculation, proof format). Three live constructions disagree and the witness
anchors whichever root the caller supplies, so no checkpoint can be claimed
settled and every new leaf states `stale`."* That is WO-C6 on the server side,
and it pins every leaf in the estate — desktop or not.

On the desktop profile there is a second, permanent reason: the measured party
has root, and `verified` is unreachable by construction. The two reasons are
separately recorded and both appear in the basis string.

**Needs: the founder.** Whether to converge the three Merkle constructions is an
estate-level decision, not a desktop one.

### 4.3 ⚑ FOUND HERE: the C2PA signer will embed a certificate for a key that did not sign

With `SCRUPLE_C2PA_VAULT_KEY_OCID` + `SCRUPLE_C2PA_KMS_ENDPOINT` set, the signer
signs through the surrogate — a **different key** from the local dev one — and
still embeds `services/c2pa-signer/keys/signer.pem`, the certificate issued for
the LOCAL key. Nothing checks that the two agree. The route answers `ok: true`,
`signing_mode: kms-http`, and `c2pa.Reader` answers:

```
['signingCredential.untrusted', 'claimSignature.mismatch']
```

— a credential nothing can verify, produced by a call that reported success. It
is silent, and an operator switching to KMS signing would have no way to notice
short of reading a manifest back.

**Worked around here, not fixed at the source.**
`scripts/d7-surrogate-cert.sh` issues a leaf certificate whose public key IS the
surrogate's (from its own `/testnet/pubkey.pem`; the private half is never
touched) and the sandbox app is pointed at it, after which the same signature
validates:

```
['signingCredential.untrusted']
```

That is the correct residual status for a dev root and it must stay.

**Needs: a decision, then a small change on the server.** The fix belongs in
`lib/c2pa/signAsset.ts` or `services/c2pa-signer/sign.py`: compare the
certificate's public key against the public half of the signing key before
signing, and REFUSE on a mismatch with a named code. This work order did not
make that change — it is the server's signing path, it affects every caller
including Fusion, and it deserves its own control rather than being smuggled in
under a desktop work order.

> **CLOSED by WO-E1** (2026-09-09, `/data/scruple-web` `6aeee18`). The decision
> is *refuse, with a code, with no override*; the guard is
> `vault_sign.assert_certificate_matches_signing_key()`, called from `sign.py`
> before anything is written, and the code is `certificate_key_mismatch`. The
> workaround below stays and is now what the gate's control (a) proves still
> works. `docs/WO-E1.md` — including the three things it does not buy.

### 4.4 A desktop artifact cannot earn a credential above tier `bare`

`POST /api/scruple/c2pa/sign` refuses tiers `witnessed`/`local`/`chain` with
*"project has no SCR-ID (never witnessed)"*, and it is right to: those tiers
build a Scruple assertion out of `projects.scr_id`, `merkle_root` and
`lock_server_signature`, which only the legacy lock routes (`/api/lock/local`,
`/api/lock/chain`) ever set. The v2 witness door does not.

So the credential this flow produces **carries no Scruple assertion binding it
to the leaf.** The binding exists in the other direction — the sign request
names the iteration, and the response returns its `leaf_hash` — but a verifier
holding only the signed file cannot follow it.

The refusal is asserted positively by the gate (`TIER-ABOVE-BARE-IS-REFUSED`)
because the failure mode worth preventing is the opposite one: a signer
producing a credential that claims a tier it cannot substantiate.

**Needs: the founder.** "How does a desktop project earn an SCR-ID under the v2
door" is a product question about what a lock tier means now that the v0 lock
routes are retired (docs/DESIGN.md, "what is kept, what is replaced").

### 4.5 The sign event's own audit leaf is not emitted here

Every credential comes back with
`witness_error: "stream scruple.c2pa.sign not found — run scripts/seed-c2pa-stream.mjs"`.
The internal-tenant stream is unseeded on the scratch deployment and its ingest
(`SCRUPLE_INTERNAL_INGEST_BASE`, default `localhost:3005`) is not running here.
The route is fail-open by design — not emitting the leaf must never block the
credential — and it reports the error rather than hiding it.

🔴 Not seeded here on purpose: the only other thing listening in that range on
this box is `:3001`, which the rails forbid contacting. Whoever seeds it should
confirm what the ingest base points at first.

Probing this left one artefact behind: `/data/scruple-web/data/witness/` holds
the internal tenant's auto-provisioned dev credentials, written by the route's
first-use fallback. It is untracked, it is dev-only, and it is not this repo's.

**Needs: a human, in an environment where that ingest is running.**

### 4.6 The desktop and the signer share a filesystem, and a real split would not

`asset_path` is a path **on the signer host**. In this sandbox the desktop and
the Next server are the same box, so handing over a path works. A real desktop
talking to a real server would have to upload the bytes, and the signed asset
would have to come back over the wire rather than being read out of the
server's `TMPDIR`.

Nothing about the custody claim changes — the key stays where the desktop cannot
reach it either way — but the transport is unwritten.

**Needs: a work order.** It is small and it is not proved here.

---

### 4.7 ⚑ FOUND HERE (WO-E7): the standalone add-on's leaf does not declare what it did not observe

`docs/BLENDER.md` says of the add-on-only product: *"Something was imported here
and we do not know what it was" is the true statement, and it needs to be on the
leaf, not in a footnote.* **It is not on the leaf.**

Measured, not argued. WO-E7 built one Blender scene around an image that came
out of a ComfyUI generation the add-on never saw, packed it into the `.blend`,
rendered it with Cycles and let the add-on's own `render_write` /
`render_complete` / `save_post` handlers witness the results. Then it did the
same thing again with a **different** AI image and compared the two leaves:

```
   output_hash               MOVED   — the pixels are different pixels
   workflow_hash             same
   machine_manifest_hash     same
   model_fingerprints        NULL on both
   input_hash                NULL on both
   host_semantics            NULL on both   ← not `blind`. NULL.
   leaf_scheme               same
```

Every field that could describe how the artifact came to exist is **invariant
under the AI step**. The graph the add-on commits to has nine keys — `kind`,
`filename`, `scene`, `engine`, `resolution`, `samples`, `camera`, `frame`,
`trigger` — reconstructed outside Blender from the add-on's own builders and
proved to be that graph by its hash matching the leaf's.

Two separate problems, and they need separate fixes:

1. **`host_semantics` is NULL, not `blind`.** Migration 058's own comment says
   NULL means *"the question was never asked of this leaf"* and `blind` means
   *"there was a hook and nobody was registered on it"*. `buildLeaf` defaults to
   `blind` for a **component**; the add-on is not a component and has no capture
   block, so its leaf reads NULL — the same value a leaf written before the hook
   existed reads. HOST-HOOK.md's central claim, *"a Level-1 leaf DECLARES its
   blindness"*, does not reach this product at all.
2. **`workflow_hash` is non-null and unreadable.** The v2 witness route hashes
   `graph` and **discards it**, so the column that says "there was a graph" reads
   identically for a ComfyUI generation graph and a Blender render-settings
   dict — same column, same `canonicalization_profile: jcs-2`, same
   `leaf_kind: workflow`. Nothing on the leaf says which kind it was.

⚑ It is not a **false** claim — nothing on this leaf asserts anything about an
AI step. It is an **absent** one, and absence and "there was nothing" read the
same. That is exactly the failure mode `blind`/`declined` exists to prevent one
layer down, arriving in the product the E-series was told to get right.

**Needs: a product decision, then a work order.** The decision is what the
standalone add-on should say — the honest candidates are a `capture` block
carrying `host_semantics: blind` from the plugin door, or a new declared field
naming the imported datablocks and their digests, or `declared_uncaptured`
(WO-E2's absence set) extended to the plugin door. Each is a change to the
server's leaf, so none of them is the add-on's to take alone. `docs/WO-E7.md`
finding **E7-1**, with what each option costs.

### 4.8 The add-on's own Settings UI does not bind on the path it ships on

`ScrupleAddonPreferences.bl_idname` is the literal `"scruple_blender"` — the
module name on the legacy `scripts/addons/` path. Installed through
`blender_manifest.toml`, which is what WO-E3 made work and what every 4.2+ user
gets, Blender enables the add-on as `bl_ext.user_default.scruple_blender`, the
two strings do not match, and `bpy.context.preferences.addons[module]
.preferences` is **None**.

Measured with a control — the same zip, the same Blender 4.2.23, both install
paths (`scripts/e7-prefs-probe.py`):

| install path | module | preferences bound |
|---|---|---|
| legacy `scripts/addons/` | `scruple_blender` | **True** |
| manifest (what ships) | `bl_ext.user_default.scruple_blender` | **False** |

So on the shipping path there is no API-key field, no base-URL field and no
verbose-logging toggle, and `get_base_url()` falls through to the SDK default
**`https://scruple.ai`** — production. What keeps the product working at all is
the fallback the SDK auth cache provides, which is what `scruple.sign_in`
writes; WO-E7's own add-on runs sign in through exactly that path.

**Needs: a one-line change in `/data/scruple-blender` and a control.** The value
has to be the module the class is registered under (`__package__`), and the
control is this probe on both paths. Not taken here: it is the add-on repo's
product surface, it moves the add-on's tamper surface hash and therefore every
baseline in the E-series fixtures, and it deserves its own gate rather than
being smuggled in under a close-out. `docs/WO-E7.md` finding **E7-2**.

### 4.9 The add-on's in-memory worker drops queued captures when it stops

`adapter/handlers.WitnessWorker._run()` re-checks the stop flag **after** pulling
a job and **before** running it, so anything still queued when `stop()` is called
is discarded — and because it never reached the SDK it is not in the on-disk
retry queue either. `unregister()` calls `stop()`, so the losing case is a
capture taken shortly before Blender quits or the add-on is disabled.

Measured on the real class, outside Blender:
`scripts/e7-worker-stop-probe.py` submits two jobs, waits until the first is in
flight, calls `stop()`, and reports `ran: ["first"], dropped: ["second"]`.

⚑ It also bit this work order: the first exploratory add-on run stopped the
worker as soon as the render returned and reported **two** captures where the
same Blender, waiting for quiescence, reports **three**.

**Needs: a work order.** The fix is small — drain the queue before honouring the
flag, with a bound — but "how long may Blender's shutdown block on a network
call" is a product question, and the store-and-forward story in
`adapter/baseline_cache.py` was written on the assumption that a capture always
reaches the SDK's spool.

### 4.10 The two products do not emit the same kind of leaf, and nothing says so

Two differences WO-E7 measured that `docs/BLENDER.md`'s table does not predict:

- **`leaf_scheme` is `v2.2` from the add-on and `v2` from the component.** A leaf
  scheme governs which fields enter the preimage and in what order, so these are
  not two differently-populated leaves, they are two differently *constructed*
  ones.
- **`machine_manifest_hash` is set by the add-on and NULL from the desktop
  component.** On that one column the *standalone* product records more: Blender's
  version, the enabled add-on list and the workflow, hashed with the SDK's
  canonicalizer. The gated path records none of it.

Neither is unsound and both are invisible to anyone reading one leaf.

**Needs: a decision.** Whether the two doors should converge on one scheme, and
whether the component should carry a machine manifest, are estate questions
about what a leaf is — not desktop ones. `docs/WO-E7.md` findings **E7-5** and
**E7-6**.

### 4.11 A Level-2 host cannot always announce before it submits

WO-E6 measured that `alexisrolland/ComfyUI-Blender` sends `{client_id,
extra_data, prompt}` and **no `prompt_id`**: ComfyUI mints one and the bridge
learns it from the response, so the announcement can only be written *after*
`/prompt` has been answered, racing the artifact. The measured margin on the
smallest generation that can exist was **1.8 s**. Nothing is unsound — a late
announcement makes a leaf say *less* — but `docs/HOST-HOOK.md` assumed a
sequence not every bridge can perform, and now says so.

And the second half of the same finding: **an unmodified bridge never calls
`bpy.ops.scruple.host_announce`.** In WO-E6 the caller was eleven lines of test
script standing in for a user's hand. In a shipped product that caller has to be
something — a Scruple panel button, an operator wrapper, a per-bridge
integration — and what it must **not** be is a patch to the bridge.

**Needs: a product decision.** This is the largest piece of unfinished product
design in the E series. `docs/WO-E6.md` finding **E6-1**.

## 5. Built but unproven

Things that exist in this repo and have no observable behind them yet:

- **`app/ipc-profile.js`'s host facts under a real user.** WO-D5 proves the
  dashboard renders the desktop shape from a real window and that inapplicable
  regions are absent. What is not proved is a human looking at it: there is no
  display on this box, and `docs/DESIGN.md` records that a screenshot under
  llvmpipe comes back blank, verified three ways. Nothing here has ever been
  gated on a pixel and nothing should be.
- **Store-and-forward under a witness that is actually down.** The queue exists
  and drains (`queueDepth: 0` on every run), and docs/DESIGN.md is explicit that
  it must not be deleted. A run against a stopped witness, asserting that the
  artifact is still delivered and the leaf arrives afterwards, has not been
  written.
- **Kohya.** `GET /api/v2/capabilities` reports it and nothing launches it.
- **Everything in `app-legacy/`.** Five IPC handler modules — lock, project,
  settings, training, wallet — are the seam the preload bridge will expose and
  none has been rewritten onto the SDK. `app-legacy/lock/merkle.js` is retired
  by WO-C6's cutover and should not be revived at all.
- **The Blender region under a human's eye** (WO-E5). It renders from a real
  window and `getComputedStyle` answers for it, and the same three readings were
  re-taken from the shell — but ⚑ **the announcement is not a measurement**: a
  host that announces a Blender it does not have gets its region drawn, and every
  reading in it says `none found` / `unread`. Finding E5-1.
- **The `at-the-gate` bridge reading, on one of the eleven.** WO-E5 proved it
  with `scripts/e5-stub-bridge` — a bridge-*shaped* add-on written here — and
  WO-E6 then ran a real one, but the *dashboard reading* was never re-taken
  against it. Detection is by SHAPE and will over- and under-report (E5-2, E5-3).
- **Every Blender measurement in this series is on an EMULATED CPU.**
  blender.org publishes no Linux ARM64 build and this box is `aarch64`, so the
  official `linux-x64` tarball runs under `qemu-user` against an amd64 sysroot.
  Blender reports its own version through that shim and the add-on loads through
  it. Finding **E3-2**, and it qualifies every Blender row above.
- **Whether `register()` should refuse a Blender below its own declared
  minimum.** WO-E3 measured that on the legacy path `bl_info`'s `"blender"` field
  is *advisory* — 3.0.1 enables an add-on built against an API three years newer
  and raises nothing — and WO-E6 measured the same thing happening to a third
  party's bridge (`bl_info` says 4.5.0; it ran on 4.2.23). Findings **E3-1** and
  **E6-2**. Nobody has decided what our `register()` should do about it.
- **Anything the add-on does beyond `render_write` / `render_complete` /
  `save_post`.** WO-E7 exercised those three. Export, the paid actions, the
  C2PA and chain-lock operators, the dashboard panel and the reconcile/settle
  path have unit tests in the add-on repo (330 passing) and no leaf in this
  sandbox behind them.
- **One bridge, one version, one workflow shape.** `BlenderOutputSaveImage` is
  the only output node WO-E6 exercised; the 3D/GLB and text output paths, the
  input nodes and `/upload/image` through the gate are all untouched. And the
  `/ws` went through the gate with nothing asserting what the gate did with it.

---

## 6. What needs a human before anything else

🔴 **The wallet.** 18 files under `app-legacy/wallet/` touching private keys,
mnemonics and WIF, plus `app-legacy/ipc/ipc-wallet-handlers.js`. docs/DESIGN.md
requires a security review **before** any of it is revived, and the reason is
worth restating: an Electron app holding spending keys is a different posture
from a gate holding a signing key, and it should not be inherited simply because
it was already in the box. Nothing in the D-series has touched it. Nothing
should, until that review happens.

Also for a human, in rough order of how cheap the fix is:

1. Enable H-1 leaf signing on the sandbox witness (§4.1) — five minutes, and it
   upgrades every leaf this flow makes.
2. ~~Decide on the cert/key mismatch guard (§4.3)~~ — done in WO-E1; see the
   note in §4.3.
3. Seed the `scruple.c2pa.sign` stream where its ingest actually runs (§4.5).
4. **Bind the add-on's Settings UI on the path it ships on** (§4.8) — one line
   in `/data/scruple-blender`, plus the probe as its control. It is the cheapest
   item on this list and the one a user notices first, because today a 4.2+ user
   has no field to paste a key into.
5. ⚑ **Apply migration 059 to the scratch app database before any gate runs.**
   Finding **E4-0**: it was one migration behind, every leaf submission answered
   500, and WO-D6's gate had been silently red for over an hour. **Nothing in
   any gate applies migrations**, and nothing in the E series changed that.
6. Fix the worker that drops queued captures at shutdown (§4.9) — small, but
   the "how long may Blender block on quit" half is a product call.

For the founder:

1. The Merkle construction disagreement that pins every leaf at `stale` (§4.2).
2. What a lock tier means under the v2 door, and how a desktop project earns an
   SCR-ID (§4.4).
3. The real trust anchor — an OCI Vault key and a certificate chain — without
   which every credential this product issues reads
   `signingCredential.untrusted`, correctly.
4. ⚑ **What the standalone add-on's leaf should say about what it did not
   see** (§4.7). This is the E-series' own headline finding and the one
   `docs/BLENDER.md` names as the row to get right. It is a change to the
   server's leaf, so it is not the add-on's to take.
5. **Who calls `host_announce` in a shipped product** (§4.11), given that an
   unmodified bridge never will and cannot always know its prompt id in time.
6. **Whether a host's RESOLVED placement belongs on the leaf.** `HOST-HOOK.md`
   limit 2 names it as "the next thing to close": a verifier holding a leaf sees
   `host` and `host_adapter` and has to look the host up to learn that neither
   was enforced. WO-E4 finding **E4-6** measured the consequence — `blender`
   (honest) and `phantom-cam` (degraded) produce indistinguishable leaves.
7. **Whether `register()` should refuse a Blender below its declared minimum**
   (E3-1), now that the same permissiveness has been observed on a third
   party's add-on (E6-2).

---

## 7. The suites, as of this writing

Desktop, `npm run gate`: D1 ✅ D2 ✅ D3 ✅ D4 ✅ D5 ✅ D6 ✅ D7 ✅ — every gate
with its own controls firing.

Server (`/data/scruple-web`), unchanged by this work order and run to prove it:

| suite | result |
|---|---|
| `npm run test:v2` | **863 pass, 0 fail** |
| `npm run test:conformance` | **47 pass, 0 fail** |
| `npm run test:integration` | **19 pass, 0 fail** |
| `npm run test:sdk` | 214 pass, **2 fail** — `test_model_write.py`, pre-existing and recorded by WO-D6 before this work order began |

⚑ WO-D7 changed **no server code**. The only thing it changed about the server
is how the sandbox app on `:3902` is *launched* — three environment variables
so it signs through the surrogate (§4.3) — and `scripts/d7-app-signing.sh`
re-applies that, and proves it by signing.

**After the E series** (2026-09-09). The E gates are separate commands and are
deliberately **not** in `npm run gate`: each of them launches a Blender under
`qemu-user` and one of them launches ComfyUI, so chaining them onto the D chain
would make the fast gate slow enough not to be run.

| gate | command | result |
|---|---|---|
| WO-E3 | `npm run e3` | ✅ with ⚑ one control **NOT UPHELD** and scored as a failure — see the E3 row in §1 |
| WO-E4 | `npm run e4` | ✅ 9 stages |
| WO-E5 | `npm run e5` | ✅ 10 stages, 34 shell checks, 39 scenario assertions, 10 mutations |
| WO-E6 | `npm run e6` | ✅ 10 stages, 27 shell checks, 33 scenario assertions ×3 clean runs, 5 mutations |
| WO-E7 | `npm run e7` | ✅ 13 stages, 58 shell checks ok / 0 FAIL / 0 inconclusive; inside it a 105-column three-way leaf comparison at 98 ok / 0 FAIL, and its self-control reddening 33 |

Server suites after WO-E1 and WO-E2 (both of which **did** change server code):

| suite | result |
|---|---|
| `npm run test:v2` | **912 pass, 0 fail** (was 863; +49 from WO-E2) |
| `npm run test:conformance` | **47 pass, 0 fail** |
| `npm run test:integration` | **19 pass, 0 fail** |
| `services/c2pa-signer` | **134 pass** (118 before WO-E1, +16 new) |
| `npm run test:sdk` | 214 pass, **2 fail** — the same pre-existing `test_model_write.py` pair, recorded at every head in this series |

Add-on (`/data/scruple-blender`): **330 passed** — 306 on arrival with 2
failures, 308 after re-vendoring the SDK (closing E3-4), 330 with WO-E4's 22 new
tests. WO-E5, WO-E6 and WO-E7 changed nothing in that repo and each re-ran it to
say so rather than to assume it.

⚑ **What was NOT re-run**, named rather than implied: WO-D5's own audit sweep
and `npm run gate` have not been re-run since WO-E5 said so.

---

## 8. How to re-establish all of this from scratch

```bash
cd /mnt/corpus/scruple-desktop
npm install                       # electron 38.8.6
npm run gate                      # WO-D1 … WO-D7, each with its controls
bash scripts/d7-gate.sh           # the whole flow on its own, and the D7 controls

# The E series. Two one-time installs first, both of which pin a digest:
npm run e3:install                # Blender 4.2.23 LTS into vendor/blender/
npm run e6:install                # alexisrolland/ComfyUI-Blender v3.3.4
npm run e3 && npm run e4 && npm run e5 && npm run e6 && npm run e7
```

🔴 **Apply the server's migrations to the scratch app database first.** Finding
E4-0: nothing in any gate does it, and a database one migration behind makes
every leaf submission answer 500 while the gate that found it was the one that
happened to look.

`scripts/d7-gate.sh` restarts the sandbox app on `:3902` if it is not already
signing through the surrogate, and it proves that by SIGNING rather than by
reading an environment variable. It leaves the surrogate running.


---

## 9. The E series, finding by finding

_Added by WO-E7, 2026-09-09. Every finding the E-series recorded, where it was
measured, and who owns it. **"The gate passed" and "here is what the gate does
not cover" are different sentences** and are in different columns._

**Owner** is one of: `closed` (fixed, with a control), `desktop` / `server` /
`addon` (a work order in that repo), `human` (§6's first list), `founder` (§6's
second list), `property` (a fact about the world, not a defect).

| id | what was measured | where | owner |
|---|---|---|---|
| **E1** | The C2PA signer embedded a certificate for a key that did not sign, and the route answered `ok: true`. **CLOSED at the source**: `vault_sign.assert_certificate_matches_signing_key()`, code `certificate_key_mismatch`, no override. Demonstrated RED first, at the parent, in a worktree. | `WO-E1.md`, §4.3 | `closed` |
| E1-a | It does **not** eliminate `claimSignature.mismatch`: c2pa-rs emits the same code for a leaf DN missing C/ST/L/O/OU/CN. The guard proves the certificate carries the signing key, not that c2pa-rs will accept it. | `WO-E1.md` | `server` |
| E1-b | Real OCI `vault` mode is unexercised — same callback, so inference from shared code, not a measurement. Needs a box with instance-principal credentials. | `WO-E1.md` | `human` |
| E1-c | ⚑ Found on the way: the gate's "no output asset" probe searched the **gate shell's** TMPDIR, not the app's, so its zero meant nothing. Now read from the captured app environment and **calibrated** in a stage where an asset certainly is written. An uncalibrated control is not a control. | `WO-E1.md` | `closed` |
| **E2** | `declared_uncaptured` — the absence set, carrying the scope it enumerated over and the method it used. The scope rule was **settled in writing first**, in its own commit, before any implementation. | `WO-E2.md` | `closed` |
| E2-a | ⚑ `uncaptured_scope_source` is `unknown` on **every** leaf and stays so: closure needs an independent observer of the history window and none exists. The blocker is a named constant and both branches are driven by tests. | `WO-E2.md` | `server` |
| E2-b | `complete` is closure over what `/history` **reported**, never over what the machine wrote. Every member of the set carries `transaction: "none"` so nobody can read delivery-completeness as artifact-completeness. | `WO-E2.md` | `property` |
| E2-c | The captured-set ledger is **process state**: it does not survive a component restart, so the first leaves after one may name artifacts an earlier process did capture. Bounded at 4096, eviction disclosed, lifetime not. | `WO-E2.md` | `server` |
| E2-d | ⚑ Found by its own mutation sweep: MUTANT 5 **survived**. A documented, implemented behaviour was **not asserted**. Fixed with a test, not a code change. | `WO-E2.md` | `closed` |
| E2-e | One unreproduced `watermark-chain.test.ts` flake, in a file WO-E2 does not touch. Seven clean full runs after. **Not diagnosed**, recorded because "I could not reproduce it" is a different sentence from "it did not happen". | `WO-E2.md` | `server` |
| **E3-1** | On the **legacy** install path a Blender add-on's declared minimum is **advisory**: 3.0.1 installs and enables an add-on whose `bl_info` says 3.6.0, `enable()` raises nothing, all six panels register. The floor that *is* enforced is `blender_manifest.toml`'s, and only on 4.2+. | `WO-E3.md`, `BLENDER.md` | `founder` |
| **E3-2** | ⚑ blender.org publishes **no Linux ARM64 build** and this box is `aarch64`. Every Blender measurement in the series is taken on an emulated CPU under `qemu-user`. | `WO-E3.md`, §5 | `property` |
| E3-3 | The extension CLI exits **0 on a refused install**. The exit code is not the observable; the directory on disk and the module name the running Blender reports are. | `WO-E3.md` | `property` |
| E3-4 | The shipped zip carried a stale vendored SDK. **Closed** by re-vendoring at web `634c66e` during WO-E4; the add-on suite went 308 → 330. | `WO-E3.md`, `WO-E4.md` | `closed` |
| E3-x | ⚑ The work order's control *"the same zip against 3.0.1 must fail to enable"* **DOES NOT HOLD**, and E3 scores it as a failure rather than narrowing the work order to what succeeded. | `WO-E3.md` | `founder` |
| **E4-0** | ⚑ The scratch app database was **one migration behind** the server tree; every leaf submission answered 500 and WO-D6's gate had been silently red for over an hour. **Nothing in any gate applies migrations**, and nothing since has changed that. | `WO-E4.md`, §6 | `human` |
| **E4-2** | `hostAdapterSink`'s schema check is **presence-only in both languages** (`k not in evidence`), so a required field present and NULL is accepted, hashed and put in the MAC — a leaf reading `supplied` with a null camera. NOT patched: the add-on refuses to emit such a document instead. The next host to register hits this with nothing in between. | `WO-E4.md` | `server` |
| E4-3 | The Python mirror needs enum members where the TypeScript takes strings. | `WO-E4.md` | `closed` |
| E4-4 | `adapter/scene.py` reported **Cycles' sample count for EEVEE renders** — `scene.cycles` exists on every scene whatever the engine is, so a default 4.2 scene announced `samples: 4096`. Fixed at the source. | `WO-E4.md` | `closed` |
| E4-5 | The announcement is bound to the artifact by the `prompt_id` **and by nothing else**. No cross-check exists that the announced scene is the scene anything was made from. | `WO-E4.md`, `HOST-HOOK.md` | `property` |
| **E4-6** | Two hosts with different declarations still produce **indistinguishable leaves**: the host's *resolved* placement is computed at registration and is not on the leaf. `HOST-HOOK.md` limit 2 names this as the next thing to close. | `WO-E4.md`, §6 | `founder` |
| **E5-1** | ⚑ The host's `x-scruple-host-apps` announcement is trusted for the **shape** and is not a measurement. A host that announces a Blender it does not have gets its region drawn — and every reading in it says `none found` / `unread`. | `WO-E5.md`, §5 | `property` |
| **E5-2** | `at-the-gate` was proved with `scripts/e5-stub-bridge`, a bridge-**shaped** add-on written here, not one of the eleven. WO-E6 then ran a real one; the *dashboard reading* was never re-taken against it. | `WO-E5.md`, §5 | `desktop` |
| E5-3 | Bridge detection is by **shape**, so it will over- and under-report. | `WO-E5.md` | `desktop` |
| E5-4 | The reading is dated by the gate it was taken against. | `WO-E5.md` | `property` |
| E5-5 | Every dashboard render on a box with Blender **starts a headless Blender**. | `WO-E5.md` | `desktop` |
| E5-6 | `/usr/bin/blender` 3.0.1 is findable and is deliberately not what this app uses. | `WO-E5.md` | `property` |
| E5-x | ⚑ The gate caught its own documentation — and then editing the gate **while bash was running it** shifted the script under bash's byte offsets and corrupted its own transcript. The unedited first run is kept as `.run/e5/gate-run1-selfcorrupted.txt`. **It happened again in WO-E7**, the same way, and that run is kept too. | `WO-E5.md`, `WO-E7.md` | `property` |
| **E6-1** | ⚑ `alexisrolland/ComfyUI-Blender` sends **no `prompt_id`** — ComfyUI mints one and the bridge learns it from the response — so a Level-2 announcement **cannot precede the submission**. Measured margin 1.8 s on the smallest generation that can exist. And an unmodified bridge never calls `host_announce` at all. | `WO-E6.md`, §4.11 | `founder` |
| **E6-2** | The bridge declares `bl_info blender=(4,5,0)` and ran on 4.2.23 anyway — E3-1 observed on a **third party's** add-on, which makes it a property of Blender rather than of our packaging. | `WO-E6.md` | `founder` |
| E6-3 | `--factory-startup` + `save_userpref()` silently **un-enables everything else** in a profile. Found by failing; fixed at the call site with the reason. | `WO-E6.md` | `closed` |
| E6-4 | One generation, **two leaves** — the `/view` response and the file the watcher found — and both carry all three halves. Not double counting; the two-surface claim being true. | `WO-E6.md` | `property` |
| **E6-5** | ⚑ The work order predicted the bypassed leaf reads `blind`. **Measured: `declined`, and it still names the host** — because the add-on IS registered, unlike WO-D4 where `blind` was right. The declared mutation set was corrected **to the measurement**, with the reason in the scenario's own `auditNote`. | `WO-E6.md`, `BLENDER.md` | `closed` |
| **E7-1** | ⚑ **The headline finding of the series.** The standalone add-on's leaf does not declare what it did not observe: `host_semantics` is NULL rather than `blind`, and `workflow_hash` is non-null and indistinguishable from a ComfyUI graph's. Measured by rendering the *same scene* around two *different* AI outputs and finding every provenance-bearing field invariant. | `WO-E7.md`, §4.7 | `founder` |
| **E7-2** | The add-on's own Settings UI **does not bind on the path it ships on**: `bl_idname` is the legacy module name, so on the manifest path `addons[module].preferences` is None and `get_base_url()` falls back to production. Measured with a control — same zip, same Blender, both paths. | `WO-E7.md`, §4.8 | `human` |
| **E7-3** | `WitnessWorker.stop()` **drops queued captures**, and they never reached the SDK's on-disk spool either. Measured on the real class. | `WO-E7.md`, §4.9 | `addon` |
| E7-4 | One still render lands **two leaves with two different graphs** — `render_write` (which carries the frame) and `render_complete` (which does not) both witness the same file. | `WO-E7.md` | `addon` |
| E7-5 | The two products emit **different leaf schemes**: `v2.2` from the add-on, `v2` from the component. Not two differently-populated leaves — two differently *constructed* ones. | `WO-E7.md`, §4.10 | `founder` |
| E7-6 | `machine_manifest_hash` is set by the add-on and **NULL** from the desktop component: on that one column the standalone product records more. | `WO-E7.md`, §4.10 | `founder` |
| E7-7 | The add-on's live modules are **top-level** (`adapter.handlers`), not attributes of the extension package. Importing the dotted name loads a second copy with a worker that was never started — a run that had witnessed perfectly well reports as empty. Cost this work order one confusing hour. | `WO-E7.md` | `property` |

### What the E series did NOT touch

- 🔴 `/opt/scruple-witness`, `127.0.0.1:5799` and `:3001`. Not contacted, not modified.
- 🔴 `CHECKPOINT_VECTORS_SETTLED`. Not flipped. Every leaf in this series reads
  `attestation_basis: stale`, asserted positively, and `verified` stays
  unrepresentable on the desktop profile by construction (migration 053).
- `app/comfy/` and `lib/capture/` are **byte-identical to WO-E4's commit**
  through E5, E6 and E7. `HOST-HOOK.md` says "there is no step 4"; a real
  third-party bridge arriving needed no step 4, and neither did comparing three
  products.
- The wallet. Nothing in `app-legacy/wallet/` was read, run or changed.
