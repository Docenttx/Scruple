// GET  /api/stripe/customer        — read-only snapshot of the user's
//                                    Stripe customer + saved payment
//                                    methods. Returns null if no
//                                    customer exists yet.
// POST /api/stripe/customer/ensure — lazily create the Stripe customer
//                                    for this user. Idempotent.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { ensureStripeCustomer, snapshotCustomer } from '@/lib/stripe/customer';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const snap = await snapshotCustomer(userId);
    return NextResponse.json({ customer: snap });
  } catch (e) {
    return NextResponse.json(
      { error: 'stripe_error', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

export async function POST() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const customerId = await ensureStripeCustomer(userId);
    const snap = await snapshotCustomer(userId);
    return NextResponse.json({ ok: true, customerId, customer: snap });
  } catch (e) {
    return NextResponse.json(
      { error: 'stripe_error', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
