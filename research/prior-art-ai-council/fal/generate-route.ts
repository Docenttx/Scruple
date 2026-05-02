// app/api/fal/generate/route.ts
// POST /api/fal/generate — Generate image via fal.ai with Scruple provenance
//
// Body:
//   prompt        string   required
//   model         string   optional — default: FAL_DEFAULT_MODEL or fal-ai/flux/schnell
//   image_size    string   optional — square_hd|square|portrait_4_3|landscape_4_3|landscape_16_9
//   num_images    number   optional — default 1
//   seed          number   optional
//   mode          string   optional — 'sync' (default) | 'queue'
//   project_id    string   optional — Scruple project context
//   session_id    string   optional — telemetry session context
//
// Returns FalGenerateResult (sync) or FalQueueSubmitResult (queue mode)

import { NextRequest, NextResponse } from 'next/server';
import { generateSync, queueSubmit } from '@/lib/group/fal';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { prompt, model, image_size, num_images, num_inference_steps,
          guidance_scale, seed, mode, project_id, session_id } = body as Record<string, any>;

  if (!prompt || typeof prompt !== 'string') {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  const input = {
    prompt,
    ...(model && { model }),
    ...(image_size && { image_size }),
    ...(num_images && { num_images }),
    ...(num_inference_steps && { num_inference_steps }),
    ...(guidance_scale !== undefined && { guidance_scale }),
    ...(seed !== undefined && { seed }),
    projectId: project_id || req.headers.get('x-scruple-project-id') || 'untracked',
    sessionId: session_id,
  };

  try {
    if (mode === 'queue') {
      const result = await queueSubmit(input);
      return NextResponse.json(result);
    } else {
      const result = await generateSync(input);
      return NextResponse.json(result);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[fal/generate]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
