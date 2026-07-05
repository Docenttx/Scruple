// POST /api/projects/[id]/rename
// Rename a project. Bearer-auth (Fusion add-in). Only the name column
// changes; SCR-ID, thumbnails, iteration history are all preserved.
//
// Called by the Fusion add-in on every documentSaved when the Fusion
// display name diverges from the stored project.name — Fusion renames
// propagate silently into the palette.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

const Body = z.object({
  name: z.string().min(1).max(160),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'name required', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
  const newName = body.name.trim();
  if (!newName) return NextResponse.json({ error: 'name cannot be blank' }, { status: 400 });

  const project = conn()
    .prepare(`SELECT id, name FROM projects WHERE id = ? AND user_id = ?`)
    .get(id, me.id) as { id: number; name: string } | undefined;
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  if (project.name === newName) {
    return NextResponse.json({ ok: true, id, name: newName, changed: false });
  }

  const now = new Date().toISOString();
  conn()
    .prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(newName, now, id, me.id);

  return NextResponse.json({ ok: true, id, name: newName, changed: true, previous: project.name });
}
