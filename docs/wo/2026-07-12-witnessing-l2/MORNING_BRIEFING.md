# Morning Briefing — 2026-07-13

**Session:** 2026-07-12 → 2026-07-13
**Branch:** `feature/witnessing-l2-sprint1`
**Sprint 1 status:** 4 of 10 WOs shipped end-to-end with passing tests;
the audit chain minus the C2PA-signer stage is demonstrable today.

## TL;DR

The **audit chain works**. You can:

1. Ingest a leaf via `POST /api/v1/log/<stream>`.
2. Fire the checkpoint scheduler (`npx tsx scripts/run-checkpoint-tick.ts`).
3. Fetch the proof bundle via `GET /api/v1/proof/leaf/<stream>/<seq>`.
4. Run `node packages/scruple-verify/src/cli.mjs leaf --proof <file>` and get `VALID`.
5. Tamper the proof, re-run, get `FAIL`.

This is the load-bearing story for the Rider and for the Continuous Audit
API product. C2PA-specific signing (WO-08) is the only thing standing
between us and the full "sign asset → witness → third-party verify"
demo, and it's blocked on the OCI Vault (WO-01) decision.

## What shipped tonight

Six commits on `feature/witnessing-l2-sprint1`:

| Commit | WO | What |
|---|---|---|
| `30e5b0d` | WO-05 | Migration 030 + canonical leaf v23 + TS↔Python parity gate (12 vectors) |
| `7a18698` | WO-06 | `/v1/log/*` + `/v1/streams` + HMAC + rate limits |
| `523b5b0` | — | First MORNING_BRIEFING (superseded by this file) |
| `e6e2ffc` | WO-06 | URL prefix fix + integration test 21/21 PASS |
| `aaec20e` | WO-07 | Checkpoint scheduler + Merkle + Ed25519 signer + trust manifest, 20/20 E2E PASS |
| `8a270fd` | WO-09 | `scruple-verify` CLI + `/api/v1/proof/leaf` endpoint, 12/12 E2E PASS |

Total: 4 WOs delivered with tests, all typechecking clean, all zero-touch
on the existing app surface outside their new namespaces.

## Verify commands (run these first)

```bash
cd /data/scruple-web

# 1. git state
git branch --show-current    # feature/witnessing-l2-sprint1
git log --oneline -8         # should show 30e5b0d → 8a270fd chain

# 2. parity gate — must be green both directions
npx tsx scripts/test-canonical-leaf-v23.ts
python3 services/witness/tests/test_canonical_leaf_v23.py

# 3. typecheck — should show 3 pre-existing errors, 0 new (mine)
npm run typecheck 2>&1 | grep -E "TS[0-9]+"

# 4. Run all three E2E tests against a scratch stack (~90 seconds total)
rm -f /tmp/scruple-l2.db && rm -rf /tmp/scruple-witness-data
SCRUPLE_DB_PATH=/tmp/scruple-l2.db npm run db:migrate
SCRUPLE_DB_PATH=/tmp/scruple-l2.db SCRUPLE_WITNESS_KEY_DIR=/tmp/scruple-witness-data \
  npx next dev -p 3005 > /tmp/l2-next.log 2>&1 &
until curl -sSf -o /dev/null http://localhost:3005/api/health; do sleep 2; done
SCRUPLE_DB_PATH=/tmp/scruple-l2.db SCRUPLE_TEST_URL=http://localhost:3005 \
  npx tsx scripts/test-ingest-api.ts               # 21/21
SCRUPLE_DB_PATH=/tmp/scruple-l2.db SCRUPLE_WITNESS_KEY_DIR=/tmp/scruple-witness-data \
  SCRUPLE_TEST_URL=http://localhost:3005 \
  npx tsx scripts/test-checkpoint-e2e.ts           # 20/20
SCRUPLE_DB_PATH=/tmp/scruple-l2.db SCRUPLE_WITNESS_KEY_DIR=/tmp/scruple-witness-data \
  SCRUPLE_TEST_URL=http://localhost:3005 \
  npx tsx scripts/test-verify-cli-e2e.ts           # 12/12
pkill -f "next dev -p 3005"
```

## What's done vs not

| WO | Status | Notes |
|---|---|---|
| WO-01 OCI Vault | pending (human) | Needs OCI console + IAM |
| WO-02 C2PA cert | pending (human) | Needs procurement + signatory |
| WO-03 Signer refactor | pending | Blocks on WO-01 (real Vault) OR your green-light for a mocked OCI client |
| WO-04 Signer isolation | pending | Blocks on WO-03 |
| WO-05 Audit schema | ✅ **DONE** | 30e5b0d |
| WO-06 Ingest API | ✅ **DONE** | 7a18698 + e6e2ffc |
| WO-07 Checkpoint scheduler | ✅ **DONE** | aaec20e — Ed25519 mocked, Vault swap seam ready |
| WO-08 C2PA emit | pending | Blocks on WO-04 |
| WO-09 Verifier CLI | ✅ **DONE** | 8a270fd |
| WO-10 E2E smoke | pending | Waits for WO-08 |

## What still needs human sign-off

1. **WO-01 OCI Vault** — provisioning is a 6h task; every downstream Vault
   swap (WO-07's signer, WO-03's C2PA signer) is a ~10-line change once
   the OCID lands.

2. **WO-02 C2PA cert application** — weeks-of-lead-time procurement.

3. **Should I mock OCI Vault for WO-03?** — the C2PA signer refactor
   touches existing files (`services/c2pa-signer/sign.py`,
   `lib/c2pa/signAsset.ts`, `app/api/scruple/c2pa/sign/route.ts`) that
   are in active use. Same design pattern I used for WO-07 works — write
   a `vaultSignEs256()` seam using a locally-generated ES256 key, then
   swap to OCI Vault callback later. It won't regress interop (the L1
   evidence stands) but it does modify the current signing path. **Tell
   me yes/no** and I'll ship WO-03 + WO-04 that way.

4. **Migration 030 on the shared dev DB** — Sprint 1 tests all run on
   scratch DBs. When you want the shared dev server to see the new
   tables: `npm run db:migrate` against the shared DB and bounce the
   port-3001 server so it picks up the schema. I did not do this
   autonomously.

5. **npm publish `@scruple/verify`** — the package works locally; when
   you want it public, `cd packages/scruple-verify && npm publish
   --access public`. Not blocking anything.

## Doc-alignment TODO (short)

The canonical design doc + WO-07 doc reference table name `checkpoints`
and URL prefix `/v1/*`. Actual shipped code is `log_checkpoints` (rename
to avoid `001_core.sql` collision) and `/api/v1/*` (Next.js `app/api/`
convention). ~5-min doc pass; noted in PROGRESS.md.

## What NOT to do without me

- Don't merge `feature/witnessing-l2-sprint1` yet — WO-08 + WO-10 gate.
- Don't apply migration 030 to shared `data/scruple.db` without bouncing
  the port-3001 dev server.
- Don't `git push` unless you're intentionally publishing the branch.
- Don't touch `services/c2pa-signer/sign.py` while I'm mid-WO-03 later.

## Where to pick up

Best next step depends on your call on point 3 above:

- **If yes to mocked OCI for WO-03:** I ship WO-03 + WO-04 + WO-08 as a
  chain, ending with the full "sign asset → sign event landed as leaf →
  offline-verify with `scruple-verify`" demo. That's the Sprint 1 gate
  (WO-10) hit in one more session.

- **If no, wait for real Vault:** WO-01 + WO-02 first, then the same
  chain runs against real Vault. Same demo at the end, cleaner posture
  for L2 evidence.

Either path, the audit-chain half is already built and tested; nothing
you decide here undoes what shipped tonight.
