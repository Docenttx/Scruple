# Morning Briefing — 2026-07-13

**Branch:** `feature/witnessing-l2-sprint1`
**Sprint 1 status:** functionally complete — sign → witness → verify
pipeline works end-to-end.
**Only pending:** WO-01 (OCI Vault, human), WO-02 (C2PA cert, external
issuer), WO-04 (systemd isolation, deferred — not required for HSM demo).

## TL;DR

The full pipeline is green end-to-end today, in local-signing mode. When
you provision the software OCI Vault tomorrow (15 min in the console)
and hand me two env vars, the same test suite re-runs with
`signing_mode: "vault"` and produces HSM-attributed evidence — no code
change.

```bash
# The one-command demo (once the dev server is up on scratch DB):
npx tsx scripts/test-c2pa-sign-witness-e2e.ts
# → 24/24 assertions PASS, ~5 seconds
```

That test **is** the vendor demo. It signs a real asset via the C2PA
pipeline, auto-mints an audit Principal for the user, emits a witness
leaf, chains a second sign, ticks the checkpoint scheduler, fetches the
proof bundle, and verifies it end-to-end with the third-party
`scruple-verify` CLI.

## Commit chain on `feature/witnessing-l2-sprint1`

| Commit | WO | Assertions |
|---|---|---|
| `30e5b0d` | WO-05 audit schema + canonical leaf v23 | 12 parity |
| `7a18698` | WO-06 ingest routes (code) | — |
| `e6e2ffc` | WO-06 integration test | 21/21 |
| `aaec20e` | WO-07 checkpoint scheduler | 20/20 |
| `8a270fd` | WO-09 verifier CLI + proof endpoint | 12/12 |
| `0d45097` | **WO-03+08+10 C2PA signer refactor + witness emit + full E2E** | **24/24** |

## Tomorrow's HSM run — exact steps

You've said you'll spin up a software-mode OCI Vault for the L2 evidence
run. When you have the OCIDs:

```bash
# On the box, once:
pip install oci
export SCRUPLE_C2PA_VAULT_KEY_OCID=ocid1.key.oc1.us-ashburn-1.xxxxx.yyyyy
export SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT=https://<vault>-crypto.kms.us-ashburn-1.oraclecloud.com

# Re-run the same E2E test:
rm -f /tmp/scruple-l2.db /tmp/scruple-witness-data/scruple-internal.dev.json
rm -rf /tmp/scruple-witness-data
SCRUPLE_DB_PATH=/tmp/scruple-l2.db npx tsx scripts/migrate.ts
SCRUPLE_DB_PATH=/tmp/scruple-l2.db \
  SCRUPLE_WITNESS_KEY_DIR=/tmp/scruple-witness-data \
  SCRUPLE_INTERNAL_CREDS_DIR=/tmp/scruple-witness-data \
  SCRUPLE_INTERNAL_INGEST_BASE=http://localhost:3005 \
  SCRUPLE_C2PA_DEV=1 \
  npx next dev -p 3005 &
# wait for :3005 up
SCRUPLE_DB_PATH=/tmp/scruple-l2.db SCRUPLE_WITNESS_KEY_DIR=/tmp/scruple-witness-data \
  SCRUPLE_TEST_URL=http://localhost:3005 \
  npx tsx scripts/test-c2pa-sign-witness-e2e.ts
```

Expected: still 24/24 PASS, but the sign response now shows
`signing_mode: "vault"` and `signer_identity: "vault:...<8-char-ocid-suffix>"`.
That's the L2 evidence: an actual HSM-signed C2PA asset with a
witnessed sign event, verified end-to-end by the third-party CLI.

For the evidence pack: capture the test output, the signed asset, the
OCI Audit log entry showing the Sign call, and an OCI Console screenshot
of the Vault protection mode. That's the artifact set the Conformance
Program submission attaches.

## What's live and demoable today

Every WO except signer isolation:

- **Audit chain**: schema, canonical leaf, ingest routes, checkpoint
  scheduler, verifier CLI — all with E2E tests.
- **C2PA sign path**: refactored to `Signer.from_callback` — one line
  swaps local ↔ Vault. Local mode still produces valid C2PA manifests
  that verify with c2pa-python / c2pa-node.
- **Witness emit**: every sign auto-provisions a Principal + delegation
  for the user, emits a leaf on `scruple.c2pa.sign`, surfaces the
  correlation in the API response. Fail-open on emit errors.
- **Verifier CLI**: `scruple-verify leaf` walks the full proof (leaf
  hash → inclusion path → checkpoint sig → trust manifest).

## What did NOT ship (and why)

- **WO-01 OCI Vault** — needs your OCI console. 15 min.
- **WO-02 C2PA production cert** — weeks-of-lead-time procurement.
- **WO-04 signer isolation (systemd + Unix socket)** — deliberately
  deferred. Not required for HSM demo or L2 capability claim; it's a
  Sprint 3 hardening item for when Scruple has customer traffic to
  protect. Ship this before first paying customer.

## Quick verify commands (start of morning)

```bash
cd /data/scruple-web

git branch --show-current    # feature/witnessing-l2-sprint1
git log --oneline -8         # confirms 0d45097 as tip

# Cross-language parity (should stay green regardless of Vault)
npx tsx scripts/test-canonical-leaf-v23.ts   # 12/12
python3 services/witness/tests/test_canonical_leaf_v23.py   # 12/12

# Typecheck — 3 pre-existing errors in unrelated files
npm run typecheck 2>&1 | grep -E "TS[0-9]+"

# Full E2E chain in local mode (no OCI required)
rm -f /tmp/scruple-l2.db /tmp/scruple-witness-data/scruple-internal.dev.json
rm -rf /tmp/scruple-witness-data
SCRUPLE_DB_PATH=/tmp/scruple-l2.db npm run db:migrate
SCRUPLE_DB_PATH=/tmp/scruple-l2.db \
  SCRUPLE_WITNESS_KEY_DIR=/tmp/scruple-witness-data \
  SCRUPLE_INTERNAL_CREDS_DIR=/tmp/scruple-witness-data \
  SCRUPLE_INTERNAL_INGEST_BASE=http://localhost:3005 \
  SCRUPLE_C2PA_DEV=1 \
  npx next dev -p 3005 &
# wait for :3005 up (~5s)
SCRUPLE_DB_PATH=/tmp/scruple-l2.db SCRUPLE_WITNESS_KEY_DIR=/tmp/scruple-witness-data \
  SCRUPLE_TEST_URL=http://localhost:3005 \
  npx tsx scripts/test-c2pa-sign-witness-e2e.ts
# ⇒ 24/24 PASS
pkill -f "next dev -p 3005"
```

## Doc-alignment TODO (5 min, non-blocking)

Design doc references `checkpoints` table + `/v1/*` URL prefix; actual
shipped code uses `log_checkpoints` and `/api/v1/*`. Same for the WO
files. Small consistency pass.

## L2 evidence checklist status (canonical design §11)

| # | Item | Status |
|---|---|---|
| 1 | HSM-backed non-exportable signing key | Tomorrow's HSM run |
| 2 | Production C2PA-trust-list-issued cert | WO-02 issuer wait |
| 3 | Signer callback path (raw key never in memory) | ✅ (0d45097) |
| 4 | Signer process isolation | Deferred (WO-04) |
| 5 | Per-sign audit log with third-party witness | ✅ (0d45097) |
| 6 | Rate limiting on signing route | Existing on /api/v1/log/*; C2PA route rate-limit is Sprint 3 |
| 7 | Key lifecycle documentation | Sprint 3 (WO-17) |
| 8 | Interop against production path | Tomorrow's HSM run |
| 9 | CI conformance gate | Sprint 3 (WO-16) |
| 10 | Security policy document | Sprint 3 (WO-17) |

Post tomorrow's HSM run + WO-02 cert issuance, items 1+2+8 close out.
Items 4/6/7/9/10 are Sprint 3 evidence-pack work; the CAPABILITY is
demonstrated by the code already shipped.

## What NOT to do without me

- Don't merge `feature/witnessing-l2-sprint1` into `feature/pivot` or
  `main` yet — even though functionally complete, the doc-alignment
  pass + WO-04 isolation are Sprint 3 items and change the diff shape.
- Don't apply migration 030 + 031 to the shared `data/scruple.db`
  without bouncing the port-3001 dev server.
- Don't `git push` unless intentional; branch is local.
