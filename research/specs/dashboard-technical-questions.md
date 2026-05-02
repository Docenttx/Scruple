# Scruple Dashboard — Technical Integration Questions
_Document prepared by the Stooges AI Council codebase session_
_Purpose: answers required before porting the Scruple Studio Workspace Tab to React inside Stooges_

---

## Context: What is Stooges and what is being built

**Stooges** is a web application (Next.js, TypeScript) that runs a multi-model AI council. Users submit a prompt; a conductor routes it to multiple AI models simultaneously (Claude, GPT-4o, Gemini, Grok, and others); each model responds in parallel; the conductor synthesizes the results. Sessions are stored in SQLite. The app runs on an Oracle Linux server — the same machine that runs the Scruple witness server at `localhost:5799`.

**Generative Art Mode** (recently built) adds image generation to the council loop:
1. The user submits an image brief
2. The council debates and refines the generation spec (prompt, size, quality, style, negative prompt)
3. The conductor synthesizes a final `GenSpec`
4. DALL-E 3 and/or Leonardo AI fire simultaneously using the exact spec
5. Images are returned as base64; provenance hashes are already computed server-side

**The Scruple Dashboard** is a new tab inside Stooges — the Scruple Studio Workspace Tab, ported to React. It will display Scruple-Bits (image generation projects), their iteration grids, chain state, lock controls, and SCR-IDs. Scope: DALL-E and Leonardo only. No ComfyUI, no Kohya, no text sessions.

**Critical constraint**: The SCR-ID computation, leaf hash chain, Merkle tree construction, pre_scr_id derivation, witness server API calls, and lock file format must be **byte-for-byte identical** to Scruple Studio. There must be no special Stooges-specific paths on the witness server. A project started in Stooges must be recognizable to Scruple Studio and vice versa.

---

## What Stooges already captures at generation time

When DALL-E 3 or Leonardo fires, `app/api/generate/route.ts` already computes and returns:

```javascript
const inputHash  = sha256(JSON.stringify({ provider, prompt, size, quality, style, negativePrompt }));
const outputHash = sha256(b64);                        // b64 = raw base64 of generated image bytes
const contentHash = sha256(inputHash + outputHash);

const provenanceRecord = {
  provider,
  prompt,
  revisedPrompt,          // DALL-E 3 returns a revised prompt; Leonardo echoes back the original
  size,
  quality,
  style,
  negativePrompt,
  inputHash,
  outputHash,
  contentHash,
  timestamp,              // ISO 8601
  sessionId,              // Stooges session ID
  roundNumber,
  bitId,
};
```

The input to provenance is **not only the image prompt** — it is the complete parameter snapshot at the exact moment the API fires. This includes every generation setting the council produced. The council transcript (how the spec was derived) is linked via `sessionId` but is a separate record; it does not enter the hash chain directly.

**What is missing to complete the Scruple chain:**
- `leaf_hash` computation (requires `previous_hash` chaining)
- `visual_hash` (used in `POST /api/witness` — definition needed)
- `pre_scr_id` assignment at project creation
- The `POST /api/witness` call per iteration
- The `POST /api/lock/:projectId` call at chain-lock tier
- Merkle tree construction to derive the SCR-ID locally
- Project state machine (unlocked → checkpointed → local_locked → chain_locked → ...)

---

## Questions requiring exact answers

### Section 1 — Hashing and leaf chain

**Q1.1 — Leaf hash exact formula**
The summary document states:
```
leaf_hash = SHA-256(previous_hash + content_hash + timestamp)
```
Confirm: is this a SHA-256 over the **concatenation of three hex strings**, or is it `SHA-256(JSON.stringify({previous_hash, content_hash, timestamp}))`? What is the exact encoding — hex strings concatenated, or UTF-8 JSON?

**Q1.2 — First iteration's previous_hash**
What is `previous_hash` for iteration 0 (the first image in a project)? A fixed 64-char zero string (`"0000...0000"`)? The `pre_scr_id` value? Something else?

**Q1.3 — visual_hash**
The witness server call `POST /api/witness` includes a `visual_hash` field. How is this computed? Is it the same as `output_hash` (SHA-256 of raw image bytes/base64)? Or is it a perceptual hash (pHash, dHash)? If perceptual, what algorithm and what library does Scruple Studio use?

**Q1.4 — input_hash canonical JSON**
Stooges currently computes:
```javascript
inputHash = sha256(JSON.stringify({ provider, prompt, size, quality, style, negativePrompt }))
```
Is this the exact field set and key order used in Scruple Studio, or does Scruple Studio include additional fields (e.g., model_id, guidance_scale, num_inference_steps for Leonardo)? Provide the canonical field list and key order so the hash is reproducible.

**Q1.5 — output_hash source**
Is `output_hash` computed from the raw image bytes before base64 encoding, or from the base64 string itself? In Stooges, the image arrives as base64 from both APIs. To compute `sha256(image_bytes)`, we convert base64 → Buffer first. Is this what Scruple Studio does?

---

### Section 2 — Merkle tree

**Q2.1 — Tree construction with odd leaf count**
When the number of iterations is odd, how does Scruple Studio handle the unpaired last leaf? Options: (a) duplicate it, (b) carry it up unmodified, (c) something else. Provide exact code or pseudocode.

**Q2.2 — Node hash formula**
For internal Merkle tree nodes, is the formula `SHA-256(left_child_hash + right_child_hash)` (hex concat)? Or `SHA-256(left + right)` where both are raw bytes? Exact encoding matters for reproducibility.

**Q2.3 — Tree built from what list**
Is the Merkle tree built from `leaf_hash` values in insertion order? Or sorted? If a project has iterations 0–N, is `leaves = [leaf_0, leaf_1, ..., leaf_N]` in that exact order?

---

### Section 3 — pre_scr_id

**Q3.1 — Full derivePreScrId algorithm**
Please paste the complete `derivePreScrId(name, createdAt)` function from `ipc/ipc-lock-handlers.js`. Stooges must use the identical implementation. If there are any helper functions it calls, include those too.

**Q3.2 — When is pre_scr_id assigned**
Is `pre_scr_id` assigned at the moment the user creates a new Scruple project (before any generation), or at the moment of the first generation? In Stooges, the equivalent moment would be when the user starts a new Generative Art session and clicks "New Scruple-Bit."

**Q3.3 — pre_scr_id on the witness server**
Is `pre_scr_id` the same value sent as `project_id` in `POST /api/witness` calls before the project is locally locked? After local_locked, does the project_id on witness calls switch to the real SCR-ID, or remain pre_scr_id throughout?

---

### Section 4 — Witness server API

**Q4.1 — POST /api/witness full request schema**
Provide the complete request body schema for `POST /api/witness`. The summary shows:
```
{ project_id, project_name, run_sequence, content_hash, visual_hash, client_timestamp }
```
Are there additional fields? Is `run_sequence` a zero-indexed integer (0, 1, 2...) or one-indexed? Is `client_timestamp` ISO 8601?

**Q4.2 — Project registration**
Does a project need to be registered with the witness server via a separate call before the first `POST /api/witness`? Or does the first witness call implicitly create the project record on the server?

**Q4.3 — POST /api/lock/:projectId request body**
What fields are sent in the body of `POST /api/lock/:projectId`? Is it just `{}`, or does it include the locally computed Merkle root, the full iteration list, or other data?

**Q4.4 — Witness server Merkle root vs local Merkle root**
After `POST /api/lock/:projectId`, the server returns a `merkle_root`. Does the server compute its own Merkle tree independently from the witnessed iterations, and Scruple Studio validates that this matches the locally computed root? Or does the server simply echo back what was sent? If they can diverge, what is the correct failure behavior?

**Q4.5 — GET /api/witness/:projectId response schema**
Provide the full response schema. Is `iterations` an array of the original witness request bodies, or does the server add fields (e.g., server_timestamp, sequence_confirmed)?

---

### Section 5 — Lock tiers

**Q5.1 — Exact lock state names**
Confirm the exact string values used in Scruple Studio for lock state. Are they:
`"unlocked"`, `"checkpointed"`, `"local_locked"`, `"chain_locked"`, `"persistent_locked"`, `"permanent_locked"`?
These need to match exactly in the Stooges DB schema and display logic.

**Q5.2 — Checkpoint serialization**
At checkpoint tier, what exactly is serialized and where? In Scruple Studio, what is the checkpoint file format and path? Stooges needs to mirror this to server-side storage (filesystem + DB). Provide the checkpoint data structure.

**Q5.3 — local_locked: is it reversible?**
Can a user "unlock" back from `local_locked` to `unlocked` in Scruple Studio? Or is `local_locked` the first irreversible tier? If irreversible, does Scruple Studio prevent new generations on a locally-locked project, or does it create a new branched project?

**Q5.4 — chain_locked prerequisites**
Must a project be `local_locked` before it can be `chain_locked`? Or can a user chain-lock directly from `checkpointed` or `unlocked`?

**Q5.5 — Lock record format**
What does the local lock record look like? Provide the full JSON schema written to disk (or DB) when `local_locked` is set. This includes: scr_id, pre_scr_id, merkle_root, leaf_hashes array, iteration_count, locked_at, and any other fields.

**Q5.6 — persistent_locked trigger**
In Scruple Studio, what triggers the `persistent_locked` tier? Is it a manual user action (button click), or does it happen automatically after `chain_locked` succeeds? What storage destination does it target?

---

### Section 6 — Scruple Package format

**Q6.1 — Full package JSON schema**
Provide or paste the complete Scruple Package JSON schema — the format of the exportable provenance file. Stooges must generate an identical format so that a package exported from Stooges can be verified by Scruple Studio (and vice versa).

**Q6.2 — package_hash computation**
How is `package_hash` computed? SHA-256 of the full JSON string? SHA-256 of a canonical subset? What fields are included/excluded from the hash input?

**Q6.3 — Does the package embed image bytes?**
Does the Scruple Package JSON embed the raw image bytes (base64) for each iteration, or only the hashes + metadata? Stooges needs to know whether the package file is self-contained (images inside) or whether it references external image files.

---

### Section 7 — Project data model

**Q7.1 — Full project record schema**
Provide the complete project record schema as stored in Scruple Studio's local DB (or filesystem). Include every field — especially: `id`, `pre_scr_id`, `scr_id` (nullable until local_locked), `name`, `created_at`, `lock_state`, `iteration_count`, `merkle_root`, and any others.

**Q7.2 — Iteration record schema**
Provide the complete iteration record schema. The Stooges iteration has: `iteration_index`, `provider`, `prompt`, `revised_prompt`, `size`, `quality`, `style`, `negative_prompt`, `input_hash`, `output_hash`, `content_hash`, `visual_hash`, `leaf_hash`, `client_timestamp`. Are there fields Scruple Studio adds that are not in this list?

**Q7.3 — Single project per session, or many?**
In Scruple Studio, can a single project contain iterations from different generation providers (e.g., some DALL-E, some Leonardo)? Or is one project always one provider? Stooges supports both providers simultaneously (two side-by-side windows). Should each provider window be a separate Scruple project, or can they be combined?

---

### Section 8 — Edge cases and behavior

**Q8.1 — Regeneration (same parameters, new image)**
If a user clicks "Regenerate" with identical parameters, does Scruple Studio create a new iteration record (new index, new leaf_hash), or replace the previous one? In Stooges, regeneration always appends — confirm this matches Scruple Studio behavior.

**Q8.2 — Failed generation**
If a DALL-E or Leonardo API call fails, does Scruple Studio create any record, or is a failed generation completely invisible to the provenance chain? Stooges currently does not call the witness server on failure — confirm this is correct.

**Q8.3 — Timestamp source**
Is `client_timestamp` the time the generation request was sent, or the time the image was received? In Stooges, the timestamp is set at the moment the response is received (after generation completes). Does this match Scruple Studio?

---

## What Stooges will handle differently (for awareness, no questions)

1. **No Electron, no IPC**: All `window.scruple.*` calls become HTTP calls to Stooges API routes. The logic is identical; only the transport changes.

2. **Fee handling**: All lock tiers will be callable without a payment gate. Stooges is subscription-based. The lock functions themselves are identical; the payment check is skipped for now.

3. **Storage**: In Scruple Studio, everything is local. In Stooges, images live temporarily on the server and are exported to the user's connected personal storage (GDrive) at lock tier progression. Server is transit only, not archive. The Scruple Package format and chain integrity are identical regardless.

4. **Blockchain anchoring**: Not implemented. `permanent_locked` is a stub that marks the project read-only. The chain up to `chain_locked` is fully functional.

5. **Input image provenance (img2img, future)**: Not in scope for this build. When added, input images will enter the `input_hash` via the same canonical JSON approach.

---

_End of document — all answers should aim for exact code, exact field names, exact encoding details. "Approximately" is not sufficient for hash reproducibility._
