// Shared iteration ingest.
//
// Pivot version (Phase S8): write artifact bytes to the user's chosen
// storage provider (Drive / OneDrive / GitHub) instead of the local
// `artifacts/` filesystem. Scruple-web records only the leaf_hash + the
// storage_pointer + chain metadata. Local copy is purged shortly after
// upload by the retention sweeper.
//
// Backward-compat: if no provider is connected, falls back to the
// existing local-FS path (lib/scruple/artifacts.storeArtifact). This
// keeps the lock pipeline + dev mode workable while users decide on a
// storage backend.

import { conn } from '@/lib/db/sqlite';
import { sha256Hex } from '@/lib/scruple/hash';
import { storeArtifact } from '@/lib/scruple/artifacts';
import { logTelemetry, estimateCostCents } from '@/lib/telemetry/log';
import { getActiveProvider } from '@/lib/storage/dispatch';
import type {
  GenerationSpec,
  IterationRow,
  ProviderName,
} from '@/lib/types';
import type { StoragePointer } from '@/lib/storage/types';

export interface IngestParams {
  userId: string;
  projectId: number;
  provider: ProviderName;
  providerJobId: string;
  prompt: string;
  spec: GenerationSpec;
  imageBytes: Buffer;
  imageContentType: string;
  imageFilename?: string | null;
  /** Backend that ran this generation (Pivot — set by /api/generate). */
  executionBackend?: 'modal-tee' | 'modal-test' | 'comfydeploy' | 'local-tunnel' | null;
  /** TEE attestation receipt, if available. */
  executionAttestation?: Record<string, unknown> | null;
}

export interface IngestResult {
  iteration: IterationRow;
  leafHash: string;
  runSequence: number;
  storagePointer: StoragePointer | null;
}

export async function ingestIteration(p: IngestParams): Promise<IngestResult> {
  const outputHash = sha256Hex(p.imageBytes);
  const inputCanonical = JSON.stringify({
    provider: p.provider,
    prompt: p.prompt,
    spec: p.spec,
  });
  const inputHash = sha256Hex(inputCanonical);
  const leafHash = outputHash;

  // Pivot S8: write to user's storage. Falls back to local FS if no
  // provider is connected (dev / pre-onboarding state).
  let storagePointer: StoragePointer | null = null;
  const provider = getActiveProvider(p.userId);
  if (provider) {
    const ext = p.imageContentType.includes('jpeg') ? 'jpg' : 'png';
    const filename = `${leafHash.slice(0, 12)}.${ext}`;
    const path = `iterations/${filename}`;
    try {
      const { pointer } = await provider.uploadFile(
        p.userId,
        path,
        p.imageBytes,
        p.imageContentType,
      );
      storagePointer = pointer;
    } catch (e) {
      console.error('[ingest] storage upload failed, falling back to local FS', e);
    }
  }
  // Always keep a local copy short-term — the iteration grid serves
  // from /api/artifact/[hash] which hits this. Retention sweeper purges
  // these after the storage upload is confirmed (Pivot S12).
  storeArtifact(outputHash, p.imageBytes);

  const now = new Date().toISOString();
  const tx = conn().transaction(() => {
    const next = (conn()
      .prepare(`SELECT COALESCE(MAX(run_sequence), 0) + 1 AS n FROM iterations WHERE project_id = ?`)
      .get(p.projectId) as { n: number }).n;

    const previousHash = (conn()
      .prepare(
        `SELECT leaf_hash FROM iterations WHERE project_id = ? ORDER BY run_sequence DESC LIMIT 1`,
      )
      .get(p.projectId) as { leaf_hash: string } | undefined)?.leaf_hash ?? null;

    const result = conn()
      .prepare(
        `INSERT INTO iterations (
           project_id, run_sequence, timestamp, leaf_hash, input_hash, output_hash,
           previous_hash, metadata, source_file, image_filename, prompt, provider, provider_job_id,
           execution_backend, execution_attestation, storage_pointer
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.projectId,
        next,
        now,
        leafHash,
        inputHash,
        outputHash,
        previousHash,
        JSON.stringify({ generationSpec: p.spec, contentType: p.imageContentType }),
        outputHash,
        p.imageFilename ?? null,
        p.prompt,
        p.provider,
        p.providerJobId,
        p.executionBackend ?? null,
        p.executionAttestation ? JSON.stringify(p.executionAttestation) : null,
        storagePointer ? JSON.stringify(storagePointer) : null,
      );

    conn()
      .prepare(`UPDATE projects SET iteration_count = iteration_count + 1, updated_at = ? WHERE id = ?`)
      .run(now, p.projectId);

    return { id: result.lastInsertRowid as number, runSequence: next };
  });

  const { id, runSequence } = tx();
  const iteration = conn()
    .prepare(`SELECT * FROM iterations WHERE id = ?`)
    .get(id) as IterationRow;

  try {
    logTelemetry({
      userId: p.userId,
      projectId: p.projectId,
      iterationId: id,
      provider: p.provider,
      providerJobId: p.providerJobId,
      prompt: p.prompt,
      spec: p.spec as unknown as Record<string, unknown>,
      costCents: estimateCostCents(p.provider),
      success: true,
    });
  } catch (e) {
    console.error('[telemetry] insert failed', e);
  }

  return { iteration, leafHash, runSequence, storagePointer };
}
