// Reconciliation sweep — records silence TRANSITIONS.
//
//   node --import tsx scripts/reconcile-sweep.ts [--tenant <id>] [--json]
//
// EXPLICITLY INVOKED. Silence itself is computed on read (see
// lib/reconcile/silence.ts) and needs nothing running; this sweep exists
// only to write down WHEN a component went dark, so an alert has an edge
// to fire on and an auditor has a durable episode rather than a predicate
// that was true at some point nobody recorded.
//
// There is deliberately no timer inside the Next.js process. A
// setInterval in a route module runs once per warm serverless instance,
// zero times on a cold one and N times across N replicas, which would
// make the evidence record depend on which instance happened to be
// alive — the same class of accident as a witness hook that no-ops when
// an env var is missing. Run this from cron, from a systemd timer, or by
// hand. It is idempotent: a component still silent on the tenth run has
// one row, not ten.

import { runMigrations } from '../lib/db/migrate';
import { sweepSilence } from '../lib/reconcile/silence';

const args = process.argv.slice(2);
const tenantIdx = args.indexOf('--tenant');
const tenantId = tenantIdx >= 0 ? args[tenantIdx + 1] : undefined;
const asJson = args.includes('--json');

runMigrations(false);
const r = sweepSilence({ tenantId });

if (asJson) {
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log(`[reconcile] checked ${r.checked} active component(s)`);
  for (const o of r.opened) {
    console.log(
      `[reconcile] SILENT  ${o.component_id} — last seen ${o.last_seen_at ?? 'never'}, ` +
        `window closed ${o.went_silent_at}`,
    );
  }
  for (const c of r.recovered) {
    console.log(`[reconcile] BACK    ${c.component_id} — witnessing again at ${c.last_seen_at}`);
  }
  if (r.still_silent.length) {
    console.log(`[reconcile] still silent, already recorded: ${r.still_silent.join(', ')}`);
  }
  if (!r.opened.length && !r.recovered.length && !r.still_silent.length) {
    console.log('[reconcile] every active component is inside its heartbeat window');
  }
}

// A non-zero exit when something is silent, so a cron wrapper or a CI
// gate can act on it without parsing stdout. Silence is the signal.
process.exit(r.opened.length + r.still_silent.length > 0 ? 1 : 0);
