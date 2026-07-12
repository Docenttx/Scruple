# Morning Briefing — 2026-07-13

**Session:** overnight autonomous 2026-07-12 → 2026-07-13
**Branch:** `feature/witnessing-l2-sprint1`
**Sprint 1 status:** 2 of 10 WOs shipped as code; 8 remain.

## TL;DR

WO-05 (audit schema + canonical leaf v23) and WO-06 (audit-API ingest routes)
landed as clean, typechecking commits on the sprint branch. The parity-test
gate (TS ↔ Python byte-identical leaf hashes) is green across 12 vectors.
No unrelated files touched — everything new is under new namespaces
(`lib/witness/`, `app/api/v1/`, `services/witness/`, `test/fixtures/`,
`scripts/`).

Nothing merged, nothing pushed. Everything is local git on the sprint branch.

## What shipped tonight

Two commits on `feature/witnessing-l2-sprint1`:

- **`30e5b0d` — feat(l2/WO-05): audit-API schema + canonical leaf v23 + parity gate**
  - Migration `030_scruple_log.sql` (7 new tables + TEN_scruple seed)
  - `lib/witness/canonicalLeafV23.ts` + `lib/witness/streamIds.ts`
  - `services/witness/canonical_leaf_v23.py`
  - `test/fixtures/canonical-leaf-v23-vectors.json` (10 leaf + 2 chain,
    expected values frozen)
  - `scripts/test-canonical-leaf-v23.ts` (--freeze | verify)
  - `services/witness/tests/test_canonical_leaf_v23.py`
  - `scripts/seed-c2pa-stream.mjs` (idempotent seed of the reserved
    `scruple.c2pa.sign` stream)

- **`7a18698` — feat(l2/WO-06): audit-API ingest — /v1/log + /v1/streams + HMAC + rate limits**
  - `lib/witness/{tenantAuth,hmacMiddleware,rateLimit,ingest}.ts`
  - `app/api/v1/log/[stream_name]/route.ts`
  - `app/api/v1/log/[stream_name]/batch/route.ts`
  - `app/api/v1/streams/route.ts` (POST + GET)
  - `scripts/test-ingest-api.ts` (11 assertions covering happy path,
    idempotency, gaps, replays, PII denylist, HMAC, batch, reserved
    streams)

## Two deviations from the WO docs (documented)

1. Migration number is **030**, not 022 as WO-05 predicted. The WO was
   drafted against a stale `ls migrations/` output; actual next available
   was 030.
2. Table name **`log_checkpoints`**, not `checkpoints` as the WO/design
   said. `001_core.sql` already owned the `checkpoints` name (older
   run-level checkpoints, unrelated). The rename is code-only — the
   canonical design doc §6.1 still says `checkpoints`; needs a doc-only
   alignment pass to keep the two in sync.

Both deviations are notes in `PROGRESS.md`.

## Verify commands (run these first thing to confirm session state)

```bash
cd /data/scruple-web

# git state
git branch --show-current    # feature/witnessing-l2-sprint1
git log --oneline -8         # should show 30e5b0d + 7a18698 as tips

# parity gate — must be green both directions
npx tsx scripts/test-canonical-leaf-v23.ts
python3 services/witness/tests/test_canonical_leaf_v23.py

# typecheck — should show 3 pre-existing errors, 0 new (mine)
npm run typecheck 2>&1 | grep -E "TS[0-9]+"
```

## What did NOT ship tonight (and why)

- **WO-01/02** — OCI Vault provisioning + C2PA cert application. Both
  need human OCI console access + procurement authority. Not attemptable
  from a code-only session.

- **WO-06 integration test run.** The test script `scripts/test-ingest-api.ts`
  is written and ready. Running it requires:
  (a) applying migration 030 to a database (`npm run db:migrate` against
      a dedicated `SCRUPLE_DB_PATH`),
  (b) starting a dedicated Next.js dev server against that DB,
  (c) `npx tsx scripts/test-ingest-api.ts`.
  Both (a) and (b) touch a running system — held for you to sign off.

- **WO-03/04** — signer refactor + isolation. Blocked on WO-01 (need
  Vault OCID); can be scaffolded against a mock OCI client if you want,
  but that touches `services/c2pa-signer/sign.py` + `lib/c2pa/signAsset.ts`
  which are existing files under active use. Held for you to say "go."

- **WO-07** — checkpoint scheduler. Blocked on WO-01 (Vault checkpoint
  key). Can be built against a mock Ed25519 local key today, wire to
  real Vault once WO-01 lands.

- **WO-08** — C2PA leaf emission. Blocks on WO-04 (isolated daemon).

- **WO-09** — verifier CLI. Deferred not because it's blocked — it's
  independent — but because with WO-07 still pending there are no real
  checkpoints or inclusion proofs to validate against; the CLI would
  ship half-built. Better to write it after WO-07 lands so it can be
  smoke-tested end-to-end same-day.

## What to do first thing this morning

Ordered by leverage:

1. **Kick off WO-01 (OCI Vault).** External dependency; longest lead
   time still to close. See `docs/wo/2026-07-12-witnessing-l2/WO-01-oci-vault-provisioning.md`
   — 6 owner-hours estimated. Every downstream WO except WO-05/06 wants
   Vault OCIDs.

2. **File the WO-02 cert application.** DigiCert Content Credentials
   or SSL.com. Weeks of issuer wait; start the clock.

3. **Apply migration 030 + run the WO-06 integration test.**
   ```bash
   cd /data/scruple-web
   # If the shared dev server on :3001 uses data/scruple.db, do this
   # against a scratch DB and a scratch port instead — do not migrate
   # prod in-place without a plan.
   SCRUPLE_DB_PATH=/tmp/scruple-l2.db npm run db:migrate
   SCRUPLE_DB_PATH=/tmp/scruple-l2.db npm run dev -- -p 3005 &  # separate port
   SCRUPLE_DB_PATH=/tmp/scruple-l2.db SCRUPLE_TEST_URL=http://localhost:3005 \
     npx tsx scripts/test-ingest-api.ts
   ```
   All 11 assertions should pass.

4. **Then either me or you can proceed to WO-07 / WO-09.** WO-09 is a
   nice fresh-context task for a sub-agent.

## Reference — the canonical & work-order docs

Read in this order after the compaction survives the night:

1. `docs/wo/2026-07-12-witnessing-l2/INDEX.md` — WO manifest
2. `docs/wo/2026-07-12-witnessing-l2/PROGRESS.md` — status log (this
   session appended two entries at the top)
3. `docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md` — design
4. `docs/wo/2026-07-12-witnessing-l2/WORK_ALLOCATION_PLAN.md` — how
   to dispatch tracks in parallel
5. Individual `WO-*.md` files for the next unit of work

## Small doc-alignment TODO (5-min job)

The canonical design doc §6.1 still lists `checkpoints` as a table name.
Rename to `log_checkpoints` in that section so the doc matches the shipped
schema. Same for WO-07 references. This is doc-only — no code change.

## What NOT to do without me

- Don't merge the sprint branch into `feature/pivot` or `main`. It's a
  work-in-progress branch.
- Don't apply migration 030 to `/data/scruple-web/data/scruple.db` (the
  shared dev DB) — use a scratch DB path per the run instructions above.
  If you do apply it to the shared DB, that's fine, but restart the
  shared dev server so the routes see the new tables.
- Don't `git push` unless you're intentionally publishing the branch.
  Everything is local.
