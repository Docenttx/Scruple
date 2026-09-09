# WO series E — Blender on the hook, and two fixes that must land first

_2026-09-09, overnight. Read `docs/BLENDER.md`, then `docs/HOST-HOOK.md`,
then `docs/STATE.md` §4. The decisions in them are settled and not open._

## Standing rails — unchanged from the D series, and they still bind

- 🔴 **Never modify `/opt/scruple-witness`** — it serves `witness.scruple.ai`
  and is live. **Never contact `127.0.0.1:5799`** (production witness) or
  **`:3001`** (`scruple.stooges.ai`, live and unsupervised). Your sandbox is the
  scratch witness on **5899**, the scratch app on **3902**, the CVM surrogate on
  **8799**.
- 🔴 The surrogate is **SOFTWARE-backed**. A leaf it signed is `passthrough` or
  `stale`, never `verified`. Migration 053 refuses `verified` + `desktop` at the
  database; do not work around it.
- 🔴 **Do not flip `CHECKPOINT_VECTORS_SETTLED`.** WO-C6 measured that none of
  the four Merkle implementations passes the shared vectors. The cutover is
  WO-C7 and its step 6 is a founder-only witness deploy.
- **Verify by side effect.** Every gate names an observable AND a control that
  must not fire. Demonstrate each control RED before the change and green after.
  A green test with no control proves only that it cannot fail. An inconclusive
  control is scored **INCONCLUSIVE**, never as a pass.
- No display: `xvfb-run -a -s "-screen 0 1280x900x24"`. ⚑ **Screenshots come
  back blank** under llvmpipe. Never gate on pixels — ask the layout engine
  (WO-D5) or the filesystem, not the framebuffer.
- Prefer Bash. Commit in the repo you changed; do not push. If a gate does not
  pass, **say so plainly and keep the work** — do not narrow a WO to whatever
  happened to succeed.

---

## WO-E1 — The C2PA signer must refuse a certificate it did not sign with

**Server repo.** `docs/STATE.md` §4.3: with `SCRUPLE_C2PA_VAULT_KEY_OCID` and
`SCRUPLE_C2PA_KMS_ENDPOINT` set, `lib/c2pa/signAsset.ts` signs through the
surrogate with one key and embeds `services/c2pa-signer/keys/signer.pem` — the
certificate issued for the **local** key — because `cert_path` is chosen
(`?? DEV_CERT`) independently of which key signs. The route answers `ok: true`,
and `c2pa.Reader` answers `['signingCredential.untrusted',
'claimSignature.mismatch']`. **A credential nothing can verify, from a call that
reported success.**

Add the guard at the source: before signing, compare the public key in the
certificate against the public key the signing path will actually use, and
**refuse** when they differ. A refusal, with a code, is the correct outcome —
never a warning, never a repaired certificate, never a silent fall back to the
local key.

**Gate:** with the mismatched pair configured, the route refuses with a distinct
code and writes **no** output asset. **Controls, all three required:** (a) the
correctly-paired surrogate certificate from `scripts/d7-surrogate-cert.sh` still
signs, and the result reads valid via `get_validation_state()` — not `is_valid`,
which is unreliable; (b) local-key signing with the local certificate is
unaffected; (c) demonstrate the defect RED first, on a worktree at the parent
commit, by reading `claimSignature.mismatch` out of a manifest the route called
`ok`.

⚑ Fusion signs through this path too. Say in the report which callers you found
on it, by enumerating them rather than asserting a number.

## WO-E2 — `declared_uncaptured`, the absence set, with its scope on the leaf

**Server repo.** WO-C5 built the machinery — the epoch, both watermarks, the
five-valued `upstream_uncaptured_reason` — and stopped before the set itself
because its scope rule was unsettled. Round 5 §3 put the question as: *must
`declared_uncaptured` carry the scope it enumerated over — which root types were
configured, and whether any were `unspecified` — or does it assert a closure it
does not have?* Line 369 answers that it needs an `enumeration_method` and an
observed scope.

Settle it in the design doc first, in writing, then build to it. The set
enumerates `/history` outputs and diffs them against the captured set; it
carries the scope it enumerated over and the method it used; and it is in the
MAC, the validator and the database like every field before it.

**Gate:** an upstream that produced an artifact the component did not capture
yields a leaf whose `declared_uncaptured` names it, with a scope that says what
was looked at. **Controls:** a run with nothing uncaptured must produce an
**empty set that is present**, not an absent field — the two mean different
things; and a run whose configured roots do not cover the output directory must
**refuse to claim closure**, because it cannot have it.

## WO-E3 — A Blender that can load the addon we actually ship

🔴 `/usr/bin/blender` is **3.0.1**. The addon's `bl_info` needs **3.6.0** and
`blender_manifest.toml` needs **4.2.0**. Nothing downstream in this series means
anything until the addon loads in a Blender that can load it.

Install Blender **4.2 LTS or newer** into this repo's own tree (not over the
system one, which other work may depend on), and prove the shipped zip installs
and enables **through the manifest path** — the one a 4.2+ user gets — headless
under xvfb.

**Gate:** `blender --background --python-expr` reports the addon enabled, its
panels registered, and its version, read out of the running Blender rather than
from the file we shipped. **Controls:** the same zip against **3.0.1** must fail
to enable — proving the version gate is real and that the new install is what
made the difference; and a deliberately corrupted manifest must be refused by
Blender rather than silently falling back to `bl_info`.

## WO-E4 — Blender registers as a Level-2 adapter, and the leaf says `supplied`

The addon becomes the host adapter of `HOST-HOOK.md`: a static, build-time
`HostRegistration` through `registerHost()`, and an announcement per generation
carrying the scene facts a wire cannot see — scene, frame, camera, and the
render settings that determined the pixels.

**Gate:** a generation announced by the addon lands a leaf reading
`host_semantics: supplied`, `capture.host: blender`, with the scene facts in the
MAC. **Controls, and the second is the one that matters:** with the addon
absent the same generation reads **`blind`**; with the addon present but silent
on that generation it reads **`declined`** — an integration that is not working,
which is a different fact with a different owner from one that was never done.
A third: an announcement whose document fails the addon's own declared schema is
**refused and recorded**, and the run continues at Level 1.

⚑ The correlation is ComfyUI's `prompt_id` and the host chooses it. Choosing it
must grant nothing: show that a wrong id makes a leaf say **less**, never
something false.

## WO-E5 — The Blender region in the dashboard

Following WO-D5 exactly: the region renders from `GET /api/v2/capabilities`,
the canon design carries across unrestyled, and what is on the box is answered
by the preload bridge in three states — measured, unavailable, refused — never
a plausible default.

**Gate:** with Blender installed the region names the version read from the
running binary, the addon's enabled state, and whether a bridge is pointed at
the gate. **Control:** with Blender not installed the region is **ABSENT** —
`count === 0` *and* zero occurrences in the serialised document, the
`dom-unmentioned` kind from WO-D5 — not empty, not greyed, not "not detected".
`STATE.md` says Blender is not installed in this app yet; that sentence changes
in this WO or it does not.

## WO-E6 — One generation, from inside Blender, through the gate

The product claim, end to end. A bridge inside Blender is pointed at the gate
instead of at ComfyUI; the user generates; the leaf carries **both halves**.

**Gate:** one leaf, from one generation started in Blender, carrying the
workflow graph, `model_fingerprints` computed from the model files, AND
`host_semantics: supplied` with the scene facts. Re-hash the artifact from the
bytes on disk and read the leaf out of the witness's own sqlite file, from the
shell, outside node.

**Controls:** (a) `model-swap` — same filename, same length, same safetensors
header, different weights — must move the fingerprint and nothing else, as in
WO-D4; (b) the bridge pointed **around** the gate must still leave a witnessed
artifact via the output watcher, recorded `no-graph` and `blind`, per finding
D4-2 — bypassing produces a *blind* record, not an absent one; (c) an
announcement naming a scene that no render produced must not make a leaf claim
it.

⚑ If a bridge cannot be pointed at an arbitrary address, **that is a finding
about that bridge** — name it, pick another, and say which of the eleven you
tried. Do not fork one, vendor one, or patch one.

## WO-E7 — The two products, mirrored, and an honest close-out

Both paths, side by side, on the same run:

1. the **addon alone**, talking to the server directly, no gate;
2. **Desktop Studio alone**, no addon;
3. **both**.

Put a leaf from each next to the others and state exactly which fields differ
and why. ⚑ **Row 1 is the one to get right**: the addon alone must not imply
anything about an AI step it never observed. If it currently does, that is the
most important finding in this series and it goes at the top of the report.

**Gate:** the three leaves differ only in the fields the table in
`docs/BLENDER.md` predicts, and no two of them read the same where they should
differ. **Control:** a field that is supposed to distinguish two of the three
must be shown to change when the thing it describes changes.

Then fold every E-series finding into `docs/STATE.md` — what works and the
observable that showed it, what is built but unproven, what needs a human, what
needs the founder. Keep "the gate passed" and "here is what the gate does not
cover" as different sentences.
