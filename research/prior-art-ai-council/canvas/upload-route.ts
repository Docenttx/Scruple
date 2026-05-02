// app/api/canvas/upload/route.ts
// POST /api/canvas/upload — Scruple intercept for input asset uploads
//
// Provenance chain:
//   1. Hash the uploaded asset bytes (input asset witness)
//   2. Forward to ComfyUI /upload/image or /upload/mask
//   3. Emit input-asset witness event to :5799

import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

export const dynamic = 'force-dynamic';

const COMFYUI = process.env.COMFYUI_BACKEND || 'http://127.0.0.1:8188';
const WITNESS_URL = process.env.WITNESS_URL || 'http://127.0.0.1:5799';

async function emitWitness(event: Record<string, unknown>) {
  try {
    await fetch(`${WITNESS_URL}/api/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    console.warn('[canvas/upload] Witness emit failed');
  }
}

export async function POST(req: NextRequest) {
  // Preserve the multipart form data for forwarding
  const formData = await req.formData();
  const projectId = req.headers.get('x-scruple-project-id') || 'untracked';

  // Hash each uploaded file
  const assetHashes: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      const bytes = Buffer.from(await value.arrayBuffer());
      assetHashes[key] = createHash('sha256').update(bytes).digest('hex');
    }
  }

  // ── Emit input-asset witness ──────────────────────────────────────────────
  if (Object.keys(assetHashes).length > 0) {
    await emitWitness({
      event_type: 'input_asset_uploaded',
      project_id: projectId,
      metadata: { asset_hashes: assetHashes },
    });
  }

  // ── Forward to ComfyUI ────────────────────────────────────────────────────
  const uploadType = req.nextUrl.searchParams.get('type') || 'image';
  const comfyRes = await fetch(`${COMFYUI}/upload/${uploadType}`, {
    method: 'POST',
    body: formData,
  });

  const comfyData = await comfyRes.json();

  return NextResponse.json({
    ...comfyData,
    _scruple: { asset_hashes: assetHashes, witnessed_at: new Date().toISOString() },
  }, { status: comfyRes.status });
}
