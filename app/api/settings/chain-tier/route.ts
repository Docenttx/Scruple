// GET  /api/settings/chain-tier  → { tier: 'basic' | 'pinned' }
// POST /api/settings/chain-tier  { tier } → { ok, tier }
//
// Server-persists the user's default chain-lock tier. Workspace
// LockButtons reads this and skips the modal tier selector.
//   basic  — RVN only (50 TSD fiat / ~500 RVN blockchain)
//   pinned — RVN + IPFS + Arweave (65 TSD fiat / +pin cost blockchain)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { getChainTier, writeUserSettings } from '@/lib/settings/user';

export const dynamic = 'force-dynamic';

const Body = z.object({ tier: z.enum(['basic', 'pinned']) });

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ tier: getChainTier(userId) });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  writeUserSettings(userId, { chain_tier: body.tier });
  return NextResponse.json({ ok: true, tier: body.tier });
}
