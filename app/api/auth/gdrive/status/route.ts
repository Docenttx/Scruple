// GET /api/auth/gdrive/status — current GDrive connection state for this user.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

interface GDriveRow {
  user_email: string | null;
  user_name: string | null;
  connected_at: string;
  expires_at: number;
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ connected: false });

  const row = conn()
    .prepare(
      `SELECT user_email, user_name, connected_at, expires_at FROM gdrive_tokens WHERE user_id = ?`,
    )
    .get(userId) as GDriveRow | undefined;

  if (!row) return NextResponse.json({ connected: false });
  return NextResponse.json({
    connected: true,
    email: row.user_email,
    name: row.user_name,
    connectedAt: row.connected_at,
    expiresAt: row.expires_at,
  });
}
