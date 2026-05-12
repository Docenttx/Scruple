// POST /api/stripe/payment-method/:id/default — set this payment method
// as the customer's default for future invoices/charges.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { getStripeCustomerId, stripe } from '@/lib/stripe/customer';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const customerId = getStripeCustomerId(userId);
  if (!customerId) return NextResponse.json({ error: 'no_customer' }, { status: 404 });

  try {
    // Confirm ownership
    const pm = await stripe().paymentMethods.retrieve(params.id);
    if (pm.customer !== customerId) {
      return NextResponse.json({ error: 'not_yours' }, { status: 404 });
    }
    await stripe().customers.update(customerId, {
      invoice_settings: { default_payment_method: params.id },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: 'stripe_error', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
