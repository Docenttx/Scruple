// POST /api/onboarding/complete
//
// Marks the user as onboarded: writes plan choice, ToS acceptance,
// and onboarded_at timestamp. Also kicks off Stripe customer creation
// (idempotent — re-uses existing customer if already created).
//
// Body: { plan: 'free'|'starter'|'pro'|'enterprise', tosAccepted: true }
//
// Auth: cookie session only (API keys cannot complete onboarding).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { ensureStripeCustomer } from '@/lib/stripe/customer';

export const dynamic = 'force-dynamic';

const Body = z.object({
  plan: z.enum(['free', 'starter', 'pro', 'enterprise']),
  tosAccepted: z.literal(true),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  // Ensure Stripe customer exists (even for free-tier — they may upgrade
  // later, and we want one canonical customer record per user).
  try {
    await ensureStripeCustomer(userId);
  } catch (e) {
    // Don't block onboarding if Stripe is down — the customer can be
    // created on first paid action. Log for visibility.
    console.warn(`[onboarding] ensureStripeCustomer failed for ${userId}:`, e);
  }

  const now = new Date().toISOString();
  conn()
    .prepare(
      `UPDATE users
       SET plan = ?,
           tos_accepted_at = COALESCE(tos_accepted_at, ?),
           onboarded_at = COALESCE(onboarded_at, ?)
       WHERE id = ?`,
    )
    .run(body.plan, now, now, userId);

  return NextResponse.json({ ok: true, plan: body.plan, onboardedAt: now });
}
