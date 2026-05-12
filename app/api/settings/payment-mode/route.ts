// GET  /api/settings/payment-mode  → { mode: 'fiat' | 'blockchain' }
// POST /api/settings/payment-mode  { mode } → { ok, mode }
//
// Server-persists the user's Fiat-vs-Blockchain choice. Workspace +
// settings UI both read this. Default 'fiat'.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { getPaymentMode, writeUserSettings } from '@/lib/settings/user';

export const dynamic = 'force-dynamic';

const Body = z.object({ mode: z.enum(['fiat', 'blockchain']) });

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ mode: getPaymentMode(userId) });
}

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
  writeUserSettings(userId, { payment_mode: body.mode });
  return NextResponse.json({ ok: true, mode: body.mode });
}
