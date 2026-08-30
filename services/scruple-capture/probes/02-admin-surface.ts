// Probe 2 — reach the component's provisioning or admin surface.
//
// §4.4's injection sequence is: the vendor mints a one-time token, the
// component redeems it with its build measurement, the server returns the IK
// once. A tenant who can reach either half of that gets to mint an identity
// whose leaves look exactly like the component's.
//
// TWO SURFACES, AND THE SECOND ONE IS THE ONE PEOPLE FORGET. The component has
// no admin HTTP surface of its own — everything on its listener is proxied to
// ComfyUI — so the first half of this probe is a check that stays true rather
// than a check that already passes. The second half is scruple-web's
// /api/v2/components/provision, which is on the public internet by design and
// therefore reachable BY CONSTRUCTION; what must fail there is the REQUEST,
// not the connection. §10 C-5 is exactly this: the one-time token alone cannot
// say which tenant is calling, so an API key carrying `component:provision` is
// required in addition, and a tenant credential must not carry it.

import type { Probe, ProbeContext, ProbeObservation } from '../../../packages/scruple-conformance/src/types';

/** Paths that would be a control surface if the component ever grew one. */
const ADMIN_PATHS = [
  '/scruple/admin',
  '/scruple/provision',
  '/scruple/identity',
  '/scruple/queue',
  '/scruple/metrics',
  '/.scruple-capture/identity.json',
];

export const probeAdminSurface: Probe = {
  id: 'P-02',
  spec: 'H-4 §7 probe 2 (§4.4, §10 C-5)',
  title: "reach the component's provisioning or admin surface",
  attempt:
    "GET a set of control paths on the component's own listener, then POST a provisioning " +
    'request to scruple-web with the credential the tenant holds',
  requirement:
    'the component must expose no control surface on the tenant-facing listener, and a ' +
    'tenant credential must not be able to provision a component',
  evidenceFor: ['P1', 'P3'],
  topological: true,

  async run(ctx: ProbeContext): Promise<ProbeObservation> {
    const leaked: string[] = [];

    for (const p of ADMIN_PATHS) {
      try {
        const res = await ctx.vantage.request(`${ctx.deployment.gateUrl}${p}`, { method: 'GET' });
        const body = await res.text();
        // The gate proxies unknown paths upstream, so a 404 from ComfyUI is
        // the expected answer. What matters is a 2xx that carries anything
        // that looks like component state.
        if (res.status >= 200 && res.status < 300 && /component_id|chain_key|counter|queue/i.test(body)) {
          leaked.push(`${p} → ${res.status}`);
        }
      } catch {
        /* unreachable is the good answer */
      }
    }

    // The provisioning endpoint. Reachability is not the question.
    let provisionStatus: number | null = null;
    let provisionBody = '';
    if (ctx.deployment.apiBaseUrl) {
      try {
        const res = await ctx.vantage.request(
          `${ctx.deployment.apiBaseUrl}/api/v2/components/provision`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(ctx.deployment.tenantApiKey
                ? { authorization: `Bearer ${ctx.deployment.tenantApiKey}` }
                : {}),
            },
            body: JSON.stringify({
              token: 'probe-02-not-a-real-token',
              build_measurement: 'probe',
            }),
          },
        );
        provisionStatus = res.status;
        provisionBody = (await res.text()).slice(0, 200);
      } catch {
        provisionStatus = null;
      }
    }

    const provisionGotThrough = provisionStatus !== null && provisionStatus >= 200 && provisionStatus < 300;

    if (leaked.length === 0 && !provisionGotThrough) {
      return {
        outcome: 'blocked',
        detail:
          `No control path on the gate returned component state (${ADMIN_PATHS.length} tried), and ` +
          `provisioning refused with ${provisionStatus ?? 'no response'}.`,
        evidence: {
          admin_paths_tried: ADMIN_PATHS.length,
          admin_paths_leaked: 0,
          provision_status: provisionStatus,
          note: 'the provisioning endpoint is reachable by design; what must fail is the request',
        },
      };
    }

    return {
      outcome: 'succeeded',
      detail:
        (leaked.length ? `Component state served on ${leaked.join(', ')}. ` : '') +
        (provisionGotThrough
          ? `A provisioning request from the tenant position was accepted (${provisionStatus}): ` +
            "§10 C-5's second factor is not enforced, so a tenant can mint an identity whose " +
            'leaves are indistinguishable from the component\'s.'
          : ''),
      evidence: {
        admin_paths_tried: ADMIN_PATHS.length,
        admin_paths_leaked: leaked.length,
        leaked: leaked.join('; '),
        provision_status: provisionStatus,
        provision_response_head: provisionBody,
      },
    };
  },
};
