// POST /api/projects/[id]/set-active
// Marks the given project as the user's active-tracked project. Sets
// is_active = 1 on this project, is_active = 0 on all other projects
// for the same user. Bearer-auth (Fusion palette + add-in use it).

import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  const db = conn();
  const project = db
    .prepare(`SELECT id, user_id FROM projects WHERE id = ? AND user_id = ?`)
    .get(id, me.id) as { id: number } | undefined;
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const tx = db.transaction(() => {
    db.prepare(`UPDATE projects SET is_active = 0 WHERE user_id = ?`).run(me.id);
    db.prepare(`UPDATE projects SET is_active = 1, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(new Date().toISOString(), id, me.id);
  });
  tx();

  return NextResponse.json({ ok: true, active_project_id: id });
}
