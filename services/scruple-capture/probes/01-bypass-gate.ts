// Probe 1 — reach ComfyUI directly, bypassing the component.
//
// §2 obligation 1: ComfyUI binds loopback or a private namespace and the
// tenant's only route is the component. config.ts can already see that it is
// unverifiable from the component's side and says so as an advisory
// (`topologyAdvisory`) rather than as a check. This is the check, run from the
// only position where it means anything.
//
// THE UPSTREAM ADDRESS IS GIVEN, NOT GUESSED. A probe that had to discover it
// would be testing our port scanner, and a deployment that survived only
// because we failed to find the port would pass. A conformant deployment is one
// where KNOWING the address does not help — which is strictly the stronger
// claim, and the one a vendor should want on their receipt.
//
// WHAT A 'blocked' HERE DOES NOT PROVE. That this vantage has no route. Not
// that no route exists: a second interface, a DNS name resolving elsewhere, a
// host-network sibling container. H-4 §6 is explicit that topology probes plus
// reconciliation make P1 CHECKABLE and that neither makes it PROVABLE, and the
// evidence record below says which of the two this is.

import type { Probe, ProbeContext, ProbeObservation } from '../../../packages/scruple-conformance/src/types';

export const probeBypassGate: Probe = {
  id: 'P-01',
  spec: 'H-4 §7 probe 1 (§2 obligation 1)',
  title: 'reach ComfyUI directly, bypassing the component',
  attempt: 'TCP connect to the declared upstream and POST /prompt without going through the gate',
  requirement: 'the upstream must be unreachable from the tenant position',
  evidenceFor: ['P1'],
  topological: true,

  async run(ctx: ProbeContext): Promise<ProbeObservation> {
    const up = ctx.deployment.declaredUpstream;
    if (!up) {
      return {
        outcome: 'not-attempted',
        detail:
          'No declared upstream. The operator must state where the workload actually listens; ' +
          'without it this probe would be a port scan, and a deployment that survived a failed ' +
          'scan would pass on our incompetence rather than on its topology.',
        evidence: { declared_upstream: null },
      };
    }

    const reachable = await ctx.vantage.tcpReachable(up.host, up.port, 2000);
    if (!reachable) {
      return {
        outcome: 'blocked',
        detail: `TCP connect to ${up.host}:${up.port} refused or timed out from the tenant position.`,
        evidence: {
          upstream: `${up.host}:${up.port}`,
          tcp_reachable: false,
          proves: 'this vantage has no route; NOT that no route exists (H-4 §6)',
        },
      };
    }

    // Reachable at the transport layer. That alone is a finding, but say
    // exactly what got through: an upstream that accepts a prompt is a
    // complete bypass, and one that merely accepts a connection may be a
    // mesh sidecar in front of it.
    let status: number | null = null;
    let body = '';
    try {
      const res = await ctx.vantage.request(`http://${up.host}:${up.port}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          '1': { class_type: 'KSampler', inputs: { seed: 1 } },
          '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'probe01', images: ['1', 0] } },
        }),
      });
      status = res.status;
      body = (await res.text()).slice(0, 200);
    } catch (e) {
      return {
        outcome: 'succeeded',
        detail:
          `TCP connect to ${up.host}:${up.port} SUCCEEDED from the tenant position. The HTTP ` +
          `request then failed (${e instanceof Error ? e.message : String(e)}), but the ` +
          'transport-layer route exists and §2 obligation 1 is not met.',
        evidence: { upstream: `${up.host}:${up.port}`, tcp_reachable: true, http_status: null },
      };
    }

    return {
      outcome: 'succeeded',
      detail:
        `POST /prompt direct to ${up.host}:${up.port} returned ${status}. The tenant can queue ` +
        'work the component never saw, and every artifact of that work is outside the gate.',
      evidence: {
        upstream: `${up.host}:${up.port}`,
        tcp_reachable: true,
        http_status: status,
        response_head: body,
      },
    };
  },
};
