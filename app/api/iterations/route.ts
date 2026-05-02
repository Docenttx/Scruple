// POST /api/iterations
//
// Ingestion endpoint. Replaces the desktop's local Express server that
// fed off Python ComfyUI custom nodes. Web clients (or our own
// /api/generate proxy) call this with the generated image bytes.
//
// Body:
//   {
//     projectId: number,
//     provider: 'fal' | 'comfydeploy' | 'manual',
//     providerJobId: string,
//     prompt: string,
//     generationSpec: GenerationSpec,
//     imageBytes: string,            // base64
//     imageContentType: string,
//     imageFilename?: string
//   }
//
// Response: { ok: true, iteration: IterationRow, leafHash, runSequence }

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { sha256Hex } from '@/lib/scruple/hash';
import { storeArtifact } from '@/lib/scruple/artifacts';
import type { ProjectRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const Body = z.object({
  projectId: z.number().int().positive(),
  provider: z.enum(['fal', 'comfydeploy', 'manual']),
  providerJobId: z.string(),
  prompt: z.string(),
  generationSpec: z.record(z.unknown()),
  imageBytes: z.string(),                  // base64
  imageContentType: z.string(),
  imageFilename: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  // Verify project ownership
  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, userId) as ProjectRow | undefined;
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  if (project.status !== 'unlocked' && project.status !== 'checkpointed') {
    return NextResponse.json(
      { error: 'Project is locked; new iterations rejected' },
      { status: 409 },
    );
  }

  // Compute hashes — desktop convention
  const imageBuf = Buffer.from(body.imageBytes, 'base64');
  const outputHash = sha256Hex(imageBuf);
  const inputCanonical = JSON.stringify({
    provider: body.provider,
    prompt: body.prompt,
    spec: body.generationSpec,
  });
  const inputHash = sha256Hex(inputCanonical);
  // Leaf hash convention: SHA-256 of raw image bytes (matches
  // studio_terminal.py._hash_image_file). The composite (input+output)
  // is recoverable via input_hash and output_hash columns.
  const leafHash = outputHash;

  // Persist artifact bytes
  storeArtifact(outputHash, imageBuf);

  // Insert in transaction; bump iteration_count atomically
  const now = new Date().toISOString();
  const tx = conn().transaction(() => {
    const next = (conn()
      .prepare(`SELECT COALESCE(MAX(run_sequence), 0) + 1 AS n FROM iterations WHERE project_id = ?`)
      .get(body.projectId) as { n: number }).n;

    const previousHash = (conn()
      .prepare(
        `SELECT leaf_hash FROM iterations WHERE project_id = ? ORDER BY run_sequence DESC LIMIT 1`,
      )
      .get(body.projectId) as { leaf_hash: string } | undefined)?.leaf_hash ?? null;

    const result = conn()
      .prepare(
        `INSERT INTO iterations (
           project_id, run_sequence, timestamp, leaf_hash, input_hash, output_hash,
           previous_hash, metadata, source_file, image_filename, prompt, provider, provider_job_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.projectId,
        next,
        now,
        leafHash,
        inputHash,
        outputHash,
        previousHash,
        JSON.stringify({ generationSpec: body.generationSpec, contentType: body.imageContentType }),
        outputHash, // source_file = artifact hash
        body.imageFilename ?? null,
        body.prompt,
        body.provider,
        body.providerJobId,
      );

    conn()
      .prepare(`UPDATE projects SET iteration_count = iteration_count + 1, updated_at = ? WHERE id = ?`)
      .run(now, body.projectId);

    return { id: result.lastInsertRowid as number, runSequence: next };
  });

  const { id, runSequence } = tx();
  const iteration = conn().prepare(`SELECT * FROM iterations WHERE id = ?`).get(id);

  return NextResponse.json({
    ok: true,
    iteration,
    leafHash,
    runSequence,
  });
}
