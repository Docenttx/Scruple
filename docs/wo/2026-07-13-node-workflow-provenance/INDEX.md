# Node + workflow provenance — WO index (2026-07-13)

**Trigger:** the node-hashing investigation (Session 2026-07-13, memory
`project_node_hashing_gap_and_workflow_provenance_plan_2026_07_13`) found
that the primary provenance claim — "the operator chose THESE nodes,
wired THIS way, with THESE parameters" — was captured in the legacy leaf
(v2/v2.2) but NOT bound to the newer v2.3 /v1/log leaf. This WO set closes
that gap and adds ComfyOrg trusted-set labeling as a viewer-side capability.

## Scope

**WO-set A** — close the v2.3 gap so the audit-side leaf carries the
authorship claim. All shipping.

**WO-set B** — layer in-container node inventory + ComfyOrg trust-list
comparison on top. Shipping code + schema; runner-side changes require
`modal deploy` for Modal-hosted deployments to activate.

Both sets treat the primary goal as HUMAN AUTHORSHIP EVIDENCE. Trust-set
verification is capability, not requirement — an unknown pack is not a
rejection.

## Work orders

| WO   | Title                                                                                 | Status | Commit  |
|------|---------------------------------------------------------------------------------------|--------|---------|
| A1   | canonical leaf v2.4 (`workflow_hash` + `machine_manifest_hash` first-class)          | ✅     | ebbeb1f |
| A2   | canonical `workflow_hash` (sorted-key JSON, not default JSON.stringify)               | ✅     | cfc97df |
| A3   | render raw `workflow_api_json` on receipt page                                        | ✅     | ec865e0 |
| A4   | scruple-verify CLI + audit-receipts.py for v2.4 fields                                | ✅     | d80a782 |
| A5   | `witness-integration.md` — workflow capture as first-class                            | ✅     | 9662f53 |
| B1   | in-container node inventory + real commit_sha in `machine_manifest_hash`              | ✅     | a3479d4 |
| B2   | ComfyOrg trusted-set fetcher + receipt badge labeling                                 | ✅     | c7f945d |

## Load-bearing invariants (do not violate)

- **Primary goal is HUMAN AUTHORSHIP EVIDENCE.** Not tamper-detection
  of node bytes. The workflow choice — which nodes, wired how, with
  what params — IS the authorship claim.

- **Trusted-set verification is CAPABILITY, not required.** Don't gate
  authorship on trust-list membership. Label, don't reject.

- **Trust label is viewer-side, NOT part of signed leaf.** Folding a
  moving list into the leaf would invalidate historical leaves any
  time ComfyOrg updated the list. Only `container_machine_manifest_hash`
  goes into the signed preimage.

- **Canonical form is sort-keys, no whitespace.** Both `workflow_hash`
  and `machine_manifest_hash` MUST be reproducible by any auditor with
  the same underlying JSON. Default `JSON.stringify()` /
  `json.dumps()` (insertion-order keys) is disallowed for these fields.

- **v2.4 is additive.** Fields default to `''` when absent; existing
  v2.3-only integrators keep working. Response echoes `leaf_scheme` so
  downstream verifiers dispatch correctly.

## Files added

**Canonical modules (leaf + workflow):**
- `lib/witness/canonicalLeafV24.ts`
- `services/witness/canonical_leaf_v24.py`
- `lib/scruple/canonicalWorkflow.ts`
- `services/witness/canonical_workflow.py`
- `packages/scruple-verify/src/core/canonicalLeafV24.mjs`
- `packages/scruple-verify/src/core/canonicalWorkflow.mjs`
- `test/fixtures/canonical-leaf-v24-vectors.json` (10 leaf + 2 chain vectors)
- `scripts/test-canonical-leaf-v24.ts`
- `services/witness/tests/test_canonical_leaf_v24.py`

**Migrations:**
- `036_leaf_v24_workflow_manifest.sql` — log_leaves + leaf_scheme columns
- `037_iterations_container_manifest.sql` — persist runner-side manifest

**Ingest + routes:**
- `lib/witness/ingest.ts` (v2.4 dispatch + validation + persistence)
- `app/api/v1/log/[stream_name]/route.ts` (leaf_scheme in response)
- `app/api/v1/log/[stream_name]/batch/route.ts` (same)
- `lib/iterations/ingest.ts` (canonical workflow hash + container manifest ladder)

**Runner-side:**
- `modal/container_manifest.py` — enumerate custom_nodes/ + commit_sha + content hash
- `modal/scruple_runner.py` — return `container_machine_manifest*` in every run

**Web-side wiring:**
- `lib/compute/backends.ts` — ComputeResult carries containerMachineManifest[Hash]
- `lib/compute/modal.ts` — plumb through
- `lib/trust/comfyorg.ts` — trust list fetcher (env-configurable)
- `lib/trust/label.ts` — labelManifest / summarizeLabels

**Receipt page:**
- `app/receipt/[scrId]/page.tsx` — WorkflowBlock (raw JSON) +
  TrustBadgesBlock (trusted/listed/unknown per pack)

**Verifier CLI:**
- `packages/scruple-verify/src/cli.mjs` — dispatch on leaf_scheme;
  workflow_hash re-derivation when proof attaches workflow JSON

**Docs:**
- `docs/api/witness-integration.md` (v2.4 fields, canonicalization, leaf_scheme)

**Smokes:**
- `scripts/smoke-leaf-v24-ingest.mjs` (12 assertions)
- `scripts/smoke-canonical-workflow.mjs` (TS + Python parity)
- `scripts/smoke-verify-leaf-v24.mjs` (positive + tamper cases)
- `scripts/smoke-container-manifest.mjs` (8 assertions)
- `scripts/smoke-trust-labeler.mjs` (7 assertions)

## Follow-ups (deliberately scoped out)

- **Runner redeploy:** `python3 -m modal deploy modal/scruple_runner.py` is
  required for the Modal-hosted runner to start returning
  `container_machine_manifest_hash`. Web-side wiring is null-safe until then.
- **ComfyOrg trust-list schema confirmation:** the fetcher works against a
  documented `TrustListResponse` shape; the actual production URL/schema
  will land here when ComfyOrg publishes stable API docs. Vendors can
  mirror the shape via `SCRUPLE_TRUST_LIST_URL`.
- **Per-app ingest (Adobe / Fusion / Kohya):** those routes currently
  don't pass workflow_hash / machine_manifest_hash. Wiring is one-liner
  per route once we identify the equivalent "graph choice" for each host
  app (Photoshop layer stack, Fusion timeline, Kohya training config).
- **Baseline events → v2.4:** WO-15 v2 (baseline events in log_leaves)
  should also emit v2.4 leaves when the baseline itself pins a
  machine_manifest_hash. Deferred.
