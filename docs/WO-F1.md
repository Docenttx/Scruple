# WO-F1 — the add-on's Settings UI binds on the path it ships on

_2026-09-10. `docs/STATE.md` §4.8 / `docs/WO-E7.md` finding **E7-2**._

**Gate: PASS.** 42 checks, 0 failures, 0 inconclusive — `npm run f1`,
transcript `.run/f1/gate-4.txt`.

**⚑ The travel laptop is unblocked.** It was holding the add-on uninstalled
because there was nowhere to put an API key or a base URL on the shipping
install path. There is now: the shipped zip installed through
`blender_manifest.toml` binds `ScrupleAddonPreferences`, exposes the API key,
base URL and verbose-logging fields, and a URL typed into the field is what
`get_base_url()` returns. Rebuild the zip from `/data/scruple-blender`
`29962b8` (`build/build_addon.sh`) and reinstall.

Changed: `/data/scruple-blender` `29962b8`. Desktop repo carries the gate, the
two probes and this report.

---

## What was wrong, in one sentence each

**`bl_idname` was a guess about the install path.** `bpy.types.AddonPreferences`
is matched to an add-on by `bl_idname == the module name Blender enabled it
under`, and that name is decided by how it was installed —
`scruple_blender` on the legacy `scripts/addons/` path,
`bl_ext.user_default.scruple_blender` through the manifest. The class carried
the first literal, so on the path every 4.2+ user gets, Blender bound nothing
and `addons[module].preferences` was `None`.

**`get_base_url()` filled the resulting blank with production.** With no
preferences object there was no value, so the lookup fell through to the SDK's
`DEFAULT_BASE_URL` — `https://scruple.ai`. An add-on nobody could configure
pointed at the live service, and neither the user nor a log line ever said so.

They are one defect from two ends: **a setting nobody can reach, and a default
nobody chose.**

## The fix

`adapter/preferences.addon_module_name()` resolves the module name; `register()`
binds `bl_idname` to the answer immediately before `register_class`.

⚑ **Not `__package__`, which is what STATE.md §4.8 and WO-E7 both predicted.**
The add-on's `__init__.py` puts its own directory on `sys.path` and then does
`from adapter import preferences`, so every module in the package is imported
**top-level**: `__package__` inside `adapter/preferences.py` is the literal
`"adapter"` on *both* install paths and would have answered neither question.
What does differ between the paths is the name the add-on's own `__init__.py` is
registered under in `sys.modules`, and that is exactly the name Blender enabled.
So the resolution walks `sys.modules` for the module whose `__file__` is the
add-on's own `__init__.py`. It runs at `register()` time, not import time, so it
does not depend on which module imported which first.

`get_base_url()` returns `""` when nobody has configured anything. The
`base_url` property's own default moves to `""` for the same reason — binding
the UI with `default=DEFAULT_BASE_URL` would have re-introduced the fallback
through the very field that was supposed to remove it. Four callers that would
otherwise have built a URL out of nothing now refuse with one shared message:
`adapter/sdk.get_client()` (no session client), `scruple.sign_in` (no browser
opened), `scruple.setup_payment`, `scruple.open_receipt`.

**Production is still one paste away.** Refusing a *default* is not refusing the
*value*: a user who types `https://scruple.ai` gets `https://scruple.ai`, and
`docs/install-quickstart.md` gained a step that tells them to. What is gone is
the version where nobody said it and it happened anyway.

## The gate and its controls

`scripts/f1-gate.sh` (`npm run f1`). Red-before is not a description of the old
behaviour — it **rebuilds the old zip**: the parent of the add-on's WO-F1
commit (`47bc3d6`) is checked out into a worktree, packaged with the add-on's
own `build/build_addon.sh`, installed and probed through both paths, and only
then is the new one. Both trees are installed at **the same absolute profile
path**, one after the other; see finding F1-1 for why that is not fussiness.

| | before (`47bc3d6`) | after (`29962b8`) |
|---|---|---|
| module Blender enables | `bl_ext.user_default.scruple_blender` | same |
| `bl_idname` | `scruple_blender` | `bl_ext.user_default.scruple_blender` |
| `.preferences` bound | **False** | **True** (`ScrupleAddonPreferences`) |
| API key field | absent | present |
| base URL field | absent | present |
| verbose toggle | absent | present |
| `get_base_url()` unconfigured | **`https://scruple.ai`** | **`""`** |
| key cached, no base URL | Client built, at `https://scruple.ai` | **no client** |
| legacy path bound | True | True |

**THE GATE** — a URL set in the field is what the adapter returns:
`http://127.0.0.1:3902` in, `http://127.0.0.1:3902` out, and the same for the
API key. The sandbox URL is a **string typed into a field and read back**; the
probe never dials it.

**Control (a) — the production fallback is gone.** Same probe, both trees. Red:
an unconfigured call yielded `https://scruple.ai`, and a cached key with no base
URL still built a session Client pointed at it. Green: the call yields `""` and
no client is built at all. Asserted as the work order words it — `scruple.ai` is
not what an unconfigured call yields — and also positively, because *empty* and
*production* are the two answers that matter and `""` is the one that means
"nobody said".

**Control (b) — the legacy path still binds.** Not traded away: the same zip
unzipped into `scripts/addons/` binds under `scruple_blender`, round-trips its
field, and does not fall back to production either. This control is what makes
the fix a resolution rather than a swap of one hardcoded string for another.

**Control (c) — the add-on's suite.** 330 → **346, green**. 16 added, 1
replaced: `test_get_base_url_falls_back_to_default` asserted the behaviour that
is now the defect. WO-E7 noted that all 330 tests missed this because they
exercised `ScrupleAddonPreferences` as a class rather than as a class Blender
bound to a module; the new ones do the latter, by putting a stand-in for the
add-on's root module into `sys.modules` under each install path's name.

## The baselines that moved, and why each move is expected

Every one of these moves because **the add-on's bytes changed**, which by D-3 is
the definition of a different integration. That is the intended consequence, not
a side effect to be worked around.

| baseline | before | after | why |
|---|---|---|---|
| tamper surface hash (bare) | `673ebe16db75e3c8…` | `96008cb55e8c6939…` | `adapter/preferences.py` and four callers are different bytes |
| tamper surface hash (as `attach()` computes it, config folded in) | `921dc862e1c2e8ff…` | `6f73c0269dc013ae…` | the number a baseline is actually keyed by |
| `adapter/preferences.py` inside the zip | `4e9dede76712fb0e…` | `b31986ca1cb60a80…` | the file that changed |
| add-on leaf `baseline_hash` (WO-E7 §"the three leaves", row `baseline_hash`) | `22e97c93c1d8…` | **did not move** | ⚑ finding F1-2 below |
| `docs/WO-E7.md` table row `baseline_hash` | `22e97c93c1d8…` | superseded — see F1-1 and F1-2 before reusing the number |

⚑ **The shipped zip's digest is NOT in that table on purpose.** It moved, but it
moves anyway: `build/build_addon.sh` writes mtimes into the archive, so two
builds of one tree disagree — measured, across three consecutive runs of this
gate the *before* zip hashed `53d89bde…`, `1ec38310…` and `ab593f19…`. A check
that passes whether or not the code changed is not evidence, so the gate scores
the file **inside** the zip instead and prints the archive digests as
information.

## ⚑ The re-record, and the two findings it turned up

The work order asks for the moved baselines to be re-recorded deliberately, so
the gate lands a **real leaf**: the add-on on the manifest path, pointed at the
scratch app by **setting its preferences fields and nothing else**, saving a
`.blend`, and letting its own `save_post` handler witness it. Nothing in
`scripts/f1-addon-baseline.py` calls a `witness_*` function. It is a stronger
statement than the gate's own round-trip, because WO-E7 had to write the SDK's
on-disk auth cache to get the add-on online at all — the gate asserts
`auth_cache_present == False`, so a leaf arriving is a side effect of the fix.

Leaf **799**, `witnessed`, content `c6d81207…`. And then:

```
code running now   6f73c0269dc013ae912123dbcfff649b6f3fefee1a7f998321bf23f34fb82915
leaf 's baseline   22e97c93c1d8176d950358c49a5726bfee0c824f795c158f6560de0c49138a91
E7 recorded        22e97c93c1d8176d950358c49a5726bfee0c824f795c158f6560de0c49138a91
```

### ⚑ F1-2 — a leaf can carry a baseline that describes different bytes

The add-on's code changed, the SDK noticed, and the leaf went out under the old
code's baseline anyway.

`Client.attach()` (`scruple_host_sdk/client.py:114`) computes the surface hash of
the code running now, then `GET /api/v2/baseline/current`; **when the tenant
already has an active baseline it adopts the server's ref whatever the local
hash is**, sets `drifted=True`, and returns. `flow.ensure_attached()` logs
`baseline drift: server=… local=…`, puts *"Baseline drift: this build's tamper
surface does not match the baseline the server has on file"* on the panel's error
surface — and carries on witnessing. `rebaseline()` exists in the SDK and
nothing in the add-on calls it.

So `iterations.baseline_hash` on an add-on leaf answers **"what did this tenant
first attach with"**, not "what code produced this". 21 leaves now sit under
`22e97c93…`, one of which was produced by code that hashes to `6f73c026…`.

The honest half is real and worth keeping: the drift **is** detected and it
**is** reported in two places. What is missing is that nothing downstream can
see it — the leaf carries no drift flag, and a verifier reading
`baseline_hash` gets a confident wrong answer rather than a refusal.

**The gate pins this as a defect**, the way WO-E7 pinned E7-2: three checks
assert the stale baseline, the detected drift, and the growing count, so they go
**red when somebody fixes it**. Not fixed here — it is the SDK's attach path, it
affects every host and not just Blender, and "may a client re-baseline itself
mid-session, or must a human approve the new bytes" is a product question with a
`prev_baseline_hash` chain and an anchoring story behind it. **Needs a work
order.**

### ⚑ F1-1 — the surface hash measures the install DIRECTORY as well as the code

`compute_tamper_surface_hash()` keys its file map by absolute path
(`files[str(f)] = sha256_file(str(f))`), so identical bytes in two directories
hash differently. `python3 scripts/f1-surface-path-proof.py`, with `diff -r` as
its control:

```
installed_at   .run/e7/blender-profile/extensions/user_default/scruple_blender
installed_hash 22e97c93c1d8176d950358c49a5726bfee0c824f795c158f6560de0c49138a91
copied_to      (a byte-identical copy, elsewhere)
copied_hash    d5c97ea51e34f5077cb0c30b2542ebde4beb1e4fb8aa71d8d31b3ee7ef11905d
bytes_identical true
verdict        PATH-SENSITIVE: identical bytes, two directories, two baselines
```

⚑ The first hash is exactly the `baselines` row for tenant
`blender-addon-standalone`, which is what confirms the column's identity.

Two users running the identical published zip therefore can never share a
baseline, and one user moving their Blender profile "drifts" without changing a
byte. It also means **no number in this report is comparable to a number
measured at a different install path** — which is why the gate installs both
trees at one path, and why `22e97c93…` cannot be diffed against `673ebe16…`
even though both describe the same old code.

Not WO-F1's doing and not fixed here. It surfaced because this is the first
change to move the add-on's surface hash, which forced the question of what the
number measures. **Needs a work order**, probably a one-line normalisation to
paths relative to the integration root — but it invalidates every baseline in
the estate on the day it lands, so it is not a change to smuggle in.

## What this does NOT do

- It does not make the add-on's leaves say anything new about provenance. That
  is WO-F3.
- It does not stop `WitnessWorker.stop()` dropping queued captures. That is
  WO-F2, and `scripts/f1-addon-baseline.py` waits for quiescence rather than
  calling `stop()` for exactly that reason.
- It does not fix F1-1 or F1-2, both recorded above with reproductions.
- It does not change the SDK. `scruple_host_sdk` is vendored into the add-on and
  `DEFAULT_BASE_URL` is still `https://scruple.ai`; the adapter simply stops
  reaching for it. Changing the SDK's default would have moved a value every
  other host depends on, under a Blender work order.

## Housekeeping done here, and one thing that was not

**`scripts/e7-gate.sh` stage 1B was flipped to assert the closure.** Four checks
in WO-E7's gate asserted the defect — including *"the base URL falls back to
production"*, which would have made the estate's own suite require that to stay
true. They now assert the bound state, with a comment naming this work order.
Verified with WO-E7's own probe against fresh profiles on both paths
(`.run/f1/e7check/prefs-{manifest,legacy}.json`: bound `true`, key settable
`true`, unconfigured base URL `""`). ⚑ **The E7 gate was not re-run end to end** —
it renders in Cycles under qemu and takes hours — so only stage 1B is covered by
that verification.

The same edit gave both E7 profiles a **zip-digest stamp**, so they are rebuilt
when the shipped zip changes rather than only when missing. Without it a gate run
after any add-on change silently measures the previous build, which is how a gate
ends up green about code nobody is shipping.

**One correction to the F-series briefing:** it says `docs/FINDINGS.md` carries
E7-1..E7-7 in full. It does not — that file stops at D5-7. The E7 findings are in
`docs/WO-E7.md` and `docs/STATE.md` §4.7–§4.10.

## Files

| repo | file | what |
|---|---|---|
| add-on | `adapter/preferences.py` | `addon_module_name()`, `bl_idname` bound at register, no production fallback, `is_configured()`, `NO_BASE_URL_MESSAGE`, the panel's "no base URL set" line |
| add-on | `adapter/sdk.py` | no base URL → no session client |
| add-on | `operators/{auth,payment_setup,open_receipt}.py` | refuse instead of building a URL out of nothing |
| add-on | `tests/test_preferences.py`, `tests/test_operators.py` | +16 / −1 |
| add-on | `docs/install-quickstart.md` | a step that names the server |
| desktop | `scripts/f1-gate.sh` | the gate, 7 stages |
| desktop | `scripts/f1-prefs-probe.py` | both install paths, inside Blender |
| desktop | `scripts/f1-addon-baseline.py` | the re-record: a real leaf, configured through the field |
| desktop | `scripts/f1-surface-path-proof.py` | finding F1-1, with its control |
| desktop | `scripts/e7-gate.sh` | stage 1B flipped to the closure; zip-digest stamps |
| desktop | `docs/STATE.md` | §4.8 marked closed |

## Re-running

```bash
cd /mnt/corpus/scruple-desktop
npm run f1                                   # the gate — rebuilds the old zip and shows it red
python3 scripts/f1-surface-path-proof.py     # finding F1-1
cd /data/scruple-blender && python3 -m pytest -q   # 346
```

Blender 4.2.23 LTS at `vendor/blender/bin/blender`. Stages 0–5 and 7 contact
nothing; stage 6 talks to the scratch app on `:3902` and the scratch witness on
`:5899` and nowhere else.
