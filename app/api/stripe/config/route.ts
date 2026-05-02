// GET /api/stripe/config — proxies witness server config (publishable
// key + price tiers) so the client can mount Stripe Elements.

import { NextResponse } from 'next/server';

const WITNESS_URL = process.env.WITNESS_SERVER_URL || 'http://127.0.0.1:5799';

export const dynamic = 'force-dynamic';

export async function GET() {
  const res = await fetch(`${WITNESS_URL}/api/stripe-config`);
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
