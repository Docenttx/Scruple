# WO-14 — Re-baseline endpoint + auto-rebaseline SDK behavior

**Phase:** 6 (Lifecycle + Transparency)
**Depends on:** WO-02, WO-05, WO-06 (SEV-SNP smoke green)
**Blocks:** WO-15, WO-16
**Owner:** server + SDK
**Effort:** ~2 days

## Purpose

Complete the re-baseline flow: server correctly chains new baselines to
prior ones, publishes the transition as a witnessed event, and the SDK
detects drift + provides a clear path to submit a re-baseline (either
automatic or manual, per tenant config).

## Deliverables

### 1. Server: re-baseline chain integrity

WO-02 delivered the `POST /rebaseline` endpoint. This WO hardens it:

- Reject with 400 if `prev_baseline_hash` in the request doesn't match
  the tenant's current baseline (already done; verify).
- On successful re-baseline, insert a new leaf with `leaf_kind =
  'rebaseline'` in the audit chain — this is the witnessed public event.
- The re-baseline leaf carries fields: `prev_baseline_hash`,
  `new_baseline_hash`, `reason`, `transitioned_at`.
- The re-baseline leaf is signed by the CVM signer at the next checkpoint
  (same mechanism as workflow leaves).

### 2. Server: baseline history endpoint enriched

Extend `GET /baseline/history` to include the corresponding `rebaseline`
leaf's audit-log position (leaf_id, checkpoint_id) so anyone can trace
the transition to the audit chain and (eventually) to a public anchor.

### 3. SDK: auto-detect drift

Extend `scruple.WitnessClient` initialization:

```python
client = scruple.WitnessClient(
    ...,
    on_baseline_drift='raise' | 'warn' | 'auto_rebaseline'
)
```

Behavior:

- On construction, compute local baseline hash and compare to
  `GET /baseline/current`.
- **`raise`** (default): raise `BaselineDriftError` — user resolves
  manually by calling `client.rebaseline(reason)`.
- **`warn`**: log a WARN, but continue accepting witness calls
  (server will 409 them). Not recommended.
- **`auto_rebaseline`**: automatically call `client.rebaseline(reason='auto-detected drift from <cause>')`.
  Cause is a short summary of which files changed. Recommended for CI
  deploy pipelines where re-baselining should be part of the release
  playbook.

### 4. SDK: rebaseline helper

`scruple.WitnessClient.rebaseline(reason: str) -> RebaselineReceipt`:

- Compute current baseline hash from local manifest.
- Fetch fresh attestation if `attestation.provider != 'none'`.
- POST to `/rebaseline` with `prev_baseline_hash = get_current_hash()`.
- Update local cached baseline.
- Return receipt with new baseline_hash + audit-leaf reference.

### 5. Middleware: 409 recovery

If the SDK gets a 409 on a witness call ("baseline mismatch"), auto-refresh
the local baseline from the server and retry ONCE. If the second attempt
also 409s, raise `BaselineOutOfSyncError` — the local integration is
running a version the server doesn't know about; re-baseline is required.

## Acceptance criteria

- [ ] `/rebaseline` correctly chains: baseline chain integrity verified via
  the audit leaves ("baseline transitioned from X to Y at time T for
  reason Z").
- [ ] Wrong `prev_baseline_hash` → 400 with clear error.
- [ ] SDK `on_baseline_drift='raise'` fires correctly.
- [ ] SDK `on_baseline_drift='auto_rebaseline'` completes without user
  intervention and updates the local cache.
- [ ] SDK middleware retries a 409 once, then raises on repeat.
- [ ] Unit tests + integration test on the AI Council box.

## Notes

- Re-baseline events are first-class public. Consider whether ABORT-shaped
  events (e.g., "attempted rebaseline but signature invalid") should also
  be recorded. Recommendation: yes, in the audit chain but not necessarily
  on the public ledger (that's WO-15's decision).

## Landing

One commit: `feat(baseline): re-baseline chain integrity + SDK auto-drift`.
