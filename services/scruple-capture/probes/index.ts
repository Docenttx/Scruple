// H-4 §7 — the seven probes, for the ComfyUI reference integration.
//
// "Run from inside the tenant container, where the adversary sits; each must
// fail." That sentence is the whole specification and it contains the two
// things this file has to get right.
//
// FROM INSIDE THE TENANT CONTAINER. Not from CI, not from the vendor's laptop,
// not from the sidecar. A probe that runs anywhere else is a design review with
// assertions in it. `TenantVantage` is how that stops being a hope: run these
// with `OsVantage` inside the workload container and their answers are facts
// about that deployment; run them with `SimulatedVantage` and the runner marks
// every topology answer inadmissible, because a policy answered the question.
//
// EACH MUST FAIL. The probe is the attack. `outcome: 'blocked'` is the good
// news. The one place this gets genuinely confusing is probes 4 and 5, where
// the "attack" is writing a file and then WAITING for the leaf not to appear —
// so the attack succeeds when nothing happens, and a conformant deployment is
// the one where something does. The requirement strings say so out loud.
//
// ---------------------------------------------------------------------------
// WHAT SPLITS THESE SEVEN INTO TWO KINDS — and it is not the numbering
// ---------------------------------------------------------------------------
//
// 1, 2, 3 and 7 ask "can the tenant reach X?". That is a fact about network
// and mount topology, and sonobuoy-conformance.md §5.2 already found the
// consequence from the other end: P1 and P3 are the irreducible cases, because
// "a process running inside the same trust boundary cannot prove it from the
// inside, no matter how cleverly the test is written." These four are marked
// `topological: true` and are only ever admissible from an occupied position.
//
// 4, 5 and 6 ask "does the capture path do its job?". Those are functional
// claims a test observes directly, exactly like every Kubernetes conformance
// claim, and they are admissible from anywhere the deployment is real.
//
// That split is not an implementation compromise. It is the finding: FOUR OF
// THE SEVEN PROBES CANNOT BE STRENGTHENED BY WRITING MORE CODE. They can only
// be strengthened by moving where they run.

import { probeBypassGate } from './01-bypass-gate';
import { probeAdminSurface } from './02-admin-surface';
import { probeSealedIk } from './03-sealed-ik';
import { probeOutputVolume } from './04-output-volume';
import { probeWebsocketRetrieval } from './05-ws-retrieval';
import { probeCounterReplay } from './06-counter-replay';
import { probeEgress } from './07-egress';

import type { Probe } from '../../../packages/scruple-conformance/src/types';

/** The seven, in spec order. The order is stable; the ids never change. */
export const COMFYUI_PROBES: readonly Probe[] = [
  probeBypassGate,
  probeAdminSurface,
  probeSealedIk,
  probeOutputVolume,
  probeWebsocketRetrieval,
  probeCounterReplay,
  probeEgress,
];

export {
  probeBypassGate,
  probeAdminSurface,
  probeSealedIk,
  probeOutputVolume,
  probeWebsocketRetrieval,
  probeCounterReplay,
  probeEgress,
};
