// /api/scruple/witness/adobe — generalized Adobe CC witness endpoint.
//
// Replaces the per-app routes (/api/scruple/witness/photoshop, …). The
// per-app routes can now be thin aliases that forward here with the
// right host_app.
//
// Body:
//   { host_app: 'photoshop' | 'illustrator' | 'indesign' | 'premiere'
//              | 'lightroom' | 'after_effects',
//     session_id?: string,
//     project_id?: number,
//     output_hash: string,
//     file_size: number,
//     filename: string,
//     structural_summary?: Record<string, unknown>,
//     client_timestamp?: number }
//
// Auth: Bearer API key (must be product-scoped to one of the Adobe
// host_apps — mint via /api/scruple/mint-api-key with product='<host>').

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { conn } from '@/lib/db/sqlite';

export const runtime = 'nodejs';

const VALID_HOSTS = new Set([
  'photoshop',
  'illustrator',
  'indesign',
  'premiere',
  'lightroom',
  'after_effects',
]);

const HOST_CONTENT_TYPE: Record<string, string> = {
  photoshop:    'image/vnd.adobe.photoshop',
  illustrator:  'application/postscript',           // AI = PDF-flavoured PS
  indesign:     'application/vnd.adobe.indesign',
  premiere:     'application/vnd.adobe.prproj',
  lightroom:    'image/x-adobe-dng',                // lightroom exports vary; approximate
  after_effects:'application/vnd.adobe.aep',
};

const HOST_SOURCE_FILE: Record<string, string> = {
  photoshop:    'photoshop',
  illustrator:  'illustrator',
  indesign:     'indesign',
  premiere:     'premiere',
  lightroom:    'lightroom-classic',
  after_effects:'after-effects',
};

interface AdobeWitnessBody {
  host_app: string;
  session_id?: string;
  project_id?: number;
  output_hash: string;
  file_size: number;
  filename: string;
  structural_summary?: Record<string, unknown>;
  client_timestamp?: number;
}

function hashApiKey(k: string): string {
  return crypto.createHash('sha256').update(k).digest('hex');
}

function lookupApiKey(rawKey: string): { user_id: string; product: string } | null {
  const row = conn()
    .prepare(
      `SELECT user_id, product FROM api_keys
        WHERE key_hash = ? AND revoked_at IS NULL`,
    )
    .get(hashApiKey(rawKey)) as { user_id: string; product: string } | undefined;
  return row ?? null;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    return NextResponse.json({ error: 'Bearer token required' }, { status: 401 });
  }

  const keyRow = lookupApiKey(bearerMatch[1]);
  if (!keyRow) {
    return NextResponse.json({ error: 'invalid key' }, { status: 401 });
  }

  const body = (await req.json()) as AdobeWitnessBody;
  if (!VALID_HOSTS.has(body.host_app)) {
    return NextResponse.json(
      { error: `host_app must be one of ${[...VALID_HOSTS].join(', ')}` },
      { status: 400 },
    );
  }
  // Key must match the claimed host
  if (keyRow.product !== body.host_app) {
    return NextResponse.json(
      { error: `key scoped to '${keyRow.product}', body claims '${body.host_app}'` },
      { status: 403 },
    );
  }
  const userId = keyRow.user_id;

  // Resolve target project
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
    const now = new Date().toISOString();
    const cur = conn()
      .prepare(
        `INSERT INTO projects
           (user_id, name, type, status, created_at, updated_at,
            iteration_count, witnessed_count, is_active, is_archived)
         VALUES (?, ?, 'image', 'unlocked', ?, ?, 0, 0, 0, 0)`,
      )
      .run(userId, `Adobe ${body.host_app.charAt(0).toUpperCase() + body.host_app.slice(1)} Documents`, now, now);
    projectId = Number(cur.lastInsertRowid);
  }

  const seqRow = conn()
    .prepare(
      `SELECT COALESCE(MAX(run_sequence), 0) + 1 AS next FROM iterations
        WHERE project_id = ?`,
    )
    .get(projectId) as { next: number };
  const runSeq = seqRow.next;

  const now = new Date().toISOString();
  const structuralSummary = JSON.stringify(body.structural_summary ?? {}).slice(0, 32000);

  // Witness server for leaf hash + HMAC seal
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
        project_name: `${body.host_app} project #${projectId}`,
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
    console.warn('[adobe-witness] witness server unreachable', e);
  }

  // `witnessed` and `leaf_scheme` were literals here — the row claimed a
  // witness whether or not the witness server ever answered, while the
  // projects.witnessed_count update below correctly used `leafHash ? 1 : 0`.
  // The row and the counter disagreed. Standard §5 makes compliance binary;
  // a fabricated 1 is the one thing that cannot reach the database.
  conn()
    .prepare(
      `INSERT INTO iterations
         (project_id, run_sequence, timestamp,
          leaf_hash, output_hash, output_kind, output_content_type,
          output_bytes, image_filename, prompt, witnessed,
          witness_id, witness_signature, witness_timestamp,
          source_file, leaf_scheme, input_artifacts)
       VALUES (?, ?, ?,
               ?, ?, 'image', ?,
               ?, ?, ?, ?,
               ?, ?, ?,
               ?, ?, ?)`,
    )
    .run(
      projectId,
      runSeq,
      now,
      leafHash ?? body.output_hash,
      body.output_hash,
      HOST_CONTENT_TYPE[body.host_app] ?? 'application/octet-stream',
      body.file_size,
      body.filename,
      `${body.host_app} save · ${body.filename}`,
      leafHash ? 1 : 0,
      witnessId,
      witnessSig,
      leafHash ? now : null,
      HOST_SOURCE_FILE[body.host_app] ?? body.host_app,
      leafHash ? 'v2.2' : 'v1',
      structuralSummary,
    );

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
    host_app: body.host_app,
    project_id: projectId,
    run_sequence: runSeq,
    leaf_hash: leafHash,
    edit_count: editCount,
  });
}
