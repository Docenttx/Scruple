// Apply watermarks to a project's image iterations at lock/publish time.
//
// Called from /api/lock/local (tier 3), /api/lock/chain-* (tier 4/5), and
// optionally /api/lock/checkpoint (tier 2, opt-in). Never called at
// generation time — masters stay clean per WATERMARK_DESIGN §4.3.
//
// For each image iteration in the project:
//   1. Read the clean master bytes from the local artifact store
//   2. Build the tier-appropriate payload
//   3. Embed via lib/watermark/embed.ts
//   4. Store the derivative bytes with a distinct hash-derived filename
//   5. Update the iterations row with the derivative fields
//
// Video iterations are skipped in MVP (Phase 2). Iterations whose master
// bytes aren't reachable locally are skipped with a note in the result.

import { createHash } from 'node:crypto';
import { conn } from '@/lib/db/sqlite';
import { readArtifact, storeArtifact } from '@/lib/scruple/artifacts';
import { buildPayloadHex, embedImageWatermark, type WatermarkTier } from './embed';
import type { IterationRow } from '@/lib/types';

export interface ApplyInput {
  projectId: number;
  tier: WatermarkTier;
  /** Required for chain-lock tiers. */
  scrId?: string;
  /** Required for chain-lock-pinned tier. */
  pinnedHint?: number;
}

export interface ApplyResult {
  applied: number;
  skipped: Array<{ runSequence: number; reason: string }>;
  errors: Array<{ runSequence: number; error: string }>;
}

const IMAGE_MIME_PREFIX = 'image/';

export function watermarkProjectIterations(input: ApplyInput): ApplyResult {
  const iterations = conn()
    .prepare(
      `SELECT id, run_sequence, output_hash, output_kind, output_content_type
         FROM iterations
        WHERE project_id = ?
        ORDER BY run_sequence ASC`,
    )
    .all(input.projectId) as Pick<
      IterationRow,
      'id' | 'run_sequence' | 'output_hash' | 'output_kind' | 'output_content_type'
    >[];

  const applied: number[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const errors: ApplyResult['errors'] = [];

  for (const it of iterations) {
    // Skip non-image outputs — video/audio watermarking is Phase 2
    if (it.output_kind !== 'image') {
      skipped.push({ runSequence: it.run_sequence, reason: `output_kind=${it.output_kind} (Phase 2)` });
      continue;
    }
    // Skip if output_content_type is a format not in our v1 image scope
    if (!it.output_content_type?.startsWith(IMAGE_MIME_PREFIX)) {
      skipped.push({ runSequence: it.run_sequence, reason: `unsupported content-type=${it.output_content_type}` });
      continue;
    }

    // Read the clean master bytes
    if (!it.output_hash) {
      skipped.push({ runSequence: it.run_sequence, reason: 'iteration has no output_hash' });
      continue;
    }
    const masterBytes = readArtifact(it.output_hash);
    if (!masterBytes) {
      skipped.push({ runSequence: it.run_sequence, reason: 'master bytes not in local artifact store' });
      continue;
    }

    try {
      // Build payload
      const payloadHex = buildPayloadHex({
        tier: input.tier,
        scrId: input.scrId,
        pinnedHint: input.pinnedHint,
      });

      // Embed → get derivative bytes
      const ct = it.output_content_type ?? 'image/png';
      const embedResult = embedImageWatermark({
        masterBytes,
        inputFormat: contentTypeToFormat(ct),
        outputFormat: contentTypeToFormat(ct),
        payloadHex,
      });

      // Store derivative bytes; hash-name them like other artifacts
      const derivativeHash = createHash('sha256').update(embedResult.derivativeBytes).digest('hex');
      storeArtifact(derivativeHash, embedResult.derivativeBytes);

      // Persist derivative metadata on the iterations row
      conn().prepare(
        `UPDATE iterations SET
           watermark_derivative_hash = ?,
           watermark_payload_hex = ?,
           watermark_scheme_version = 1,
           watermark_tier = ?,
           watermark_signed_at = ?
         WHERE id = ?`,
      ).run(
        derivativeHash,
        payloadHex,
        tierToInt(input.tier),
        new Date().toISOString(),
        it.id,
      );

      applied.push(it.run_sequence);
    } catch (e) {
      errors.push({
        runSequence: it.run_sequence,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    applied: applied.length,
    skipped,
    errors,
  };
}

function contentTypeToFormat(ct: string): string {
  if (ct.includes('png')) return 'PNG';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'JPEG';
  if (ct.includes('webp')) return 'WEBP';
  if (ct.includes('tiff')) return 'TIFF';
  return 'PNG'; // default lossless
}

function tierToInt(tier: WatermarkTier): number {
  switch (tier) {
    case 'c2pa-signed': return 1;
    case 'checkpoint': return 2;
    case 'local-lock': return 3;
    case 'chain-lock-basic': return 4;
    case 'chain-lock-pinned': return 5;
  }
}
