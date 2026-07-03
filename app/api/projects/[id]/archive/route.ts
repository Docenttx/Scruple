// POST   /api/projects/[id]/archive → archive (is_archived = 1)
// DELETE /api/projects/[id]/archive → unarchive (is_archived = 0)
//
// Bearer-token authenticated variant of the archiveProject/unarchiveProject
// server actions in lib/projects/actions.ts — needed because the Fusion
// palette hits the API with an API key, not a NextAuth session cookie.

import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

function projectId(params: { id: string }): number | null {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = projectId(params);
  if (!id) return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });

  const now = new Date().toISOString();
  const db = conn();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE projects SET is_active = 0 WHERE id = ? AND user_id = ?`).run(id, me.id);
    db.prepare(`UPDATE projects SET is_archived = 1, updated_at = ? WHERE id = ? AND user_id = ?`).run(now, id, me.id);
  });
  tx();
  return NextResponse.json({ ok: true, archived: true });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = projectId(params);
  if (!id) return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });

  const now = new Date().toISOString();
  conn()
    .prepare(`UPDATE projects SET is_archived = 0, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(now, id, me.id);
  return NextResponse.json({ ok: true, archived: false });
}
