// Probe 7 — open an outbound connection to an arbitrary external host.
//
// NEW IN §10 C-9, AND IT EXISTS BECAUSE §2's CENTRAL CLAIM WAS FALSE AS
// WRITTEN. §2 said owning both surfaces means a tenant "cannot produce a
// retrievable artifact with no leaf." WO-7 found the counterexample:
// `comfy_api_nodes/` ships ~25 in-tree node packs that open `aiohttp` sessions
// to external services from INSIDE the ComfyUI process (nodes_topaz.py:421 is
// one), and any custom node can POST an image anywhere. Those bytes leave
// through neither the gate nor the output volume.
//
// The error was symmetrical-sounding language — "owns both surfaces" — for a
// component that only ever faced one direction. §2's obligations constrain
// what can REACH ComfyUI and say nothing about what ComfyUI can REACH.
// Obligation 4 is the fix: egress from the workload container is denied except
// through the component. This probe is what checks it.
//
// TWO WAYS TO GET A WRONG ANSWER HERE, both closed below:
//
//   * PROBING AN ALLOWLISTED HOST PROVES NOTHING. If the operator names a
//     target the vendor's policy permits, a reachable result is a correctly
//     configured deployment and an unreachable one is luck. The target must be
//     a host the deployment has no business reaching, and the probe records
//     which host it used so a reviewer can judge that for themselves.
//   * DNS IS ITSELF AN EGRESS CHANNEL. A policy that blocks TCP and leaves the
//     resolver open still leaks — a few dozen bytes per query, which is plenty
//     for a hash or a key. Both are attempted and reported separately.

import type { Probe, ProbeContext, ProbeObservation } from '../../../packages/scruple-conformance/src/types';

/** A name the workload has no business resolving. Not fetched — only resolved. */
const DNS_CANARY = 'scruple-conformance-probe-07.invalid.example';

export const probeEgress: Probe = {
  id: 'P-07',
  spec: 'H-4 §10 C-9 → §7 probe 7 (new §2 obligation 4)',
  title: 'open an outbound connection to an arbitrary external host',
  attempt: 'TCP connect to an external host from the tenant position, and resolve a canary name',
  requirement:
    'egress from the workload container must be denied except through the component — both ' +
    'the connection and the DNS query',
  evidenceFor: ['P1', 'P2', 'P6'],
  topological: true,

  async run(ctx: ProbeContext): Promise<ProbeObservation> {
    const target = ctx.deployment.egressTarget;
    if (!target) {
      return {
        outcome: 'not-attempted',
        detail:
          'No egress target declared. The operator must name a host the deployment has no ' +
          'business reaching; probing an allowlisted one would report a correctly configured ' +
          'policy as a hole, or luck as a policy.',
        evidence: { egress_target: null, negative_control: null },
      };
    }

    const tcp = await ctx.vantage.tcpReachable(target.host, target.port, 3000);
    // Through the vantage, not through node:dns directly: the resolver is a
    // second egress channel and it has to be measured from the same position
    // as the first, or a report can say "TCP denied" while a node quietly
    // exfiltrates a hash per query.
    const dnsResolved = await ctx.vantage.dnsResolvable(DNS_CANARY);

    const control = ctx.deployment.egressControl;
    const controlReachable = control
      ? await ctx.vantage.tcpReachable(control.host, control.port, 3000)
      : false;

    const evidence = {
      egress_target: `${target.host}:${target.port}`,
      tcp_reachable: tcp,
      dns_canary: DNS_CANARY,
      dns_channel_open: dnsResolved,
      negative_control: control ? `${control.host}:${control.port}` : null,
      negative_control_reachable: controlReachable,
      why: 'comfy_api_nodes/ opens aiohttp sessions to external services from inside the ComfyUI process',
    };

    // A reachable target is decisive on its own: the bytes can leave, and no
    // control is needed to establish that.
    if (tcp || dnsResolved) {
      const channels = [tcp ? 'TCP' : null, dnsResolved ? 'DNS' : null].filter(Boolean).join(' and ');
      return {
        outcome: 'succeeded',
        detail:
          `${channels} egress is open from the tenant position. A custom node — or any of the ~25 ` +
          'in-tree comfy_api_nodes packs — can put artifact bytes on that channel, and they touch ' +
          'neither the gate nor the output volume. Until obligation 4 is enforced the correct ' +
          'claim is the narrower one: "every artifact retrieved through the sanctioned path is ' +
          'witnessed."',
        evidence,
      };
    }

    // Nothing got out. That is only a PASS if we can show something was
    // supposed to.
    if (!controlReachable) {
      return {
        outcome: 'not-attempted',
        detail:
          (control
            ? `The negative control ${control.host}:${control.port} was also unreachable. `
            : 'No negative control was declared. ') +
          'Nothing left this position, and this probe cannot tell egress denied by the ' +
          "deployment's policy from egress denied by the environment it is running in — a " +
          'sandbox, an air-gapped runner, a lab bench with no route. Recorded as inconclusive, ' +
          'which is not a pass. Declare a control endpoint outside the workload policy and ' +
          're-run from inside the tenant container.',
        evidence,
      };
    }

    return {
      outcome: 'blocked',
      detail:
        `No TCP route to ${target.host}:${target.port} and no resolver answered ${DNS_CANARY}, ` +
        `while the negative control ${control!.host}:${control!.port} WAS reachable from the same ` +
        'position. The denial is the policy, not the environment. §2 obligation 4 holds at this vantage.',
      evidence,
    };
  },
};
