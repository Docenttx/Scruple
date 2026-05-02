// app/api/canvas/view/route.ts
// GET /api/canvas/view — Scruple intercept for ComfyUI output/image retrieval
//
// Provenance chain:
//   1. Fetch image bytes from ComfyUI /view
//   2. SHA256 hash the raw bytes (output witness)
//   3. Save copy to controlled artifact store (artifacts/canvas/)
//   4. Record artifact in scruple_artifacts table
//   5. Emit artifact witness event to :5799
//   6. Stream image to client

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { conn } from '@/lib/db/sqlite';
import { captureBit } from '@/lib/bits';

export const dynamic = 'force-dynamic';

const COMFYUI = process.env.COMFYUI_BACKEND || 'http://127.0.0.1:8188';
const WITNESS_URL = process.env.WITNESS_URL || 'http://127.0.0.1:5799';

// Controlled artifact store — outside web root, under project root
const ARTIFACT_ROOT = path.join(process.cwd(), 'artifacts', 'canvas');

async function emitWitness(event: Record<string, unknown>) {
  try {
    await fetch(`${WITNESS_URL}/api/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    console.warn('[canvas/view] Witness emit failed');
  }
}

function extForContentType(ct: string): string {
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return 'png';
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const filename = params.get('filename');
  const type = params.get('type') || 'output';
  const subfolder = params.get('subfolder') || '';

  if (!filename) {
    return NextResponse.json({ error: 'filename required' }, { status: 400 });
  }

  // ── 1. Fetch image bytes from ComfyUI ─────────────────────────────────────
  const url = new URL(`${COMFYUI}/view`);
  url.searchParams.set('filename', filename);
  url.searchParams.set('type', type);
  if (subfolder) url.searchParams.set('subfolder', subfolder);

  const comfyRes = await fetch(url.toString());
  if (!comfyRes.ok) {
    return new NextResponse(null, { status: comfyRes.status });
  }

  const imageBytes = Buffer.from(await comfyRes.arrayBuffer());
  const contentType = comfyRes.headers.get('content-type') || 'image/png';

  // ── 2. Hash the raw image bytes ───────────────────────────────────────────
  const outputHash = createHash('sha256').update(imageBytes).digest('hex');

  // Extract project context from headers
  const projectId = req.headers.get('x-scruple-project-id') || 'untracked';
  const promptId = req.headers.get('x-scruple-prompt-id') || params.get('prompt_id') || '';
  const runSequenceHeader = req.headers.get('x-scruple-run-sequence');
  const runSequence = runSequenceHeader ? parseInt(runSequenceHeader) : null;

  const witnessedAt = new Date().toISOString();

  // ── 3. Save copy to controlled artifact store ─────────────────────────────
  // Path: artifacts/canvas/{project_id}/{hash}.{ext}
  const ext = extForContentType(contentType);
  const projectDir = path.join(ARTIFACT_ROOT, projectId);
  const storagePath = path.join(projectId, `${outputHash}.${ext}`);
  const fullPath = path.join(ARTIFACT_ROOT, storagePath);

  try {
    fs.mkdirSync(projectDir, { recursive: true });
    // Only write if not already stored (idempotent by content hash)
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, imageBytes);
    }
  } catch (err) {
    console.error('[canvas/view] Artifact store write failed:', err);
    // Non-fatal — still serve the image
  }

  // ── 4. Capture as a Bit in user storage ──────────────────────────────────
  const sessionId = req.headers.get('x-scruple-session-id') || '';
  if (sessionId) {
    captureBit({
      sceneId: sessionId,
      content: imageBytes,
      source: 'canvas',
      filename,
      mimeType: contentType,
      bitType: 'image',
    });
  }

  // ── 5. Record in scruple_artifacts table ──────────────────────────────────
  try {
    const db = conn();
    // Ensure migration has run (table may not exist on first boot before migration)
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scruple_artifacts'"
    ).get();
    if (exists) {
      const existing = db.prepare(
        'SELECT id FROM scruple_artifacts WHERE content_hash = ? AND project_id = ?'
      ).get(outputHash, projectId);
      if (!existing) {
        db.prepare(`
          INSERT INTO scruple_artifacts
            (id, project_id, prompt_id, run_sequence, filename, content_hash,
             content_type, size_bytes, storage_path, witnessed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          projectId,
          promptId || null,
          runSequence,
          filename,
          outputHash,
          contentType,
          imageBytes.length,
          storagePath,
          witnessedAt,
        );
      }
    }
  } catch (err) {
    console.error('[canvas/view] Artifact DB record failed:', err);
  }

  // ── 5. Emit artifact witness ──────────────────────────────────────────────
  await emitWitness({
    event_type: 'artifact_retrieved',
    project_id: projectId,
    content_hash: outputHash,
    metadata: {
      filename,
      type,
      subfolder,
      prompt_id: promptId,
      size_bytes: imageBytes.length,
      content_type: contentType,
      storage_path: storagePath,
    },
  });

  // ── 6. Stream image to client with Scruple hash header ───────────────────
  return new NextResponse(imageBytes, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(imageBytes.length),
      'X-Scruple-Output-Hash': outputHash,
      'X-Scruple-Witnessed-At': witnessedAt,
      'X-Scruple-Storage-Path': storagePath,
      'Cache-Control': 'no-store',
    },
  });
}
