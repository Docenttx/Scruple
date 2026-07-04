// POST /api/projects/clear-active
// Clears is_active on ALL projects for the requesting user. Called by
// the Fusion add-in when documentActivated fires for a doc that has no
// Scruple binding (blank untitled design, or a design opened via a
// non-tracked path). Result: palette workspace shows no tracking pill.

import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  conn().prepare(`UPDATE projects SET is_active = 0 WHERE user_id = ?`).run(me.id);
  return NextResponse.json({ ok: true });
}
