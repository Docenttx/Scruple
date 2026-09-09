# WO-E3 — A Blender that can load the addon we actually ship

_2026-09-09. Desktop repo. Gate: `bash scripts/e3-gate.sh` (`npm run e3`);
install: `bash scripts/e3-install-blender.sh` (`npm run e3:install`)._

## Verdict

**NOT PASSED, and the failing half is a finding rather than a mishap.**

| what the work order asked for | outcome |
|---|---|
| Blender 4.2 LTS or newer in this repo's tree, not over the system one | **PASS** — 4.2.23 LTS at `vendor/blender/bin/blender`; `/usr/bin/blender` still 3.0.1 |
| the shipped zip installs and enables **through the manifest path**, headless | **PASS** |
| `blender --background --python-expr` reports enabled, panels, version, read out of the running Blender | **PASS** |
| control: a deliberately corrupted manifest is **refused**, never a silent `bl_info` fallback | **PASS**, three ways |
| control: the same zip against 3.0.1 **fails to enable** | ⚑ **NOT UPHELD.** 3.0.1 enables it. |

The gate exits non-zero. It is deliberately **not** chained into `npm run gate`:
a link that is red by design would redden D1–D7 for everyone. `npm run e3` runs
it on its own.

---

## What is installed, and the thing that made it awkward

`scripts/e3-install-blender.sh` puts **Blender 4.2.23 LTS** — the newest patch
of the 4.2 LTS series, the series `blender_manifest.toml` floors at — under
`vendor/blender/`, gitignored, ~1.5 GB. The script is idempotent, pins the
published sha256 of the tarball, and refuses to extract on a digest mismatch.
`/usr/bin/blender` is untouched: other work may depend on it, and stage 5 needs
it to stay 3.0.1 to be a control at all.

### ⚑ Finding E3-2 — blender.org publishes no Linux ARM64 build, and this box is aarch64

`uname -m` is `aarch64`. Checked on 2026-09-09, the release directories for
**4.2, 4.3, 4.4 and 4.5** each carry exactly one Linux archive,
`blender-<v>-linux-x64.tar.xz`, and nothing else. Ubuntu jammy's arm64 archive
offers `3.0.1+dfsg-7` and no more. There is no `snap` for it here either. So
there was no way to satisfy "install 4.2 LTS or newer" natively.

What is installed is the **official linux-x64 tarball, unmodified and
digest-checked**, run under `qemu-user` against an amd64 sysroot built in the
same tree from `ubuntu-base-22.04.5-base-amd64.tar.gz` plus the twenty-odd
libraries `readelf -d blender` asks the system for. `vendor/blender/bin/blender`
is the one entry point; on an x86_64 host the same script writes a launcher that
`exec`s the binary directly and builds no sysroot.

Three things were needed to make that work and each is a real property, not a
patch to Blender:

1. `QEMU_CPU=max`. Blender's own `libblender_cpu_check` refuses a CPU without
   SSE4.2, and qemu's default `qemu64` model does not advertise it. This changes
   what the guest is **told**; it does not change Blender.
2. `QEMU_LD_PREFIX` rather than `-L`. **Blender's extension system re-execs
   itself** — `--command extension install-file` runs
   `scripts/addons_core/bl_pkg/cli/blender_ext.py` under the bundled
   `python3.11`, which the kernel hands to the `binfmt_misc` handler and not to
   our launcher. With the flag form the child dies on `Could not open
   /lib64/ld-linux-x86-64.so.2` and the install reports *"Package should have
   been installed but not found"* while exiting 0. The two `QEMU_*` variables
   are inherited, so the child gets the same sysroot and CPU.
3. The sysroot's `/lib64/ld-linux-x86-64.so.2` had to be made **relative**.
   Ubuntu's usrmerge makes `/lib64` a symlink to `usr/lib64`, and the stock
   absolute link resolves against the *host* root under qemu's prefix, so the
   ELF interpreter is simply not found.

**What this costs the E series:** every Blender measurement from here on is
taken on an emulated CPU. Enabling an addon, registering classes and reading a
manifest are all CPU-agnostic, so E3's claims are unaffected. Anything in E6
that depends on render output, float determinism or timing is **not** something
this box can settle. Say so there rather than here.

Cost measured: ~16 s per `--background` invocation, ~40 s per install. The whole
gate is about eight Blender launches.

---

## The gate

`bash scripts/e3-gate.sh`, whole transcript in `.run/e3/gate-final.txt`.

Everything asserted is a JSON field returned by `bpy` **inside the running
Blender**, or a path on disk. Nothing reads a pixel; nothing reads a log line
for its verdict. The install happens in one process and every assertion is made
by a **different, later process** that had to load the addon from saved
preferences to answer at all.

```
$ blender --command extension install-file -r user_default -e <zip>
   STATUS Installed "scruple_blender"

   the work order's literal form, --python-expr, in a SEPARATE process:
   E3_EXPR module=bl_ext.user_default.scruple_blender version=0.1.0 min=4.2.0 panels=6

   the running Blender's version                  [4, 2]                                ok
   the module, as Blender names it   "bl_ext.user_default.scruple_blender"               ok
   ...which means the MANIFEST path               true                                  ok
   installed in the extensions repo               "user_default"                        ok
   blender_manifest.toml is beside it             true                                  ok
   NOT in scripts/addons (the bl_info path)       false                                 ok
   the floor Blender read                         [4, 2, 0]                             ok
   the description Blender read   "Provenance, C2PA, and chain-lock for Blender"         ok
   the addon version                              [0, 1, 0]                             ok
   panels registered      SCRUPLE_PT_{edits,locks,main,projects,receipt,tracker}         ok
   operators registered: 19
```

### How "the manifest path" is told apart from "the bl_info path"

This is the part worth reading, because "it enabled" alone does not distinguish
them. Four independent discriminators agree, and the shipped zip is not
modified to produce any of them:

| | manifest path (4.2.23) | `bl_info` path (3.0.1) |
|---|---|---|
| module name | `bl_ext.user_default.scruple_blender` | `scruple_blender` |
| unpacked under | `extensions/user_default/` | `scripts/addons/` |
| reported floor | `(4, 2, 0)` ← `blender_version_min` | `(3, 6, 0)` ← `bl_info["blender"]` |
| reported description | `"…chain-lock for Blender"` ← manifest `tagline` | `"…for Blender renders, saves, and exports."` ← `bl_info["description"]` |

The last two are the decisive ones. The two files **disagree** about both
fields, so whichever value comes back names the file Blender actually read. The
addon ships both on purpose (`__init__.py`: *"On 4.2+ the manifest wins and this
dict is ignored"*) — this is that sentence, measured.

### Vacuity control

Stage 1 runs the same probe against a 4.2 profile with nothing installed:
`matched_module=None`, `loaded_via_manifest=False`, `panels=0`. The gate's
observable can come back red, so its green means something.

---

## The controls

### ✅ A corrupted manifest is refused, and does not fall back to `bl_info`

Three variants, each derived from the shipped zip with **one file changed** and
`bl_info` left intact, so a fallback would be visible as a legacy install:

| variant | what Blender said | in extensions repo | in `scripts/addons` | enabled |
|---|---|---|---|---|
| unparseable TOML | `Failed to load manifest … Expected '=' after a key in a key/value pair` | 0 | 0 | `null` |
| valid TOML, `id` removed | `Failed to load manifest from: missing "id"` | 0 | 0 | `null` |
| `blender_version_min = "4.9.0"` | `This Blender version (4.2.23) doesn't meet the minimum supported version (4.9.0)` | 0 | 0 | `null` |

The first two are two different readers — a TOML parser and a schema check —
and the third is the version gate. **In all three the addon is refused entirely
and nothing lands anywhere.** The third is the one that matters for the work
order's other control: the floor Blender *enforces* is the manifest's.

### ⚑ NOT UPHELD — "the same zip against 3.0.1 must fail to enable"

Measured on `/usr/bin/blender` 3.0.1, offering it the identical
`scruple-blender-0.1.0.zip`:

```
   Blender 3.0.1 · extensions system present: False · extension prefs: False
   bl_info as 3.0.1 read it: blender=[3, 6, 0]
   install_result: FINISHED
   enable() raised: None   is_enabled: True   panels: 6
```

**3.0.1 installs it, enables it, raises nothing, and registers all six panels**,
although `bl_info` declares a minimum of `(3, 6, 0)` — three minor versions
above it.

#### Finding E3-1 — `bl_info["blender"]` is advisory and nothing enforces it

`addon_utils.enable()` never reads that field. Blender's preferences UI shows a
warning next to an addon whose declared minimum is above the running version;
the enable path does not consult it, and neither does `addon_install`. So:

- **4.2+ users are version-gated**, by `blender_manifest.toml`, at install time,
  hard — stage 4 shows the refusal.
- **3.x/4.0/4.1 users are not gated at all.** They will load an addon written
  against an API three years newer than theirs, and the first thing they see
  will be whatever it happens to break on, not a refusal.

The addon ships the dual manifest deliberately so 3.x users can install the same
zip. That decision stands; what does not stand is the belief that the declared
minimum protects them.

**The narrow fix** is a guard at the top of `register()` in
`/data/scruple-blender/__init__.py` that raises when `bpy.app.version` is below
the declared `bl_info["blender"]`, making the addon's own declaration the thing
that enforces it. That is a change to the addon product, it was not asked for
here, and it would change what "the standalone addon keeps working" means for
3.x users — so **it is left to a decision, not taken**. Until it is taken,
stage 5 stays red and `scripts/e3-gate.sh` exits non-zero.

The half of the control that **does** hold, and that carries the work order's
actual intent — *the new install is what made the difference* — is that 3.0.1
has **no manifest path whatsoever**: `"extensions" in dir(bpy.ops)` is `False`
and `bpy.context.preferences.extensions` does not exist. The path this work
order proves was unreachable on this box before today, and is reachable now.

---

## Two more findings, both about trusting the wrong signal

### Finding E3-3 — the extension CLI exits 0 on a refused install

```
$ blender --command extension install-file -r user_default -e corrupt-manifest.zip
ERROR Failed to load manifest from: Archive contains a manifest that could not be parsed …
$ echo $?
0
```

Same for the version-floor refusal. Anything that installs the addon
programmatically — WO-E4, WO-E5's "is it on the box", a build step — must **not**
gate on the exit code. The gate here reads the extensions repo directory and
then asks a fresh Blender what is enabled. Recorded so E4 does not learn it the
expensive way.

### Finding E3-4 — the shipped zip carries a stale vendored SDK

`python3 -m pytest -q` in `/data/scruple-blender`: **306 passed, 2 failed.**
Both failures are the same fact —
`test_every_vendored_file_hashes_to_what_the_manifest_says` and
`test_the_vendored_copy_matches_the_source_tree_it_came_from` report that
`scruple_host_sdk/{model_write,server_library,witness_flow}.py` in `vendor/`
no longer match `/data/scruple-web`.

**These were red on arrival and neither repo was touched by this work order** —
both are clean in `git status`. The drift comes from three commits in the server
repo: `179f875` (WO-C2), `fcbfe91` (WO-C5) and `634c66e` (**WO-E2, earlier
tonight**). The addon's own suite is doing exactly its job.

It matters here because the zip this gate proved,
`dist/scruple-blender-0.1.0.zip` (sha256 `2a25721bc39cdf1c…`, built 2026-09-07),
carries that stale copy. **WO-E3's claim is unaffected** — it is about whether
Blender loads the archive through the manifest, not about what the archive's SDK
does. But WO-E4 and WO-E6 are about what the SDK does, and they should re-run
`build/vendor_sdk.sh` and `build/build_addon.sh` first, then re-run
`npm run e3` against the new zip.

---

## What changed

**Desktop repo only.** Nothing in `/data/scruple-blender` or `/data/scruple-web`
was modified; nothing was installed system-wide; `/opt/scruple-witness`,
`:5799` and `:3001` were never contacted.

| file | what |
|---|---|
| `scripts/e3-install-blender.sh` | fetches, digest-checks and installs Blender 4.2.23 LTS into `vendor/blender/`; builds the amd64 sysroot on non-x86_64 hosts; writes the launcher and `INSTALLED.json` |
| `scripts/e3-gate.sh` | the gate and all five controls |
| `scripts/e3-probe.py` | asks a running 4.2+ Blender what it loaded; prints JSON |
| `scripts/e3-legacy-attempt.py` | offers the same zip to a pre-extensions Blender and reports what happened |
| `docs/BLENDER.md` | "Blender on this box" rewritten from measurements — the sentence *"The installed Blender cannot load the addon we ship"* was false and is now recorded as false, with what replaced it |
| `package.json` | `e3:install`, `e3`. **Not** added to the `gate` chain |
| `.gitignore` | `vendor/blender/` |

`docs/STATE.md` is untouched: WO-E7 owns the fold-in, and §0's sentence
*"Blender is not installed in this app"* is WO-E5's to change — a binary in the
repo tree is not the app speaking to it.

## What this does not cover

- The addon **enabling** is not the addon **working**. Nothing here calls an
  operator, signs anything or reaches the witness. That is E4 onward.
- Every measurement is on an emulated x86-64 CPU (E3-2). Render output, float
  determinism and timing are not settled by this box.
- Only the `user_default` local repo was exercised. The remote extensions
  repository, `blender --command extension install` from a listing, and the
  4.2 online-access prompt are untested; `bpy.app.online_access` is `False`
  here.
- 4.3, 4.4 and 4.5 were **not** tested. The floor is proved at 4.2.23 only.
- The zip under test predates tonight's server commits (E3-4).
