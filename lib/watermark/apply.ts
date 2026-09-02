// Apply watermarks to a project's image iterations at lock/publish time,
// and — since WO-28 — witness each derivative as a leaf of its own.
//
// Called from /api/lock/local (tier 3). /api/lock/chain-* (tier 4/5) and
// /api/lock/checkpoint (tier 2) do NOT call it today; the header of this
// file claimed they did until WO-28 measured otherwise. Never called at
// generation time — masters stay clean per WATERMARK_DESIGN §4.3.
//
// For each image iteration in the project:
//   1. Read the clean master bytes from the local artifact store
//   2. Build the tier-appropriate payload
//   3. Embed via lib/watermark/embed.ts
//   4. Store the derivative bytes with a distinct hash-derived filename
//   5. WITNESS the derivative as its own leaf, carrying the lineage trio
//      (master_hash, watermark_payload_hex, ingredient_master_leaf_hash)
//   6. Update the iterations row with the derivative fields AND the leaf
//
// ── SIBLING LEAF, NOT AN INGREDIENT OF THE MASTER ────────────────────────
//
// The derivative is a NEW leaf appended after every master leaf. The
// master's leaf is not touched. Three reasons, in order of weight:
//
//   1. The master leaf is already sealed. It was witnessed at generation
//      time, HMAC'd and (where H-1 is enabled) ECDSA-signed over a record
//      whose `server_timestamp` names that instant, and chained into the
//      witness's own prev_record_hash chain. Folding the derivative into
//      that preimage means recomputing and re-signing a record that
//      claims a moment at which the derivative did not exist. That is not
//      a stronger commitment; it is a manufactured one.
//   2. Append-only is the property the 403 in the witness server exists
//      to defend. A design that rewrites a sealed leaf commits the same
//      violation the 403 refuses, from inside.
//   3. C2PA points the same direction. A derived asset carries its own
//      manifest naming the master as a `c2pa.ingredient`; the master's
//      manifest is untouched. WO-28's brief says the C2PA-signed version
//      MIRRORS the provenance shape — if provenance folded while C2PA
//      referenced, they would not mirror.
//
// So: SIBLING IN THE TREE, INGREDIENT IN THE RECORD. The lineage pointer
// lives inside the derivative's own preimage and points backwards.
//
// ── ORDERING ─────────────────────────────────────────────────────────────
//
// Derivative leaves are APPENDED after all master leaves, in master
// run_sequence order (see `lockLeafOrder`). Consequences, both wanted:
//   · a project with no derivative produces a byte-identical Merkle root
//     to the one it produced before WO-28;
//   · master leaf index still equals run_sequence − 1, the invariant
//     app/api/verify/route.ts checks.
//
// The synthetic run_sequence a derivative is witnessed under is
// `maxMasterRunSequence + masterRunSequence` — strictly greater than
// every master, distinct per master, monotone in the master's order, so
// the witness server's own hash chain also puts every derivative after
// every master.
//
// ── SEAM: C2PA (owned by another work order) ─────────────────────────────
//
// The artifact that should be C2PA-signed is the DERIVATIVE, not the
// master — the derivative is the file the public receives. The signing
// call belongs here, immediately after the derivative leaf is minted,
// and should be `signAsset` with intent EDIT, a `c2pa.edited` action, and
// the master as a `c2pa.ingredient`, binding
// `watermark_derivative_leaf_hash` (written below) into the manifest.
// Deliberately NOT implemented here: a second signer is the last thing
// this estate needs. `iterations.watermark_signed_at` is the timestamp of
// the WATERMARK event, not of a signature; do not repurpose it.
//
// Video iterations are skipped in MVP (Phase 2). Iterations whose master
// bytes aren't reachable locally are skipped with a note in the result.

import { createHash } from 'node:crypto';
import { conn } from '@/lib/db/sqlite';
import { readArtifact, storeArtifact } from '@/lib/scruple/artifacts';
import { witness, wireLeafScheme } from '@/lib/scruple/witness';
import { buildPayloadHex, embedImageWatermark, type WatermarkTier } from './embed';
import type { IterationRow } from '@/lib/types';

/** Leaf scheme the witness server records for a watermarked derivative. */
export const DERIVATIVE_LEAF_SCHEME = 'v2.5';

export interface ApplyInput {
  projectId: number;
  tier: WatermarkTier;
  /** Required for chain-lock tiers. */
  scrId?: string;
  /** Required for chain-lock-pinned tier. */
  pinnedHint?: number;
  /** Project id as the witness server knows it. Defaults to String(projectId). */
  witnessProjectId?: string;
  projectName?: string;
}

/** A derivative that was watermarked AND sealed as its own witness leaf. */
export interface DerivativeLeaf {
  iterationId: number;
  /** The master's run_sequence. */
  runSequence: number;
  /** The synthetic run_sequence the derivative leaf was witnessed under. */
  derivativeRunSequence: number;
  masterHash: string;
  masterLeafHash: string;
  derivativeHash: string;
  payloadHex: string;
  leafHash: string;
  leafScheme: string;
  witnessId: string;
  witnessTimestamp: string;
  prevRecordHash: string;
  witnessSignature: string | null;
}

export interface ApplyResult {
  applied: number;
  skipped: Array<{ runSequence: number; reason: string }>;
  errors: Array<{ runSequence: number; error: string }>;
  /**
   * Derivatives that carry a witness leaf, ordered by master run_sequence
   * ASC. THIS is what the caller appends to the Merkle leaf list.
   */
  witnessed: DerivativeLeaf[];
  /**
   * Derivatives whose bytes exist but which the witness did not seal —
   * witness unreachable, or a witness server that predates WO-28 and
   * answered with a plain 'v2' leaf. The bytes are still stored and the
   * receipt still offers them; they are simply NOT in the chain, and
   * `watermark_derivative_leaf_hash` stays NULL to say so.
   */
  unwitnessed: Array<{ runSequence: number; derivativeHash: string; reason: string }>;
}

const IMAGE_MIME_PREFIX = 'image/';

/**
 * The canonical leaf order for a lock: every master leaf in run_sequence
 * order, then every witnessed derivative leaf in its master's order.
 *
 * A verifier reproduces the root with exactly this concatenation. Kept as
 * a named, exported function rather than an inline spread so that the
 * rule has one definition and a test can pin it.
 */
export function lockLeafOrder(
  masterLeaves: string[],
  derivatives: Array<{ leafHash: string }>,
): string[] {
  return [...masterLeaves, ...derivatives.map((d) => d.leafHash)];
}

/**
 * The synthetic run_sequence a derivative is witnessed under.
 * `maxMasterRunSequence + masterRunSequence`.
 */
export function derivativeRunSequence(maxMasterRunSequence: number, masterRunSequence: number): number {
  return maxMasterRunSequence + masterRunSequence;
}

type Candidate = Pick<
  IterationRow,
  'id' | 'run_sequence' | 'leaf_hash' | 'output_hash' | 'output_kind' | 'output_content_type'
>;

export async function watermarkProjectIterations(input: ApplyInput): Promise<ApplyResult> {
  const iterations = conn()
    .prepare(
      `SELECT id, run_sequence, leaf_hash, output_hash, output_kind, output_content_type
         FROM iterations
        WHERE project_id = ?
        ORDER BY run_sequence ASC`,
    )
    .all(input.projectId) as Candidate[];

  const applied: number[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const errors: ApplyResult['errors'] = [];
  const witnessed: DerivativeLeaf[] = [];
  const unwitnessed: ApplyResult['unwitnessed'] = [];

  const maxSeq = iterations.reduce((m, it) => Math.max(m, it.run_sequence), 0);
  const witnessProjectId = input.witnessProjectId ?? String(input.projectId);

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
    // A derivative leaf names its master's leaf as its ingredient. With no
    // master leaf there is no lineage to claim, and the witness would
    // (correctly) 400 the partial trio.
    if (!it.leaf_hash) {
      skipped.push({ runSequence: it.run_sequence, reason: 'master has no leaf_hash to bind as ingredient' });
      continue;
    }
    const masterBytes = readArtifact(it.output_hash);
    if (!masterBytes) {
      skipped.push({ runSequence: it.run_sequence, reason: 'master bytes not in local artifact store' });
      continue;
    }

    let derivativeHash: string;
    let payloadHex: string;
    try {
      // Build payload
      payloadHex = buildPayloadHex({
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
      derivativeHash = createHash('sha256').update(embedResult.derivativeBytes).digest('hex');
      storeArtifact(derivativeHash, embedResult.derivativeBytes);

      // Persist the derivative itself. Unconditional: the bytes exist
      // whether or not the witness can be reached, and the receipt shows
      // them. The leaf columns below are what says "and it is in the
      // chain".
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
      continue;
    }

    // ── Witness the derivative ───────────────────────────────────────────
    //
    // THIS CALL ONLY SUCCEEDS BEFORE THE LOCK. The witness server 403s any
    // witness request for a project that already holds a locked_projects
    // row (server.js handleWitness), and `finalize` writes that row. The
    // caller must therefore run this whole function BEFORE
    // confirmAndExecute — which is exactly the reorder WO-28 made to
    // app/api/lock/local/route.ts, and the reason migration 038's column
    // was NULL from the day it landed.
    //
    // Sequential on purpose: the witness chains prev_record_hash off the
    // project's highest run_sequence so far, so issuing these in parallel
    // would make the chain order a race.
    const seq = derivativeRunSequence(maxSeq, it.run_sequence);
    try {
      const w = await witness.witnessIteration({
        projectId: witnessProjectId,
        projectName: input.projectName,
        runSequence: seq,
        contentHash: derivativeHash,
        masterHash: it.output_hash,
        watermarkPayloadHex: payloadHex,
        ingredientMasterLeafHash: it.leaf_hash,
      });

      // A witness server that predates WO-28 accepts the request, ignores
      // the three fields, and returns a plain 'v2' leaf that does NOT
      // commit to the lineage. Recording that leaf would be worse than
      // recording none: it would look witnessed and prove nothing. Refuse
      // it explicitly rather than trusting the deploy.
      const scheme = wireLeafScheme(w);
      if (!w.leaf_hash || scheme !== DERIVATIVE_LEAF_SCHEME) {
        unwitnessed.push({
          runSequence: it.run_sequence,
          derivativeHash,
          reason: `witness returned leaf_scheme=${String(scheme)} (expected ${DERIVATIVE_LEAF_SCHEME}) — witness server needs the WO-28 redeploy`,
        });
        continue;
      }

      const rec: DerivativeLeaf = {
        iterationId: it.id,
        runSequence: it.run_sequence,
        derivativeRunSequence: seq,
        masterHash: it.output_hash,
        masterLeafHash: it.leaf_hash,
        derivativeHash,
        payloadHex,
        leafHash: w.leaf_hash,
        leafScheme: scheme,
        witnessId: w.witness_id,
        witnessTimestamp: w.server_timestamp,
        prevRecordHash: typeof w.prev_record_hash === 'string' ? w.prev_record_hash : '',
        witnessSignature: typeof w.signature === 'string' ? w.signature : null,
      };

      conn().prepare(
        `UPDATE iterations SET
           watermark_derivative_leaf_hash = ?,
           watermark_derivative_witness_id = ?,
           watermark_derivative_run_sequence = ?,
           watermark_derivative_witness_timestamp = ?,
           watermark_derivative_prev_record_hash = ?,
           watermark_derivative_leaf_scheme = ?,
           watermark_derivative_witness_signature = ?
         WHERE id = ?`,
      ).run(
        rec.leafHash,
        rec.witnessId,
        rec.derivativeRunSequence,
        rec.witnessTimestamp,
        rec.prevRecordHash,
        rec.leafScheme,
        rec.witnessSignature,
        it.id,
      );

      witnessed.push(rec);
    } catch (e) {
      // Unreachable witness does not lose the derivative — it loses the
      // leaf, visibly. watermark_derivative_leaf_hash stays NULL, which
      // is what NULL was always supposed to mean.
      unwitnessed.push({
        runSequence: it.run_sequence,
        derivativeHash,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    applied: applied.length,
    skipped,
    errors,
    witnessed,
    unwitnessed,
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
