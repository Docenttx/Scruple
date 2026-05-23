#!/usr/bin/env node
/**
 * stripe-test-pay.mjs — drives the same Stripe Elements flow a browser
 * does, from the CLI, for sandbox testing of paid lock actions.
 *
 *   1. POST /api/stripe/payment-intent   (creates a test-mode PI)
 *   2. POST {WITNESS}/api/admin/confirm-pi   (confirms with pm_card_visa)
 *   3. prints the succeeded paymentIntentId
 *
 * The result is a real, succeeded test-mode PaymentIntent that any of
 * the /api/lock/* routes will accept and that the witness server will
 * verify the same way it would a live payment. There is no "dev" code
 * path on either server — only different keys (sk_test vs sk_live).
 *
 * Usage:
 *   SCRUPLE_SESSION=<cookie> node scripts/stripe-test-pay.mjs \
 *       --action <checkpoint|finalize|chain-lock-basic|chain-lock-pinned> \
 *       --project <id>
 *
 *   prints: PAYMENT_INTENT=<pi_id>   (single line, easy to capture in $())
 *
 * Env:
 *   SCRUPLE_BASE        default http://127.0.0.1:3001
 *   WITNESS_URL         default http://127.0.0.1:5799
 *   SCRUPLE_SESSION     __Secure-authjs.session-token (required)
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const BASE = process.env.SCRUPLE_BASE ?? 'http://127.0.0.1:3001';
const WIT  = process.env.WITNESS_URL ?? 'http://127.0.0.1:5799';
const SESSION = process.env.SCRUPLE_SESSION;
const ACTION  = args.action;
const PROJECT = Number(args.project);

if (!SESSION) { console.error('SCRUPLE_SESSION env required'); process.exit(2); }
if (!ACTION)  { console.error('--action required (checkpoint|finalize|chain-lock-basic|chain-lock-pinned)'); process.exit(2); }
if (!PROJECT) { console.error('--project <id> required'); process.exit(2); }

const cookie = `__Secure-authjs.session-token=${SESSION}`;

async function main() {
  const c = await fetch(`${BASE}/api/stripe/payment-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: ACTION, projectId: PROJECT }),
  });
  const created = await c.json().catch(() => ({}));
  if (!c.ok) {
    console.error(`create-payment-intent ${c.status}:`, JSON.stringify(created));
    process.exit(1);
  }
  const piId = created.paymentIntentId || created.id || (created.clientSecret || '').split('_secret_')[0];
  if (!piId) {
    console.error('no paymentIntentId in create response:', JSON.stringify(created));
    process.exit(1);
  }

  const f = await fetch(`${WIT}/api/admin/confirm-pi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentIntentId: piId, paymentMethod: 'pm_card_visa' }),
  });
  const conf = await f.json().catch(() => ({}));
  if (!f.ok || conf.status !== 'succeeded') {
    console.error(`confirm-pi ${f.status}:`, JSON.stringify(conf));
    process.exit(1);
  }

  console.log(`PAYMENT_INTENT=${piId}`);
}

main().catch((e) => { console.error('stripe-test-pay error:', e); process.exit(1); });
