// GET /api/storage/status — which provider is active for this user,
// plus the last ~20 sync log entries.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

interface ProviderRow {
  provider: string;
  metadata: string;
  updated_at: string;
}

interface SyncRow {
  iteration_id: number | null;
  operation: string;
  provider: string;
  status: string;
  detail: string | null;
  size_bytes: number | null;
  ts: string;
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const provider = conn()
    .prepare(`SELECT provider, metadata, updated_at FROM storage_providers WHERE user_id = ?`)
    .get(userId) as ProviderRow | undefined;

  const recent = conn()
    .prepare(
      `SELECT iteration_id, operation, provider, status, detail, size_bytes, ts
         FROM storage_sync_log WHERE user_id = ?
         ORDER BY ts DESC LIMIT 20`,
    )
    .all(userId) as SyncRow[];

  return NextResponse.json({
    connected: !!provider,
    provider: provider?.provider ?? null,
    profile: provider ? JSON.parse(provider.metadata) : null,
    connectedAt: provider?.updated_at ?? null,
    recent,
  });
}
