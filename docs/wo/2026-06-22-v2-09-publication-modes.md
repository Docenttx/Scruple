# WO-9 · Three publication modes per iteration

**Scope:** Add `workflow_publication ∈ {full, hash-only, witness-only}` to iterations. Pure presentation — leaf preimage doesn't change. Receipt page redacts per mode.

**Reference:** `docs/architecture/canvas-v2.md` decision 6.

(Column already added in WO-3 migration 021.)

## Files

- `app/receipt/[scrId]/page.tsx` (or current path) — branch on `iteration.workflow_publication`:
  - `full` → show output_hash, input_hash, workflow_hash, manifest_hash, model_fingerprints_hash, timestamp, prev_record_hash, leaf_hash
  - `hash-only` → output_hash, manifest_hash, timestamp, leaf_hash. Workflow_hash + input_hash redacted with note.
  - `witness-only` → output_hash + timestamp + leaf_hash + "Scruple witnessed this artist generated this output at this time." Everything else redacted.
- `lib/settings/user.ts` — add `default_publication_mode: 'full' | 'hash-only' | 'witness-only'` (default `'full'`)
- `components/settings/PublicationSection.tsx` — Settings → Receipt Publication
- `app/api/iterations/[id]/publication/route.ts` — POST `{ mode }`; enforces upgrade-only (cannot downgrade)
- `lib/ingestIteration.ts` — read user's default publication mode; stamp on new iteration

## Upgrade-only rule

```sql
UPDATE iterations SET workflow_publication = $new
WHERE id = $id AND user_id = $u
  AND (
    (workflow_publication = 'witness-only')  -- can go to anything
    OR (workflow_publication = 'hash-only' AND $new = 'full')
    -- 'full' cannot change
  );
```

## Verify

- New iteration with `default_publication_mode='hash-only'` → row created with that mode
- `/receipt/<scr-id>` for hash-only iteration shows redacted workflow_hash
- POST publication upgrade hash-only → full → works
- POST publication downgrade full → hash-only → 403

## Out of scope

- IPFS pin redaction (handled separately when triple-chain lock is set; out of v2 scope for now)
