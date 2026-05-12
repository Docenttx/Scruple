// POST /api/auth/gdrive/disconnect — revoke local tokens. Does not call
// Google to revoke the OAuth grant; user can do that at myaccount.google.com.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { disconnectGDrive } from '@/lib/storage/gdrive';

export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  disconnectGDrive(userId);
  return NextResponse.json({ ok: true });
}
