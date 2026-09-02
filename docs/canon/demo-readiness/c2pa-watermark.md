# Demo readiness — C2PA and watermarking, by modality

**Scope:** given an artifact, can we sign it, watermark it, and does either enter
the provenance chain. Generation flows and training are owned by other surveys.
**Date:** 2026-09-02. **Method:** read the code, then run it. Every WORKS/BROKEN
cell below was measured on this host, not inferred.

**Safety observed:** `WITNESS_SERVER_URL=http://127.0.0.1:1` and a scratch
`SCRUPLE_DB_PATH` for every command. The production witness at `127.0.0.1:5799`
was never contacted. `/opt/scruple-witness/` was read, never written. No git
write commands. No Modal, no deploys, no spend.

---

## The matrix

| | C2PA signable | Watermarkable | Derivative enters chain | Verified end-to-end |
|---|---|---|---|---|
| **Image** (PNG/JPEG/WebP/TIFF) | **WORKS** — measured | **WORKS** — measured, with caveats | **BROKEN** — §3 | **BROKEN** — no flow calls the signer (§1.4) |
| **Video** (MP4/MOV) | **WORKS** — measured, §1.2 | **NEVER BUILT** — §2.1 | **NEVER BUILT** | **BROKEN** — no flow calls the signer |
| **Video** (WebM) | **BROKEN** — §1.2 | NEVER BUILT | NEVER BUILT | BROKEN |
| **Model checkpoint** (.safetensors/.pt) | **BROKEN** embedded / **BROKEN** sidecar — §1.3 | **NEVER BUILT** | **NEVER BUILT** | **UNVERIFIED** since 2026-07-14 |

One sentence for the founder: **the signer works, on more formats than anyone
claims, and nothing in the product calls it; the watermarker works on images
only, was never wired into Studio, and its output is structurally locked out of
the evidence chain.**

---

## 0. The archaeology — this is a partially-wired replacement, not a regression

The founder's recollection is right on both counts, and the correction is the
important part.

**C2PA did work, pre-L2, on a local key.** `50c1873` (2026-07-03) landed the
signing pipeline using `c2pa.Signer.from_info(private_key=…)` reading
`services/c2pa-signer/keys/es256.pem` — **a file that was tracked in git**, so it
existed on every checkout. Signing worked out of the box for ten days.

Then the L2 tranche replaced that path, in four steps, and left two ends loose:

| Date | Commit | What it did | What it left |
|---|---|---|---|
| 07-12 | `dc95b7d` | `from_info(private_key=…)` → `Signer.from_callback(vault_sign_es256, …)`; `vault_sign.py` dispatches to OCI Vault on `SCRUPLE_C2PA_VAULT_KEY_OCID`, else a local PEM | the local-PEM default was hardcoded to `keys/es256.pem` |
| 07-12 | `bf524d0` | added `keys/regen-dev-cert.sh`, which emits **`signer.pem` + `signer.key`** — different names | two naming conventions now coexist |
| 07-13 | `0b6ee43` | gitignored `es256.pem` and purged it from history (`pre-key-purge-2026-07-13` is the anchor tag) | **no checkout has a key at the name the code uses. Break #1.** |
| 08-04 | `0004af2` | GPSA v3 fail-closed assertion partition | `CREATED_ALLOWLIST` contained none of the four labels the Application tier emits. **Break #2.** |

Both were fixed late — `bff1fd8` (08-27, allowlist) and `e9f731b` (08-29, key
pointer). **`e9f731b`'s commit message says `es256.pem` "HAS NEVER EXISTED". That
is wrong, and the history rewrite is why:** `0b6ee43`'s own message says "the
prior tracked copy will be purged from git history by git-filter-repo". The
evidence of the working pre-L2 state was deleted by the same commit that broke
it. This matters because it is the difference between "restore something" and
"finish something".

**The same gaps are still open, in the same shape.** Two more call sites still
default to the key name that has not existed since 07-13:

- `services/c2pa-signer/vault_sign.py:39` — `SCRUPLE_C2PA_LOCAL_KEY_PATH` default
  is `keys/es256.pem`. Harmless only because `sign.py:138` sets that env var from
  the job spec.
- `services/c2pa-signer/sign_leaf.py:73,95` — same default, **and nothing sets the
  env var for it**. Measured:

  ```
  $ echo <64-hex> | python3 sign_leaf.py
  {"error": "signing failed: [Errno 2] No such file or directory:
    '.../keys/es256.pem'", "mode": "local"}
  $ SCRUPLE_C2PA_LOCAL_KEY_PATH=.../keys/signer.key … → {"signature": "MEUCIQC5…"}
  ```

  `services/witness-server/leaf_signer.js:96-104` shells out to `sign_leaf.py`
  and does **not** set the variable. In `vault-py` mode with no Vault OCID, every
  leaf signature fails, is swallowed (`resolve(null)`), and the leaf is recorded
  as not independently verifiable. Third instance of the identical defect, on the
  audit path.

- `services/c2pa-signer/vault_sign.py:120` — `signer_identity()` returns the
  literal string `"local:services/c2pa-signer/keys/es256.pem"`, naming a file that
  is not the one that signed. **This string is written into the witness leaf** as
  `signingIdentity` (`app/api/scruple/c2pa/sign/route.ts:224`). Confirmed in
  every signing result I produced tonight. A false identity in the audit record.

**Why nothing caught any of it.** CI runs SCA/SAST/SBOM/typecheck and no test
suite; `services/c2pa-signer/tests/` (52 tests, all passing tonight) tests the
partition and the source-type contract; the TypeScript suite
(`test/v2/digital-source-type.test.ts:60`) stubs the Python signer with a shell
**shim** and never signs. Only `test_digital_source_type.py:211` performs a real
sign, and it is PNG-only.

---

## 1. C2PA coverage by modality

### 1.1 Current state: signing works

Measured end-to-end through the real path (`lib/c2pa/signAsset.ts` → `spawn
python3` → `services/c2pa-signer/sign.py` → `c2pa-python 0.36.0` → local
`signer.pem`/`signer.key`), in both `SCRUPLE_C2PA_DEV=1` and prod posture:

```
PNG   ok=true  44,609 bytes
MP4   ok=true  18,139 bytes
MOV   ok=true  18,086 bytes
WEBM  ok=false "Builder does not support video/webm"
```

Read back through `c2pa.Reader`, the signed MP4 gives
`validation_state: Valid`, assertions `['c2pa.actions.v2',
'c2pa.hash.bmff.v3', 'cawg.training-mining']`, and the inception action carries
`digitalSourceType: …/trainedAlgorithmicMedia`. The only validation code is
`signingCredential.untrusted`, which is the expected result for a dev cert not on
a trust list.

### 1.2 Video — the open question, answered: **MP4 and MOV work today**

Our path supports video and nobody has claimed it since July. The chain is
complete at every layer:

| Layer | MP4 | MOV | WebM | AVI |
|---|---|---|---|---|
| `signAsset.ts` `mimeFromPath` | `video/mp4` | `video/quicktime` | `video/webm` | `video/x-msvideo` |
| `formats.GENERATE_MIMES` | yes | yes | **absent** | **absent** (validate-only) |
| `assertion_partition.py` | format-agnostic | — | — | — |
| `c2pa-python 0.36.0` Builder | **signs** | **signs** | **refuses** | **signs** |
| `lib/v2/capabilities.ts` `C2PA_SIGNABLE` | yes | yes | **absent** | yes |

Three mismatches, all cheap:

1. **WebM is the exact PSD-class gap on video.** `mimeFromPath` maps `.webm` to
   `video/webm`, so the emitter will route a WebM file to a signer that refuses
   it. It is not in `GENERATE_MIMES` and not in `capabilities.ts`, so the failure
   is at least loud and late rather than silent — but a `.webm` from a txt2vid
   flow gets a 500 from `/api/scruple/c2pa/sign`, not a "not supported" answer.
2. **AVI is under-claimed.** `video/x-msvideo` is in `VALIDATE_MIMES` only, yet
   it signs cleanly, and `capabilities.ts` already advertises it as signable. The
   Intake Form and `capabilities.ts` disagree in the direction that matters
   (advertising generation of a format we only asserted validation for).
3. **PSD is confirmed still broken, and worse than described.**
   `lib/v2/capabilities.ts:42` lists `image/vnd.adobe.photoshop` in `C2PA_SIGNABLE`;
   `formats.py` lists it in neither `GENERATE_MIMES` nor `VALIDATE_MIMES`;
   `mimeFromPath` has no `.psd` case, so a PSD resolves to
   `application/octet-stream`. Measured: `c2pa-python 0.36.0` refuses **both**
   `image/vnd.adobe.photoshop` and `application/octet-stream` — so the ceiling is
   the library, not our config, and `capabilities.ts` is advertising a capability
   no version of our stack has.

### 1.3 Model checkpoint — BROKEN, two ways

**Embedded is impossible.** `formats.GENERATE_MIMES` asserts
`application/x-pytorch` on the Conformance Intake Form. Measured:
`c2pa-python 0.36.0` → `Builder does not support application/x-pytorch`.
`mimeFromPath` has no `.safetensors`, `.pt` or `.pth` case at all (its own comment
says so) and returns `application/octet-stream`, which also refuses. The intake
assertion is not backed by the installed library.

**The sidecar path is the right design and is currently unrunnable.**
`scripts/puffjuly12/12-emit-lora-sidecar.py` binds a `.safetensors` by whole-file
SHA-256 into a `format="c2pa"` external manifest — correct, and the reasoning in
its docstring is sound. It is served by
`app/api/projects/[id]/lora-sidecar.c2pa/route.ts`, which shells out to that
script. But the script reads its key material from
`SCRUPLE_C2PA_KEYS_DIR`, defaulting to **`/tmp/puffjuly12/keys`**:

```
$ ls /tmp/puffjuly12/keys   → No such file or directory
$ ls data/lora-sidecars/    → No such file or directory
$ grep -rn SCRUPLE_C2PA_KEYS_DIR  → only the script's own default
```

So the route 500s on first hit. Worse, even repaired it signs with
`c2pa-es256.pem`, a **different key from the Scruple signer's**
`signer.key` — a model checkpoint would carry a signer identity unrelated to
every signed image. Last known-good is the 2026-07-14 puffjuly12 run;
**UNVERIFIED** since.

### 1.4 `digitalSourceType` — fails closed correctly, and the question is moot

Both ends refuse rather than guess (`signAsset.ts:363-379`, `sign.py:126-146`),
and `037c89d` fixed the real harm: a `TRAINED_ALGORITHMIC_MEDIA` default was
writing "generative AI made this" into Blender renders. Measured: an absent or
unrecognised value returns `ok:false` before the asset is even opened. This is
right.

But the brief's question — "confirm each flow has a caller declaring it" — has an
uncomfortable answer:

```
$ grep -rn "signAsset(" --include=*.ts .    (excl. node_modules, docs)
  lib/c2pa/signAsset.ts        (the definition)
  app/api/scruple/c2pa/sign/route.ts:194   ← the only production caller
  test/v2/digital-source-type.test.ts      (stubbed)
```

and nothing in the repo calls that route. `grep -rn "c2pa/sign"` across
`packages/`, `external/`, `examples/`, `artifacts/` and all `.tsx` returns
nothing but documentation. `components/LockButtons.tsx:74-89` carries a
**"Sign with C2PA"** button that is hard-disabled with
`unavailable: 'C2PA signing is not available yet…'`. `app/api/v2/mark/route.ts`
answers every `c2pa` request with `outstanding: signer_unavailable`.
`grep -rni "c2pa|signAsset|watermark" lib/canvas/ app/canvas-proxy/ app/canvas/
modal/*.py components/Canvas*.tsx` → **zero matches**.

**No flow can fail to declare a `digitalSourceType`, because no flow signs.**

---

## 2. Watermarking

### 2.1 What it actually does, and to what

`lib/watermark/embed.ts` shells out to `services/watermark/cli.py`; the encoder is
`image_dct.py` — a DCT coefficient-parity scheme over 8×8 blocks of the Y channel,
operating on **whatever Pillow can open**. Reachable formats via
`contentTypeToFormat` / `extForFormat`: PNG, JPEG, WEBP, TIFF.

**Video: nothing. Audio: nothing.** No `.py` under `services/watermark/` mentions
video, audio, MP4 or ffmpeg. `lib/watermark/apply.ts:52-56` skips any iteration
whose `output_kind !== 'image'` with the literal reason `"(Phase 2)"`.

Measured round trip (512×512, real payload):

```
embed  → ok, 697,857 bytes
decode clean          → recovered
decode after JPEG q85 → recovered
decode after 512→480 resize → NULL
decode after 8px crop       → NULL
```

The decoder has no synchronisation: `image_dct.py:174-175` derives block indices
from the **received** image's width, so any geometric change re-indexes every bit.
Survives re-encoding; does not survive resize or crop.

### 2.2 Was it ever wired into Studio? **No — NEVER BUILT is the answer**

`lib/watermark/` has exactly one commit in its entire history — `1d1d24c`,
2026-07-14, "ship WATERMARK v1.2 MVP". There is no commit where a Studio flow
called it and none that removed such a call. The founder's uncertainty is
correct: it never shipped into Studio.

The one path that does fire is accidental. `watermarkProjectIterations` sweeps
**every** image iteration on a project by `project_id`, and Studio's canvas proxy
writes ordinary `iterations` rows with `output_kind='image'`. So a Studio user who
leaves the canvas, goes to the workspace, and pays $5 for a local lock gets their
Studio outputs marked — from a button on a page Studio does not link to
(`app/canvas/page.tsx` has no `LockButtons`; `components/WorkspaceView.tsx:212`
does). One caller, in one route:

```
$ grep -rl "watermarkProjectIterations"
  lib/watermark/apply.ts   app/api/lock/local/route.ts
```

`apply.ts:5-6` claims it is "Called from /api/lock/local, /api/lock/chain-*, and
optionally /api/lock/checkpoint". Only the first is true —
`app/api/lock/chain/route.ts` and `app/api/lock/checkpoint/route.ts` contain no
watermark reference of any kind, so **§9.3's SCR_ID watermark (tiers 4/5) is coded
and never invoked.**

### 2.3 The ordering defect — **confirmed, and it is worse than "finalises first"**

`app/api/lock/local/route.ts`, in execution order:

| Lines | What happens |
|---|---|
| 79-80 | `const leaves = iterations.map(i => i.leaf_hash)`; `buildMerkle(leaves)` — the tree commits the **clean master** hashes |
| 83 | `deriveScrId(tree.root)` |
| 97-119 | `witness.confirmAndExecute({action:'finalize', …})` — the witness server signs the root **and inserts into `locked_projects`** |
| 131-141 | local transaction: `status='local_locked'`, `is_active=0` |
| 153-157 | `watermarkProjectIterations(…)` — **here** |

The derivative is produced after the seal. That alone would leave it merely
uncommitted. The second constraint is what makes it unfixable in this order:

```
/opt/scruple-witness/server.js:577
  const locked = db.prepare('SELECT 1 FROM locked_projects WHERE project_id = ?')…
  if (locked) return send(res, 403, {error:'Project is locked, no new iterations allowed'});
```

`finalize` writes `locked_projects` at `server.js:1191`. So by the time the
watermark exists, **the witness will 403 any attempt to witness it.** That is why
`iterations.watermark_derivative_leaf_hash` — added by migration 038 in July — has
been NULL since the day it landed and is written by no code in the repo
(`grep` finds the column only in the migration).

The comment at `route.ts:145-150` says "the lock itself succeeds regardless…
watermarking is additive". It is additive in exactly the sense that makes it
worthless as evidence.

### 2.4 The founder's stated design — **partially implemented, and the missing half is the load-bearing one**

| The design | Status |
|---|---|
| A non-watermarked original from the Scruple workflow | **IMPLEMENTED.** `apply.ts` reads master bytes and never modifies them; master hash stays `iterations.output_hash` |
| A copy gets watermarked | **IMPLEMENTED.** `embedImageWatermark` returns new bytes; stored under their own sha256 via `storeArtifact` |
| Both are presented to the user | **IMPLEMENTED.** `app/receipt/[scrId]/page.tsx:557-620` renders a two-download UX — "Clean master" and "Release (watermarked)" — plus tier/payload/timestamp badges |
| **The watermarked version enters the project workflow as its own source** | **NOT IMPLEMENTED.** No new `iterations` row, no leaf, no witness call. `watermark_derivative_leaf_hash` NULL, and §2.3 says it cannot be filled |
| **The C2PA-signed version mirrors this** | **NOT IMPLEMENTED.** `/api/scruple/c2pa/sign` signs an arbitrary `asset_path` with `intent: CREATE` and no ingredient. There is no `c2pa.edited` action, no ingredient reference to the master, and no code anywhere passes the derivative to the signer |

The shape of the missing half is already designed **in the wrong module.**
`lib/witness/ingest.ts:45-51` declares `master_hash`, `watermark_payload_hex` and
`ingredient_master_leaf_hash`, citing WATERMARK_DESIGN §7.4, and validates them
properly at lines 219-244 (all-three-or-none, 64-hex, 32-hex, magic byte `5c`,
version nibble). But `ingest.ts` serves `/api/v1/log/*` — the Scruple witness API
in Next — while lock/local talks to the **standalone witness server**, which has
**zero** occurrences of `master_hash` or `watermark_payload_hex`. Two witness
surfaces; the derivative vocabulary exists only on the one the lock does not use.

### 2.5 EU AI Act Article 50 — the public page overclaims on four points

`docs/website/eu-ai-act-article-50-section-1.md` §"Measure 2" is the marking-measures
claim to the AI Office. Against what I measured:

| Claim on the page | Measured |
|---|---|
| "imperceptible pixel-space watermark for image **and video** outputs" | **False for video.** No video embedder exists in any form |
| "survives common transformations (re-encoding, **resizing**, colour transforms)" | **Half true.** Survives JPEG q85. Dies on a 512→480 resize and on an 8-px crop |
| "encodes a hash back into the Scruple audit chain" | **False.** The 128-bit payload is magic + version + tier + a wall-clock reading (`embed.ts:59`). No chain hash, no leaf hash, no SCR_ID below tier 4 |
| "both paths point back to the same Scruple audit chain" | **False.** The C2PA path does; the watermark derivative is not in any chain (§2.3) |

A provenance conversation is defensible today for images and MP4/MOV: a real
C2PA manifest, valid in any third-party verifier, with a correct
`digitalSourceType`. **A marking-measures conversation is not.** The mark carries
no identifier that resolves to anything, does not survive a resize, and applies to
no video. If the AI Office asks for a marked video, or asks what the mark resolves
to, there is no answer.

---

## 3. How they compose — the actual order, and where the chain breaks

Today, for a single Studio image:

```
generate (canvas proxy)
  → captureOutput → ingestIteration        leaf commits sha256(clean master)
  → [user navigates to the workspace]
  → POST /api/lock/local
       ├─ buildMerkle(leaf_hashes)          ── over MASTERS
       ├─ witness finalize                  ── seals; writes locked_projects
       ├─ UPDATE projects status=local_locked
       └─ watermarkProjectIterations        ── derivative born AFTER the seal
                                               witness now 403s it forever
  → C2PA sign:  never happens (no caller; button disabled)
```

**Where it breaks, in order of upstream-ness:**

1. **The seal precedes the derivative** (`lock/local` lines 97-119 before 153-157)
   and the seal is what forbids new leaves. Everything else is downstream of this
   one ordering.
2. **The derivative has no leaf shape on the witness that locks projects.** The
   vocabulary exists on `/v1/log` only.
3. **No caller signs anything.** The signer is reachable, correct, and orphaned.
4. **The signed artifact would be the master, not the released derivative** — so
   even with 1-3 fixed, the bytes the public receives and the bytes with the
   content credential would be different files.

**The specific failure the brief asked me to look for — a derivative that cannot
be witnessed — is real, and its cause is a 403, not an omission.**

---

## 4. What must change for one artifact to come out watermarked, signed and witnessed

Ordered by upstream-ness, not by effort. Items 1-3 are the chain; 4-6 are truth
in advertising.

1. **Reorder `app/api/lock/local/route.ts`: watermark → witness the derivative →
   build the Merkle tree → finalize.** The derivative leaf must be created while
   the project is still open, because `server.js:577` refuses afterwards. This is
   the single change that makes a witnessed derivative possible; nothing else on
   this list works without it.
2. **Give the standalone witness server the derivative vocabulary** —
   `master_hash`, `watermark_payload_hex`, `ingredient_master_leaf_hash`. The
   validation logic is already written and tested at
   `lib/witness/ingest.ts:219-244`; port it rather than rewrite it. Then write
   `iterations.watermark_derivative_leaf_hash`, which migration 038 has been
   holding open since July.
3. **Sign the derivative, not the master, and say so in the manifest.** A second
   `signAsset` call with `intent: 'EDIT'`, a `c2pa.edited` action, and the master
   as a `c2pa.ingredient` — which is already on the `created` allowlist in
   `config/c2pa-assertions.json`. Then one caller: the lock route, after step 2.
4. **Fix the three surviving `es256.pem` references** —
   `vault_sign.py:39`, `sign_leaf.py:73,95`, and the false identity string at
   `vault_sign.py:120` that is being written into witness leaves. Have
   `leaf_signer.js` set `SCRUPLE_C2PA_LOCAL_KEY_PATH`. Same defect, same shape,
   fourth through sixth instances.
5. **Reconcile the three format lists.** `mimeFromPath`, `formats.py` and
   `capabilities.ts` disagree on WebM (emitter-only), AVI (validate-only but
   advertised as signable), PSD (advertised, supported nowhere) and pytorch
   (asserted on the Intake Form, refused by the library). One list, derived, with
   a test that signs a fixture of each claimed MIME. **The current suite would
   have caught none of tonight's findings.**
6. **Correct the Article 50 page** on video watermarking, resize robustness, and
   "encodes a hash back into the audit chain" — or implement them. All three are
   currently claims to a regulator that the code does not support.

Video watermarking (`apply.ts`'s "Phase 2") is a genuinely new build and is not on
this list. Nothing above depends on it; the Article 50 page does.
