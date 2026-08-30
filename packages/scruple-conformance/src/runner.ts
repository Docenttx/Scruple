// The runner. Sonobuoy's aggregator, minus the cluster.
//
// It does three things the probes are deliberately not trusted to do
// themselves:
//
//   1. It decides ADMISSIBILITY. A topological probe run from a simulated
//      vantage is inconclusive no matter what the probe returns, because the
//      question it asked ("can the tenant reach X?") was answered by a policy
//      the operator wrote rather than by the deployment. Leaving that judgement
//      inside each probe would mean seven places to forget it.
//   2. It converts an attack outcome into a verdict, in one place, in one
//      direction: a successful attack is a failed deployment.
//   3. It refuses to let a thrown probe become a silent gap. An exception is
//      'not-attempted', which is inconclusive, which is not a pass.

import crypto from 'node:crypto';

import type { Probe, ProbeContext, ProbeResult, ProbeRun } from './types';
import { verdictOf } from './types';

export async function runProbes(
  probes: readonly Probe[],
  ctx: ProbeContext,
): Promise<ProbeRun> {
  const startedAt = new Date().toISOString();
  const results: ProbeResult[] = [];

  for (const probe of probes) {
    const t0 = Date.now();
    const at = new Date().toISOString();
    // A topology question answered by a policy is not answered.
    const admissible = !(probe.topological && ctx.vantage.kind !== 'os');

    let obs;
    try {
      obs = await probe.run(ctx);
    } catch (e) {
      obs = {
        outcome: 'not-attempted' as const,
        detail:
          `probe threw before it could conclude: ${e instanceof Error ? e.message : String(e)}. ` +
          'Recorded as inconclusive, which is not a pass.',
        evidence: { error: e instanceof Error ? e.name : 'unknown' },
      };
    }

    results.push({
      ...obs,
      id: probe.id,
      spec: probe.spec,
      title: probe.title,
      attempt: probe.attempt,
      requirement: probe.requirement,
      evidenceFor: probe.evidenceFor,
      topological: probe.topological,
      verdict: verdictOf(obs.outcome, admissible),
      vantage: ctx.vantage.kind,
      admissible,
      startedAt: at,
      durationMs: Date.now() - t0,
    });
  }

  const passed = results.filter((r) => r.verdict === 'pass').length;
  const failed = results.filter((r) => r.verdict === 'fail').length;
  const inconclusive = results.filter((r) => r.verdict === 'inconclusive').length;

  return {
    runId: crypto.randomUUID(),
    startedAt,
    finishedAt: new Date().toISOString(),
    vantages: [...new Set(results.map((r) => r.vantage))].sort(),
    results,
    summary: {
      passed,
      failed,
      inconclusive,
      line:
        failed === 0 && inconclusive === 0
          ? `SUCCESS! -- ${passed} Passed | 0 Failed | 0 Inconclusive`
          : `FAILURE -- ${passed} Passed | ${failed} Failed | ${inconclusive} Inconclusive`,
    },
    admissible: failed === 0 && inconclusive === 0,
  };
}

/** The human-readable log. `e2e.log`'s analogue: raw, ordered, ends with the summary. */
export function renderProbeLog(run: ProbeRun): string {
  const out: string[] = [];
  out.push(`scruple-conformance run ${run.runId}`);
  out.push(`started ${run.startedAt}`);
  out.push(`vantage(s) ${run.vantages.join(', ')}`);
  out.push('');
  out.push(
    'Every probe below is an ATTACK made from the tenant position. A conformant',
    'deployment BLOCKS all seven. "blocked" is the good outcome; "succeeded"',
    'means the attack worked and the deployment is non-conformant.',
    '',
  );
  for (const r of run.results) {
    out.push(`--- ${r.id} ${r.title} (${r.spec})`);
    out.push(`    attempt      ${r.attempt}`);
    out.push(`    requirement  ${r.requirement}`);
    out.push(`    outcome      ${r.outcome}`);
    out.push(`    verdict      ${r.verdict.toUpperCase()}${r.admissible ? '' : '  [INADMISSIBLE: ' + r.vantage + ' vantage on a topology probe]'}`);
    out.push(`    detail       ${r.detail}`);
    for (const [k, v] of Object.entries(r.evidence)) out.push(`    · ${k} = ${String(v)}`);
    out.push(`    ${r.durationMs} ms`);
    out.push('');
  }
  out.push(run.summary.line);
  out.push(
    run.admissible
      ? 'ADMISSIBLE: every probe was attempted and blocked from an occupied tenant position.'
      : 'NOT ADMISSIBLE as a conformance submission. A run with any failed or inconclusive ' +
          'probe is the analogue of a Sonobuoy run that skipped tests, and a valid ' +
          'certification run may not skip.',
  );
  return out.join('\n') + '\n';
}
