# Patent Delta — 02 — Graph Capture + Iteration Witnessing

**Scruple canonical flow, segment 2 of 5.**

Source: `/data/scruple-web` (feature/pivot), `/opt/scruple-witness/server.js`

## Purpose

Trace each iteration end-to-end: the proxy captures every relevant browser action, the witness server hashes and signs a **Leaf v2.2** record, and chains it via `prev_record_hash`. This is the heart of the system — every claim Scruple makes about an AI artifact ultimately depends on this segment.

## Canonical flow (numbered)

1. **Browser action → proxy intercept** — `[app/canvas-proxy/[sessionId]/[...path]/route.ts:112-113]` — proxy routes `POST /prompt` and `GET /view` through capture hooks; all other ComfyUI API calls pass through unchanged.

2. **POST /prompt capture** — `[route.ts:142-168]`
   - Capture request body — extract the full workflow JSON from `parsedReq.prompt`.
   - Wait for Modal response containing `prompt_id`.
   - Fire-and-forget `startWorkflow()` writes the prompt_id ↔ workflow mapping to `canvas_pending_iterations`.
   - Proxy returns response immediately; does NOT await witness.

3. **GET /view capture** — `[route.ts:170-191]`
   - Capture response body bytes via `upstreamRes.clone().arrayBuffer()`.
   - Extract filename from query string.
   - Fire-and-forget `captureOutput()` pairs with the most-recent pending iteration and triggers `ingestIteration()`.

4. **Hash construction** — `[lib/iterations/ingest.ts:120-191]` — five hashes computed and bound per iteration:

   | Field | Preimage | File:Line |
   |---|---|---|
   | `output_hash` | raw output artifact bytes | `ingest.ts:120` |
   | `input_hash` | canonical JSON `{provider, prompt, spec, inputs:[{kind, hash}, ...]}` | `ingest.ts:164-170` |
   | `workflow_hash` | canonical JSON of `workflowApiJson` (NULL for non-workflow paths) | `ingest.ts:172-177` |
   | `model_fingerprints_hash` | canonical JSON of sorted per-model manifest (each model: safetensors header_hash + full content_hash) | `ingest.ts:179-191` |
   | `machine_manifest_hash` | resolved from `machines` table (user's custom or default); preferred via `ORDER BY user_id IS NULL ASC, created_at DESC` | `ingest.ts:230-246` |

5. **Witness server call** — `[lib/scruple/witness.ts:141-155]` — synchronous POST `/api/witness` with the five hashes + run_sequence + project_id.

6. **Canonical record construction** — `[/opt/scruple-witness/server.js:233-245]` — `canonicalRecordV22()` builds the EXACT field order (immutable across implementations):
   ```
   { run_sequence, output_hash, input_hash, workflow_hash,
     model_fingerprints_hash, machine_manifest_hash,
     server_timestamp, prev_record_hash }
   ```
   `server_timestamp` set at `[server.js:481]` as ISO 8601.
   `prev_record_hash` looked up from prior witness row for same project (run_sequence DESC) at `[server.js:488-494]`; empty string if first.

7. **Leaf scheme selection** — `[server.js:506]` — `leaf_scheme = machine_manifest_hash ? 'v2.2' : 'v2'`. Used by audit script for canonical-form dispatch.

8. **Sign — HMAC-SHA256 (current)** — `[server.js:194-199, 508]` — `crypto.createHmac('sha256', SCRUPLE_WITNESS_SECRET).update(leaf_hash).digest('hex')`. **PATENT-DELTA NOTE: the Standard mandates asymmetric (Ed25519 or ECDSA P-256); current code ships symmetric HMAC.**

9. **Persistence — two tables across two processes**:
   - `witnesses` (witness server DB) — `[server.js:510-524]` — full canonical record + signature + leaf_hash + leaf_scheme.
   - `iterations` (scruple-web SQLite) — `[ingest.ts:283-328]` — bound hashes + witness_id + witness_timestamp + witness_signature + leaf_scheme + chain link.

10. **Chain link** — `previous_hash` (web side) and `prev_record_hash` (witness side) both reference the prior iteration's `leaf_hash` for the same project. Monotonic per-project chain.

11. **End — iteration sealed** — receipt page can render this iteration immediately; audit script can re-derive it from first principles.

## Decision diamonds (for flowchart)

| ID | Where | Condition | Branches |
|---|---|---|---|
| D1 | `route.ts:112` | POST /prompt? | YES → startWorkflow \| NO → passthrough |
| D2 | `route.ts:149` | Modal response contains prompt_id? | YES → write pending row \| NO → skip witness |
| D3 | `route.ts:113` | GET /view + response OK? | YES → capture bytes \| NO → passthrough |
| D4 | `canvas/witness.ts:82-88` | Pending iteration found for prompt_id? | YES → ingest \| NO → log + return |
| D5 | `ingest.ts:258` | Witness server reachable? | YES → await \| NO → catch, witnessed=0 |
| D6 | `ingest.ts:268-270` | Witness succeeded? | YES → use leaf_hash \| NO → fallback to output_hash |
| D7 | `ingest.ts:235-246` | Machine manifest resolved? | YES → bind \| NO → NULL (leaf_scheme='v2') |
| D8 | `ingest.ts:277-281` | Previous iteration exists for project? | YES → chain prev_record_hash \| NO → start chain (empty) |

## State writes per iteration

| Table | Columns | File:Line |
|---|---|---|
| canvas_pending_iterations | prompt_id, session_id, user_id, project_id, workflow_api_json, status | `canvas/witness.ts:43-55` |
| canvas_pending_iterations | status='done' | `canvas/witness.ts:146-151` |
| witnesses (Oracle VM) | witness_id, project_id, run_sequence, content_hash, server_timestamp, signature, input_hash, workflow_hash, model_fingerprints_hash, machine_manifest_hash, prev_record_hash, leaf_hash, leaf_scheme | `server.js:510-524` |
| iterations (web SQLite) | run_sequence, leaf_hash, input_hash, output_hash, previous_hash, workflow_hash, model_fingerprints_hash, machine_manifest_hash, witness_id, witness_timestamp, witness_signature, witnessed, leaf_scheme | `ingest.ts:283-328` |

## External calls

- **Witness server** — `POST /api/witness` (synchronous; web side awaits)
- **Modal upstream** — proxy forwards `POST /prompt` and `GET /view` to per-user container

## Patent-bearing observations

**Browser-side has no provenance code (G-2)** — All hashing and witness logic runs server-side in the proxy + ingest path. Browser is the source of intent (user clicks) but not the source of truth (no client-side cryptography). A compromised browser cannot forge a Scruple leaf.

**machine_manifest_hash bound into every leaf (G-1)** — Custom-node pack, ComfyUI version, dependency lockstate — all collapsed into a single hash that is part of the canonical record. Swapping a custom node mid-session would change the manifest and invalidate the next leaf. This is the toolchain-binding the Standard requires.

**Leaf v2.2 canonical record** — Fixed field order, fixed JSON encoding (compact, no whitespace), empty-string default for missing fields. Identical canonicalization across web and witness sides; identical re-derivation in audit script. `[server.js:233-245, scripts/audit-receipts.py]`

**HMAC vs asymmetric (open patent delta)** — Current code uses symmetric HMAC. The Standard requires asymmetric (Ed25519 / ECDSA P-256) so verifiers can authenticate the witness without holding the secret. Migrating to asymmetric is a tracked follow-up; it does not change the canonical record shape, only the signing key class.

**Three-process atomicity (open patent delta)** — Web ingest, witness server, and DB writes are not fully transactional. If witness fails after Modal returns output, the iteration still persists with `witnessed=0`. Lock operations later detect and reject unwitnessed iterations. This degrade-rather-than-fail behavior is intentional but worth flagging for claim scope.

## Sub-flowchart candidates

- **Failure modes** — what happens at each ◇ when a step fails — useful as a separate diagram for resilience claims.
- **Hash construction detail** — five sub-flows for the five hashes, particularly `model_fingerprints_hash` (per-model fingerprint + fold) which has its own complexity.
