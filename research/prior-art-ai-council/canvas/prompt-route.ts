// app/api/canvas/prompt/route.ts
// POST /api/canvas/prompt — Scruple intercept for ComfyUI workflow submission
//
// Provenance chain:
//   1. Hash the full workflow JSON (input witness)
//   2. Forward to ComfyUI /prompt
//   3. Capture prompt_id from response
//   4. Emit pre-queue witness event to :5799
//   5. Return ComfyUI response to client

import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

export const dynamic = 'force-dynamic';

const COMFYUI = process.env.COMFYUI_BACKEND || 'http://127.0.0.1:8188';
const WITNESS_URL = process.env.WITNESS_URL || 'http://127.0.0.1:5799';

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function emitWitness(event: {
  event_type: string;
  project_id: string;
  run_sequence?: number;
  content_hash?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await fetch(`${WITNESS_URL}/api/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Non-fatal — witness server offline or slow; log but don't block generation
    console.warn('[canvas/prompt] Witness emit failed:', event.event_type);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // ── 1. Hash the workflow (the full prompt object is the canonical input) ──
  const workflowJson = JSON.stringify(body.prompt || body);
  const workflowHash = sha256(workflowJson);

  // Extract project context from headers or body extras
  const projectId = req.headers.get('x-scruple-project-id') || body._scruple_project_id || 'untracked';
  const runSequence = parseInt(req.headers.get('x-scruple-run-sequence') || '0') || Date.now();

  // Strip Scruple metadata from payload before forwarding to ComfyUI
  const { _scruple_project_id, _scruple_run_sequence, ...cleanBody } = body;

  // ── 2. Emit pre-queue witness ─────────────────────────────────────────────
  await emitWitness({
    event_type: 'pre_queue',
    project_id: projectId,
    run_sequence: runSequence,
    content_hash: workflowHash,
    metadata: {
      workflow_node_count: Object.keys(body.prompt || {}).length,
      client_id: body.client_id,
    },
  });

  // ── 3. Forward to ComfyUI ─────────────────────────────────────────────────
  const comfyRes = await fetch(`${COMFYUI}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cleanBody),
  });

  const comfyData = await comfyRes.json();

  if (!comfyRes.ok) {
    return NextResponse.json(comfyData, { status: comfyRes.status });
  }

  const promptId = comfyData.prompt_id as string;

  // ── 4. Emit queue-accepted witness ────────────────────────────────────────
  await emitWitness({
    event_type: 'queue_accepted',
    project_id: projectId,
    run_sequence: runSequence,
    content_hash: workflowHash,
    metadata: {
      prompt_id: promptId,
      queue_remaining: comfyData.number,
    },
  });

  // ── 5. Return to client with Scruple receipt ──────────────────────────────
  return NextResponse.json({
    ...comfyData,
    _scruple: {
      workflow_hash: workflowHash,
      project_id: projectId,
      run_sequence: runSequence,
      witnessed_at: new Date().toISOString(),
    },
  });
}
