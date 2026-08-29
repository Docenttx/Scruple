I've completed the investigation. Here is the Phase 2 report.

---

# Phase 2 — Watermarking reaches nothing: how it reaches Studio

**Scope:** Gap 3 of `docs/canon/STUDIO_L2_MERGE.md`. Read-only investigation.
**Date:** 2026-08-29. **Signing target:** the surrogate at `http://127.0.0.1:8799` only.
**The production witness `127.0.0.1:5799` was not contacted at any point.** The only network call made was `GET http://127.0.0.1:8799/health`.

---

## Headline

The premise in `STUDIO_L2_MERGE.md` is confirmed on the letter and wrong in one useful detail.

Confirmed:

```
$ grep -rni "watermark" lib/canvas/ app/canvas-proxy/ app/canvas/ modal/*.py components/Canvas*.tsx
(no output)
$ grep -rni "c2pa\|signAsset" lib/canvas/ app/canvas-proxy/ modal/*.py
(no output)
```

The detail: **Studio's outputs are already watermarkable today, transitively, and nobody appears to have noticed.** `captureOutput` → `ingestIteration` writes ordinary `iterations` rows with `output_kind='image'` and `output_content_type='image/png'` (`lib/canvas/witness.ts:104-108`, `126-144`), and `watermarkProjectIterations` sweeps *every* image iteration on a project by `project_id` (`lib/watermark/apply.ts:41-51`). If a Studio user leaves the canvas, goes to the workspace, and pays $5 for a local lock, their Studio outputs get tier-3 marks.

That is not a defence of the current state. It is worse than the gap as written, because it means the one path that does fire is the one path nobody designed for Studio, it fires only from a page Studio doesn't link to (`app/canvas/page.tsx` has no `LockButtons`; `components/WorkspaceView.tsx:212` does), and **the derivative it produces is committed by nothing at all**. See §5.

Four findings drive everything below:

1. §9.2's "signing timestamp" is not implemented. The payload carries an app-tier wall-clock reading taken at embed time (`lib/watermark/embed.ts:59`), and no signer is involved in producing it.
2. §9.3's SCR_ID watermark is coded and never invoked — confirmed. `app/api/lock/chain/route.ts` contains no watermark reference of any kind.
3. The derivative bytes are outside the evidence chain, and **cannot be brought into it in the current call order**, because `/api/lock/local` finalizes before it watermarks and the witness server refuses new leaves on a locked project.
4. The robustness posture claimed in `WATERMARK_DESIGN_v1.md §9` is measurably false. I ran it.

---

## 1. What `embed.ts`, `apply.ts` and `services/watermark/` actually do

### 1a. The stack, bottom to top

| Layer | File | Role |
|---|---|---|
| Payload packing | `services/watermark/payload.py` | 128-bit struct, pure |
| Image codec | `services/watermark/image_dct.py` | DCT embed/decode, NumPy + SciPy + Pillow + reedsolo |
| Subprocess entry | `services/watermark/cli.py` | JSON job on stdin, JSON result on stdout |
| TS wrapper | `lib/watermark/embed.ts` | `spawnSync` into the two above |
| Orchestration | `lib/watermark/apply.ts` | Iterate a project's rows, embed, store, UPDATE |
| Caller | `app/api/lock/local/route.ts:151-160` | The only invocation in the estate |

There is **no HTTP server anywhere in `services/watermark/`**. `find services/watermark -type f` returns five files: `__init__.py`, `payload.py`, `image_dct.py`, `cli.py`, `requirements.txt`. No `server.py`, no FastAPI, no `http.server`. The `/v2/mark` route's stated reason (`app/api/v2/mark/route.ts:23-24`) is factually correct.

### 1b. `buildPayloadHex` — `lib/watermark/embed.ts:51-81`

**Input:** `{ tier, scrId?, pinnedHint?, signedAtUnixSeconds? }`.
**Output:** a 32-character lowercase hex string (16 bytes).

It builds a Python source string and shells out. Tiers 1–3 take the timestamp branch at line 58; the timestamp is computed **in JavaScript** at line 59 (`Math.floor(Date.now()/1000)`) and interpolated into the script. Tiers 4–5 take the SCR_ID branch at line 65.

Two problems in this function:

- **Line 74 interpolates `input.scrId` unescaped into Python source**: `scr_id='${input.scrId}'`. `REPO_ROOT` is likewise interpolated at lines 61 and 72. `scrId` is a plain `string` on `BuildPayloadInput` (line 39) with no validation at this boundary. Today the only caller passes a server-derived value, so this is not live — but any new endpoint that accepts an `scr_id` from a request body makes it live immediately. The endpoint I specify in §4 must not pass a caller-supplied `scr_id` through this path unvalidated.
- The `signedAtUnixSeconds` override is documented "tier 1-3 only" (line 42) and is silently ignored for tiers 4–5, which is correct but undocumented in the type.

### 1c. `embedImageWatermark` — `lib/watermark/embed.ts:108-144`

**Input:** `{ masterBytes: Buffer, inputFormat?, outputFormat?, outputQuality?, payloadHex }`.
**Output:** `{ derivativeBytes: Buffer, payloadHex, scheme: 'dct-v1', version: 1 }`.

It writes the master to a temp dir, spawns `python3 -m services.watermark.cli` with an `embed` job, reads the output file back, and deletes the temp dir in `finally`.

**`outputQuality` is declared (line 89) and never sent.** The job object at lines 114-120 carries only `action`, `input_path`, `output_path`, `output_format`, `payload_hex`. `image_dct.embed_image` therefore always uses its default `output_quality=95` (`image_dct.py:86`). `inputFormat` (line 85) is likewise only used to choose a temp-file extension (line 110) and is never sent either; Pillow sniffs the content, so this is harmless but the field is dead.

`decodeImageWatermark` (lines 160-191) is the mirror image and returns `null` on any failure, matching §9.2.5.

### 1d. `watermarkProjectIterations` — `lib/watermark/apply.ts:40-132`

Per image iteration in a project, in `run_sequence` order:

1. Skip if `output_kind !== 'image'` (line 59) — **video and audio are skipped unconditionally**, noted as "Phase 2".
2. Skip if `output_content_type` doesn't start with `image/` (line 64).
3. Read master bytes from the **local** artifact store (line 74) — `readArtifact` is filesystem-only (`lib/scruple/artifacts.ts:26-30`). Storage-provider-only masters are skipped.
4. Build payload (82), embed (90), `sha256` the derivative (98), `storeArtifact` (99).
5. `UPDATE iterations SET watermark_derivative_hash, watermark_payload_hex, watermark_scheme_version=1, watermark_tier, watermark_signed_at` (102-116).

Three defects here:

- **`watermark_derivative_leaf_hash` is never written.** Migration 038 adds the column with the comment "the witness leaf hash for the derivative" (`lib/db/migrations/038_watermark_derivative.sql:25-27`). Nothing in the estate writes it. This is the structural hole; §5 is about it.
- **The stored timestamp is a second, different clock reading.** `new Date().toISOString()` at line 114 is not the value embedded in the payload (which came from `embed.ts:59` inside `buildPayloadHex`). Under load or a slow subprocess these differ. `watermark_signed_at` is therefore not a reliable index into the payload, and the receipt page renders it as if it were (`app/receipt/[scrId]/page.tsx:616-618`).
- **`scrId`/`pinnedHint` are plumbed but never supplied.** `ApplyInput` accepts them (lines 26-29) and passes them to `buildPayloadHex` (82-86); the only caller passes neither. Tier 4/5 is dead code end to end.

### 1e. `payload.py` — the 128-bit struct

Matches `WATERMARK_DESIGN_v1.md §3.1` exactly: magic `0x5C` (8 bits) · version (4) · tier (4) · 112-bit body. Tiers 1–3 body = `signed_at_unix_seconds` (64) + reserved (48); tiers 4–5 = `scr_id` u64 (64) + `pinned_hint` (48). Verified live:

```
$ python3 -c "... build_payload_tier_1_3(Tier.LOCAL_LOCK, signed_at_unix_seconds=1756400000) ..."
5c130000000068b08980000000000000
{'magic': 92, 'version': 1, 'tier': 3, 'tier_name': 'LOCAL_LOCK',
 'signed_at_unix_seconds': 1756400000, 'reserved': 0}
```

**Two SCR_ID round-trip bugs, both live for §9.3.** Measured:

```
SCR_A38E30     -> 5c14a38e300000000000000000000000 -> SCR_A38E3000   roundtrip_ok=False
SCR_A38E30FF   -> 5c14a38e30ff00000000000000000000 -> SCR_A38E30FF   roundtrip_ok=True
SCRB_ABCDEF    -> 5c14abcdef0000000000000000000000 -> SCR_ABCDEF00   roundtrip_ok=False
```

- `_u64_to_scr_id` (`payload.py:73-81`) keeps a minimum of 8 hex digits after stripping padding zeros. `lib/scruple/hash.ts:20-23` produces **6-character** SCR_IDs (`'SCR_' + merkleRoot.slice(0,6).toUpperCase()`). Every scruple-web-derived SCR_ID therefore decodes to a different string than the one embedded, and a verifier querying that string on RVN finds nothing.
- `_scr_id_to_u64` strips the `SCRB_` prefix (lines 61-62) and `_u64_to_scr_id` always re-emits `SCR_`. Persistent-lock IDs (`deriveScrId(root, true)`) lose their namespace.

There is a *third* SCR_ID derivation in play. The witness server computes `'SCR_' + sha256(rootSource).substring(0,8).toUpperCase()` (`services/witness-server/server.js:1215-1217`) — 8 characters of a *hash of* the root. `deriveScrId` uses 6 characters *of* the root. These are different identifiers for the same lock. Any watermark endpoint must embed the value that was actually minted, not the locally-derived `preScr`.

### 1f. `image_dct.py` — what the encoder really is

`services/watermark/image_dct.py:80-146` embed, `149-199` decode. Parameters: `BLOCK_SIZE=8`, `COEF_POS=(4,3)`, `ALPHA=20.0`, `ECC_BYTES=14`, `BIT_REPEAT=3`. 16-byte payload → Reed-Solomon(30,16) → 240 bits → ×3 repetition → 720 blocks required, i.e. **~216 px minimum per side** (measured: a 200×200 image raises `image too small to embed watermark: 625 blocks available, need 720`).

The module docstring calls this "Cox et al. spread-spectrum". It is not. Line 131 is `d[COEF_POS] = target` — the mid-frequency coefficient is **overwritten** with ±20, not modulated relative to its original value. Decode thresholds on sign (line 178). This is coefficient replacement, and it is why the mark is both perceptually cheap and fragile in a specific way, below.

**Media types actually supported:** raster images only, whatever Pillow can open. `PNG`, `JPEG`, `WEBP`, `TIFF` are reachable through `extForFormat` (`embed.ts:193-199`) and `contentTypeToFormat` (`apply.ts:134-140`). I confirmed TIFF embed+decode works. **Video: nothing. Audio: nothing.** No `.py` in `services/watermark/` mentions either.

**Alpha is silently destroyed.** `embed_image` does `img.convert('YCbCr')` (line 103) and re-merges with `.convert('RGB')` (line 139). Measured:

```
master mode: RGBA
derivative mode: RGB    alpha preserved: False
```

ComfyUI routinely emits RGBA PNGs. A Studio user who locks a transparent output gets a "Release (watermarked)" download with a black or opaque background and no warning. This is not hypothetical for Studio specifically.

**Dependency drift.** `services/watermark/requirements.txt` pins `numpy==1.26.4`, `scipy==1.14.1`, `pillow==10.4.0`. This host runs numpy 2.2.6, scipy 1.15.3, Pillow 12.2.0. The reference implementation is not executing against its pinned deps, and `lib/watermark/embed.ts` shells out to whatever `SCRUPLE_PYTHON` resolves to with no version gate.

---

## 2. Does the implementation meet §9.2? Checked clause by clause

### §9.2.4 — payload structure: **MET**

> "A fixed-length payload with a magic-byte gate, version field, tier discriminator, and tier-specific body… The gate and forward-error-correction layer together provide false-positive rejection at decode time."

All four elements present (`payload.py:28-49`), Reed-Solomon present (`image_dct.py:53`), and the gate rejects non-marked input. Measured: decoding the unwatermarked master returns `None`. No finding.

### §9.2.5 — detector semantics: **MET, and unusually precisely**

> "…returns either the parsed payload on success or a null verdict on failure. A recovery is considered successful only when forward-error-correction decode succeeds, the magic-byte gate matches, and the version is supported. No probabilistic confidence score is returned; the gate is binary."

`decode_image` (`image_dct.py:149-199`) returns `Optional[dict]`. RS failure → `None` (188). Magic/version failure raises inside `decode_payload` and is caught → `None` (196-199). No score is computed or returned anywhere. `decodeImageWatermark` and `packages/scruple-verify/src/watermark_verify.mjs:74-79` both preserve the binary verdict (`NO_WATERMARK`). This clause is implemented correctly and deserves saying so.

### §9.2 body — "payload encodes a SIGNING TIMESTAMP": **NOT MET**

> "…an imperceptible watermark to the output whose payload encodes a signing timestamp"

`WATERMARK_DESIGN_v1.md §3.1` glosses the field as "the Scruple signer's UTC timestamp at the moment the derivative was signed."

What is actually embedded is `Math.floor(Date.now()/1000)` read by the Next.js process in `lib/watermark/embed.ts:59`, at the moment `buildPayloadHex` is called. In the only live path that is *after* `confirmAndExecute('finalize')` has already returned (`app/api/lock/local/route.ts:97-119` precedes `151-160`), so it is not the lock's signing time either — `exec.lockedAt` is available on line 123 and is not used.

More fundamentally: **nothing signs the derivative.** No C2PA manifest, no witness leaf, no ECDSA signature covers those bytes or that timestamp. There is no signer whose timestamp this could be. The claim in `lib/v2/capabilities.ts:98` — *"An imperceptible mark carrying a signing timestamp"* — is returned to plugins today as an available capability, and it overstates what the embedder produces.

Fixing this is not cosmetic and it is not free; §5 and §6 specify it.

### §9.2 body — "recoverable from pixels or audio alone": **MET for pixels in the narrow case, NOT MET as the design doc claims it**

Recoverable from pixels alone in the sense that matters legally — no metadata, no sidecar, no lookup — yes, for tiers 1–3. The verifier CLI demonstrates it (`packages/scruple-verify/src/watermark_verify.mjs:99-115`).

But `WATERMARK_DESIGN_v1.md §9` claims survival of "JPEG re-encoding at quality ≥ 60", "Resize to 50% of original", "Crop to ≥ 60% of original", and "Common social-platform re-encoding". I measured all of these on a 512×512 photographic-style image (smooth gradient + Gaussian noise), tier-3 payload:

```
PSNR vs master: 42.40 dB          ← matches the "invisible" claim

identity PNG                 -> RECOVERED
WebP q90                     -> RECOVERED
JPEG q95                     -> RECOVERED
JPEG q80                     -> RECOVERED
JPEG q75                     -> RECOVERED
JPEG q70                     -> RECOVERED
JPEG q65                     -> none
JPEG q60                     -> none          ← claimed to survive
resize 90%                   -> none          ← claimed to survive at 50%
resize 50%                   -> none          ← claimed to survive
crop 90% (top-left)          -> none          ← claimed to survive at 60%
crop 90% (centred)           -> none
unwatermarked master         -> none          ← correct negative
```

The perceptual claim holds exactly (42.4 dB against a stated target of ~42). The robustness claims do not.

**The mechanism, isolated.** The decoder has no synchronisation. `image_dct.py:174-175` maps bit index `i` to block `(i // n_blocks_w, i % n_blocks_w)` where `n_blocks_w = w // 8` is computed from **the received image**, not the original. Any change to width re-indexes every bit. Confirmed by three targeted transforms:

```
crop bottom only (width kept, 512→512×400)  -> RECOVERED
crop right       (width 512→456, 8-aligned) -> none
shift 1px left   (width 512→511)            -> none
```

So it is not compression fragility that breaks crop and resize — it is that there is no sync template, no block-grid search, and no width-invariant embedding order. This is a fixable design gap (a repeated tiling with a correlation-based grid search is the standard remedy), but it is not fixed, and **the JPEG threshold is ~q70, not q60**, which is below Twitter/X and Instagram's typical re-encode.

`WATERMARK_DESIGN_v1.md §9` and `§10.2`'s "Effective — measured against the survival matrix" should be corrected before any of it is shown to a regulator. That is an evidence-claim-above-implementation problem of exactly the kind `L2_FLOOR.md §4` H-5 names.

### One more §9.2 conformance gap, in `capabilities.ts`

`lib/v2/capabilities.ts:54-57` returns `available: true` for **any** `image/*`, `video/*` or `audio/*` MIME except SVG. `apply.ts:59` skips everything that is not `output_kind='image'`, and no video or audio encoder exists.

So `GET /api/v2/capabilities?mime=video/mp4` answers "available: An imperceptible mark carrying a signing timestamp, recoverable from the pixels or audio alone," and `POST /v2/mark` accepts the modality (`mark/route.ts:86-95` passes the gate) before reporting it outstanding. `test/v2/capabilities.test.ts:15` asserts this behaviour as correct.

That is the same failure mode D-7 exists to prevent, inverted: instead of a client hiding a button that should be shown, the server offers a modality it cannot perform. Under the canon skeleton's own fail-closed rule (`CANON_SKELETON.md §5`, property 2) `isWatermarkable` should be narrowed to the raster set the encoder actually handles, with an honest reason for video and audio.

---

## 3. §9.3 SCR_ID watermark — is it implemented?

**The canon audit is correct: coded, never invoked. I verified it four ways.**

1. `app/api/lock/chain/route.ts` (230 lines, the whole chain-lock pipeline for both the custodial Stripe path and the non-custodial wallet path) contains **no `watermark` token at all**. `grep -n -i watermark app/api/lock/chain/route.ts` → nothing. Same for `app/api/lock/checkpoint/route.ts`.
2. Estate-wide, `watermarkProjectIterations` has exactly one call site: `app/api/lock/local/route.ts:153`, with `tier: 'local-lock'` hardcoded and no `scrId`.
3. `buildPayloadHex`'s tier-4/5 branch (`embed.ts:65-76`) is reachable only from `apply.ts:82`, which is reachable only from that one call site. The chain-lock branch is unreachable in production.
4. `lib/watermark/apply.ts:3-4` documents the intent — *"Called from /api/lock/local (tier 3), /api/lock/chain-\* (tier 4/5)"* — describing a wiring that does not exist.

The only tier-4 exercise anywhere is `scripts/smoke-watermark-e2e.mjs:51`, which hand-builds `SCR_A38E30FF` (an 8-char literal that happens to round-trip) and never touches the lock pipeline. Its own header comment claims step 4 covers *"lib/watermark/apply.watermarkProjectIterations against a fixture-populated iterations row"*; the actual step 4 is the negative case. **No test anywhere imports `lib/watermark/apply.ts`** (`grep -rn "lib/watermark" test/ packages/` → nothing).

So `CANON_SKELETON.md` D-6 is right, and there are two additional obstacles it does not mention:

- **The SCR_ID that would be embedded is the wrong one.** `chain/route.ts:76` computes `preScr = deriveScrId(tree.root, false)` — 6 chars of the root. The witness mints `SCR_ + sha256(root)[0:8]` (`server.js:1215-1217`) and `resolvedScrId` is set from `exec.scrId` (line 130) or `lock.scrId` (line 142). Embedding `preScr` would mark the file with an identifier that names no RVN asset.
- **The 6-character form does not survive the round trip** (§1e). Even if the correct identifier is used, it must be ≥8 hex chars or `_u64_to_scr_id` will return a different string to the verifier.

`SCRUPLE_STANDARD_v1_7.md §9.3` calls this "the in-band component of the chain-lock modality" and §9.5 counts it as one of four independent verification paths. Chain lock currently ships one of the four.

---

## 4. The missing HTTP endpoint

### 4a. Where it lives: a Next route. Not a server in `services/watermark`.

**Recommendation: `app/api/v2/watermark/route.ts`.** The reasoning, in order of weight:

1. **The estate's precedent is unambiguous, and it is the subprocess pattern.** `services/c2pa-signer/` — the more security-sensitive of the two Python services — runs no HTTP server either. `grep -rn "HTTPServer\|uvicorn\|FastAPI" services/c2pa-signer/*.py` → nothing. It is reached by `lib/c2pa/signAsset.ts:320` (`spawn(PYTHON_BIN, [SIGNER_SCRIPT])`) and exposed as a Next route at `app/api/scruple/c2pa/sign/route.ts`. `lib/watermark/embed.ts` is already the analogue of `signAsset.ts`. What is missing is only the route.

2. **The one reason the signer *would* need a server does not apply here.** The C2PA signer's separation exists because the key must stay inside the attested CVM; `CANON_SKELETON.md §7` notes that `asset_path` "on the signer host" is a real interface problem caused by that separation. **Watermarking involves no key.** The payload is a public struct; the mark is not a secret. There is nothing to hold at GPSR C.2.2 custody, so there is nothing to isolate.

3. **A new HTTP server is a net negative against the L2 floor.** `L2_FLOOR.md §3` already grades C.2.5 as Partial, citing `/api/diag/fusion` and `/embed/fusion/debug` as unauthenticated by design. Standing up a byte-accepting Python listener on the app host adds a surface with its own auth, its own rate limiting, its own patch-recency story, and — like `/opt/scruple-witness/` — a strong tendency to end up outside the measured TOE. The subprocess is invoked by an already-authenticated Next route inside the application's trust boundary, which is strictly better.

4. **`/v2` already has the auth, error and scope model.** `requireScope(req, 'mark:write')` (`lib/v2/auth.ts:123-146`) and `v2Error`/`v2Ok` (`lib/v2/http.ts`) exist. A separate service would be the sixth authentication mechanism in an estate that `lib/v2/auth.ts:1-23` is explicitly written to reduce to one.

**Against the recommendation, stated fairly:** `spawnSync` blocks the Node event loop for the duration of the embed. On the 512×512 case the Python round trip is a Python interpreter start plus two DCT passes; on a large canvas output it is meaningfully longer. That is a real argument for a long-lived worker, and the honest answer is that it is an argument for `spawn` (async) rather than `spawnSync` inside the route, not an argument for HTTP. If a warm worker later proves necessary, the right shape is a local job queue behind the same route, not a second public listener.

### 4b. The endpoint

```
POST /api/v2/watermark
```

**Auth:** `Authorization: Bearer sk_...` via `requireScope(req, 'mark:write')`. Session cookies rejected, per `lib/v2/auth.ts:16-19`. The browser lock flow does not use this route — it calls `watermarkAndWitness()` in-process (§6).

**Request** (`application/json`):

```jsonc
{
  "leaf_id": "1471",              // required. An iterations.id the caller owns.
  "tier": "local-lock",           // optional. Default: derived from the project's
                                  //   lock state. Enum matches WatermarkTier.
  "output_format": "PNG",         // optional. Default: the master's own format.
  "witness": true                 // optional, default true. false = embed without
                                  //   creating a derivative leaf (dev only).
}
```

Deliberately **no `scr_id` and no `pinned_hint` in the request.** Both are server facts: `scr_id` must be the minted identifier from the witness response, never a caller-supplied string. This also closes the `embed.ts:74` interpolation hole by construction — the only `scrId` that ever reaches `buildPayloadHex` is one the server read out of its own `projects.scr_id` column, and the route should still validate it against `/^SCRB?_[0-9A-F]{6,16}$/` before passing it.

Deliberately **no raw bytes in v1 of this route.** `WATERMARK_DESIGN_v1.md §7.4` reserves server-side embedding for the SaaS surface, and every SaaS caller already has its bytes in the artifact store keyed by `output_hash`. A `multipart/form-data` variant for direct API callers is a later addition; adding it now means designing an upload limit, a scan, and a retention rule for bytes that have no leaf.

**Response 200:**

```jsonc
{
  "leaf_id": "1471",
  "master_hash": "9f2c…",              // iterations.output_hash, unchanged
  "derivative_hash": "b71a…",          // sha256 of the marked bytes
  "watermark": {
    "tier": 3,
    "tier_name": "local-lock",
    "version": 1,
    "scheme": "dct-v1",
    "payload_hex": "5c130000000068b08980000000000000",
    "signed_at_unix_seconds": 1756400000   // THE value in the payload, not a re-read
  },
  "derivative_leaf": {                 // null when witness:false or the witness is down
    "leaf_hash": "3ac8…",
    "leaf_scheme": "v2.2",
    "witnessed": true,
    "leaf_signature": "MEUCIQ…",       // H-1; null when the signer is disabled
    "leaf_signer_key_id": "ocid1.key…surrogate…",
    "leaf_signature_alg": "ECDSA_SHA_256",
    "independently_verifiable": true,
    "surrogate": true                  // honest, per the surrogate's own posture
  },
  "download_url": "/api/artifact/b71a…",
  "master_preserved": true             // §4.3, asserted explicitly
}
```

**Errors**, all through `v2Error` so the codes are the existing enum (`lib/v2/http.ts:9-19`):

| Condition | Code | Status |
|---|---|---|
| No/invalid key, or missing `mark:write` | `unauthorized` / `forbidden_scope` | 401 / 403 |
| No such leaf, or not the caller's | `not_found` | 404 |
| MIME not watermarkable (CAD, SVG, and — after the narrowing in §2 — video/audio) | `modality_unavailable` | 422 |
| Master bytes not in the local artifact store | `not_found`, detail names the storage pointer | 404 |
| Image below ~216 px per side | `modality_unavailable`, detail quotes the encoder's own message | 422 |
| Project already locked, so the derivative leaf would be refused | `conflict` | 409 |
| Embed subprocess failure | `internal` | 500 |

The 409 matters and is not defensive padding: `services/witness-server/server.js:577` returns 403 `"Project is locked, no new iterations allowed"` for any project with a `locked_projects` row. Returning a marked derivative that could not be witnessed, without saying so, would be the silent-downgrade failure `mark/route.ts:19-22` was written against.

### 4c. `/v2/mark` calls the same function, it does not call this route

`app/api/v2/mark/route.ts:114-121` should stop pushing `watermark` to `outstanding` and instead invoke the shared internal function — not issue an HTTP request to its own server. `CANON_SKELETON.md §6` is right that per-modality endpoints are wrong for *modality selection*; that argument is about atomicity of the recorded selection and does not forbid a byte-level capability route. `/v2/watermark` is the capability; `/v2/mark` remains the one call that records the selection in the leaf.

---

## 5. Where in the Studio flow should watermarking happen?

This is the question. I'll take the two options as posed, add the third that the code actually offers, and then say what I think and why.

### 5a. The constraint that makes it hard, stated precisely

`lib/iterations/ingest.ts:146` — `const outputHash = sha256Hex(p.imageBytes)`.
`lib/iterations/ingest.ts:294-303` — that hash goes to the witness as `contentHash`.
`services/witness-server/server.js:598-609` — it lands in the canonical record as `output_hash` and the leaf is `sha256` of that record.
`services/witness-server/server.js:610` — the HMAC signs the leaf; H-1's `signLeaf` (line 616) signs the same leaf.

So the leaf commits the bytes as they were at ingest. Watermark before that point and the leaf commits marked bytes. Watermark after and the leaf commits bytes that are not the ones anyone will ever see.

There is a second constraint the question does not name, and it is the one that decides the matter:

`services/witness-server/server.js:1172` — `finalize` inserts into `locked_projects`.
`services/witness-server/server.js:577` — `handleWitness` refuses any project with such a row.
`app/api/lock/local/route.ts:97-119` — finalize runs.
`app/api/lock/local/route.ts:151-160` — the watermark runs *after* it.

**The current sequencing makes a witnessed derivative structurally impossible.** `watermark_derivative_leaf_hash` is not merely unwritten; the witness server would 403 the request. That is why the column has been NULL since migration 038 landed.

### 5b. Option A — in the Modal container, before the bytes come back

**For.**

- The unmarked bytes would never exist outside the compute boundary. That is the cleanest possible EU AI Act Article 50 story: everything the provider places on the market carries the mark from the moment it exists.
- On `ComfyUIH100CC` (`modal/canvas_app.py:247-254`) the container is the attested compute. A mark applied there inherits whatever attestation that class carries.
- One leaf. No derivative, no lineage bookkeeping, no second hash, no `master_hash`/`ingredient_master_leaf_hash` machinery.
- Studio has the best claim to this of any integration, because Scruple controls the whole container.

**Against.**

- **There is nowhere to put the code.** `modal/canvas_app.py:205-254` declares four classes whose entire body is `_start_comfy()` and a bare `@modal.web_server(port=8188)`. Modal proxies straight to unmodified ComfyUI. There is no Scruple process in the container. The auth shim that would give you one is explicitly a follow-up that has not shipped (`canvas_app.py:177-186`, "canvas-v2-04a"), and the `scruple_nodes` pack was **deliberately removed** from the image (`canvas_app.py:116-124`). You would be reversing a decision that was made on good grounds.
- **The image would change, and the image is in the leaf.** Adding a custom `SaveImage` node or a shim means new `run_commands` and a new pip dep — `reedsolo` is absent from both Modal images (`grep -n reedsolo modal/*.py` → nothing; numpy, scipy and Pillow are present at `canvas_app.py:60-66`). That changes the machine manifest, hence `manifest_hash`, hence `machine_manifest_hash` in the v2.2 leaf preimage (`server.js:292-303`). Every machine re-baselines. That is not a reason never to do it; it is a reason it is not a small change.
- **The container cannot know the tier, and the tier is the payload.** At generation time the SCR_ID does not exist — it is derived from a Merkle root over leaves that do not exist yet. A tier-1/2/3 timestamp minted in the container is a *generation* timestamp, and §9.2 asks for a signing timestamp. `WATERMARK_DESIGN_v1.md §11` states the row plainly: **Generate → watermark: never — invariant.**
- **It breaks §4.3, the one invariant the design doc marks unconditional**, and it breaks it in the product where it costs most. Studio has **Kohya inside it**. The canonical Studio loop is generate → feed the output back as img2img/ControlNet input, or into a LoRA training set. `WATERMARK_DESIGN_v1.md §10.1` says this in as many words: marking pipeline-input images "degrades downstream model output and can poison training data, defeating the mark's purpose," and it is the technical-feasibility argument Scruple's own Article 50(2) mapping rests on. Marking at generation would mean Studio trains LoRAs on watermarked pixels.
- **It marks everything, including the discards.** An artist generates dozens of images per session and keeps two. §10.1 explicitly scopes the modality to "content the provider places into the market, not internal artifacts."
- **It marks the previews.** `/view` is how ComfyUI renders thumbnails in its own UI, which the proxy comment at `route.ts:70-73` acknowledges. The artist's on-canvas image would be the marked one, so they would be judging quality through the mark.

### 5c. Option B — at the proxy, in `captureOutput`, before ingest hashes

Not in the question as posed, but it is the option the code most invites, so it deserves a hearing.

`lib/canvas/witness.ts:74-81` receives `bytes: Buffer` and passes them to `ingestIteration` at 126-144. `ingest.ts:146` hashes them. Inserting an embed between those two lines makes the leaf commit the marked bytes with **no container change, no Modal deploy, no manifest change**.

**Against.** It has all of Option A's semantic problems — same §4.3 violation, same "no honest tier at capture time", same marking of previews and discards — while adding one of its own: the browser gets the *unmarked* bytes. The proxy streams `upstreamRes.body` back at `route.ts:334` while the capture tee runs fire-and-forget at `206-227`. So the artist sees one image and the archive holds a different one. Making them agree means buffering every `/view` response and re-emitting it, which gives up streaming on the hot path for every thumbnail load.

Option B is the cheapest way to get a marked, hash-committed artifact, and it is cheap precisely because it does the wrong thing efficiently.

### 5d. Option C — server-side at publication, after ingest

This is what the code does today (`app/api/lock/local/route.ts:145-160`).

**For.**

- Matches `WATERMARK_DESIGN_v1.md §4.2`, `§4.3` and `§11` exactly, and matches `SCRUPLE_STANDARD_v1_7.md §9.3`'s framing of the SCR_ID mark as a *chain-lock* component.
- The tier is knowable and truthful: local lock → 3; chain lock → 4/5 with the real minted SCR_ID.
- The master stays clean, so Studio's own iterate-and-train loop is untouched, and the two-download UX already built at `app/receipt/[scrId]/page.tsx:565-623` makes the distinction visible to the artist.
- Marks only what is published. Discards cost nothing.
- Reaches every integration on the ingest path at once, not just Studio — the same leverage argument that made Gap 2 the right first move.

**Against — and this is the whole of the cost.**

- **The released bytes are committed by nothing.** The leaf commits `output_hash`, which is the master. The derivative has a hash, a row, and no leaf. The evidence covers the file nobody sees; the file in the world is outside the chain. For a company whose product is evidence, that is exactly inverted.
- **It cannot be fixed in the current order**, per §5a: finalize precedes the watermark and seals the project against new leaves.
- The `signed_at` in the payload is an app-tier clock reading, not a signer's (§2).

### 5e. Recommendation

**Option C — publication-time, server-side — but reordered so the derivative is witnessed before the project seals, and with the derivative leaf carrying master lineage.**

The reason to reject A and B is not that they are hard. It is that the hash problem the question raises is a *symptom*, and marking early cures the symptom by destroying the thing the master invariant protects. Studio is the single worst place in the estate to mark at generation, because Studio is the one product with a trainer inside it. The right response to "watermarking after hashing changes the bytes" is not "hash later" — it is **"then witness the changed bytes too."**

Concretely, the order inside a lock route becomes:

```
1.  build Merkle over the master leaves                 (unchanged)
2.  derive the tier's payload
3.  embed  → derivative bytes → derivative_hash
4.  WITNESS the derivative leaf                          ← project still unlocked
      contentHash = derivative_hash
      master_hash = output_hash
      ingredient_master_leaf_hash = the master's leaf_hash
      watermark_payload_hex = the embedded payload
5.  persist watermark_derivative_leaf_hash               ← the NULL column, finally
6.  rebuild the Merkle over master + derivative leaves
7.  confirmAndExecute('finalize' | 'chain-lock-*')       ← seals the project last
```

Steps 4 and 6 are the change. Both are on the app side of the boundary except for the witness server's willingness to carry three extra fields, which brings me to a piece of good news:

**The derivative-leaf shape is already designed and already validated — in the wrong module.** `lib/witness/ingest.ts:45-51` declares `master_hash`, `watermark_payload_hex` and `ingredient_master_leaf_hash`, citing "WATERMARK_DESIGN_v1.md v1.2 §7.4". Lines 219-244 validate them properly and together: all-three-or-none, 64-hex for the two hashes, 32-hex for the payload, magic byte `5c` asserted at line 234, version nibble asserted at 238.

And then **the values are dropped on the floor.** They are not in the v2.3 preimage, not in the v2.4 preimage (`grep -n "master_hash\|watermark" lib/witness/canonicalLeafV23.ts lib/witness/canonicalLeafV24.ts` → nothing), and not in the `INSERT INTO log_leaves` column list (`lib/witness/ingest.ts:332-353`). A caller can submit a perfectly-formed derivative lineage to `/api/v1/log/{stream}` and receive a leaf that commits none of it.

That module is the Continuous Audit API path, not Studio's. Studio goes to `services/witness-server/server.js`, which has **no concept of watermarks at all** (`grep -rn -i "watermark\|master_hash\|derivative" services/witness-server/*.js` → nothing).

So the honest scope for step 4 is: extend `canonicalRecordV22` into a `v2.3` scheme carrying `master_hash` and `watermark_payload_hex`, and mirror the validation that `lib/witness/ingest.ts:219-244` already got right. That is a witness-server change, which — per Phase 1's finding — means it also depends on the deployment question, since `/opt/scruple-witness/server.js` does not track git.

**Two circularities to name, because they are real and one of them has no clean answer yet.**

*The SCR_ID circularity.* For chain lock, the tier-4 payload needs the SCR_ID; the SCR_ID derives from the Merkle root; if derivative leaves join the root, the root depends on the payload. Three ways out:

- **(i) Derive the SCR_ID from the master-only root** — which is exactly what `chain/route.ts:76` already does — embed that, and let the derivative leaves chain via `prev_record_hash` without entering the anchored root. Reachable through the witness log, not through a Merkle proof. Weaker, but correct and available today.
- **(ii) Anchor `sha256(master_root ‖ derivative_root)`.** Correct end state. Changes what an SCR_ID means and needs the witness server.
- **(iii) Carry the derivative hashes in the lock package** — `buildLockPackage` / `recordPackageHash` already run at `chain/route.ts:210-211` — and in the RVN asset metadata.

Recommend **(i) plus (iii)** now, **(ii)** as the stated end state. And whichever is chosen, the embedded identifier must be the **minted** SCR_ID (`exec.scrId` / `lock.scrId`), padded to ≥8 hex chars so `_u64_to_scr_id` round-trips, with the `SCRB_` prefix preserved.

*The timestamp circularity.* §9.2 wants a signing timestamp; the payload must be embedded before the derivative is hashed, which is before it is witnessed, so the witness's `server_timestamp` cannot be inside the payload it commits to. The pragmatic resolution: mint the second app-side, embed it, and **pass that same integer** into both `watermark_signed_at` and the derivative leaf's record — so the timestamp is *attested by* an ECDSA-signed leaf even though it was *generated by* the app tier. That is defensible and it should be documented as exactly that, not dressed up as a signer timestamp. It also fixes the double-clock-read at `apply.ts:114` for free.

---

## 6. Exact changes to Studio

Before/after descriptions. Nothing here was applied.

### Change 1 — `lib/watermark/apply.ts`: return the payload's own timestamp; stop re-reading the clock

*Before* (`apply.ts:82-116`): `buildPayloadHex` is called without `signedAtUnixSeconds`, so the second is minted inside `embed.ts:59` and thrown away; line 114 reads the clock again for the DB column.

*After:* mint `const signedAt = Math.floor(Date.now()/1000)` once in `watermarkProjectIterations`, pass it as `signedAtUnixSeconds` for tiers 1–3, store `new Date(signedAt*1000).toISOString()` in `watermark_signed_at`, and add `signedAtUnixSeconds` to `ApplyResult` so the caller can put the same integer in the derivative leaf. The `watermark_signed_at` column and the payload then agree by construction.

### Change 2 — `lib/watermark/apply.ts`: add per-iteration application, not just per-project

*Before:* the only entry point is `watermarkProjectIterations(input)`, which sweeps a whole project.

*After:* extract `watermarkIteration(iterationId, opts): IterationWatermarkResult` containing the body of the loop at `apply.ts:57-125`, and reduce `watermarkProjectIterations` to a loop over it. `/api/v2/watermark` needs the single-row form; the lock routes keep the sweep. No behaviour change to the existing caller.

### Change 3 — new `lib/watermark/witness.ts`: `watermarkAndWitness()`

New file. Composes Change 2 with a witness call, and is the single place both `/api/v2/watermark` and the lock routes enter:

```
watermarkAndWitness({ iterationId, tier, scrId?, pinnedHint? })
  → watermarkIteration(...)                      // embed + storeArtifact
  → witness.witnessIteration({                   // NEW derivative leaf
        projectId, runSequence: <next>,
        contentHash: derivativeHash,
        masterHash: master output_hash,          // new field
        watermarkPayloadHex: payloadHex,         // new field
        ingredientMasterLeafHash: master leaf_hash,
        workflowHash / modelFingerprintsHash / machineManifestHash: carried from the master row
    })
  → UPDATE iterations SET watermark_derivative_leaf_hash = <leaf_hash>,
                          watermark_derivative_witnessed = <0|1>
  → returns { derivativeHash, payloadHex, signedAt, derivativeLeaf | null }
```

The witness call must be non-blocking in the same sense `ingest.ts:304-306` is: a witness outage leaves a marked derivative with a NULL leaf hash and an explicit `witnessed: false`, never a silent claim.

### Change 4 — `lib/scruple/witness.ts`: declare the three derivative fields

*Before* (`witness.ts:7-28`): `WitnessIterationInput` carries `contentHash`, `inputHash`, `workflowHash`, `modelFingerprintsHash`, `machineManifestHash`.

*After:* add `masterHash?`, `watermarkPayloadHex?`, `ingredientMasterLeafHash?`, and send them in the `postJson` body at lines 142-154 as `master_hash`, `watermark_payload_hex`, `ingredient_master_leaf_hash`. Pre-change witness servers ignore unknown fields harmlessly — the same argument the `machine_manifest_hash` comment makes at line 152. Mirror Phase 1's `leaf_signature` fields on `WitnessIterationResult` so the derivative leaf's H-1 signature is captured too.

### Change 5 — migration 042: two columns on `iterations`

```sql
ALTER TABLE iterations ADD COLUMN watermark_derivative_witnessed INTEGER;
ALTER TABLE iterations ADD COLUMN watermark_derivative_leaf_scheme TEXT;
```

`watermark_derivative_leaf_hash` already exists unused from migration 038:25-27. Under Phase 1's proposal the derivative leaf also wants its own `leaf_signature` / `leaf_signer_key_id` / `leaf_signature_alg` columns; whether those live on `iterations` or in a `watermark_derivatives` side table is a modelling call — a side table is cleaner, because §4.4 contemplates multiple derivatives per master over an artifact's life (day-1 local lock, day-30 chain lock) and the current single-column design silently overwrites the first.

### Change 6 — `lib/types.ts`: declare the watermark columns on `IterationRow`

*Before:* `grep -n watermark lib/types.ts` → nothing. `apply.ts:48-51` casts through `Pick<IterationRow, …>` for columns the type does not have, and `app/receipt/[scrId]/page.tsx:568-574` casts through `as unknown as {…}`.

*After:* add the six migration-038 columns plus the migration-042 ones to `IterationRow` and delete both casts.

### Change 7 — `app/api/lock/local/route.ts`: move the watermark **before** the finalize

This is the load-bearing edit.

*Before:* `confirmAndExecute('finalize')` at 97-103 → merkle/status transaction at 124-141 → watermark at 151-160.

*After:*

```
 79  leaves = iterations.map(i => i.leaf_hash)
 80  tree   = buildMerkle(leaves)
 --  NEW: watermarkResult = watermarkAndWitnessProject({ projectId, tier: 'local-lock' })
 --  NEW: if any derivative leaves were witnessed, rebuild:
 --         tree = buildMerkle([...leaves, ...watermarkResult.derivativeLeafHashes])
 83  scrId  = deriveScrId(tree.root, false)
 97  exec   = await witness.confirmAndExecute({ ... merkleRoot: tree.root ... })
124  the existing transaction, unchanged
```

Keep the existing failure posture verbatim: `app/api/lock/local/route.ts:149-150` says errors here do not roll back the lock, and that stays true — a watermark failure logs and proceeds with the master-only tree. What changes is only that the *successful* case now produces witnessed derivatives, and that the Merkle root commits them.

Note the ordering interaction with the 409 in §4b: once this lands, `/api/v2/watermark` on an already-locked project is genuinely impossible, and the 409 is the honest answer rather than a placeholder.

### Change 8 — `app/api/lock/chain/route.ts`: wire tier 4/5 (§9.3, D-6)

*Before:* no watermark reference. `resolvedScrId` is captured at line 130 or 142 and used only for the `projects` UPDATE.

*After*, inserted between the witness response (line 159) and the transaction (line 171):

```ts
const wmTier = tier === 'pinned' ? 'chain-lock-pinned' : 'chain-lock-basic';
if (scrId) {
  watermarkResult = watermarkAndWitnessProject({
    projectId: body.projectId,
    tier: wmTier,
    scrId,                              // the MINTED id, not preScr
    pinnedHint: tier === 'pinned' ? computePinnedHint(ipfsCid, arweaveTxId) : undefined,
  });
}
```

Three constraints on this edit:

- `scrId` must be `resolvedScrId` (line 163), never `preScr`. They are different identifiers (§1e).
- The value must be ≥8 hex characters after the prefix or it will not round-trip. Either widen `deriveScrId` (`lib/scruple/hash.ts:20-23`) to 8, or normalise at the payload boundary. Widening `deriveScrId` changes SCR_IDs for future locks and must not be applied retroactively.
- `computePinnedHint` does not exist. `WATERMARK_DESIGN_v1.md §3.1` defines `pinned_hint` as "a short lookup key that resolves the IPFS CID and Arweave txid through the RVN asset's chain metadata" and does not specify the derivation. **UNVERIFIED — there is no implementation anywhere in the repo and no test vector.** Until it is specified, tier 5 should embed tier 4's payload and the response should say so, rather than invent a hint that no resolver understands. This is the one part of D-6 that is genuinely blocked on a spec decision rather than on code.

Note that this route also has `if (false && REQUIRE_PAYMENT && !body.paymentIntentId)` at line 48 — a disabled payment gate on the $100/$150 path. Out of scope for Phase 2, flagged because anyone editing this file will touch it.

### Change 9 — `app/api/v2/mark/route.ts`: apply the watermark instead of reporting it outstanding

*Before* (lines 114-121): pushes `{modality: 'watermark', reason: 'No watermark service endpoint exists yet…'}`.

*After:* call `watermarkAndWitness({ iterationId: leaf.id, tier: … })`. On success push `'watermark'` to `applied` and return the derivative block. On failure keep the outstanding entry with the real reason — the §7 posture at line 118 is right and should survive the change.

### Change 10 — `lib/v2/capabilities.ts`: narrow `isWatermarkable` to what exists

*Before* (lines 54-57): every `image/*`, `video/*`, `audio/*` except SVG returns available.

*After:* an explicit allowlist matching the encoder — `image/png`, `image/jpeg`, `image/webp`, `image/tiff`. Video and audio return `available: false` with a reason naming the gap: "§9.2.2 video and §9.2.3 audio embedders are not implemented; only still-image marking ships today." `test/v2/capabilities.test.ts:15` will need updating, and that is the point — the test currently asserts a capability the server does not have.

### Change 11 — `lib/watermark/embed.ts`: three small corrections

- Send `output_quality` in the job object at lines 114-120 so the declared field at line 89 stops being a lie. Studio outputs are PNG, so this is not urgent for Studio; it matters the moment a JPEG master is marked.
- Validate `scrId` against `/^SCRB?_[0-9A-Fa-f]{6,16}$/` before line 74's interpolation.
- **Preserve alpha.** `image_dct.embed_image` (`image_dct.py:99-139`) must split off an `A` band before the YCbCr conversion and re-merge it after, instead of `.convert('RGB')` at line 139. Measured today: an RGBA master returns an RGB derivative. For a Studio product that emits transparent PNGs this is a data-loss bug on the released artifact, not a nicety.

### Change 12 — `app/api/artifact/[hash]/route.ts`: content-type for derivatives

*Before* (lines 21-23): looks up `metadata` `WHERE output_hash = ?`. A derivative hash matches no `output_hash`, so the receipt page's "Release (watermarked)" link (`app/receipt/[scrId]/page.tsx:595-604`) serves `application/octet-stream`.

*After:* fall back to `WHERE watermark_derivative_hash = ?` when the first lookup misses.

### What does **not** change

`modal/canvas_app.py`, `modal/scruple_runner.py`, `app/canvas-proxy/[sessionId]/[[...path]]/route.ts`, `lib/canvas/witness.ts`, `lib/canvas/manifest.ts`, `lib/iterations/ingest.ts`.

That is the point of choosing Option C. No container rebuild, no manifest change, no re-baselining, no Modal redeploy, and the hot path stays a pure passthrough. **Studio gains §9.2 without a single line changing inside the container or on the capture path.**

---

## 7. How to test with the surrogate

The safety posture is Phase 1's, unchanged and non-negotiable: `lib/scruple/witness.ts:5` defaults to `http://127.0.0.1:5799` when `WITNESS_SERVER_URL` is unset, and `services/witness-server/server.js:552-570` refuses only `tenant:` and `baseline:` prefixes — which does **not** protect this path, because Studio ingests with a bare integer project id.

### 7.1 Environment — set this first, in the same shell, before anything else

```bash
mkdir -p /tmp/studio-l2-wm
cd /data/scruple-web

export WITNESS_SERVER_URL="http://127.0.0.1:5899"      # scratch witness, NOT 5799
export SCRUPLE_DB_PATH="/tmp/studio-l2-wm/app.db"      # scratch app DB
[ "${WITNESS_SERVER_URL}" = "http://127.0.0.1:5899" ] || { echo "REFUSING"; return 1; }

export SURROGATE_BASE="http://127.0.0.1:8799"
export SURROGATE_KEY_OCID="ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey"
```

### 7.2 Surrogate — already live

Verified during this investigation:

```
$ curl -s -D- -m2 http://127.0.0.1:8799/health
HTTP/1.0 200 OK
X-Scruple-Surrogate: 1
{"ok": true, "service": "cvm-surrogate", "surrogate": true, "region": "us-surrogate-1", …}
```

If it is not running: `nohup python3 services/cvm-surrogate/surrogate.py > /tmp/studio-l2-wm/surrogate.log 2>&1 &`

### 7.3 Scratch witness on 5899, git copy, H-1 enabled

Identical to Phase 1 §6.3 — the derivative leaf must be ECDSA-signed by the surrogate or the interesting assertion in 7.7 cannot be made.

```bash
export NODE_PATH=/opt/scruple-witness/node_modules            # ABI matches: node v20.20.2 both sides
export SCRUPLE_WITNESS_SECRET="$(openssl rand -hex 32)"

PORT=5899 \
DB_PATH=/tmp/studio-l2-wm/witness-scratch.db \
SCRUPLE_WITNESS_KMS_ENDPOINT="$SURROGATE_BASE" \
SCRUPLE_WITNESS_KMS_KEY_OCID="$SURROGATE_KEY_OCID" \
SCRUPLE_WITNESS_KMS_PUBKEY_URL="$SURROGATE_BASE/testnet/pubkey.pem" \
node services/witness-server/server.js > /tmp/studio-l2-wm/witness.log 2>&1 &

curl -s http://127.0.0.1:5899/api/signer | python3 -m json.tool     # gate on self_check.ok
curl -s "$SURROGATE_BASE/testnet/pubkey.pem" > /tmp/studio-l2-wm/leaf-pub.pem
```

`DB_PATH` is mandatory — `server.js:94` otherwise drops a database into the working tree.

### 7.4 Layer 0 — the encoder, standalone, no server

This is the layer that already exists and the one that produced the §2 findings. Run it first because if it regresses nothing above it is meaningful.

```bash
python3 -m services.watermark.payload      # prints tier 1/4/5 vectors + decodes
python3 -m services.watermark.image_dct    # 256×256 gradient embed → decode → negative case
node scripts/smoke-watermark-e2e.mjs       # 5 steps, TS wrapper + scruple-verify CLI
```

Add a robustness harness that asserts the *measured* matrix rather than the design doc's. My results, reproducible from §2, are the baseline; a green test that asserts "survives resize 50%" would be asserting a falsehood.

### 7.5 Layer 1 — the Studio capture path, no Modal, no ComfyUI

`captureOutput` (`lib/canvas/witness.ts:74`) is what the proxy actually calls (`app/canvas-proxy/[sessionId]/[[...path]]/route.ts:216`), and its whole contract with the proxy is bytes plus a `canvas_pending_iterations` row. So the real path runs headless:

```bash
npm run db:migrate
sqlite3 /tmp/studio-l2-wm/app.db "PRAGMA table_info(iterations);" | grep watermark_derivative_leaf
```

Then, via `tsx`: insert a project (`is_active=1`) and a `canvas_pending_iterations` row with a workflow JSON, generate a ≥512×512 RGB PNG, and call `captureOutput({ sessionId, userId, machineId: 't4-free', filename: 'ComfyUI_00001_.png', bytes, contentType: 'image/png' })`.

Assert: an `iterations` row exists, `witnessed=1`, `leaf_scheme='v2.2'`, `output_hash` = sha256 of the clean bytes, and `artifacts/<hash[:2]>/<hash>` holds them byte-identically.

### 7.6 Layer 2 — watermark and witness the derivative

Call `watermarkAndWitness({ iterationId, tier: 'local-lock' })` (Change 3).

Assert, in order:

1. `iterations.output_hash` is **unchanged** and `readArtifact(output_hash)` returns bytes byte-identical to what was ingested — §4.3, the master preservation invariant, asserted as a test rather than as a comment.
2. `watermark_derivative_hash` is set and differs from `output_hash`.
3. `watermark_derivative_leaf_hash` is **not NULL**. This single assertion is the whole of Phase 2; it is NULL today and structurally cannot be otherwise.
4. `decodeImageWatermark(readArtifact(watermark_derivative_hash))` returns `{tier: 3, version: 1, signedAtUnixSeconds: T}` where `T` equals `Date.parse(watermark_signed_at)/1000` exactly — the double-clock-read regression test.
5. `decodeImageWatermark(readArtifact(output_hash))` returns `null`.
6. The scratch witness log shows a second `[WITNESS]` line for the same project with the next `run_sequence` and `prev_record_hash` = the master's leaf.

### 7.7 Layer 3 — the assertion that actually matters

A third party verifies the **released** file with no Scruple secret:

```bash
node packages/scruple-verify/src/cli.mjs watermark \
     --input /tmp/studio-l2-wm/release.png --json
```

→ `verdict: VALID`, `tier: 3`, `dispatch.type: self-contained`, `signed_at_iso` matching.

Then, separately, verify the derivative leaf's ECDSA signature against `/tmp/studio-l2-wm/leaf-pub.pem` using only `leaf_hash` and `leaf_signature` — no `SCRUPLE_WITNESS_SECRET` in the verifying process's environment. The two together are the claim: *the bytes in the wild carry a mark, and the leaf that commits those exact bytes is signed by a key a stranger can check.* Neither half alone is worth anything.

The response must report `surrogate: true`. A test asserting `protectionMode: SOFTWARE` on the key metadata belongs here too, for the same reason `services/cvm-surrogate/README.md:46-50` gives.

### 7.8 Layer 4 — tier 4/5, once Change 8 lands

Point `witness.lockProject` at the scratch witness with the RVN executor disabled so `mintError` is populated and `proofTxId` is null, and assert:

- The embedded SCR_ID equals the value persisted on `projects.scr_id`, **not** `preScr`.
- `decodeImageWatermark(...).scrId` string-equals that value — the `_u64_to_scr_id` round-trip regression, which fails today for every 6-character ID.
- `SCRB_` survives on the persistent tier.

### 7.9 Teardown

```bash
kill %1 %2 2>/dev/null
rm -rf /tmp/studio-l2-wm
unset WITNESS_SERVER_URL SCRUPLE_DB_PATH
```

Do not `unset WITNESS_SERVER_URL` before killing the witness. And never run any of §7.5–§7.8 with that variable unset — an unset variable **is** production.

---

## Summary of the proposed change set

| # | Change | Where | Size |
|---|---|---|---|
| 1 | One clock reading, shared by payload and column | `lib/watermark/apply.ts:82-116` | trivial |
| 2 | Extract `watermarkIteration` | `lib/watermark/apply.ts:57-125` | small |
| 3 | `watermarkAndWitness()` — embed then witness the derivative | new `lib/watermark/witness.ts` | **medium — the core** |
| 4 | Three derivative fields on the witness client | `lib/scruple/witness.ts:7-28`, `142-154` | small |
| 5 | Migration 042 — two columns (or a `watermark_derivatives` table) | `lib/db/migrations/` | small |
| 6 | Declare watermark columns on `IterationRow` | `lib/types.ts` | trivial |
| 7 | **Watermark before finalize, not after** | `app/api/lock/local/route.ts:79-160` | **medium — unblocks everything** |
| 8 | Tier 4/5 on chain lock (§9.3, D-6) | `app/api/lock/chain/route.ts:159-171` | medium; `pinned_hint` blocked on spec |
| 9 | `/v2/mark` applies rather than reports outstanding | `app/api/v2/mark/route.ts:114-121` | small |
| 10 | Narrow `isWatermarkable` to the shipped encoder | `lib/v2/capabilities.ts:54-57` | trivial; breaks a test on purpose |
| 11 | `output_quality`, `scr_id` validation, **alpha preservation** | `embed.ts:114-120`, `74`; `image_dct.py:99-139` | small |
| 12 | Content-type for derivative downloads | `app/api/artifact/[hash]/route.ts:21-23` | trivial |
| — | New endpoint `POST /api/v2/watermark` | `app/api/v2/watermark/route.ts` | small once 1–6 exist |
| — | Witness server carries `master_hash` + `watermark_payload_hex` in the preimage | `services/witness-server/server.js:274-306` | **gated on the deployment question from Phase 1** |
| — | Correct `WATERMARK_DESIGN_v1.md §9` / `§10.2` robustness claims | docs | small, and overdue |

**Sequencing.** 7 before 3 before everything else — the reorder is what makes a witnessed derivative possible at all, and without it changes 3, 5 and 9 write a column the witness will refuse to populate. 10 and 11's alpha fix are independent and can land immediately; both are correctness fixes that make the current behaviour honest.

**What is genuinely blocked, and on what:** the `pinned_hint` derivation (no spec, no test vector, no resolver — a decision, not a task) and the witness-server preimage extension (the same deployment question Phase 1 surfaced: `/opt/scruple-witness/server.js` does not track git). Everything else in the table is reachable today against the surrogate.
