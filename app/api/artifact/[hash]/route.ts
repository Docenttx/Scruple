// GET /api/artifact/[hash] — content-addressed artifact retrieval.
// Public read access by hash (the hash itself is unguessable; if the
// caller knows the hash they're entitled to the bytes).

import { NextRequest, NextResponse } from 'next/server';
import { readArtifact } from '@/lib/scruple/artifacts';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { hash: string } }) {
  const hash = params.hash;
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return NextResponse.json({ error: 'Invalid hash' }, { status: 400 });
  }
  const bytes = readArtifact(hash);
  if (!bytes) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Sniff content-type from the iterations row metadata if we have it.
  let contentType = 'application/octet-stream';
  const row = conn()
    .prepare(`SELECT metadata FROM iterations WHERE output_hash = ? LIMIT 1`)
    .get(hash) as { metadata: string | null } | undefined;
  if (row?.metadata) {
    try {
      const meta = JSON.parse(row.metadata) as { contentType?: string };
      if (meta.contentType) contentType = meta.contentType;
    } catch {
      /* ignore */
    }
  }

  // Buffer is a valid Web BodyInit at runtime; cast for TS.
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
