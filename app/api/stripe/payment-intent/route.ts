// POST /api/stripe/payment-intent
//
// Asks the witness server (which holds the Stripe key) to create a
// payment intent for a given lock action + project. We forward to the
// witness server's existing endpoint to keep all Stripe knowledge
// centralized there.
//
// Body: { action: LockAction, projectId: number }
// Response: forwarded from witness server
//
// If the witness server doesn't have STRIPE_SECRET_KEY set, this will
// fail with the witness server's error. The user-facing chain-lock UI
// can fall back to LOCK_REQUIRE_PAYMENT=0 for local development.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';

const WITNESS_URL = process.env.WITNESS_SERVER_URL || 'http://127.0.0.1:5799';

const Body = z.object({
  action: z.enum(['finalize', 'checkpoint', 'chain-lock-basic', 'chain-lock-pinned']),
  projectId: z.number().int().positive(),
});

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // Verify project ownership
  const project = conn()
    .prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, userId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  // Forward to witness server. Use namespaced project id so the witness
  // server's payment metadata maps back unambiguously.
  //
  // Use the bare project id — the witness's anti-tamper check on
  // confirm-and-execute compares paymentIntent.metadata.projectId to
  // the request's projectId, and every other web caller (witness.
  // witnessIteration, witness.confirmAndExecute, witness.lockProject)
  // passes bare ids. The previously-namespaced "sw:<userId>:<id>"
  // form created a round-trip mismatch.
  const res = await fetch(`${WITNESS_URL}/api/create-payment-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: body.action,
      projectId: String(body.projectId),
      installationId: userId,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return NextResponse.json(data, { status: res.status });
  return NextResponse.json(data);
}
