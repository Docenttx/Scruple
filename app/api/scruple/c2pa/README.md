# `POST /api/scruple/c2pa/sign` — the C2PA signing entry point

**Status: working, and until 2026-09-02 it had zero in-repo callers.**

The signer is not a stub and never was. It signs eighteen MIME types to
`validation_state: Valid` through `c2pa-python 0.36.0` — images, MP4,
MOV, AVI and audio — and `services/c2pa-signer/tests/test_format_support.py`
proves each one against the fixture that went to the C2PA conformance
reviewer. What was missing was a caller. `components/LockButtons.tsx`
hard-disables its "Sign with C2PA" button, `app/api/v2/mark/route.ts`
answers every `c2pa` request with `outstanding: signer_unavailable`, and
nothing in `lib/canvas/`, `app/canvas-proxy/` or `modal/` mentions it.

This file is the contract for the WO that adds the caller.

---

## Request

`POST /api/scruple/c2pa/sign`, authenticated by `requireUser` (session
cookie or API key).

```jsonc
{
  "project_id": 123,               // required. Must be owned by the caller.
  "iteration_id": 456,             // optional. Defaults to the project's
                                   // highest run_sequence.
  "asset_path": "/abs/path.png",   // required. Absolute path ON THE SIGNER
                                   // HOST. Not a URL, not an upload.
  "product": "studio",             // required. "studio" | "fusion".
  "tier": "witnessed",             // required. bare | witnessed | local | chain.
  "digital_source_type": "TRAINED_ALGORITHMIC_MEDIA",  // REQUIRED. See below.
  "title": "optional"              // optional, ≤200 chars. Defaults to the
                                   // project name.
}
```

### `digital_source_type` is required, is never inferred, and fails closed

This is the field that decides whether the signed manifest asserts
*"generative AI made this"* or *"a human made this with non-generative
tools"*, in a third-party-verifiable document. There is no default at any
layer — not in the route, not in `lib/c2pa/signAsset.ts`, not in
`services/c2pa-signer/sign.py`. Absent or unrecognised is a **400**,
checked before the asset is opened.

There used to be a default of `TRAINED_ALGORITHMIC_MEDIA`, and no plugin
path overrode it, so every Blender render was signed with a claim that
generative AI produced it. `037c89d` removed it. Do not put it back, and
do not infer it from `product`: Studio spans ComfyUI generation
(`TRAINED_ALGORITHMIC_MEDIA`) and hand-authored work.

| Value | Use for |
|---|---|
| `TRAINED_ALGORITHMIC_MEDIA` | GenAI output — the canvas / ComfyUI / Modal flow |
| `DIGITAL_CREATION` | a human in a non-generative tool (CAD, 3D, animation) |
| `ALGORITHMIC_MEDIA` | pure algorithm, no training data |
| `ALGORITHMICALLY_ENHANCED` | an input improved by an algorithm |
| `COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA` | a composite including GenAI |
| `HUMAN_EDITS` | human-in-the-loop editing |
| `DATA_DRIVEN_MEDIA` | data-driven synthesis |
| `EMPTY` | declines to state — still a declaration |

The canonical list is `C2PA_DIGITAL_SOURCE_TYPES` in
`lib/c2pa/signAsset.ts`; the route's zod enum is built from it, so the
wire contract cannot drift from the library contract.

### What it accepts, and what it refuses

The format is derived from the asset's extension unless the caller passes
one. One registry decides: `services/c2pa-signer/formats.py`, mirrored in
`lib/c2pa/formats.ts`, checked against each other by
`test/v2/c2pa-reachable.test.ts` and against the installed library by
`services/c2pa-signer/tests/test_format_support.py`.

**Signable (18).** `image/jpeg` `image/png` `image/svg+xml`
`image/x-adobe-dng` `image/tiff` `image/webp` `image/heic` `image/heif`
`image/avif` `image/gif` `image/jxl` · `video/mp4` `video/quicktime`
`video/x-msvideo` · `audio/flac` `audio/mpeg` `audio/wav` `audio/mp4`.

**Refused, by name, before the signer subprocess is spawned:**
`video/webm`, `image/vnd.adobe.photoshop`, `application/x-pytorch`,
`application/octet-stream`, and anything else. c2pa-rs 0.36.0 has no
handler for these; the ceiling is the library, not our configuration, and
the error says so. A `.webm` used to reach c2pa-rs and come back as a 500
that was indistinguishable from the signer being down.

`application/pdf` is **validate-only**: the Reader has a handler, the
Builder does not.

A model checkpoint (`.safetensors`, `.pt`) cannot carry an embedded
manifest at all. The design for it is an external sidecar —
`scripts/puffjuly12/12-emit-lora-sidecar.py` — and it is a separate route.

### Tier gating

`tier` is checked against the project's state before signing, and the
route answers **409** if the project has not reached it:

| tier | requires |
|---|---|
| `bare` | nothing. Emits no `ai.scruple.provenance.v1` assertion. |
| `witnessed` | `projects.scr_id` |
| `local` | `projects.lock_server_signature` |
| `chain` | `projects.rvn_txid` |

## Responses

```jsonc
// 200
{
  "ok": true,
  "signed_path": "/tmp/scruple-c2pa-XXXX/name.c2pa.png",  // a NEW file
  "bytes": 44609,
  "tier": "witnessed",
  "scr_id": "SCR-...",
  "project_id": 123,
  "iteration_id": 456,
  "signing_mode": "local",                    // or "vault"
  "signer_identity": "local:/abs/keys/signer.key",
  "witness": { "leaf_hash": "…", "chain_hash": "…", … }   // when the leaf emitted
  // "witness_error": "…"                     // when it did not. See below.
}
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `undeclared_source_type` | no/unknown `digital_source_type` |
| 400 | — | invalid body, or the asset is not a readable file |
| 401 | — | not authenticated |
| 404 | — | project not found, or not the caller's |
| 409 | — | the project has not reached the requested `tier` |
| **415** | `unsupported_format` | c2pa-rs has no handler for this MIME |
| 500 | `signer_material_missing` | the box has no cert/key — ours to fix |
| 500 | — | the signer failed |

`code` exists so a caller can classify a failure without matching on
prose. Retrying a 415 or a 400 never helps.

## Things a caller has to know

- **The output is a new file in a fresh `mkdtemp` directory.** The route
  does not move it, register it, or clean it up. The caller owns it from
  the 200 onward.

- **`asset_path` is a server-side absolute path.** The route `path.resolve`s
  it and `stat`s it, and there is no upload form. A caller on the
  generation path should pass the path it just wrote.

- **The witness leaf is fail-open.** If `emitC2paSignLeaf` fails, the
  response is still a 200 carrying `witness_error`. The signature is real
  whether or not the leaf landed; the leaf is what makes it findable
  later. A caller that needs the leaf must check for the field.

- **`signer_identity` is not a log line.** It is folded into the canonical
  payload whose sha256 becomes the leaf's `payload_hash`, and only the
  hash is stored. A wrong value is committed into an append-only chain,
  is invisible there, cannot be corrected, and makes a verifier's
  recomputation mismatch — which reads as tampering. Until 2026-09-02 it
  was a hardcoded string naming a key file purged from git on 2026-07-13.
  It now names the key that actually signed, or the sign fails.

- **The signing material is gitignored.** `keys/signer.key` and
  `keys/signer.pem` are not tracked, so a fresh clone signs nothing until
  `services/c2pa-signer/keys/regen-dev-cert.sh` has been run. That is a
  `500 signer_material_missing`, and the error says so.

- **Signing the master is not signing the release.** This route signs
  whatever `asset_path` names, with `intent: CREATE` and no ingredient.
  If a watermarked derivative is ever what the public receives, it needs
  a second call with `intent: 'EDIT'`, a `c2pa.edited` action and the
  master as a `c2pa.ingredient` — none of which exists yet. See
  `docs/canon/demo-readiness/c2pa-watermark.md` §2.4.

## Layers, in order

```
POST /api/scruple/c2pa/sign        auth, project/tier gate, assertion payload
  → lib/c2pa/signAsset.ts          source-type gate, format gate, manifest,
                                   spawn
  → services/c2pa-signer/sign.py   source-type gate, format gate, allowlist
                                   partition, age + patch guards, Builder
  → services/c2pa-signer/vault_sign.py   OCI Vault, or the local key
  → c2pa-python 0.36.0
```

Both gates are enforced at both ends on purpose: `sign.py` has other
callers, and the far end is the one that owns the library.

## Tests that hold this up

- `test/v2/c2pa-reachable.test.ts` — registry agreement, a real PNG and a
  real MP4 signed end to end and read back `Valid`, the refusals, and this
  README against the route's own schema.
- `services/c2pa-signer/tests/test_format_support.py` — every advertised
  MIME signed against its conformance fixture, plus the must-NOT-fire
  control that the refused ones are still refused.
- `services/c2pa-signer/tests/test_leaf_signing.py` — one key resolver, a
  real signer identity, and a loud typed failure when the key is absent.
- `test/v2/digital-source-type.test.ts` — the source-type contract,
  against a stand-in signer, so it needs no key.
