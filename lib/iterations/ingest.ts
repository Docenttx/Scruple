// Shared iteration ingest. Used by:
//   - POST /api/iterations (raw client/server upload of image bytes)
//   - POST /api/generate   (server-side after polling a provider)
//
// Pure side-effects: writes artifact bytes, inserts iterations row,
// bumps projects.iteration_count, fires telemetry. Caller is
// responsible for auth and project-ownership checks; this function
// trusts its inputs.

import { conn } from '@/lib/db/sqlite';
import { sha256Hex } from '@/lib/scruple/hash';
import { storeArtifact } from '@/lib/scruple/artifacts';
import { logTelemetry, estimateCostCents } from '@/lib/telemetry/log';
import type {
  GenerationSpec,
  IterationRow,
  ProviderName,
} from '@/lib/types';

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
}

export interface IngestResult {
  iteration: IterationRow;
  leafHash: string;
  runSequence: number;
}

export function ingestIteration(p: IngestParams): IngestResult {
  const outputHash = sha256Hex(p.imageBytes);
  const inputCanonical = JSON.stringify({
    provider: p.provider,
    prompt: p.prompt,
    spec: p.spec,
  });
  const inputHash = sha256Hex(inputCanonical);
  // Leaf hash convention matches studio_terminal.py._hash_image_file.
  const leafHash = outputHash;

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
           previous_hash, metadata, source_file, image_filename, prompt, provider, provider_job_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  return { iteration, leafHash, runSequence };
}
