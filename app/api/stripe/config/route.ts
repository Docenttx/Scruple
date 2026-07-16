// GET /api/stripe/config
//
// Returns { publishableKey, actions } where `actions` is a catalog of
// paid actions keyed by action name, each with amount_cents, label,
// short_label, and description.
//
// Merges: witness server owns publishable key + authoritative amounts
// (STRIPE_FEES enforces at charge time); lib/pricing/actions.ts owns
// the labels + descriptions consumed by client UIs. This route stitches
// them together so a single fetch gives a client everything it needs to
// render a paid-action button.

import { NextResponse } from 'next/server';
import { ACTION_CATALOG, type PaidAction } from '@/lib/pricing/actions';

const WITNESS_URL = process.env.WITNESS_SERVER_URL || 'http://127.0.0.1:5799';

export const dynamic = 'force-dynamic';

export async function GET() {
  const res = await fetch(`${WITNESS_URL}/api/stripe-config`);
  const data = (await res.json().catch(() => ({}))) as {
    publishableKey?: string;
    actions?: Record<string, number>;
    error?: string;
  };
  if (!res.ok) return NextResponse.json(data, { status: res.status });

  const enriched: Record<string, { amount_cents: number; label: string; short_label: string; description: string }> = {};
  for (const [action, amount_cents] of Object.entries(data.actions ?? {})) {
    const entry = ACTION_CATALOG[action as PaidAction];
    enriched[action] = {
      amount_cents,
      label: entry?.label ?? action,
      short_label: entry?.short_label ?? action,
      description: entry?.description ?? '',
    };
  }

  return NextResponse.json({
    publishableKey: data.publishableKey,
    actions: enriched,
  });
}
