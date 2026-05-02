// GET /api/projects/[id]/export
//
// Streams a ZIP containing:
//   manifest.json       — the deterministic lock-package
//   merkle-tree.json    — full node list
//   iterations/<seq>-<hash>.png   — every artifact byte-identical to capture
//   README.txt          — human notes
//
// Compatible with desktop SCRUPLE Studio's import: same layout that
// lock-package-builder.js produced.

import { NextRequest, NextResponse } from 'next/server';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { buildLockPackage } from '@/lib/scruple/lock-package';
import { artifactPath } from '@/lib/scruple/artifacts';
import type { ProjectRow, IterationRow } from '@/lib/types';
import fs from 'node:fs';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(id, userId) as ProjectRow | undefined;
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!project.merkle_root) {
    return NextResponse.json({ error: 'Project must be locked or checkpointed first' }, { status: 400 });
  }

  const iterations = conn()
    .prepare(`SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence ASC`)
    .all(id) as IterationRow[];

  const pkg = buildLockPackage(id);

  const stream = new PassThrough();
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => stream.destroy(err));
  archive.pipe(stream);

  // manifest.json — deterministic
  archive.append(pkg.bytes, { name: 'manifest.json' });

  // merkle-tree.json
  const merkleNodes = conn()
    .prepare(`SELECT level, position, hash, left_child_hash, right_child_hash
              FROM merkle_nodes WHERE project_id = ? ORDER BY level, position`)
    .all(id);
  archive.append(JSON.stringify({ root: project.merkle_root, nodes: merkleNodes }, null, 2), {
    name: 'merkle-tree.json',
  });

  // README.txt
  archive.append(
    `Scruple Web export — ${project.name}\n` +
      `SCR-ID: ${project.scr_id ?? '(none)'}\n` +
      `Merkle root: ${project.merkle_root}\n` +
      `Iterations: ${iterations.length}\n` +
      `Status: ${project.status}\n` +
      `Built: ${new Date().toISOString()}\n\n` +
      `Verify by uploading manifest.json to POST /api/verify on any\n` +
      `Scruple Web instance, or import into desktop SCRUPLE Studio.\n`,
    { name: 'README.txt' },
  );

  // iterations/<seq>-<hash>.png
  for (const it of iterations) {
    if (!it.output_hash) continue;
    const p = artifactPath(it.output_hash);
    if (!fs.existsSync(p)) continue;
    const ext = inferExt(it.metadata);
    archive.file(p, { name: `iterations/${String(it.run_sequence).padStart(4, '0')}-${it.output_hash.slice(0, 12)}${ext}` });
  }

  archive.finalize();

  const filename = `${(project.scr_id || project.name).replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`;
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function inferExt(metadata: string | null): string {
  if (!metadata) return '.bin';
  try {
    const m = JSON.parse(metadata) as { contentType?: string };
    if (m.contentType === 'image/png') return '.png';
    if (m.contentType === 'image/jpeg') return '.jpg';
    if (m.contentType === 'image/webp') return '.webp';
  } catch {
    /* */
  }
  return '.bin';
}
