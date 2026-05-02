// GET /api/telemetry/spend?month=YYYY-MM
//
// Returns the signed-in user's spend for the given month (defaults to
// the current month). Surfaced in /settings.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { spendForMonth } from '@/lib/telemetry/log';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const month = new URL(req.url).searchParams.get('month') ??
    new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
  }

  return NextResponse.json(spendForMonth(userId, month));
}
