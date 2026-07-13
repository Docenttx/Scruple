# WO-15 — Baseline chain-lock + public baseline registry

**Phase:** 6 (Lifecycle + Transparency)
**Depends on:** WO-14
**Blocks:** WO-16
**Owner:** server
**Effort:** ~2 days

## Purpose

Implement the "public ledger anchoring of the baseline" feature from
Standard §4 — the core transparency option. Genesis and re-baseline
events land on the public ledger via the same chain-lock mechanism used
for artifact leaves. Also expose a public registry endpoint so anyone
can look up a vendor's baseline history by identifier.

## Deliverables

### 1. Baseline chain-lock

Extend the existing chain-lock code path (`lib/anchor/rvn.ts` +
`lib/anchor/ipfs.ts` + `lib/anchor/arweave.ts`) to handle baseline leaves.

Since baseline leaves already enter the audit log with `leaf_kind =
'baseline'` or `'rebaseline'`, they're already Merkle-included in
checkpoints and included in super-root anchors by default. The delta
here is:

- **Tenant config toggle:** `publish_baseline_publicly: true|false`
  (default: `false`). When `true`, the tenant's baseline + rebaseline
  events are guaranteed to have their checkpoints anchored to RVN + IPFS
  + Arweave with a stable `SCR_<8hex>` tag prefixed `BASE_` for filterable
  lookup.
- **Baseline anchor manifest:** each anchored baseline gets an
  `anchor_json` blob published to IPFS + Arweave with fields
  `{baseline_hash, prev_baseline_hash, tenant_id, activated_at, rvn_txid, checkpoint_ref}`.
- Emit an event or admin log so ops can confirm public anchoring
  succeeded.

### 2. Public baseline registry endpoint

New public (unauthenticated) route:

**`GET /api/v1/registry/baselines/{scr_id}`** — returns the current
baseline for the tenant identified by `scr_id`.

**`GET /api/v1/registry/baselines/{scr_id}/history`** — returns the
tenant's full baseline chain.

**`GET /api/v1/registry/baselines/{scr_id}/verify/{baseline_hash}`** —
returns whether the specific baseline hash is / was ever active for the
tenant, and when.

These are readable by anyone with the tenant's public identifier;
returns baseline hashes + activation times + public-anchor references
only (no attestation bytes, no code hashes — those live in the on-chain
anchor, not in the API response).

Rate-limit at a generous default (100 req/min per IP; configurable).

### 3. Documentation

Include a doc `docs/api/public-baseline-registry.md` describing:
- What the registry contains
- How to look up a vendor by identifier
- How to independently verify a baseline hash against the public anchor
- Example curl / Python one-liners

## Acceptance criteria

- [ ] Tenant with `publish_baseline_publicly: true` has genesis baseline
  visible on RVN + IPFS + Arweave within the tenant's checkpoint window.
- [ ] Registry endpoints return correct data for a tenant with a chain
  of two baselines (genesis + one rebaseline).
- [ ] Verify endpoint correctly returns "was current from T1 to T2" for
  a superseded baseline.
- [ ] Tenants with `publish_baseline_publicly: false` don't have their
  baselines exposed in the registry.
- [ ] Rate-limit fires on abusive query rates.
- [ ] Doc landed.

## Notes

- Anchoring cost is Scruple's operational cost (per the commercial memory).
  For tenants opting into public transparency, this is a small extra
  chain-lock event per re-baseline — negligible compared to per-leaf
  anchoring for high-volume tenants.
- Consider whether the registry should be its own subdomain
  (`registry.scruple.ai`) or a path on `witness.scruple.ai`. Recommend
  the latter for v1 (simpler DNS); split later if abuse warrants isolation.

## Landing

One commit: `feat(baseline): public chain-lock + registry endpoints`.
