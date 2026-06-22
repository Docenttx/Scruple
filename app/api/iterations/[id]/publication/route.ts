// POST /api/iterations/:id/publication  { mode: 'full' | 'hash-only' | 'witness-only' }
//   → { ok, mode } | 403 if downgrade attempted
//
// Per-iteration publication-mode override. Upgrade-only:
//   witness-only → hash-only → full     (allowed, additive disclosure)
//   full → anything                     (denied: cannot un-publish)
//
// Canvas v2 (WO-9). See docs/architecture/canvas-v2.md decision 6.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import type { PublicationMode } from '@/lib/settings/user';

export const dynamic = 'force-dynamic';

const Body = z.object({
  mode: z.enum(['full', 'hash-only', 'witness-only']),
});

const ORDER: Record<PublicationMode, number> = {
  'witness-only': 0,
  'hash-only': 1,
  'full': 2,
};

interface IterRow {
  id: number;
  project_id: number;
  workflow_publication: PublicationMode;
}
interface ProjectRow {
  user_id: string;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const params = await ctx.params;
  const iterId = Number(params.id);
  if (!iterId || isNaN(iterId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const it = conn()
    .prepare(`SELECT id, project_id, workflow_publication FROM iterations WHERE id = ?`)
    .get(iterId) as IterRow | undefined;
  if (!it) return NextResponse.json({ error: 'Iteration not found' }, { status: 404 });

  const proj = conn()
    .prepare(`SELECT user_id FROM projects WHERE id = ?`)
    .get(it.project_id) as ProjectRow | undefined;
  if (!proj || proj.user_id !== userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const current = it.workflow_publication ?? 'full';
  if (ORDER[body.mode] < ORDER[current]) {
    return NextResponse.json(
      {
        error: 'downgrade_not_allowed',
        detail: `Already published as ${current}; cannot reduce disclosure.`,
      },
      { status: 403 },
    );
  }

  conn()
    .prepare(`UPDATE iterations SET workflow_publication = ? WHERE id = ?`)
    .run(body.mode, iterId);

  return NextResponse.json({ ok: true, mode: body.mode });
}
