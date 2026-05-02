// app/api/canvas/artifact/[hash]/route.ts
// GET /api/canvas/artifact/{sha256hash} — serve a controlled Scruple artifact
//
// Serves images from the local artifact store (artifacts/canvas/).
// Used by Scruple UI to display witnessed outputs without hitting ComfyUI.
// Falls back to 404 if the artifact is not in the store.

import { NextRequest, NextResponse } from 'next/server';
import { conn } from '@/lib/db/sqlite';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const ARTIFACT_ROOT = path.join(process.cwd(), 'artifacts', 'canvas');

export async function GET(
  _req: NextRequest,
  { params }: { params: { hash: string } }
) {
  const { hash } = params;

  // Validate: sha256 is exactly 64 hex chars
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return NextResponse.json({ error: 'invalid hash' }, { status: 400 });
  }

  // Look up in DB to get project_id and storage_path
  let storagePath: string | null = null;
  let contentType = 'image/png';
  try {
    const db = conn();
    const row = db.prepare(
      'SELECT storage_path, content_type FROM scruple_artifacts WHERE content_hash = ? LIMIT 1'
    ).get(hash) as { storage_path: string; content_type: string } | undefined;
    if (row) {
      storagePath = row.storage_path;
      contentType = row.content_type;
    }
  } catch {
    // DB lookup failed — try filesystem scan
  }

  // If no DB record, try to find by glob across project dirs
  if (!storagePath) {
    const exts = ['png', 'jpg', 'webp', 'gif'];
    for (const ext of exts) {
      // glob: artifacts/canvas/*/{hash}.{ext}
      const found = findArtifactByHash(hash, ext);
      if (found) {
        storagePath = found;
        break;
      }
    }
  }

  if (!storagePath) {
    return NextResponse.json({ error: 'artifact not found' }, { status: 404 });
  }

  const fullPath = path.join(ARTIFACT_ROOT, storagePath);
  if (!fs.existsSync(fullPath)) {
    return NextResponse.json({ error: 'artifact file missing' }, { status: 404 });
  }

  const imageBytes = fs.readFileSync(fullPath);
  return new NextResponse(imageBytes, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(imageBytes.length),
      'X-Scruple-Output-Hash': hash,
      // Long cache — content-addressed, immutable
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

function findArtifactByHash(hash: string, ext: string): string | null {
  if (!fs.existsSync(ARTIFACT_ROOT)) return null;
  try {
    const projectDirs = fs.readdirSync(ARTIFACT_ROOT);
    for (const dir of projectDirs) {
      const candidate = path.join(dir, `${hash}.${ext}`);
      if (fs.existsSync(path.join(ARTIFACT_ROOT, candidate))) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }
  return null;
}
