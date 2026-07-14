// Server-side wrapper for the Python watermark reference implementation.
// Used by lock/publish routes to embed watermarks on the SaaS surface
// (Scruple Studio Web). Client-side integrators use @scruple/watermark
// directly and never touch this file.
//
// Contract: input = clean master bytes + tier + optional SCR_ID/hint.
// Output = watermarked derivative bytes + the payload_hex that was
// embedded (which the caller then hands to the /v1/log signer along
// with the master_hash + derivative_hash to establish lineage).
//
// See docs/architecture/WATERMARK_DESIGN_v1.md v1.2 for the full spec.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const PYTHON = process.env.SCRUPLE_PYTHON || 'python3';

export type WatermarkTier =
  | 'c2pa-signed'        // tier 1
  | 'checkpoint'         // tier 2
  | 'local-lock'         // tier 3
  | 'chain-lock-basic'   // tier 4
  | 'chain-lock-pinned'; // tier 5

const TIER_TO_INT: Record<WatermarkTier, number> = {
  'c2pa-signed': 1,
  'checkpoint': 2,
  'local-lock': 3,
  'chain-lock-basic': 4,
  'chain-lock-pinned': 5,
};

export interface BuildPayloadInput {
  tier: WatermarkTier;
  /** Required for chain-lock tiers. Ignored for tier 1-3. */
  scrId?: string;
  /** Required for chain-lock-pinned (tier 5). */
  pinnedHint?: number;
  /** Override current time for reproducibility (tier 1-3 only). */
  signedAtUnixSeconds?: number;
}

/**
 * Build a 128-bit watermark payload as a 32-char hex string. Pure
 * function delegating to the Python reference's `payload` module.
 * No image bytes touched — only payload construction.
 */
export function buildPayloadHex(input: BuildPayloadInput): string {
  const tierInt = TIER_TO_INT[input.tier];
  if (tierInt === undefined) {
    throw new Error(`unknown tier: ${input.tier}`);
  }

  let script: string;
  if (tierInt <= 3) {
    const ts = input.signedAtUnixSeconds ?? Math.floor(Date.now() / 1000);
    script = `
import sys; sys.path.insert(0, '${REPO_ROOT}/services')
from watermark.payload import build_payload_tier_1_3, Tier, payload_hex
print(payload_hex(build_payload_tier_1_3(Tier(${tierInt}), signed_at_unix_seconds=${ts})))
`;
  } else {
    if (!input.scrId) throw new Error('scrId required for chain-lock tiers');
    if (tierInt === 5 && input.pinnedHint === undefined) {
      throw new Error('pinnedHint required for tier 5');
    }
    const hintArg = tierInt === 5 ? `pinned_hint=${input.pinnedHint}` : '';
    script = `
import sys; sys.path.insert(0, '${REPO_ROOT}/services')
from watermark.payload import build_payload_tier_4_5, Tier, payload_hex
print(payload_hex(build_payload_tier_4_5(Tier(${tierInt}), scr_id='${input.scrId}'${hintArg ? ', ' + hintArg : ''})))
`;
  }

  const r = spawnSync(PYTHON, ['-c', script], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return r.stdout.trim();
}

export interface EmbedInput {
  masterBytes: Buffer;
  /** Source format hint (png, jpeg, webp, etc). Defaults to png. */
  inputFormat?: string;
  /** Output format. Defaults to png (lossless — preserves watermark). */
  outputFormat?: string;
  /** Output JPEG/WEBP quality if applicable. */
  outputQuality?: number;
  payloadHex: string;
}

export interface EmbedResult {
  derivativeBytes: Buffer;
  payloadHex: string;
  scheme: 'dct-v1';
  version: 1;
}

/**
 * Embed a watermark payload into image bytes; return the derivative
 * bytes. Master preservation invariant per WATERMARK_DESIGN §4.3:
 * the caller passes the master bytes; this function does NOT modify
 * them — it returns brand-new derivative bytes for the caller to
 * persist alongside the master.
 */
export function embedImageWatermark(input: EmbedInput): EmbedResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'scruple-wm-'));
  const srcPath = path.join(dir, 'master' + extForFormat(input.inputFormat));
  const dstPath = path.join(dir, 'watermarked' + extForFormat(input.outputFormat));
  try {
    writeFileSync(srcPath, input.masterBytes);
    const job = {
      action: 'embed',
      input_path: srcPath,
      output_path: dstPath,
      output_format: (input.outputFormat || 'PNG').toUpperCase(),
      payload_hex: input.payloadHex,
    };
    const r = spawnSync(
      PYTHON,
      ['-m', 'services.watermark.cli'],
      {
        input: JSON.stringify(job),
        encoding: 'utf-8',
        cwd: REPO_ROOT,
      },
    );
    if (r.status !== 0) throw new Error(`watermark embed failed: ${r.stderr || r.stdout}`);
    const resultLine = r.stdout.trim().split('\n').at(-1) || '';
    const result = JSON.parse(resultLine) as { ok: boolean; error?: string };
    if (!result.ok) throw new Error(`watermark embed failed: ${result.error}`);
    const derivativeBytes = readFileSync(dstPath);
    return {
      derivativeBytes,
      payloadHex: input.payloadHex,
      scheme: 'dct-v1',
      version: 1,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export interface DecodeResult {
  found: true;
  tier: number;
  version: number;
  scrId?: string;
  scrIdU64?: number;
  pinnedHint?: number | null;
  signedAtUnixSeconds?: number;
}

/**
 * Decode a watermark from image bytes. Returns null if no valid Scruple
 * watermark is recovered.
 */
export function decodeImageWatermark(imageBytes: Buffer): DecodeResult | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'scruple-wm-dec-'));
  const srcPath = path.join(dir, 'input.png');
  try {
    writeFileSync(srcPath, imageBytes);
    const r = spawnSync(
      PYTHON,
      ['-m', 'services.watermark.cli'],
      {
        input: JSON.stringify({ action: 'decode', input_path: srcPath }),
        encoding: 'utf-8',
        cwd: REPO_ROOT,
      },
    );
    if (r.status !== 0) return null;
    const resultLine = r.stdout.trim().split('\n').at(-1) || '';
    const parsed = JSON.parse(resultLine) as { ok: boolean; decoded: Record<string, unknown> | null };
    if (!parsed.ok || !parsed.decoded) return null;
    const d = parsed.decoded;
    return {
      found: true,
      tier: d.tier as number,
      version: d.version as number,
      scrId: d.scr_id as string | undefined,
      scrIdU64: d.scr_id_u64 as number | undefined,
      pinnedHint: d.pinned_hint as number | null | undefined,
      signedAtUnixSeconds: d.signed_at_unix_seconds as number | undefined,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function extForFormat(fmt?: string): string {
  const f = (fmt || 'PNG').toUpperCase();
  if (f === 'JPEG' || f === 'JPG') return '.jpg';
  if (f === 'WEBP') return '.webp';
  if (f === 'TIFF') return '.tiff';
  return '.png';
}
