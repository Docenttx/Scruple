#!/usr/bin/env bash
# scripts/probe-harness/run.sh — occupy the tenant position and run all seven.
#
#   ./scripts/probe-harness/run.sh                 # the conformant topology
#   ./scripts/probe-harness/run.sh --audit         # conformant + all 8 breaks
#   ./scripts/probe-harness/run.sh p5-passthrough-ws
#
# Results land in a fresh directory under `$TMPDIR/scruple-probe-harness/`
# (override with HARNESS_OUT), one per profile: `probes.json` (results + the namespace inodes the run occupied),
# `probes.log` (the Sonobuoy-shaped human half), `deployment.json`, `gaps.json`.
#
# THE AUDIT PASS IS NOT OPTIONAL CEREMONY. A clean probe run against a
# deployment nobody has attacked is likelier to mean the probes are weak than
# that the topology is strong, so `--audit` breaks the deployment once per probe
# in the way that probe exists to catch, and the run is only worth reporting if
# each break is caught by the probe it targets AND ignored by the others.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILES=(none)
if [ "${1:-}" = "--audit" ]; then
  PROFILES=(none p1-second-route p2-open-provisioning p3-state-mounted p3-shared-pid \
            p4-singular-volume p5-passthrough-ws p6-permissive-ingest p7-open-egress)
elif [ -n "${1:-}" ]; then
  PROFILES=("$@")
fi

# THE STANDING SAFETY RULE. The production witness server is live on
# 127.0.0.1:5799 and a prior session polluted its audit log. Nothing this
# harness starts may address it, so the variable is pinned to a dead port here,
# above every profile, rather than in each child.
export WITNESS_SERVER_URL=http://127.0.0.1:1

if ! unshare --user --map-root-user --net true 2>/dev/null; then
  echo "unprivileged user+network namespaces are unavailable on this host." >&2
  echo "Without them the probes can only be run from the WRONG position, and a" >&2
  echo "topological result from the wrong vantage is inconclusive (H-4 §10 C-11)." >&2
  exit 2
fi

# NOT under `artifacts/`. That directory is the app's content-addressed store
# (lib/scruple/artifacts.ts), and a run directory sitting among its hex shards
# is a collision waiting for the first person who enumerates it. Override with
# HARNESS_OUT to put the evidence somewhere a submission bundle can pick it up.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_ROOT="${HARNESS_OUT:-${TMPDIR:-/tmp}/scruple-probe-harness}/$STAMP"
mkdir -p "$OUT_ROOT"

status=0
for profile in "${PROFILES[@]}"; do
  root="$OUT_ROOT/$profile"
  mkdir -p "$root"
  echo "── $profile ────────────────────────────────────────────" >&2
  if ! HARNESS_PROFILE="$profile" HARNESS_ROOT="$root" HARNESS_REPO="$REPO" \
      unshare --user --map-root-user --net --mount --fork -- \
      bash "$REPO/scripts/probe-harness/topology.sh" 2>"$root/harness.log"; then
    echo "  profile $profile did not complete; see $root/harness.log" >&2
    status=1
  fi
done

echo >&2
echo "results: $OUT_ROOT" >&2
exit $status
