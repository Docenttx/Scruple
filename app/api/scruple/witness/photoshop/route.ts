// /api/scruple/witness/photoshop — WO-PHOTOSHOP Phase 3.
//
// Called from the Photoshop UXP plugin on every document save. Body
// mirrors the Fusion witness endpoint shape:
//   { product, session_id, project_id?, output_hash, file_size,
//     filename, structural_summary, client_timestamp }
//
// Server:
//   1. Auth by API key (Bearer <key>) — mint from
//      /api/scruple/mint-api-key with product='photoshop'
//   2. Look up user by API key
//   3. Insert an iterations row into project_id (or the user's
//      most-recent Photoshop project if project_id is null)
//   4. Call the witness server (:5799) for the leaf HMAC + prev-chain
//   5. Return leaf_hash + edit_count so the plugin can display it

import { NextRequest, NextResponse } from 'next/server';
import { conn } from '@/lib/db/sqlite';

export const runtime = 'nodejs';

interface PhotoshopWitnessBody {
  product: 'photoshop';
  session_id?: string;
  project_id?: number;
  output_hash: string;
  file_size: number;
  filename: string;
  structural_summary?: Record<string, unknown>;
  client_timestamp?: number;
}

interface ApiKeyRow {
  user_id: string;
  product: string;
}

function lookupApiKey(rawKey: string): ApiKeyRow | null {
  const row = conn()
    .prepare(
      `SELECT user_id, product FROM api_keys
        WHERE key_hash = ? AND revoked_at IS NULL`,
    )
    .get(hashApiKey(rawKey)) as ApiKeyRow | undefined;
  return row ?? null;
}

// Mirror hash algo from lib/scruple/apiKeys.ts. Placeholder — swap in
// the real one if paths differ.
import crypto from 'node:crypto';
function hashApiKey(k: string): string {
  return crypto.createHash('sha256').update(k).digest('hex');
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    return NextResponse.json({ error: 'Bearer token required' }, { status: 401 });
  }
  const apiKey = bearerMatch[1];

  const keyRow = lookupApiKey(apiKey);
  if (!keyRow || keyRow.product !== 'photoshop') {
    return NextResponse.json({ error: 'invalid or wrong-product key' }, { status: 401 });
  }
  const userId = keyRow.user_id;

  const body = (await req.json()) as PhotoshopWitnessBody;

  // Resolve target project: explicit project_id > user's most-recent
  // Photoshop-typed project. If neither, auto-create a "Photoshop
  // Documents" catch-all like Fusion does.
  let projectId = body.project_id;
  if (!projectId) {
    const p = conn()
      .prepare(
        `SELECT id FROM projects
          WHERE user_id = ? AND type = 'image'
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(userId) as { id: number } | undefined;
    projectId = p?.id;
  }
  if (!projectId) {
    // Auto-create the catch-all project. Type = 'image' since PSDs
    // are essentially images with layers.
    const now = new Date().toISOString();
    const cur = conn()
      .prepare(
        `INSERT INTO projects
           (user_id, name, type, status, created_at, updated_at,
            iteration_count, witnessed_count, is_active, is_archived)
         VALUES (?, 'Photoshop Documents', 'image', 'unlocked',
                 ?, ?, 0, 0, 0, 0)`,
      )
      .run(userId, now, now);
    projectId = Number(cur.lastInsertRowid);
  }

  // Determine run_sequence for this project
  const seqRow = conn()
    .prepare(
      `SELECT COALESCE(MAX(run_sequence), 0) + 1 AS next FROM iterations
        WHERE project_id = ?`,
    )
    .get(projectId) as { next: number };
  const runSeq = seqRow.next;

  const now = new Date().toISOString();

  // Insert the iteration first (leaf hash comes from witness server)
  const structuralSummary = JSON.stringify(body.structural_summary ?? {}).slice(0, 32000);

  // Call witness server for leaf hash + HMAC signature
  const witnessBase = process.env.WITNESS_SERVER_URL ?? 'http://localhost:5799';
  let leafHash: string | null = null;
  let witnessId: string | null = null;
  let witnessSig: string | null = null;
  try {
    const witnessRes = await fetch(`${witnessBase}/api/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: String(projectId),
        project_name: `Photoshop project #${projectId}`,
        run_sequence: runSeq,
        content_hash: body.output_hash,
        visual_hash: body.output_hash,
        client_timestamp: new Date().toISOString(),
      }),
    });
    if (witnessRes.ok) {
      const witBody = (await witnessRes.json()) as {
        leaf_hash: string;
        witness_id: string;
        signature: string;
      };
      leafHash = witBody.leaf_hash;
      witnessId = witBody.witness_id;
      witnessSig = witBody.signature;
    }
  } catch (e) {
    console.warn('[photoshop-witness] witness server unreachable', e);
  }

  conn()
    .prepare(
      `INSERT INTO iterations
         (project_id, run_sequence, timestamp,
          leaf_hash, output_hash, output_kind, output_content_type,
          output_bytes, image_filename, prompt, witnessed,
          witness_id, witness_signature, witness_timestamp,
          source_file, leaf_scheme, input_artifacts)
       VALUES (?, ?, ?,
               ?, ?, 'image', 'image/vnd.adobe.photoshop',
               ?, ?, ?, 1,
               ?, ?, ?,
               'photoshop', 'v2.2', ?)`,
    )
    .run(
      projectId,
      runSeq,
      now,
      leafHash ?? body.output_hash,
      body.output_hash,
      body.file_size,
      body.filename,
      `Photoshop save · ${body.filename}`,
      witnessId,
      witnessSig,
      leafHash ? now : null,
      structuralSummary,
    );

  // Bump project counts
  conn()
    .prepare(
      `UPDATE projects
          SET iteration_count = iteration_count + 1,
              witnessed_count = witnessed_count + (CASE WHEN ? THEN 1 ELSE 0 END),
              updated_at = ?
        WHERE id = ?`,
    )
    .run(leafHash ? 1 : 0, now, projectId);

  const editCount = (
    conn()
      .prepare(`SELECT iteration_count FROM projects WHERE id = ?`)
      .get(projectId) as { iteration_count: number }
  ).iteration_count;

  return NextResponse.json({
    ok: true,
    project_id: projectId,
    run_sequence: runSeq,
    leaf_hash: leafHash,
    edit_count: editCount,
  });
}
