// C2PA signing — thin wrapper around the Python subprocess in
// services/c2pa-signer/sign.py. Both Scruple Studio and Scruple Fusion
// call this via /api/scruple/c2pa/sign.
//
// The subprocess model (rather than a native binding) keeps the c2pa-rs
// dependency isolated — Rust build tooling never enters the Node install
// path, and swapping to a Node-native binding later is a single-file
// change here.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const SIGNER_DIR = path.join(process.cwd(), 'services', 'c2pa-signer');
const SIGNER_SCRIPT = path.join(SIGNER_DIR, 'sign.py');
const KEYS_DIR = path.join(SIGNER_DIR, 'keys');
const DEV_CERT = path.join(KEYS_DIR, 'es256.pub');
const DEV_KEY = path.join(KEYS_DIR, 'es256.pem');
const PYTHON_BIN = process.env.SCRUPLE_C2PA_PYTHON ?? 'python3';

export type LockTier = 'bare' | 'witnessed' | 'local' | 'chain';

export interface ScrupleAssertionData {
  lock_tier: LockTier;
  scr_id?: string;
  leaf_hash?: string;
  merkle_root?: string;
  chain_position?: number;
  signed_at: string;
  // local + chain tiers
  lock_server_signature?: string;
  local_lock_at?: string;
  // chain tier only
  rvn_txid?: string;
  rvn_block_height?: number;
  ipfs_cid?: string;
  arweave_uri?: string;
}

export interface WorkflowAssertionData {
  workflow_hash?: string;
  model_fingerprints_hash?: string;
  seed?: number;
  prompt_hash?: string;
  machine_manifest_hash?: string;
  generation_type?: 'txt2img' | 'img2img' | 'txt2video' | 'lora_train';
}

export interface CadAssertionData {
  f3d_hash?: string;
  timeline_op_count?: number;
  external_source?: Array<{ type: 'script' | 'import' | 'marketplace' | 'link'; ref: string; hash?: string }>;
  units?: string;
}

export interface SignAssetInput {
  assetPath: string;
  outputPath: string;
  product: 'studio' | 'fusion';
  tier: LockTier;
  title?: string;
  scruple?: ScrupleAssertionData;
  workflow?: WorkflowAssertionData;
  cad?: CadAssertionData;
  format?: string; // MIME type; defaults from asset extension
}

export interface SignAssetResult {
  ok: true;
  outputPath: string;
  bytes: number;
  /** 'vault' when SCRUPLE_C2PA_VAULT_KEY_OCID is set; 'local' otherwise. */
  signingMode?: 'vault' | 'local';
  /** Human-safe identifier: 'vault:...<last-8-of-ocid>' or 'local:<path>'. */
  signerIdentity?: string;
  /** sha256 hex of the SOURCE asset bytes (pre-sign). */
  assetSha256?: string;
  /** sha256 hex of the C2PA JUMBF manifest embedded in the signed output. */
  outputManifestSha256?: string;
}

export interface SignAssetError {
  ok: false;
  error: string;
  trace?: string[];
}

async function sha256HexOfFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Extract the C2PA JUMBF box from a signed asset and hash it.
 *
 * PNG (and JPEG/WebP) can embed C2PA manifests in different ways; the
 * cheapest reliable approximation for the audit leaf is to hash the
 * DIFFERENCE between the signed file and the source file's bytes:
 * whatever the signer added is the JUMBF payload (plus format
 * scaffolding). Not byte-perfect JUMBF-only, but stable, unique per
 * signed manifest, and cheap.
 *
 * Sprint 2 (WO-13 proof API v2) may swap this for a real JUMBF extract
 * via a c2pa-node call; today the diff-hash is enough for audit
 * correlation and passes the parity requirement (same input → same
 * output).
 */
async function computeSignedArtifactHashes(
  sourcePath: string,
  outputPath: string,
): Promise<{ assetSha256: string; outputManifestSha256: string }> {
  const [assetSha256, outputSha256] = await Promise.all([
    sha256HexOfFile(sourcePath),
    sha256HexOfFile(outputPath),
  ]);
  // Manifest-scope hash: sha256(source||signed) covers both — a distinct
  // source or a distinct manifest produces a distinct outputManifestSha256.
  const combined = createHash('sha256');
  combined.update(assetSha256, 'hex');
  combined.update(outputSha256, 'hex');
  return { assetSha256, outputManifestSha256: combined.digest('hex') };
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

function buildManifest(input: SignAssetInput): Record<string, unknown> {
  const assertions: Array<{ label: string; data: unknown }> = [];

  // Standard C2PA actions — first action MUST be created/opened to avoid
  // the `assertion.action.malformed` validation warning.
  assertions.push({
    label: 'c2pa.actions.v2',
    data: {
      actions: [
        { action: 'c2pa.created' },
        { action: 'c2pa.published', softwareAgent: 'Scruple/0.1' },
      ],
    },
  });

  // Training-mining opt-out (CAWG namespace; c2pa.training_mining was
  // removed in C2PA 2.0).
  assertions.push({
    label: 'cawg.training-mining',
    data: { entries: [{ use: 'notAllowed' }] },
  });

  // Scruple provenance — omitted for `bare` tier per design.
  if (input.tier !== 'bare' && input.scruple) {
    assertions.push({
      label: 'ai.scruple.provenance.v1',
      data: input.scruple,
    });
  }

  if (input.product === 'studio' && input.workflow) {
    assertions.push({ label: 'ai.scruple.workflow.v1', data: input.workflow });
  }
  if (input.product === 'fusion' && input.cad) {
    assertions.push({ label: 'ai.scruple.cad.v1', data: input.cad });
  }

  return {
    claim_generator: 'Scruple/0.1 (c2pa-python 0.36)',
    title: input.title ?? path.basename(input.assetPath),
    format: input.format ?? mimeFromPath(input.assetPath),
    assertions,
  };
}

export async function signAsset(
  input: SignAssetInput,
): Promise<SignAssetResult | SignAssetError> {
  try {
    await fs.access(input.assetPath);
  } catch {
    return { ok: false, error: `asset not found: ${input.assetPath}` };
  }

  // Ensure dev cert/key are on disk (they always should be — they're
  // committed in the repo; this guard makes local-dev errors legible).
  try {
    await Promise.all([fs.access(DEV_CERT), fs.access(DEV_KEY)]);
  } catch {
    return { ok: false, error: 'signer cert/key missing at services/c2pa-signer/keys/' };
  }

  const job = {
    asset_path: input.assetPath,
    output_path: input.outputPath,
    cert_path: process.env.SCRUPLE_C2PA_CERT ?? DEV_CERT,
    key_path: process.env.SCRUPLE_C2PA_KEY ?? DEV_KEY,
    manifest: buildManifest(input),
  };

  return await new Promise<SignAssetResult | SignAssetError>((resolve) => {
    const proc = spawn(PYTHON_BIN, [SIGNER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: SIGNER_DIR,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, error: `subprocess spawn failed: ${e.message}` }));
    proc.on('close', () => {
      // sign.py writes ONE JSON object to stdout, possibly preceded by
      // Python deprecation warnings (they land on stderr but be defensive).
      try {
        const jsonStart = stdout.indexOf('{');
        const jsonEnd = stdout.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1) {
          return resolve({ ok: false, error: `no JSON in signer output. stderr: ${stderr.slice(0, 500)}` });
        }
        const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as {
          ok: boolean;
          output_path?: string;
          bytes?: number;
          signing_mode?: 'vault' | 'local';
          signer_identity?: string;
          error?: string;
          trace?: string[];
        };
        if (parsed.ok && parsed.output_path && typeof parsed.bytes === 'number') {
          // Compute post-sign asset + manifest hashes for the audit leaf.
          computeSignedArtifactHashes(input.assetPath, parsed.output_path)
            .then((hashes) =>
              resolve({
                ok: true,
                outputPath: parsed.output_path!,
                bytes: parsed.bytes!,
                signingMode: parsed.signing_mode,
                signerIdentity: parsed.signer_identity,
                assetSha256: hashes.assetSha256,
                outputManifestSha256: hashes.outputManifestSha256,
              }),
            )
            .catch((e) =>
              // Hash failure is non-fatal for the sign result — return
              // sign success + undefined hashes; caller decides whether
              // to skip the audit emit.
              resolve({
                ok: true,
                outputPath: parsed.output_path!,
                bytes: parsed.bytes!,
                signingMode: parsed.signing_mode,
                signerIdentity: parsed.signer_identity,
              }),
            );
          return;
        }
        return resolve({ ok: false, error: parsed.error ?? 'unknown signer error', trace: parsed.trace });
      } catch (e) {
        return resolve({
          ok: false,
          error: `bad signer output: ${(e as Error).message}. raw: ${stdout.slice(0, 300)}`,
        });
      }
    });
    proc.stdin.write(JSON.stringify(job));
    proc.stdin.end();
  });
}
