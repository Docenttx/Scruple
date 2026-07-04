// GET  /api/projects                  → list this user's projects (lightweight)
// POST /api/projects                  → create a project
//
// Auth: NextAuth cookie OR Authorization: Bearer <api_key> (Fusion add-in).
//
// Used by the scrupel CLI, the Fusion add-in, and any UI that wants the
// project list as JSON (the home page uses the server action directly).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';
import { createProjectAs } from '@/lib/projects/actions';
import type { ProjectRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const search = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? '200'), 500));
  // archived: 'live' (default, is_archived=0) | 'only' (=1) | 'all' (no filter)
  const archivedParam = (url.searchParams.get('archived') ?? 'live').toLowerCase();
  const archiveWhere =
    archivedParam === 'only' ? ' AND is_archived = 1'
    : archivedParam === 'all' ? ''
    : ' AND is_archived = 0';

  const projects = search
    ? (conn()
        .prepare(
          `SELECT * FROM projects WHERE user_id = ?${archiveWhere} AND name LIKE ?
           ORDER BY is_active DESC, updated_at DESC, created_at DESC LIMIT ?`,
        )
        .all(me.id, `%${search}%`, limit) as ProjectRow[])
    : (conn()
        .prepare(
          `SELECT * FROM projects WHERE user_id = ?${archiveWhere}
           ORDER BY is_active DESC, updated_at DESC, created_at DESC LIMIT ?`,
        )
        .all(me.id, limit) as ProjectRow[]);

  const active = conn()
    .prepare(`SELECT * FROM projects WHERE user_id = ? AND is_active = 1 LIMIT 1`)
    .get(me.id) as ProjectRow | undefined;

  return NextResponse.json({
    projects,
    activeId: active?.id ?? null,
    count: projects.length,
  });
}

const CreateBody = z.object({
  name: z.string().min(1).max(160),
  type: z.enum(['image', 'video', 'training', 'cad']).default('image'),
  // Accept 'kind' as an alias for 'type' (the Python client uses 'kind').
  kind: z.enum(['image', 'video', 'training', 'cad']).optional(),
  // Fusion add-in passes the design's lineage URN so we can dedupe
  // against the account-scan row (which already has the thumbnail)
  // instead of creating a bare-metal duplicate on first save.
  fusion_data_id: z.string().min(1).max(500).optional(),
});

export async function POST(req: NextRequest) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
  const type = body.kind ?? body.type;

  // Dedupe by fusion_data_id first — return the existing row (with its
  // thumbnail + fusion_data_id) instead of creating a new one.
  if (body.fusion_data_id) {
    const existing = conn()
      .prepare(`SELECT * FROM projects WHERE user_id = ? AND fusion_data_id = ? LIMIT 1`)
      .get(me.id, body.fusion_data_id) as ProjectRow | undefined;
    if (existing) {
      return NextResponse.json({
        ok: true,
        project: existing,
        ...existing,
        preScrId: existing.pre_scr_id,
        deduped: true,
      });
    }
  }

  try {
    const project = await createProjectAs(me.id, { name: body.name, type });
    // Persist the URN on the newly-created row so future auto-binds
    // for this Fusion doc match by URN and don't duplicate.
    if (body.fusion_data_id) {
      conn()
        .prepare(`UPDATE projects SET fusion_data_id = ? WHERE id = ? AND user_id = ?`)
        .run(body.fusion_data_id, project.id, me.id);
    }
    // The Python client expects { id, name, status, pre_scr_id, ... } at
    // the top level when reading the response. Echo flat as well as
    // wrapped for compat. Also alias pre_scr_id → preScrId (camelCase)
    // so the JS UI can read it either way.
    return NextResponse.json({
      ok: true,
      project,
      ...project,
      preScrId: project.pre_scr_id,
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'Create failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
