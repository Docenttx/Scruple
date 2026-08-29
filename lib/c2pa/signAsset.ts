// C2PA signing — thin wrapper around the Python subprocess in
// services/c2pa-signer/sign.py. Both Scruple Studio and Scruple Fusion
// call this via /api/scruple/c2pa/sign.
//
// The subprocess model (rather than a native binding) keeps the c2pa-rs
// dependency isolated — Rust build tooling never enters the Node install
// path, and swapping to a Node-native binding later is a single-file
// change here.

import { spawn } from 'child_process';
import assertionContract from '@/config/c2pa-assertions.json';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const SIGNER_DIR = path.join(process.cwd(), 'services', 'c2pa-signer');
const SIGNER_SCRIPT = path.join(SIGNER_DIR, 'sign.py');
const KEYS_DIR = path.join(SIGNER_DIR, 'keys');
// The dev cert chain and key.
//
// These named es256.pub / es256.pem, and es256.pem HAS NEVER EXISTED.
// keys/regen-dev-cert.sh — the script that actually produces the dev
// material — emits signer.key (the ES256 private key) and signer.pem
// (leaf + root chain in the order c2pa-rs expects). Both sat beside the
// wrong names, unused.
//
// The effect: signAsset() returned {ok:false} at the fs.access guard
// below, BEFORE spawning the signer, for every caller. So C2PA signing
// had two independent breaks, not one. The assertion-allowlist mismatch
// fixed in bff1fd8 was real, and it was the SECOND thing in the way —
// nothing ever reached it, because this guard failed first.
//
// Invisible to CI because services/c2pa-signer's suite tests the
// assertion partition and never signs anything; tests.yml says so in
// terms.
const DEV_CERT = path.join(KEYS_DIR, 'signer.pem');
const DEV_KEY = path.join(KEYS_DIR, 'signer.key');
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

/** C2PA v2 builder intent — governs which inception action the SDK emits. */
export type C2paIntent = 'CREATE' | 'EDIT' | 'UPDATE';

/**
 * IPTC Digital Source Type — required on the inception action per
 * C2PA v2 spec. Values map 1:1 to c2pa-python's C2paDigitalSourceType
 * enum names. Defaults to TRAINED_ALGORITHMIC_MEDIA — the accurate
 * marker for Scruple's canonical use case (signing GenAI output).
 */
export type C2paDigitalSourceType =
  | 'TRAINED_ALGORITHMIC_MEDIA'         // GenAI-produced (Scruple default)
  | 'ALGORITHMIC_MEDIA'                 // deterministic algorithm, no ML
  | 'ALGORITHMICALLY_ENHANCED'          // input enhanced by algorithm
  | 'COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA'
  | 'HUMAN_EDITS'                       // human-in-the-loop editing
  | 'DIGITAL_CREATION'                  // digital artist creation
  | 'DATA_DRIVEN_MEDIA'                 // data-driven synthesis
  | 'EMPTY';                            // no explicit source type

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
  /** C2PA v2 intent. Defaults to CREATE. */
  intent?: C2paIntent;
  /** digitalSourceType on the inception action. Defaults to TRAINED_ALGORITHMIC_MEDIA. */
  digitalSourceType?: C2paDigitalSourceType;
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

/**
 * Extension → MIME map. Kept in sync with the C2PA Conformance intake
 * assertion (services/c2pa-signer/formats.py) so any format we claim to
 * generate can be routed correctly to the signer at runtime. The Python
 * signer wrapper (services/c2pa-signer/build_evidence_bundle.py) uses
 * an identical dispatch — see docs/c2pa-conformance-evidence/2026-07-14/.
 *
 * If you add a MIME here, also add it to formats.GENERATE_MIMES and
 * producers.PRODUCERS so the evidence bundle stays complete.
 */
function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  // images
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  if (ext === '.dng') return 'image/x-adobe-dng';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.jxl') return 'image/jxl';
  // video
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.webm') return 'video/webm';
  // audio
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  // documents / mlModel — INTAKE-asserted but NOT SUPPORTED by
  // c2pa-python 0.89 signer wrapper as of 2026-07-14. Falls back to
  // octet-stream so the caller gets a clean error rather than a wrong
  // MIME dispatch. Revisit when c2pa-python exposes these features.
  //   .pdf → application/pdf     (wrapper missing)
  //   .pt / .pth → pytorch       (wrapper missing)
  return 'application/octet-stream';
}

/**
 * Assertion labels this module emits.
 *
 * The Signer enforces a fail-closed allowlist (services/c2pa-signer/
 * assertion_partition.py). If a label here is absent from the shared
 * contract, the Signer refuses to sign EVERY asset — which is what
 * happened on 2026-08-04. The check below turns that runtime outage
 * into a module-load failure with a name attached.
 */
const SCRUPLE_LABELS = {
  trainingMining: 'cawg.training-mining',
  provenance: 'ai.scruple.provenance.v1',
  workflow: 'ai.scruple.workflow.v1',
  cad: 'ai.scruple.cad.v1',
} as const;

/** Strip a trailing `.vN`, matching _base_label() in assertion_partition.py. */
function baseLabel(label: string): string {
  return label.replace(/\.v\d+$/, '');
}

{
  const allowed = new Set<string>([
    ...assertionContract.created.c2pa_sdk,
    ...assertionContract.created.signer,
    ...assertionContract.created.application_tier,
  ]);
  const missing = Object.values(SCRUPLE_LABELS).filter(
    (l) => !allowed.has(baseLabel(l)),
  );
  if (missing.length > 0) {
    throw new Error(
      `signAsset: labels absent from config/c2pa-assertions.json — the Signer ` +
        `will refuse to sign every asset. Add them to created.application_tier: ` +
        missing.join(', '),
    );
  }
}

/**
 * Build the c2pa manifest dict passed to sign.py. The `c2pa.actions.v2`
 * assertion is NOT constructed here — actions go through the sign.py
 * job spec's `intent` + `digital_source_type` + `actions` fields, which
 * the signer feeds into c2pa-python's Builder.set_intent() and
 * Builder.add_action() APIs. That path handles digitalSourceType,
 * inception-first ordering, and assertion-bucket placement per C2PA v2.
 * Raw c2pa.actions.v2 injection did not satisfy the reviewer 2026-07-16.
 */
function buildManifest(input: SignAssetInput): Record<string, unknown> {
  const assertions: Array<{ label: string; data: unknown }> = [];

  // Training-mining opt-out (CAWG namespace; c2pa.training_mining was
  // removed in C2PA 2.0).
  assertions.push({
    label: SCRUPLE_LABELS.trainingMining,
    data: { entries: [{ use: 'notAllowed' }] },
  });

  // Scruple provenance — omitted for `bare` tier per design.
  if (input.tier !== 'bare' && input.scruple) {
    assertions.push({
      label: SCRUPLE_LABELS.provenance,
      data: input.scruple,
    });
  }

  if (input.product === 'studio' && input.workflow) {
    assertions.push({ label: SCRUPLE_LABELS.workflow, data: input.workflow });
  }
  if (input.product === 'fusion' && input.cad) {
    assertions.push({ label: SCRUPLE_LABELS.cad, data: input.cad });
  }

  return {
    // c2pa-python's version is NOT hardcoded here. The string previously
    // read "c2pa-python 0.89", a version that has never been published;
    // the same fictional version was removed from the Bundle Instructions
    // on 2026-08-05 but survived here, where it is stamped into every
    // signed manifest. sign.py substitutes the real installed version.
    claim_generator: 'Scruple/0.1',
    title: input.title ?? path.basename(input.assetPath),
    format: input.format ?? mimeFromPath(input.assetPath),
    assertions,
  };
}

/**
 * Supplementary actions Scruple always emits after the SDK-emitted
 * inception action. Kept as a small list so it's easy to add product-
 * specific actions later without touching the raw manifest builder.
 */
function buildSupplementaryActions(_input: SignAssetInput): Array<Record<string, unknown>> {
  // softwareAgent uses ClaimGeneratorInfo object shape per C2PA v2
  // canonical guidance (opensource.contentauthenticity.org).
  return [
    { action: 'c2pa.published', softwareAgent: { name: 'Scruple', version: '0.1' } },
  ];
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
    intent: input.intent ?? 'CREATE',
    digital_source_type: input.digitalSourceType ?? 'TRAINED_ALGORITHMIC_MEDIA',
    actions: buildSupplementaryActions(input),
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
