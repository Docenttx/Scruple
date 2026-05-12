// POST /api/stripe/setup-intent — start a saved-card collection flow.
//
// Creates (or ensures) the user's Stripe customer, then issues a
// SetupIntent so the client can mount Stripe Elements + ask Stripe
// to attach a payment method to the customer for future use.
//
// Body: {} (no payload needed — derives customer from the session)
// Returns: { clientSecret, customerId, publishableKey }

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { ensureStripeCustomer, stripe } from '@/lib/stripe/customer';

export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const customerId = await ensureStripeCustomer(userId);
    const intent = await stripe().setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session', // future charges without re-prompting the user
      metadata: { scrupleUserId: userId },
    });
    return NextResponse.json({
      ok: true,
      clientSecret: intent.client_secret,
      customerId,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'stripe_error', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
