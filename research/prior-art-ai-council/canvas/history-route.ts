// app/api/canvas/history/route.ts
// GET /api/canvas/history — Scruple intercept for run history/metadata
// Binds ComfyUI run records back to Scruple witness records by prompt_id

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const COMFYUI = process.env.COMFYUI_BACKEND || 'http://127.0.0.1:8188';
const WITNESS_URL = process.env.WITNESS_URL || 'http://127.0.0.1:5799';

export async function GET(req: NextRequest) {
  const promptId = req.nextUrl.searchParams.get('prompt_id') || '';
  const projectId = req.headers.get('x-scruple-project-id') || 'untracked';

  const url = promptId
    ? `${COMFYUI}/history/${promptId}`
    : `${COMFYUI}/history`;

  const comfyRes = await fetch(url);
  if (!comfyRes.ok) return new NextResponse(null, { status: comfyRes.status });

  const history = await comfyRes.json();

  // Fetch witness records for this project to enrich the history
  let witnessRecords: unknown[] = [];
  try {
    const witnessRes = await fetch(`${WITNESS_URL}/api/witness/${projectId}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (witnessRes.ok) {
      const w = await witnessRes.json();
      witnessRecords = w.iterations || [];
    }
  } catch {
    // Non-fatal
  }

  // Annotate history entries with matching witness records
  const annotated = Object.fromEntries(
    Object.entries(history).map(([pid, run]) => {
      const witness = witnessRecords.find(
        (w: any) => w.metadata?.prompt_id === pid
      );
      return [pid, { ...(run as object), _scruple_witness: witness || null }];
    })
  );

  return NextResponse.json(annotated);
}
