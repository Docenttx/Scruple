// Model fingerprinting for training artifacts (Loras + checkpoints).
//
// Produces two independently-verifiable hashes per file:
//
//   contentHash    — SHA-256 of the complete file bytes. Canonical proof
//                    of authenticity. Same scheme as image iterations.
//                    Slow on multi-GB files (~30-60 s) but only done once
//                    at training-completion time. Anchors the SCR-ID.
//
//   headerHash     — SHA-256 of the safetensors JSON header region (the
//                    8-byte size prefix is NOT included; only the JSON
//                    bytes themselves). Kilobytes. Instant. Fingerprints
//                    the model's tensor topology — same hash means same
//                    architecture (tensor names, shapes, dtypes).
//
// Plus a structural summary (JSON, ~1 KB) recording tensor count, param
// total, dtypes seen, shape patterns, and a model-type guess from the
// tensor naming.
//
// Patent angle: dual-hash provenance for AI model artifacts — bit-exact
// authenticity AND architectural authenticity, both verifiable from the
// chain receipt.
//
// File format reference: lib/scruple/safetensors.ts

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { readSafetensorsHeader, type TensorEntry, type SafetensorsHeader } from './safetensors';
import { sha256Hex } from './hash';

export interface StructuralSummary {
  tensorCount: number;
  totalParamCount: number;       // sum of (product of shape) across tensors
  dtypes: string[];               // distinct dtypes seen, sorted
  shapesSketch: Record<string, string>;   // tensor-name-pattern → shape signature
  modelTypeGuess: string;        // FluxLora | SDXLLora | SD15Lora | SDXLCheckpoint | Unknown
  fileSize: number;               // bytes
  headerSize: number;             // bytes of JSON header
  metadata: Record<string, string>;  // safetensors __metadata__ contents
}

export interface ModelFingerprint {
  contentHash: string;     // 64-hex SHA-256 of full file
  headerHash: string;      // 64-hex SHA-256 of header JSON bytes
  headerSize: number;
  tensorCount: number;
  fileSize: number;
  structuralSummary: StructuralSummary;
}

// Fingerprint a safetensors file on disk. Streams the file for the content
// hash — never materializes the full blob in memory. ~30-60 s on a 4 GB
// checkpoint on a modern CPU.
export async function fingerprintModelFile(filePath: string): Promise<ModelFingerprint> {
  // Header first — instant, lets us fail fast on non-safetensors files.
  const { header, handle } = await readSafetensorsHeader(filePath);
  await handle.close();

  const headerHash = sha256Hex(header.headerBytes);
  const { size: fileSize } = await stat(filePath);

  // Stream content hash. Node's createHash + pipeline = O(1) memory.
  const contentHasher = createHash('sha256');
  await pipeline(
    createReadStream(filePath),
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        contentHasher.update(chunk);
        cb();
      },
    }),
  );
  const contentHash = contentHasher.digest('hex');

  const structuralSummary = buildStructuralSummary(header, fileSize);

  return {
    contentHash,
    headerHash,
    headerSize: header.headerSize,
    tensorCount: header.tensors.length,
    fileSize,
    structuralSummary,
  };
}

// Compute only the structural fingerprint (header hash + summary) — skips
// the full content-hash stream. Useful for fast structural verification:
// pull just the first few KB of a candidate file, compute, compare to the
// recorded headerHash. Confirms architecture without paying the multi-GB
// SHA-256 cost.
export async function structuralFingerprintOnly(filePath: string): Promise<{
  headerHash: string;
  headerSize: number;
  tensorCount: number;
  structuralSummary: StructuralSummary;
}> {
  const { header, handle, fileSize } = await readSafetensorsHeader(filePath);
  await handle.close();
  return {
    headerHash: sha256Hex(header.headerBytes),
    headerSize: header.headerSize,
    tensorCount: header.tensors.length,
    structuralSummary: buildStructuralSummary(header, fileSize),
  };
}

function buildStructuralSummary(header: SafetensorsHeader, fileSize: number): StructuralSummary {
  const tensors = header.tensors;
  const totalParamCount = tensors.reduce((acc, t) => acc + tensorElements(t), 0);
  const dtypes = Array.from(new Set(tensors.map(t => t.dtype))).sort();
  const shapesSketch = buildShapesSketch(tensors);
  const modelTypeGuess = guessModelType(tensors, header.metadata);
  return {
    tensorCount: tensors.length,
    totalParamCount,
    dtypes,
    shapesSketch,
    modelTypeGuess,
    fileSize,
    headerSize: header.headerSize,
    metadata: header.metadata,
  };
}

function tensorElements(t: TensorEntry): number {
  return t.shape.reduce((a, b) => a * b, 1);
}

// Collapses tensor names by replacing numeric segments with *, so that
// "lora_unet_down_blocks_0_attn1_q.weight" and
// "lora_unet_down_blocks_5_attn1_q.weight" share one row.
function buildShapesSketch(tensors: TensorEntry[]): Record<string, string> {
  const buckets = new Map<string, { shape: number[]; count: number }>();
  for (const t of tensors) {
    const pattern = t.name.replace(/(?<![a-zA-Z])\d+(?![a-zA-Z])/g, '*');
    const shape = t.shape;
    const key = pattern + '|' + shape.join('x');
    const cur = buckets.get(key);
    if (cur) cur.count += 1;
    else buckets.set(key, { shape, count: 1 });
  }
  const out: Record<string, string> = {};
  for (const [key, { shape, count }] of buckets) {
    const pattern = key.split('|')[0];
    out[pattern] = `[${shape.join(', ')}]${count > 1 ? ` ×${count}` : ''}`;
  }
  return out;
}

// Heuristic model-type guess from tensor naming + metadata. Kohya Loras
// carry the canonical base-model id in __metadata__.ss_base_model_version
// (e.g. "sd_v15", "sdxl_base_v1-0", "flux1_dev"); when present we trust
// it. Otherwise we fall back to tensor-name pattern matching.
function guessModelType(
  tensors: TensorEntry[],
  metadata: Record<string, string>,
): string {
  if (tensors.length === 0) return 'Unknown';
  const names = tensors.map(t => t.name);
  const lower = names.join('\n').toLowerCase();
  const totalParams = tensors.reduce((a, t) => a + tensorElements(t), 0);

  const isLora =
    lower.includes('lora_') ||
    lower.includes('.lora_a.') ||
    lower.includes('.lora_b.') ||
    lower.includes('lora_down') ||
    lower.includes('lora_up');

  const isFluxByName =
    lower.includes('double_blocks') ||
    lower.includes('single_blocks') ||
    lower.includes('img_in.') ||
    lower.includes('txt_in.');

  const isSDXLByName =
    lower.includes('input_blocks') &&
    lower.includes('output_blocks') &&
    (lower.includes('label_emb') || lower.includes('add_embedding'));

  const isSD15ByName =
    lower.includes('model.diffusion_model.') &&
    !isSDXLByName &&
    totalParams < 2_000_000_000;

  // Kohya metadata trumps name heuristics for Loras.
  const ssBase = (metadata.ss_base_model_version || '').toLowerCase();
  let baseFamily: 'flux' | 'sdxl' | 'sd15' | null = null;
  if (ssBase.includes('flux')) baseFamily = 'flux';
  else if (ssBase.includes('sdxl') || ssBase.includes('sd_xl')) baseFamily = 'sdxl';
  else if (ssBase.includes('sd_v15') || ssBase.includes('sd_v1') || ssBase.includes('sd_15')) baseFamily = 'sd15';
  else if (isFluxByName) baseFamily = 'flux';
  else if (isSDXLByName) baseFamily = 'sdxl';
  else if (isSD15ByName) baseFamily = 'sd15';

  if (isLora) {
    if (baseFamily === 'flux') return 'FluxLora';
    if (baseFamily === 'sdxl') return 'SDXLLora';
    if (baseFamily === 'sd15') return 'SD15Lora';
    return 'Lora';
  }
  if (baseFamily === 'flux') return 'FluxCheckpoint';
  if (baseFamily === 'sdxl') return 'SDXLCheckpoint';
  if (baseFamily === 'sd15') return 'SD15Checkpoint';
  return 'Unknown';
}
