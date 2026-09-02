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
import { mimeFromPath, signRefusalReason } from './formats';

const SIGNER_DIR = path.join(process.cwd(), 'services', 'c2pa-signer');
const SIGNER_SCRIPT = path.join(SIGNER_DIR, 'sign.py');
const KEYS_DIR = path.join(SIGNER_DIR, 'keys');
// The dev cert chain and key.
//
// keys/regen-dev-cert.sh is the script that produces the dev material and
// it emits signer.key (the ES256 private key) and signer.pem (leaf + root
// chain in the order c2pa-rs expects). Those are the names used here and
// in services/c2pa-signer/vault_sign.py, which is the ONE place the local
// key path is resolved.
//
// This constant used to name a different, purged key. That file was real
// — tracked in git, and signing worked out of the box for ten days from
// 50c1873 (07-03) — and 0b6ee43 (07-13) gitignored it and purged it from
// history, so no checkout has had it since. The commit that repaired this
// line said the old name "HAS NEVER EXISTED"; the history rewrite is why
// that looked true. The distinction matters, because it is the difference
// between restoring something and finishing something. The full
// archaeology is in docs/canon/demo-readiness/c2pa-watermark.md §0.
//
// The effect while it was wrong: signAsset() returned {ok:false} at the
// fs.access guard below, BEFORE spawning the signer, for every caller. So
// C2PA signing had two independent breaks, not one. The assertion-allowlist
// mismatch fixed in bff1fd8 was real, and it was the SECOND thing in the
// way — nothing ever reached it, because this guard failed first.
//
// The same purged name survived in three more places until 2026-09-02
// (vault_sign.py's local default and its identity string, sign_leaf.py's
// twice) because each site resolved the path for itself. They now all call
// vault_sign.local_key_path(), which is the only resolver.
//
// Invisible to CI because services/c2pa-signer's suite tested the
// assertion partition and never signed anything; tests.yml says so in
// terms. test/v2/c2pa-reachable.test.ts and
// services/c2pa-signer/tests/test_format_support.py now sign for real.
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
 * IPTC Digital Source Type — required on the inception action per the
 * C2PA v2 spec, and REQUIRED on SignAssetInput. There is no default.
 *
 * There used to be one. `digitalSourceType` fell back to
 * TRAINED_ALGORITHMIC_MEDIA and no plugin path ever overrode it. The
 * plugin market exists to prove an artifact was made WITHOUT generative
 * AI — Fusion, Blender, Meshroom and Toon Boom are CAD / 3D / animation
 * hosts that run no inference — so that fallback wrote the exact
 * opposite claim into a signed, third-party-verifiable manifest. That is
 * a false signed claim, not a wrong-looking field. Latent on Fusion (no
 * CAD MIME is C2PA-signable today), live on Blender, whose PNG and JPEG
 * renders are.
 *
 * The fix is the posture the canon already takes everywhere else —
 * CANON_SKELETON.md §5 property 2 (an unknown modality fails closed),
 * capture()'s refusal without an explicit `mime`
 * (packages/scruple-host-sdk/scruple_host_sdk/capture.py), and the
 * Signer's fail-closed assertion allowlist. The caller wrote the asset
 * and knows how it was made; this module does not guess. A caller that
 * does not declare gets a refusal.
 *
 * Values are c2pa-python C2paDigitalSourceType enum names. The two that
 * matter to Scruple, with the URIs c2pa 0.36.0 actually emits — verified
 * by signing a PNG at each value and reading the manifest back through
 * c2pa.Reader, not by reading the enum:
 *
 *   TRAINED_ALGORITHMIC_MEDIA
 *     http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia
 *     GenAI output. Correct for the canvas / ComfyUI / Modal flow.
 *   DIGITAL_CREATION
 *     http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation
 *     IPTC term "Digital creation": "Media created by a human using
 *     non-generative tools." Correct for every plugin host.
 */
export const C2PA_DIGITAL_SOURCE_TYPES = [
  'TRAINED_ALGORITHMIC_MEDIA',            // GenAI-produced
  'ALGORITHMIC_MEDIA',                    // pure algorithm, no training data
  'ALGORITHMICALLY_ENHANCED',             // input enhanced by algorithm
  'COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA',
  'HUMAN_EDITS',                          // human-in-the-loop editing
  'DIGITAL_CREATION',                     // human, non-generative tools
  'DATA_DRIVEN_MEDIA',                    // data-driven synthesis
  'EMPTY',                                // declines to state — still a declaration
] as const;

export type C2paDigitalSourceType = (typeof C2PA_DIGITAL_SOURCE_TYPES)[number];

/**
 * Runtime twin of the union above. The union is erased at compile time,
 * so a JS caller, an `as any`, or a JSON body could still push an
 * undeclared value through. Derived from the same array so the two
 * cannot drift.
 */
const DIGITAL_SOURCE_TYPE_SET: ReadonlySet<string> = new Set(
  C2PA_DIGITAL_SOURCE_TYPES,
);

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
  /**
   * digitalSourceType on the inception action. REQUIRED — no default,
   * no inference from `product`. See C2paDigitalSourceType above.
   */
  digitalSourceType: C2paDigitalSourceType;
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
  /**
   * Machine-readable reason, so a caller can tell a bad request from a
   * broken signer without matching on prose.
   *
   *   'undeclared_source_type' — no digitalSourceType. 400.
   *   'unsupported_format'     — the MIME has no c2pa-rs handler. 415.
   *   'asset_not_found'        — 400.
   *   'signer_material_missing'— the box has no cert/key. 500, ours.
   *   undefined                — the signer failed. 500.
   */
  code?:
    | 'undeclared_source_type'
    | 'unsupported_format'
    | 'asset_not_found'
    | 'signer_material_missing';
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
  // digitalSourceType is checked FIRST — before the asset even has to
  // exist. An undeclared source type is not a missing convenience; it
  // is the caller declining to say whether generative AI was involved,
  // and the only honest thing to emit in that case is nothing.
  if (
    typeof input.digitalSourceType !== 'string' ||
    !DIGITAL_SOURCE_TYPE_SET.has(input.digitalSourceType)
  ) {
    return {
      ok: false,
      code: 'undeclared_source_type',
      error:
        `signAsset() requires an explicit digitalSourceType and will not ` +
        `guess one. There is no default: a default of ` +
        `TRAINED_ALGORITHMIC_MEDIA signs a claim that generative AI made ` +
        `this asset, which is the opposite of what the plugin hosts exist ` +
        `to prove. Declare TRAINED_ALGORITHMIC_MEDIA for GenAI output, ` +
        `DIGITAL_CREATION for a human working in a non-generative tool ` +
        `(CAD, 3D, animation). Got: ${JSON.stringify(input.digitalSourceType)}. ` +
        `Valid: ${C2PA_DIGITAL_SOURCE_TYPES.join(', ')}.`,
    };
  }

  // The format is settled BEFORE the subprocess, for the same reason
  // digitalSourceType is: a format c2pa-rs has no handler for is not a
  // signing failure to be reported as a 500, it is a question with a
  // known answer. A .webm from a txt2vid flow used to reach c2pa-rs and
  // come back as "Builder does not support video/webm" wrapped in a 500;
  // the caller could not distinguish that from the signer being down.
  //
  // lib/c2pa/formats.ts is the list, services/c2pa-signer/formats.py is
  // its emitting twin, and sign.py re-checks at the far end so a second
  // caller of the subprocess cannot route around this.
  const format = input.format ?? mimeFromPath(input.assetPath);
  const refusal = signRefusalReason(format);
  if (refusal) {
    return {
      ok: false,
      code: 'unsupported_format',
      error:
        `${refusal} Declared/derived format for ${path.basename(input.assetPath)}: ` +
        `${format}.`,
    };
  }

  try {
    await fs.access(input.assetPath);
  } catch {
    return { ok: false, code: 'asset_not_found', error: `asset not found: ${input.assetPath}` };
  }

  // Ensure the signing material is on disk. It is NOT committed — both
  // signer.key and signer.pem are gitignored — so a fresh clone has
  // neither and this guard is the only thing between that and a c2pa-rs
  // exception. It is also, for seven weeks, the guard that fired for
  // every caller because DEV_KEY named a purged file.
  try {
    await Promise.all([fs.access(DEV_CERT), fs.access(DEV_KEY)]);
  } catch {
    return {
      ok: false,
      code: 'signer_material_missing',
      error:
        'signer cert/key missing at services/c2pa-signer/keys/. Both are ' +
        'gitignored, so a fresh clone has neither: run ' +
        'services/c2pa-signer/keys/regen-dev-cert.sh to produce signer.key ' +
        'and signer.pem, or set SCRUPLE_C2PA_CERT / SCRUPLE_C2PA_KEY.',
    };
  }

  const job = {
    asset_path: input.assetPath,
    output_path: input.outputPath,
    cert_path: process.env.SCRUPLE_C2PA_CERT ?? DEV_CERT,
    key_path: process.env.SCRUPLE_C2PA_KEY ?? DEV_KEY,
    manifest: buildManifest({ ...input, format }),
    intent: input.intent ?? 'CREATE',
    // No `??` fallback here, and none in sign.py either. Both ends
    // refuse rather than guess.
    digital_source_type: input.digitalSourceType,
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
