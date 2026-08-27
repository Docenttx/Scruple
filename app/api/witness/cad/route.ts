// POST /api/witness/cad
//
// Direct-witness endpoint for CAD source files (Fusion 360 add-in is the
// first caller). The bytes ARE the output — no Modal round-trip. We feed
// the bytes straight into ingestIteration so the canonical leaf is built
// the same way it is for canvas / runs iterations.
//
// Auth: NextAuth cookie OR Authorization: Bearer <api_key>.
//
// Body:
//   {
//     projectId: number,
//     filename: string,              // e.g. "design.f3d"
//     contentType?: string,          // defaults to application/octet-stream
//     inlineBase64: string,          // archive bytes, base64-encoded
//     machineManifest: {             // bound into machine_manifest_hash
//       host: string,                // "fusion360"
//       fusion_version: string,
//       addin: string,               // "scruple-fusion"
//       addin_version: string,
//       ...
//     },
//     prompt?: string                // human label for the witness row
//   }

import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';
import { ingestIteration } from '@/lib/iterations/ingest';
import type { ProjectRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Body = z.object({
  projectId: z.number().int().positive(),
  filename: z.string().min(1).max(260),
  contentType: z.string().max(120).optional(),
  inlineBase64: z.string().min(1),
  machineManifest: z.record(z.unknown()),
  prompt: z.string().max(500).optional(),
});

function canonicalize(obj: unknown): string {
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  if (obj !== null && typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(obj);
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export async function POST(req: NextRequest) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const project = conn()
    .prepare(`SELECT id, status FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, me.id) as { id: number; status: string } | undefined;
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (project.status !== 'unlocked' && project.status !== 'checkpointed') {
    return NextResponse.json(
      { error: `Project is ${project.status}; new witnesses rejected` },
      { status: 409 },
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(body.inlineBase64, 'base64');
  } catch (e) {
    return NextResponse.json({ error: 'Invalid base64' }, { status: 400 });
  }
  if (bytes.length === 0) {
    return NextResponse.json({ error: 'Empty payload' }, { status: 400 });
  }

  // machine_manifest_hash is the sha256 of the canonical-JSON serialization
  // of the manifest. This is the v2.2 leaf-preimage component that binds
  // the toolchain identity into the witness.
  const machineManifestHash = sha256Hex(canonicalize(body.machineManifest));

  const result = await ingestIteration({
    userId: me.id,
    projectId: body.projectId,
    provider: 'comfydeploy', // dummy — backend isn't a generator here
    providerJobId: `fusion-${crypto.randomUUID()}`,
    prompt: body.prompt ?? `fusion-witness — ${body.filename}`,
    spec: {
      prompt: body.prompt ?? `fusion-witness — ${body.filename}`,
      providerExtras: { source: 'fusion-addin', filename: body.filename },
    } as never,
    imageBytes: bytes,
    imageContentType: body.contentType ?? 'application/octet-stream',
    imageFilename: body.filename,
    outputKind: 'cad',
    inputs: [],
    machineManifestHash,
  });

  return NextResponse.json({
    ok: true,
    // `ok` means the iteration was captured. It does NOT mean it was
    // witnessed — capture is non-blocking by design. Clients must read
    // `witnessed` and say so plainly in the UI; per Standard §5 there is
    // no partial credit, and a client that renders capture as witnessing
    // is making a claim the server did not make.
    witnessed: result.witnessed,
    leafScheme: result.leafScheme,
    iteration: result.iteration,
    leafHash: result.leafHash,
    runSequence: result.runSequence,
    machineManifestHash,
    storagePointer: result.storagePointer,
  });
}
