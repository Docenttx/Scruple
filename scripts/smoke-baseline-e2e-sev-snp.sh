#!/bin/bash
# Baseline + SEV-SNP end-to-end smoke.
#
# Applies migrations 030, 032, 033 to a scratch DB, exercises the
# baseline DAO + ingest_check helper against the real captured SEV-SNP
# report from docs/l2-evidence/2026-07-12T174954Z/.
#
# Composite smoke runner — invokes the sub-smokes from WO-02/03 and
# reports overall pass/fail. Real HTTP-route smoke requires a running
# Next.js dev server; deferred to WO-13 (CLI) which exercises the full
# receipt walk.
#
# Run: bash scripts/smoke-baseline-e2e-sev-snp.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=================================================================="
echo "Scruple baseline + SEV-SNP E2E smoke"
echo "=================================================================="
echo

FAIL=0

echo "[1/3] Envelope + dispatch shared library"
echo "---"
if (cd packages/scruple-attestation-verifiers && ../../node_modules/.bin/tsc >/dev/null 2>&1 && node --test dist/envelope.test.js dist/dispatch.test.js dist/plugins/sev_snp.test.js 2>&1 | tail -8 | head -6); then
  echo "PASS: shared library tests"
else
  echo "FAIL: shared library tests"
  FAIL=$((FAIL + 1))
fi
echo

echo "[2/3] Baseline DAO smoke"
echo "---"
if node scripts/smoke-baseline-dao.mjs 2>&1 | tail -5; then
  echo "PASS: DAO smoke"
else
  echo "FAIL: DAO smoke"
  FAIL=$((FAIL + 1))
fi
echo

echo "[3/3] Ingest check smoke with real SEV-SNP report"
echo "---"
if node scripts/smoke-baseline-ingest-check.mjs 2>&1 | tail -5; then
  echo "PASS: ingest check smoke"
else
  echo "FAIL: ingest check smoke"
  FAIL=$((FAIL + 1))
fi
echo

echo "=================================================================="
if [ "$FAIL" -eq 0 ]; then
  echo "OVERALL PASS — baseline + SEV-SNP path proven end-to-end"
  echo "=================================================================="
  exit 0
else
  echo "OVERALL FAIL — $FAIL sub-smoke(s) failed"
  echo "=================================================================="
  exit 1
fi
