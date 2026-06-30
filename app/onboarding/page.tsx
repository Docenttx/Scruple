// /onboarding — first-run setup for new Scruple accounts.
//
// Routes here:
//   - First time an OAuth-authed user lands anywhere (server-side
//     redirect from /api/auth/keys/fusion-mint and similar)
//   - After-login from /login when the user hasn't onboarded yet
//
// Flow:
//   1. Welcome the user + name what they're about to do
//   2. Pick a plan (free / starter / pro / enterprise — pilot via support)
//   3. Add a payment method (Stripe SetupIntent → Stripe Elements card form)
//      — required for paid plans, skippable for free
//   4. Accept ToS + privacy
//   5. POST /api/onboarding/complete → set onboarded_at + tos_accepted_at + plan
//   6. Redirect to ?next= (default /)

import { auth } from '@/lib/auth/auth';
import { redirect } from 'next/navigation';
import { conn } from '@/lib/db/sqlite';
import OnboardingClient from './OnboardingClient';

interface PageProps {
  searchParams: { next?: string };
}

function safeNext(raw: string | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.includes('..')) return '/';
  return raw;
}

export default async function OnboardingPage({ searchParams }: PageProps) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    redirect('/login?callbackUrl=/onboarding');
  }
  const next = safeNext(searchParams.next);

  // If already onboarded, skip — go straight to next destination.
  const row = conn()
    .prepare('SELECT onboarded_at, plan FROM users WHERE id = ?')
    .get(userId) as { onboarded_at: string | null; plan: string } | undefined;
  if (row?.onboarded_at) {
    redirect(next);
  }

  return (
    <OnboardingClient
      next={next}
      userEmail={session?.user?.email ?? ''}
      userName={session?.user?.name ?? ''}
    />
  );
}
