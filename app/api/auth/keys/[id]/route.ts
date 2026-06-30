// DELETE /api/auth/keys/[id] — revoke an API key the caller owns.
//
// Auth: NextAuth session only (API keys can't revoke API keys; that's a
// privilege-escalation hazard if a key leaks).

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { revokeApiKey } from '@/lib/auth/apiKey';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const ok = revokeApiKey(userId, params.id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
