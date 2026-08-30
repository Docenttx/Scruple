#!/usr/bin/env bash
# The topology, built with unshare(2) because this host has no Docker.
#
# Runs INSIDE a user namespace we are root in (see run.sh). From there we own
# the network and mount namespaces we create, which is what makes an
# unprivileged tenant boundary possible at all.
#
#   deployment ns                      tenant ns
#   ------------                       ---------
#   lo        127.0.0.1  <- ComfyUI    lo        127.0.0.1  (a DIFFERENT loopback)
#   veth-h    10.77.0.1  <- gate,API   veth-t    10.77.0.2
#   veth-hc   10.88.0.1  <- control    veth-tc   10.88.0.2
#                                      (no default route, no resolver)
#
# WHAT EACH BOUNDARY BUYS, stated here so a reader is not left to infer it:
#
#   network ns  a genuine answer for probes 1, 2 and 7. The tenant's routing
#               table is the deployment's egress policy, and it is real.
#   mount ns    a genuine answer for probe 3's file half: the component's state
#               directory is not in the tenant's mount namespace.
#   pid ns      the other half of probe 3. Without it, /proc/<pid>/root walks
#               straight into the component's mount namespace and the mount
#               boundary is worth nothing. `p3-shared-pid` is that experiment.
#
# WHAT NO PART OF THIS BUYS. A user namespace maps the invoking uid to root, so
# a 0600 file owned by that uid is readable here BY DESIGN. This harness
# therefore cannot answer the OTHER §4.4 step-4 posture — "a 0600 file owned by
# a principal the tenant is not, in a shared mount namespace". It answers the
# isolated-mount posture, which is a different configuration, and certification
# is per configuration (§7).
set -euo pipefail

PROFILE="${HARNESS_PROFILE:?}"
ROOT="${HARNESS_ROOT:?}"
REPO="${HARNESS_REPO:?}"

export HARNESS_LINK_IP=10.77.0.1
export HARNESS_CTL_IP=10.88.0.1
export HARNESS_GATE_PORT=8188
export HARNESS_API_PORT=8199
export HARNESS_CTL_PORT=9999
# TEST-NET-3 (RFC 5737). Never a live service, so a reachable result can only
# mean this harness routed it.
export HARNESS_EGRESS_IP=203.0.113.1
export HARNESS_EGRESS_PORT=443

TENANT_IP=10.77.0.2
TENANT_CTL_IP=10.88.0.2

ip link set lo up

# ── the tenant namespace ──────────────────────────────────────────────────
# `p3-shared-pid` deliberately withholds the PID namespace. Everything else
# gets net + mount + pid.
if [ "$PROFILE" = "p3-shared-pid" ]; then
  TENANT_PID_NS=0
  unshare --net --mount --fork --kill-child -- sleep 3600 &
else
  TENANT_PID_NS=1
  unshare --net --mount --pid --fork --kill-child -- sleep 3600 &
fi
HOLDER=$!
sleep 0.4
TPID=$(pgrep -P "$HOLDER" sleep || echo "$HOLDER")
echo "tenant namespace holder pid=$TPID (own pid ns: $TENANT_PID_NS)" >&2

cleanup() {
  kill "$HOLDER" 2>/dev/null || true
  kill "${DEPLOY_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT

# ── two links, so a reachable negative control means routing, not luck ────
ip link add veth-h  type veth peer name veth-t  netns "$TPID"
ip link add veth-hc type veth peer name veth-tc netns "$TPID"
ip addr add "$HARNESS_LINK_IP/24" dev veth-h  && ip link set veth-h  up
ip addr add "$HARNESS_CTL_IP/24"  dev veth-hc && ip link set veth-hc up
nsenter -t "$TPID" -n ip link set lo up
nsenter -t "$TPID" -n ip addr add "$TENANT_IP/24"     dev veth-t
nsenter -t "$TPID" -n ip addr add "$TENANT_CTL_IP/24" dev veth-tc
nsenter -t "$TPID" -n ip link set veth-t  up
nsenter -t "$TPID" -n ip link set veth-tc up

# ── the p7 break: a route to somewhere the policy should not permit ───────
if [ "$PROFILE" = "p7-open-egress" ]; then
  ip addr add "$HARNESS_EGRESS_IP/32" dev veth-h
  nsenter -t "$TPID" -n ip route add "$HARNESS_EGRESS_IP/32" via "$HARNESS_LINK_IP" dev veth-t
fi

# ── the deployment ────────────────────────────────────────────────────────
rm -f "$ROOT/READY"
# `exec`, so DEPLOY_PID is node itself. Without it the pid is the subshell,
# SIGTERM never reaches the component, and the harness waits forever on a
# process it thinks it just asked to stop.
( cd "$REPO" && exec node --import tsx scripts/probe-harness/deployment.ts ) &
DEPLOY_PID=$!

for _ in $(seq 1 150); do
  [ -f "$ROOT/READY" ] && break
  kill -0 "$DEPLOY_PID" 2>/dev/null || { echo "deployment died before READY" >&2; exit 1; }
  sleep 0.2
done
[ -f "$ROOT/READY" ] || { echo "deployment never became ready" >&2; exit 1; }

# ── the tenant's mount view ───────────────────────────────────────────────
# An empty tmpfs over the directory that HOLDS the state directory, so the
# state directory does not exist in the tenant's namespace at all. That is
# "not mounted into the workload container", modelled as absence rather than
# as a file mode — see the header for why the mode is not the question here.
if [ "$PROFILE" != "p3-state-mounted" ]; then
  nsenter -t "$TPID" -m -- mount -t tmpfs none "$ROOT/private"
fi
# A private /proc, so the tenant's PID namespace is visible in /proc rather
# than only in the kernel. Without this, /proc still shows the host's tasks and
# the isolation would be real but unobservable — and an unobservable boundary
# is one nobody can check.
if [ "$TENANT_PID_NS" = "1" ]; then
  nsenter -t "$TPID" -m -p -- mount -t proc proc /proc
fi

# ── the probes, from the tenant position ──────────────────────────────────
set +e
if [ "$TENANT_PID_NS" = "1" ]; then
  HARNESS_TENANT_PID_NS=1 nsenter -t "$TPID" -n -m -p -- \
    env -C "$REPO" HARNESS_TENANT_PID_NS=1 node --import tsx scripts/probe-harness/tenant.ts "$ROOT"
else
  HARNESS_TENANT_PID_NS=0 nsenter -t "$TPID" -n -m -- \
    env -C "$REPO" HARNESS_TENANT_PID_NS=0 node --import tsx scripts/probe-harness/tenant.ts "$ROOT"
fi
RC=$?
set -e

kill -TERM "$DEPLOY_PID" 2>/dev/null || true
wait "$DEPLOY_PID" 2>/dev/null || true
exit $RC
