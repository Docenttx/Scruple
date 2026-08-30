// Probe 6 — submit a leaf with a counter at or below the component's last.
//
// ---------------------------------------------------------------------------
// WHAT §7 PROBE 6 ASKED FOR IS NOT WHAT §10 C-3 LEFT BEHIND
// ---------------------------------------------------------------------------
//
// §7 probe 6 was written when §4.2 said counters must STRICTLY INCREASE, so
// "submit at or below the last" was a single, complete test: any such
// submission must be refused.
//
// C-3 replaced strict increase with a BOUNDED ACCEPTANCE WINDOW, and it had to:
// §5 lets a queued event keep its counter and drain later, so under strict
// increase a genuinely captured event comes back as a replay and is lost from
// the record. Under C-3 an UNSEEN counter below the high-water mark is
// ACCEPTED — that is the queue draining, and refusing it would destroy exactly
// the evidence the queue exists to preserve.
//
// So the probe as written would now fail a conformant server for doing the
// right thing. What survives, and what this implements, is the part C-3 kept:
// replay defence is the `(component_id, counter)` primary key, and the MAC.
// Three submissions, three distinct refusals:
//
//   6a  a counter at or below the high-water mark with a FORGED MAC
//       → refused. This is the tenant forging history.
//   6b  a counter far below the acceptance window
//       → refused as `counter_too_far` (C-2's bound, applied downward).
//   6c  a counter far ABOVE the high-water mark
//       → refused as `counter_too_far`, and refused BEFORE any ratcheting
//         (§10 C-6): the counter is attacker-supplied and ratcheting to it is
//         work proportional to it.
//
// A tenant cannot produce a valid MAC at all without the chain key, so this
// probe is bounded by construction: it establishes that the server refuses
// forged history, NOT that it would refuse a component that had been
// compromised. Probe 3 is the one that speaks to the second, and §6 is honest
// that neither is a proof.

import crypto from 'node:crypto';

import type { Probe, ProbeContext, ProbeObservation } from '../../../packages/scruple-conformance/src/types';

/** Roughly ACCEPTANCE_WINDOW_COUNTERS + MAX_RATCHET_ADVANCE headroom. */
const FAR = 250_000;

interface Attempt {
  label: string;
  counter: number;
  status: number | null;
  body: string;
  accepted: boolean;
  /** Refused by the field validator rather than by the ratchet. Not evidence. */
  malformed: boolean;
}

export const probeCounterReplay: Probe = {
  id: 'P-06',
  spec: 'H-4 §7 probe 6, as amended by §10 C-2/C-3/C-6',
  title: 'submit a leaf at or below the component\'s last counter',
  attempt:
    'POST three forged submissions to /api/v2/witness claiming the component identity — one ' +
    'inside the acceptance window, one far below it, one far above it',
  requirement: 'all three must be refused; none may be recorded as a verified component event',
  evidenceFor: ['P4', 'P5'],
  topological: false,

  async run(ctx: ProbeContext): Promise<ProbeObservation> {
    const componentId = ctx.deployment.componentId;
    if (!componentId) {
      return {
        outcome: 'not-attempted',
        detail:
          'No component id supplied. A forgery probe needs the identity it is forging; without ' +
          'it this would test nothing but the 400 handler.',
        evidence: { component_id: null },
      };
    }

    const high = await ctx.leaves.highWaterCounter();
    const base = high ?? 0;
    const attempts: Attempt[] = [];

    const cases: Array<{ label: string; counter: number }> = [
      { label: 'at-or-below-high-water', counter: Math.max(0, base) },
      { label: 'far-below-window', counter: base - FAR },
      { label: 'far-above-high-water', counter: base + FAR },
    ];

    // A DEGENERATE CASE THIS PROBE CANNOT ESCAPE, RECORDED RATHER THAN HIDDEN.
    // On a young component (`base < FAR`) the far-below counter is NEGATIVE, so
    // the server refuses it as `invalid_counter` — the integer validator, not
    // C-3's downward acceptance window. The refusal is correct and the probe
    // learned nothing about the window's floor. Exercising it needs a component
    // whose high-water mark exceeds the window plus MAX_RATCHET_ADVANCE, which
    // a fresh deployment does not have and a probe must not manufacture by
    // spending 250,000 of the vendor's counters.
    const farBelowDegenerate = base < FAR;

    for (const c of cases) {
      const submission = forgedSubmission(componentId, c.counter);
      let status: number | null = null;
      let body = '';
      try {
        const res = await ctx.vantage.request(`${ctx.deployment.apiBaseUrl}/api/v2/witness`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(ctx.deployment.tenantApiKey
              ? { authorization: `Bearer ${ctx.deployment.tenantApiKey}` }
              : {}),
            'x-scruple-component-counter': String(c.counter),
          },
          body: JSON.stringify(submission),
        });
        status = res.status;
        body = (await res.text()).slice(0, 300);
      } catch (e) {
        body = e instanceof Error ? e.message : String(e);
      }
      // ACCEPTED means the forgery was recorded as a VERIFIED component event.
      // A 2xx that records `component_verified = 0` is the route doing its job
      // for a leaf with no envelope, and is not what this probe is hunting.
      const accepted = status !== null && status >= 200 && status < 300 && !/"component_verified"\s*:\s*(0|false)/.test(body);
      // A refusal AT THE FIELD VALIDATOR is not a refusal by the ratchet, and
      // reporting the two the same way is how this probe passed against a
      // deployment it never reached. See forgedSubmission's header.
      const malformed = /malformed|invalid_json|bad json|schema/i.test(body) || status === 400;
      attempts.push({ label: c.label, counter: c.counter, status, body, accepted, malformed });
    }

    const got = attempts.filter((a) => a.accepted);
    const evidence: Record<string, string | number | boolean | null> = {
      component_id: componentId,
      high_water: high,
      attempts: attempts.length,
      accepted: got.length,
      far_below_degenerate: farBelowDegenerate,
      far_below_note: farBelowDegenerate
        ? "high-water mark is below the window width, so the 'far below' counter is negative " +
          "and is refused as an invalid integer rather than as counter_too_far; C-3's downward " +
          'floor is NOT exercised by this run'
        : "C-3's downward floor was exercised",
    };
    for (const a of attempts) {
      evidence[`${a.label}_status`] = a.status;
      evidence[`${a.label}_response`] = a.body.slice(0, 120);
    }

    const malformed = attempts.filter((a) => a.malformed);
    evidence.refused_as_malformed = malformed.length;

    if (malformed.length > 0) {
      // Inconclusive, which is not a pass. The submissions never reached the
      // replay defence, so this run says nothing about whether one exists.
      return {
        outcome: 'not-attempted',
        detail:
          `${malformed.length} of ${attempts.length} forged submissions were refused as ` +
          'malformed rather than as forged, so they never reached the ratchet. A deployment ' +
          'with no replay defence at all would answer identically. Either the probe\'s ' +
          'submission shape has drifted from the ingest contract or the ingest is refusing at ' +
          'the field validator; both make this result inadmissible as evidence about ' +
          'C-2/C-3/C-6, and inconclusive is not a pass.',
        evidence,
      };
    }

    if (got.length === 0) {
      return {
        outcome: 'blocked',
        detail:
          `All ${attempts.length} forged submissions reached the ratchet and were refused ` +
          `(${attempts.map((a) => `${a.label}:${a.status ?? 'no-response'}`).join(', ')}).`,
        evidence,
      };
    }

    return {
      outcome: 'succeeded',
      detail:
        `${got.length} forged submission(s) accepted as component events ` +
        `(${got.map((a) => `${a.label} at counter ${a.counter}`).join(', ')}). The ratchet is ` +
        'decorative on this deployment: a tenant can write history the component never produced.',
      evidence,
    };
  },
};

/**
 * A structurally valid submission with a MAC nobody could have computed.
 *
 * ---------------------------------------------------------------------------
 * "STRUCTURALLY VALID" USED TO BE A LIE HERE, AND THE PROBE PASSED ON IT
 * ---------------------------------------------------------------------------
 *
 * Found by running this probe from the tenant position for the first time
 * (WO-14). The first version of this object was a plausible-looking sketch —
 * `schema`, `size_bytes`, a `component` block with `attestation_status` and no
 * `attestation`, a three-field `capture`. An ingest that canonicalises before
 * it verifies rejects that at the JSON layer: all three attempts came back
 * `400 malformed_submission` and the probe recorded a clean `blocked`.
 *
 * THREE 400s ARE NOT EVIDENCE OF A RATCHET. They are evidence of a field
 * validator, and a deployment whose replay defence was entirely absent would
 * have produced exactly the same three 400s and exactly the same PASS. The
 * probe was measuring our own malformed request.
 *
 * So the shape below is the full `Submission` (services/scruple-capture/src/
 * leaf.ts) written out longhand rather than imported. Restated, for the reason
 * probe 5 restates `server.py`'s frame header: a probe that asked the component
 * it is attacking what a valid submission looks like would agree with that
 * component by construction, including where it is wrong.
 *
 * Every field is present and well-typed. The ONLY thing wrong with it is the
 * MAC — 32 random bytes, the right shape and the wrong value, which is the only
 * forgery a tenant without the chain key can make. The refusal therefore comes
 * from the ratchet, and the probe measures the SERVER.
 */
function forgedSubmission(componentId: string, counter: number): Record<string, unknown> {
  const bytes = Buffer.from(`scruple-conformance P-06 ${crypto.randomUUID()}`, 'utf8');
  const observedAt = new Date().toISOString();
  return {
    baseline_ref: 'ff'.repeat(32),
    kind: 'artifact',
    content_hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    mime: 'image/png',
    capture: {
      surface: 'network-gate',
      hook: 'artifact.produced',
      fidelity: 'as-delivered',
      size_bytes: bytes.length,
      mime_source: 'upstream-declared',
      correlation_id: null,
      correlation_method: null,
      egress: '/probe-06',
      close_detection: null,
      workflow_hash: null,
      observed_at: observedAt,
      attestation_status: 'passthrough',
    },
    component: {
      component_id: componentId,
      build_measurement: 'probe-06-forged',
      counter,
      attestation: { provider: 'none', quote_ref: null },
    },
    mac: crypto.randomBytes(32).toString('hex'),
  };
}
