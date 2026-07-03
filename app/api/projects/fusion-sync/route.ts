// POST /api/projects/fusion-sync
//
// Batch-mirror the caller's Fusion Team / Hub design list into Scruple
// projects. The Fusion add-in walks `app.data.dataProjects` on palette
// load and hands us `{fusion_data_id, name, fusion_project_id?}` for
// every `.f3d` file. Idempotent — subsequent calls UPDATE rows keyed on
// (user_id, fusion_data_id) instead of duplicating.
//
// Auth: Bearer API key (Fusion add-in has one, cookie session doesn't
// reach this route in practice).
//
// Body:
//   {
//     files: [
//       { fusion_data_id: "urn:...", name: "MyDesign", fusion_project_id: "urn:..." },
//       ...
//     ]
//   }
//
// Response:
//   { synced: <count>, created: <count>, updated: <count>, skipped: <count> }

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';
import { deriveScrId, sha256Hex } from '@/lib/scruple/hash';

export const dynamic = 'force-dynamic';

const FileSchema = z.object({
  fusion_data_id: z.string().min(1).max(500),
  name: z.string().min(1).max(160),
  fusion_project_id: z.string().max(500).optional(),
  fusion_web_url: z.string().url().max(1000).optional(),
});

const BodySchema = z.object({
  files: z.array(FileSchema).max(5000),
});

// Coerce a Fusion filename to a Scruple project name that satisfies the
// per-user UNIQUE(user_id, name) constraint by appending "(2)", "(3)" if
// needed. Returns the first name that doesn't collide with an existing
// row for this user OTHER than the row we're about to update.
function pickUniqueName(uid: string, base: string, allowRowId: number | null): string {
  const db = conn();
  let candidate = base;
  let counter = 2;
  while (counter < 1000) {
    const existing = db
      .prepare(`SELECT id FROM projects WHERE user_id = ? AND name = ?`)
      .get(uid, candidate) as { id: number } | undefined;
    if (!existing || existing.id === allowRowId) return candidate;
    candidate = `${base} (${counter})`;
    counter += 1;
  }
  // Fallback — should be effectively unreachable.
  return `${base} (${Date.now()})`;
}

export async function POST(req: NextRequest) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const db = conn();
  const now = new Date().toISOString();

  const findByFusionId = db.prepare(
    `SELECT id, name FROM projects WHERE user_id = ? AND fusion_data_id = ?`,
  );
  const updateExisting = db.prepare(
    `UPDATE projects
     SET name = ?, fusion_project_id = ?, fusion_web_url = ?, updated_at = ?
     WHERE id = ?`,
  );
  const insertNew = db.prepare(
    `INSERT INTO projects (user_id, name, type, fusion_data_id, fusion_project_id, fusion_web_url, created_at, updated_at)
     VALUES (?, ?, 'cad', ?, ?, ?, ?, ?)`,
  );
  const setPreScrId = db.prepare(
    `UPDATE projects SET pre_scr_id = ? WHERE id = ? AND pre_scr_id IS NULL`,
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;

  const tx = db.transaction((files: z.infer<typeof FileSchema>[]) => {
    for (const f of files) {
      try {
        const existing = findByFusionId.get(me.id, f.fusion_data_id) as
          | { id: number; name: string }
          | undefined;

        if (existing) {
          // Rename picked up from Fusion.
          const uniqueName = pickUniqueName(me.id, f.name, existing.id);
          updateExisting.run(uniqueName, f.fusion_project_id ?? null, f.fusion_web_url ?? null, now, existing.id);
          updated += 1;
        } else {
          const uniqueName = pickUniqueName(me.id, f.name, null);
          const result = insertNew.run(
            me.id,
            uniqueName,
            f.fusion_data_id,
            f.fusion_project_id ?? null,
            f.fusion_web_url ?? null,
            now,
            now,
          );
          const projectId = Number(result.lastInsertRowid);
          const preScrId = deriveScrId(
            sha256Hex(`${me.id}:${projectId}:${uniqueName}:${now}`),
          );
          setPreScrId.run(preScrId, projectId);
          created += 1;
        }
      } catch (e) {
        console.error('[fusion-sync] skip', f.fusion_data_id, e);
        skipped += 1;
      }
    }
  });

  tx(body.files);

  return NextResponse.json({
    ok: true,
    synced: created + updated,
    created,
    updated,
    skipped,
    total_received: body.files.length,
  });
}
