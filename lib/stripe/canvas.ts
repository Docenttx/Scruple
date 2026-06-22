// Stripe per-second billing for canvas sessions — Canvas v2 (WO-6).
//
// Lifecycle:
//   1. mint     → createCanvasHold() : PaymentIntent(manual_capture,
//                                       amount=1h × hourly_rate).
//                                       Card holds the amount on
//                                       confirm; money sits on user's
//                                       card, NOT in Scruple's account.
//   2. tick     → heartbeat-driven; nothing here, just accumulated_seconds++
//   3. end      → finalizeCanvasCharge() :
//                  - amount_to_capture = ceil(elapsed * rate / 3600)
//                  - if > 0: paymentIntents.capture(amount_to_capture)
//                  - if = 0: paymentIntents.cancel()
//                  - audit row in canvas_session_charges
//
// "Non-custodial" = the hold sits on the user's payment-method, never
// in a Scruple Stripe Connect account. We're a standard Stripe direct-
// charge merchant; the only twist is manual_capture + amount_to_capture.

import { stripe } from './customer';
import { conn } from '@/lib/db/sqlite';
import { getMachineById } from '@/lib/compute/machines';

interface SessionRow {
  id: string;
  user_id: string;
  machine_id: string;
  payment_intent_id: string | null;
  payment_status: string;
  accumulated_seconds: number;
  finalized_at: number | null;
  hold_cents: number | null;
  started_at: string;
  expires_at: string;
}

/**
 * Place a 1h × hourly_rate hold on the user's default payment method.
 * Throws if the customer has no default payment method (caller should
 * surface a "add a card in Settings → Payment" message).
 *
 * Returns the PaymentIntent id + hold amount in cents.
 */
export async function createCanvasHold(opts: {
  sessionId: string;
  userId: string;
  customerId: string;
  machineId: string;
}): Promise<{ paymentIntentId: string; holdCents: number }> {
  const machine = getMachineById(opts.machineId);
  if (!machine) throw new Error(`Unknown machine: ${opts.machineId}`);
  const holdCents = machine.hourlyRateCents; // 1h × rate

  const s = stripe();
  // Find a default payment method (or any card method).
  const cust = await s.customers.retrieve(opts.customerId);
  if (cust.deleted) {
    throw new Error('Stripe customer is deleted; add a payment method in Settings → Payment');
  }
  let defaultPm: string | null =
    typeof cust.invoice_settings?.default_payment_method === 'string'
      ? cust.invoice_settings.default_payment_method
      : cust.invoice_settings?.default_payment_method?.id ?? null;
  if (!defaultPm) {
    const methods = await s.paymentMethods.list({
      customer: opts.customerId,
      type: 'card',
      limit: 1,
    });
    defaultPm = methods.data[0]?.id ?? null;
  }
  if (!defaultPm) {
    throw new Error('No payment method on file. Add a card in Settings → Payment.');
  }

  const pi = await s.paymentIntents.create(
    {
      amount: holdCents,
      currency: 'usd',
      customer: opts.customerId,
      payment_method: defaultPm,
      capture_method: 'manual',
      confirm: true,
      off_session: true,
      description: `Scruple canvas session ${opts.sessionId} (${machine.name})`,
      metadata: {
        scrupleUserId: opts.userId,
        scrupleSessionId: opts.sessionId,
        scrupleMachineId: opts.machineId,
      },
    },
    { idempotencyKey: `canvas-session-${opts.sessionId}` },
  );

  conn()
    .prepare(
      `UPDATE canvas_sessions
          SET payment_intent_id = ?,
              payment_status = 'held',
              hold_cents = ?,
              last_heartbeat = unixepoch()
        WHERE id = ?`,
    )
    .run(pi.id, holdCents, opts.sessionId);

  return { paymentIntentId: pi.id, holdCents };
}

/**
 * Finalize a session — capture actual usage cents (or cancel if zero).
 * Idempotent on `payment_status` (re-finalize is a no-op).
 *
 * Returns the captured amount in cents (0 means cancelled).
 */
export async function finalizeCanvasCharge(
  sessionId: string,
): Promise<{ capturedCents: number; outcome: 'captured' | 'cancelled' | 'capture_failed'; detail?: string }> {
  const row = conn()
    .prepare(`SELECT * FROM canvas_sessions WHERE id = ?`)
    .get(sessionId) as SessionRow | undefined;
  if (!row) throw new Error(`Session ${sessionId} not found`);
  if (row.finalized_at) {
    return {
      capturedCents: row['accumulated_seconds'] ? 0 : 0,
      outcome: row.payment_status === 'captured' ? 'captured' : 'cancelled',
      detail: 'already finalized',
    };
  }
  if (!row.payment_intent_id) {
    // Mint failed mid-stream or pre-WO-6 row; nothing to capture.
    conn()
      .prepare(
        `UPDATE canvas_sessions
            SET finalized_at = unixepoch(),
                payment_status = 'none',
                captured_cents = 0,
                status = 'expired'
          WHERE id = ?`,
      )
      .run(sessionId);
    return { capturedCents: 0, outcome: 'cancelled', detail: 'no payment intent' };
  }

  const machine = getMachineById(row.machine_id);
  if (!machine) throw new Error(`Machine ${row.machine_id} missing from catalog`);
  const accumCents = Math.ceil(
    (row.accumulated_seconds * machine.hourlyRateCents) / 3600,
  );

  const s = stripe();
  let outcome: 'captured' | 'cancelled' | 'capture_failed' = 'captured';
  let outcomeDetail: string | undefined;
  let capturedCents = 0;

  try {
    if (accumCents <= 0) {
      await s.paymentIntents.cancel(row.payment_intent_id, {
        cancellation_reason: 'abandoned',
      });
      outcome = 'cancelled';
    } else {
      const captured = await s.paymentIntents.capture(row.payment_intent_id, {
        amount_to_capture: accumCents,
      });
      capturedCents = captured.amount_received ?? accumCents;
    }
  } catch (e) {
    outcome = 'capture_failed';
    outcomeDetail = e instanceof Error ? e.message : String(e);
  }

  conn()
    .prepare(
      `UPDATE canvas_sessions
          SET finalized_at = unixepoch(),
              captured_cents = ?,
              payment_status = ?,
              status = 'expired'
        WHERE id = ?`,
    )
    .run(capturedCents, outcome, sessionId);

  conn()
    .prepare(
      `INSERT INTO canvas_session_charges
         (session_id, user_id, machine_id, payment_intent_id,
          hold_cents, captured_cents, accumulated_seconds, outcome, outcome_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      row.user_id,
      row.machine_id,
      row.payment_intent_id,
      row.hold_cents ?? 0,
      capturedCents,
      row.accumulated_seconds,
      outcome,
      outcomeDetail ?? null,
    );

  return { capturedCents, outcome, detail: outcomeDetail };
}

/** Heartbeat updates accumulated_seconds + last_heartbeat. Idempotent. */
export function heartbeatCanvasSession(sessionId: string): { accumulated_seconds: number } | null {
  const row = conn()
    .prepare(
      `SELECT last_heartbeat, accumulated_seconds, finalized_at
         FROM canvas_sessions WHERE id = ?`,
    )
    .get(sessionId) as
    | { last_heartbeat: number | null; accumulated_seconds: number; finalized_at: number | null }
    | undefined;
  if (!row || row.finalized_at) return null;

  const now = Math.floor(Date.now() / 1000);
  const last = row.last_heartbeat ?? now;
  const delta = Math.max(0, Math.min(120, now - last)); // cap delta at 120s to bound runaway accum
  const newAccum = row.accumulated_seconds + delta;
  conn()
    .prepare(
      `UPDATE canvas_sessions
          SET last_heartbeat = ?,
              accumulated_seconds = ?
        WHERE id = ?`,
    )
    .run(now, newAccum, sessionId);
  return { accumulated_seconds: newAccum };
}
