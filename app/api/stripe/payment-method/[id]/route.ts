// DELETE /api/stripe/payment-method/:id — detach a card from the
//                                          user's Stripe customer
// POST   /api/stripe/payment-method/:id/default — set as customer's
//                                                 default payment method
//
// Both routes verify the payment method actually belongs to the user's
// customer before mutating.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { getStripeCustomerId, stripe } from '@/lib/stripe/customer';

export const dynamic = 'force-dynamic';

async function assertOwnership(userId: string, pmId: string): Promise<{ ok: true; customerId: string } | { ok: false; status: number; error: string }> {
  const customerId = getStripeCustomerId(userId);
  if (!customerId) return { ok: false, status: 404, error: 'no_customer' };
  try {
    const pm = await stripe().paymentMethods.retrieve(pmId);
    if (pm.customer !== customerId) {
      return { ok: false, status: 404, error: 'not_yours' };
    }
    return { ok: true, customerId };
  } catch (e) {
    return { ok: false, status: 502, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const own = await assertOwnership(userId, params.id);
  if (!own.ok) return NextResponse.json({ error: own.error }, { status: own.status });

  try {
    await stripe().paymentMethods.detach(params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: 'stripe_error', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
