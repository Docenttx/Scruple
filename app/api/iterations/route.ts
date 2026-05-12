// POST /api/iterations
//
// Raw ingestion endpoint. For clients that already have image bytes
// in hand (manual upload, third-party hook). The /api/generate route
// uses the same underlying ingestIteration() helper after polling a
// provider.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { ingestIteration } from '@/lib/iterations/ingest';
import type { GenerationSpec, ProjectRow } from '@/lib/types';

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

  const { iteration, leafHash, runSequence } = await ingestIteration({
    userId,
    projectId: body.projectId,
    provider: body.provider,
    providerJobId: body.providerJobId,
    prompt: body.prompt,
    spec: body.generationSpec as unknown as GenerationSpec,
    imageBytes: Buffer.from(body.imageBytes, 'base64'),
    imageContentType: body.imageContentType,
    imageFilename: body.imageFilename ?? null,
  });

  return NextResponse.json({
    ok: true,
    iteration,
    leafHash,
    runSequence,
  });
}
