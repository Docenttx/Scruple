// Public GET route: /api/projects/<id>/lora-sidecar.c2pa
//
// Serves a C2PA-vocabulary sidecar for a trained model belonging to a locked
// training project. The sidecar is a JUMBF-wrapped, COSE_Sign1-signed manifest
// carrying:
//   - c2pa.actions (created + algorithmicMedia + Scruple-specific parameters)
//   - c2pa.hash.data — binds the sidecar to the trained model file's SHA-256
//   - c2pa.assertion.training-mining — training dataset merkle + trainer + hyperparams
//   - com.scruple.leaf — the canonical leaf preimage, Merkle inclusion path,
//     RVN txid, IPFS CID, Arweave tx (the offline decomposition breadcrumb)
//
// A verifier with only the model file + this sidecar can independently confirm:
//   1. Hash the model file, compare to c2pa.hash.data
//   2. Validate COSE_Sign1 against the x5chain
//   3. Recompute the Merkle root from the leaf + inclusion path, compare to the anchor
//   4. Look up the RVN txid on-chain and confirm the asset data equals the root
//
// No cooperation from Scruple is required at verification time — this route is
// merely a distribution mechanism for the sidecar bytes.
//
// Backing script: scripts/puffjuly12/12-emit-lora-sidecar.py. First hit populates
// data/lora-sidecars/<scrId>.c2pa; subsequent hits serve from disk. Regenerate
// by DELETE-ing the cache file (a future admin route can automate that).

import { NextResponse } from 'next/server';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { conn } from '@/lib/db/sqlite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_DIR = path.join(process.cwd(), 'data', 'lora-sidecars');
const SCRIPT = path.join(process.cwd(), 'scripts', 'puffjuly12', '12-emit-lora-sidecar.py');

interface ProjectRow {
  id: number;
  scr_id: string | null;
  status: string;
  type: string;
  name: string;
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const projectId = Number.parseInt(params.id, 10);
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: 'bad project id' }, { status: 400 });
  }

  const project = conn()
    .prepare(
      `SELECT id, scr_id, status, type, name
         FROM projects
        WHERE id = ?`,
    )
    .get(projectId) as ProjectRow | undefined;

  if (!project) {
    return NextResponse.json({ error: 'project not found' }, { status: 404 });
  }

  if (project.type !== 'training') {
    return NextResponse.json(
      { error: 'sidecar only available for training projects' },
      { status: 400 },
    );
  }

  // Sidecar is meaningful only after the project is locked — before locking
  // there is no on-chain anchor to reference, so the com.scruple.leaf
  // assertion would carry nulls. Refuse rather than return a half-manifest.
  const lockedStates = new Set([
    'local_locked',
    'chain_locked',
    'persistent_locked',
    'permanent_locked',
  ]);
  if (!lockedStates.has(project.status)) {
    return NextResponse.json(
      {
        error: 'project must be locked before sidecar can be emitted',
        current_status: project.status,
      },
      { status: 409 },
    );
  }

  // Cache key: <scrId>.c2pa (falls back to project id when SCR not yet minted)
  const cacheKey = `${project.scr_id ?? `p${projectId}`}.c2pa`;
  const cachePath = path.join(CACHE_DIR, cacheKey);

  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const outDir = path.dirname(cachePath);
    const sidecarName = path.basename(cachePath);

    const proc = spawnSync(
      'python3',
      [
        SCRIPT,
        '--project-id',
        String(projectId),
        '--out-dir',
        outDir,
        '--sidecar-name',
        sidecarName,
      ],
      { encoding: 'utf-8' },
    );

    if (proc.status !== 0 || !fs.existsSync(cachePath)) {
      return NextResponse.json(
        {
          error: 'sidecar emit failed',
          detail: (proc.stderr || proc.stdout || '').slice(-500),
        },
        { status: 500 },
      );
    }
  }

  const bytes = fs.readFileSync(cachePath);

  // application/c2pa is the C2PA-defined external-manifest MIME.
  // Suggest a filename derived from the trained-model file if the DB has one.
  const iterFn = conn()
    .prepare(
      `SELECT image_filename FROM iterations
        WHERE project_id = ? AND output_kind = 'training'
        ORDER BY run_sequence DESC LIMIT 1`,
    )
    .get(projectId) as { image_filename: string | null } | undefined;
  const suggestedName = iterFn?.image_filename
    ? `${iterFn.image_filename}.c2pa`
    : cacheKey;

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/c2pa',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${suggestedName}"`,
      'Cache-Control': 'public, max-age=3600, immutable',
    },
  });
}
