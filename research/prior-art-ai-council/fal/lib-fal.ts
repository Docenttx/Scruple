// lib/group/fal.ts
// fal.ai image generation client with Scruple provenance.
//
// Supports:
//   - Synchronous runs (fal.run/{app}) — small/fast models
//   - Queue runs (queue.fal.run/{app}) — large models, webhook-friendly
//
// Provenance chain:
//   1. Hash request payload (input witness)
//   2. POST to fal.ai
//   3. Fetch output image bytes from result URL
//   4. Hash output bytes (output witness)
//   5. Emit witness events to :5799
//   6. Save bytes to artifacts/fal/{project_id}/{hash}.{ext}
//
// Models (set FAL_DEFAULT_MODEL in env or pass model param):
//   fal-ai/flux/dev        — FLUX.1 Dev (high quality, ~4s)
//   fal-ai/flux/schnell    — FLUX.1 Schnell (fast, ~1s)
//   fal-ai/flux-lora       — FLUX with LoRA adapters
//   fal-ai/stable-diffusion-v3-medium

import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { conn } from '@/lib/db/sqlite';
import { writeTelemetry, getActiveRound } from '@/lib/telemetry';
import { captureBit } from '@/lib/bits';

const FAL_QUEUE_BASE = 'https://queue.fal.run';
const FAL_SYNC_BASE  = 'https://fal.run';
const WITNESS_URL    = process.env.WITNESS_URL || 'http://127.0.0.1:5799';
const ARTIFACT_ROOT  = path.join(process.cwd(), 'artifacts', 'fal');

export type FalImageSize =
  | 'square_hd'        // 1024×1024
  | 'square'           // 512×512
  | 'portrait_4_3'     // 768×1024
  | 'portrait_16_9'    // 576×1024
  | 'landscape_4_3'    // 1024×768
  | 'landscape_16_9';  // 1024×576

export interface FalGenerateInput {
  prompt: string;
  model?: string;
  image_size?: FalImageSize;
  num_inference_steps?: number;
  guidance_scale?: number;
  num_images?: number;
  seed?: number;
  enable_safety_checker?: boolean;
  /** Scruple project context */
  projectId?: string;
  sessionId?: string;
}

export interface FalImageOutput {
  url: string;
  content_type: string;
  width: number;
  height: number;
}

export interface FalGenerateResult {
  images: FalImageOutput[];
  seed: number;
  prompt: string;
  timings?: Record<string, number>;
  /** Scruple provenance receipt */
  _scruple: {
    input_hash: string;
    output_hashes: string[];
    project_id: string;
    storage_paths: string[];
    witnessed_at: string;
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function falKey(): string {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('FAL_KEY not set in environment');
  return key;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function emitWitness(event: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${WITNESS_URL}/api/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    console.warn('[fal] Witness emit failed:', (event as any).event_type);
  }
}

function extForContentType(ct: string): string {
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  return 'png';
}

async function saveArtifact(
  imageBytes: Buffer,
  outputHash: string,
  contentType: string,
  projectId: string,
  promptId: string,
  filename: string,
): Promise<string> {
  const ext = extForContentType(contentType);
  const projectDir = path.join(ARTIFACT_ROOT, projectId);
  const storagePath = path.join(projectId, `${outputHash}.${ext}`);
  const fullPath = path.join(ARTIFACT_ROOT, storagePath);

  try {
    fs.mkdirSync(projectDir, { recursive: true });
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, imageBytes);
    }
  } catch (err) {
    console.error('[fal] Artifact write failed:', err);
    return storagePath; // non-fatal
  }

  // Record in DB
  try {
    const db = conn();
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scruple_artifacts'"
    ).get();
    if (exists) {
      const existing = db.prepare(
        'SELECT id FROM scruple_artifacts WHERE content_hash = ? AND project_id = ?'
      ).get(outputHash, projectId);
      if (!existing) {
        db.prepare(`
          INSERT INTO scruple_artifacts
            (id, project_id, prompt_id, filename, content_hash, content_type,
             size_bytes, storage_path, witnessed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), projectId, promptId, filename,
          outputHash, contentType, imageBytes.length,
          storagePath, new Date().toISOString(),
        );
      }
    }
  } catch (err) {
    console.error('[fal] Artifact DB record failed:', err);
  }

  return storagePath;
}

// ── Synchronous generation (fal.run — fast models, <10s) ─────────────────────

export async function generateSync(input: FalGenerateInput): Promise<FalGenerateResult> {
  const model = input.model || process.env.FAL_DEFAULT_MODEL || 'fal-ai/flux/schnell';
  const projectId = input.projectId || 'untracked';
  const promptId = randomUUID();

  // ── 1. Hash request ────────────────────────────────────────────────────────
  const { projectId: _p, sessionId: _s, model: _m, ...falPayload } = input;
  const requestPayload = {
    prompt: input.prompt,
    image_size: input.image_size || 'landscape_4_3',
    num_inference_steps: input.num_inference_steps ?? 4,
    num_images: input.num_images ?? 1,
    enable_safety_checker: input.enable_safety_checker ?? true,
    ...(input.guidance_scale !== undefined && { guidance_scale: input.guidance_scale }),
    ...(input.seed !== undefined && { seed: input.seed }),
  };
  const inputHash = sha256(JSON.stringify(requestPayload));

  // ── 2. Emit pre-generation witness ────────────────────────────────────────
  await emitWitness({
    event_type: 'fal_pre_generate',
    project_id: projectId,
    content_hash: inputHash,
    metadata: { model, prompt_id: promptId, mode: 'sync' },
  });

  // ── 3. Call fal.ai ────────────────────────────────────────────────────────
  const startMs = Date.now();
  const res = await fetch(`${FAL_SYNC_BASE}/${model}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${falKey()}`,
    },
    body: JSON.stringify(requestPayload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal.ai error (${res.status}): ${errText}`);
  }

  const data = await res.json() as {
    images: FalImageOutput[];
    seed: number;
    prompt: string;
    timings?: Record<string, number>;
  };

  const elapsedMs = Date.now() - startMs;

  // ── 4. Download + hash each output image ─────────────────────────────────
  const outputHashes: string[] = [];
  const storagePaths: string[] = [];
  const witnessedAt = new Date().toISOString();

  for (let i = 0; i < data.images.length; i++) {
    const img = data.images[i];
    const imgRes = await fetch(img.url);
    const imageBytes = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || img.content_type || 'image/png';
    const outputHash = sha256(imageBytes);
    outputHashes.push(outputHash);

    const storagePath = await saveArtifact(
      imageBytes, outputHash, contentType, projectId, promptId,
      `fal-${promptId}-${i}.${extForContentType(contentType)}`,
    );
    storagePaths.push(storagePath);

    // Capture as a Bit in user storage
    if (input.sessionId) {
      captureBit({
        sceneId: input.sessionId,
        content: imageBytes,
        source: 'image_aurora',
        mimeType: contentType,
        bitType: 'image',
        prompt: input.prompt,
      });
    }
  }

  // ── 5. Emit completion witness ────────────────────────────────────────────
  await emitWitness({
    event_type: 'fal_generated',
    project_id: projectId,
    content_hash: inputHash,
    metadata: {
      model,
      prompt_id: promptId,
      output_hashes: outputHashes,
      storage_paths: storagePaths,
      elapsed_ms: elapsedMs,
      seed: data.seed,
    },
  });

  // ── 6. Telemetry ──────────────────────────────────────────────────────────
  writeTelemetry({
    roundLabel: getActiveRound(),
    sessionId: input.sessionId || projectId,
    model,
    callType: 'fal_image_generation',
    inputTokens: Math.ceil(input.prompt.length / 4),
    outputTokens: 0,
    metadata: `elapsed_ms=${elapsedMs}`,
  });

  return {
    images: data.images,
    seed: data.seed,
    prompt: data.prompt,
    timings: data.timings,
    _scruple: {
      input_hash: inputHash,
      output_hashes: outputHashes,
      project_id: projectId,
      storage_paths: storagePaths,
      witnessed_at: witnessedAt,
    },
  };
}

// ── Queued generation (queue.fal.run — large models, async) ──────────────────

export interface FalQueueSubmitResult {
  request_id: string;
  status: 'IN_QUEUE' | 'IN_PROGRESS';
  response_url: string;
  status_url: string;
  cancel_url: string;
  _scruple: { input_hash: string; project_id: string; prompt_id: string };
}

export async function queueSubmit(input: FalGenerateInput): Promise<FalQueueSubmitResult> {
  const model = input.model || process.env.FAL_DEFAULT_MODEL || 'fal-ai/flux/dev';
  const projectId = input.projectId || 'untracked';
  const promptId = randomUUID();

  const requestPayload = {
    prompt: input.prompt,
    image_size: input.image_size || 'landscape_4_3',
    num_inference_steps: input.num_inference_steps ?? 28,
    guidance_scale: input.guidance_scale ?? 3.5,
    num_images: input.num_images ?? 1,
    enable_safety_checker: input.enable_safety_checker ?? true,
    ...(input.seed !== undefined && { seed: input.seed }),
  };
  const inputHash = sha256(JSON.stringify(requestPayload));

  await emitWitness({
    event_type: 'fal_pre_generate',
    project_id: projectId,
    content_hash: inputHash,
    metadata: { model, prompt_id: promptId, mode: 'queue' },
  });

  const res = await fetch(`${FAL_QUEUE_BASE}/${model}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${falKey()}`,
    },
    body: JSON.stringify(requestPayload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal.ai queue error (${res.status}): ${errText}`);
  }

  const data = await res.json() as {
    request_id: string;
    status: string;
    response_url: string;
    status_url: string;
    cancel_url: string;
  };

  await emitWitness({
    event_type: 'fal_queued',
    project_id: projectId,
    content_hash: inputHash,
    metadata: { model, prompt_id: promptId, request_id: data.request_id },
  });

  return {
    ...data,
    status: data.status as FalQueueSubmitResult['status'],
    _scruple: { input_hash: inputHash, project_id: projectId, prompt_id: promptId },
  };
}

export async function queueResult(
  model: string,
  requestId: string,
  projectId = 'untracked',
  sessionId?: string,
): Promise<FalGenerateResult> {
  const res = await fetch(`${FAL_QUEUE_BASE}/${model}/requests/${requestId}`, {
    headers: { Authorization: `Key ${falKey()}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal.ai result error (${res.status}): ${errText}`);
  }

  const data = await res.json() as {
    images: FalImageOutput[];
    seed: number;
    prompt: string;
    timings?: Record<string, number>;
  };

  const outputHashes: string[] = [];
  const storagePaths: string[] = [];
  const witnessedAt = new Date().toISOString();

  for (let i = 0; i < data.images.length; i++) {
    const img = data.images[i];
    const imgRes = await fetch(img.url);
    const imageBytes = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || img.content_type || 'image/png';
    const outputHash = sha256(imageBytes);
    outputHashes.push(outputHash);

    const storagePath = await saveArtifact(
      imageBytes, outputHash, contentType, projectId, requestId,
      `fal-${requestId}-${i}.${extForContentType(contentType)}`,
    );
    storagePaths.push(storagePath);
  }

  await emitWitness({
    event_type: 'fal_generated',
    project_id: projectId,
    metadata: {
      request_id: requestId,
      output_hashes: outputHashes,
      storage_paths: storagePaths,
      seed: data.seed,
    },
  });

  writeTelemetry({
    roundLabel: getActiveRound(),
    sessionId: sessionId || projectId,
    model,
    callType: 'fal_image_generation',
    inputTokens: 0,
    outputTokens: 0,
    metadata: `request_id=${requestId}`,
  });

  return {
    images: data.images,
    seed: data.seed,
    prompt: data.prompt,
    timings: data.timings,
    _scruple: {
      input_hash: '',
      output_hashes: outputHashes,
      project_id: projectId,
      storage_paths: storagePaths,
      witnessed_at: witnessedAt,
    },
  };
}

export async function queueStatus(model: string, requestId: string): Promise<{
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  queue_position?: number;
  logs?: string[];
}> {
  const res = await fetch(`${FAL_QUEUE_BASE}/${model}/requests/${requestId}/status`, {
    headers: { Authorization: `Key ${falKey()}` },
  });
  if (!res.ok) throw new Error(`fal.ai status error (${res.status})`);
  return res.json();
}
