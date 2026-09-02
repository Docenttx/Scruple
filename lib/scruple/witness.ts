// Witness server client. Wraps the live HTTP API at WITNESS_SERVER_URL
// (default http://127.0.0.1:5799). Source of truth for the protocol is
// /opt/scruple-witness/server.js on this host.

const WITNESS_URL = process.env.WITNESS_SERVER_URL || 'http://127.0.0.1:5799';

export interface WitnessIterationInput {
  projectId: string;       // free-form; we use scruple-web project IDs as strings
  projectName?: string;
  runSequence: number;
  contentHash: string;     // SHA-256 of the iteration's OUTPUT bytes (hex)
  visualHash?: string;
  clientTimestamp?: string;
  // v2 — fold inputs + workflow into the canonical record so the
  // RVN-anchored Merkle leaf commits the full provenance package.
  inputHash?: string;      // SHA-256 of canonical(provider, prompt, spec, inputs[])
  workflowHash?: string;   // SHA-256 of canonical(workflowApiJson) or omitted
  // Migration 017 — fingerprints of every model file the runner loaded
  // for this run, hashed in-container. Pre-hashed to a single field so
  // the canonical record stays a small flat object; the full manifest
  // is persisted alongside the iteration for the receipt and audit.
  modelFingerprintsHash?: string;
  // v2.2 — pinned manifest of custom-node packs the workflow ran on.
  // Binds the artist's choice of toolchain into the leaf. Server includes
  // it in the canonical record only when present; absent → v2 behavior.
  // See docs/architecture/canvas-v2.md decision 5.
  machineManifestHash?: string;
  // v2.5 (WO-28) — the watermarked-derivative trio. ALL THREE OR NONE;
  // the server 400s a partial set. When present the leaf is promoted to
  // leaf_scheme='v2.5' and the trio joins the preimage.
  //
  // Vocabulary and validation are lib/witness/ingest.ts:45-51 / 219-244,
  // which have carried these three fields since July on the /v1/log
  // surface — the one the lock does not use. Ported, not reinvented.
  //
  //   masterHash                — sha256 of the CLEAN master bytes
  //   watermarkPayloadHex       — the 128-bit payload actually embedded
  //   ingredientMasterLeafHash  — the master's own witness leaf hash
  masterHash?: string;
  watermarkPayloadHex?: string;
  ingredientMasterLeafHash?: string;
}

export interface WitnessIterationResult {
  witness_id: string;
  server_timestamp: string;
  signature: string;
  // v2 fields (absent from pre-v2 servers; treat as optional).
  leaf_hash?: string;       // sha256(canonical(record)) — the Merkled leaf
  prev_record_hash?: string;
  /**
   * Scheme of a MASTER leaf. 'v2.5' — the watermarked-derivative leaf
   * WO-28 added — is deliberately NOT in this union, even though the wire
   * returns it, because this union is assigned straight into
   * `IterationRow.leaf_scheme` (lib/iterations/ingest.ts, app/api/v2/witness)
   * and an iteration row records the scheme of its MASTER, which is never
   * a derivative. Widening it here would push 'v2.5' into a column
   * where it can never legitimately appear.
   *
   * Read the scheme the server actually sent with `wireLeafScheme()`.
   */
  leaf_scheme?: 'v1' | 'v2' | 'v2.2';
  // H-1 — the asymmetric evidence signature. Declared here so reading it
  // is ordinary typed code rather than an `unknown` cast; every field is
  // defined in lib/leaf/registry.yaml on the `response` surface. Null
  // when leaf signing is disabled or the KMS is unreachable, which the
  // witness records rather than failing the event over.
  leaf_signature?: string | null;
  leaf_signer_key_id?: string | null;
  leaf_signature_alg?: string | null;
  /**
   * NOTE THE NAME. The witness server's own COLUMN is
   * `leaf_signer_surrogate` (server.js:234-236, 626); the field on the
   * WIRE is `signer_surrogate` (server.js:661). Reading the column name
   * off a response yields undefined forever, and the index signature
   * below means the compiler will not say so.
   *
   * The registry records this as a rename rather than reconciling it —
   * see lib/leaf/registry.yaml, group registry.witness-leaf.deprecated —
   * because a live wire field is not renamed for tidiness, and
   * `resolveField()` maps either spelling onto the same field.
   */
  signer_surrogate?: boolean;
  independently_verifiable?: boolean;
  // Whatever else the server returns
  [k: string]: unknown;
}

/**
 * The leaf scheme the witness server actually put on the wire, including
 * 'v2.5', which `WitnessIterationResult.leaf_scheme` omits on purpose
 * (see the note there). Returns undefined for a server old enough not to
 * send the field at all.
 */
export function wireLeafScheme(r: WitnessIterationResult): string | undefined {
  const v = (r as { leaf_scheme?: unknown }).leaf_scheme;
  return typeof v === 'string' ? v : undefined;
}

export interface LockProjectResult {
  project_id: string;
  iterations: Array<{
    run_sequence: number;
    content_hash: string;
    witness_id: string;
    server_timestamp: string;
    signature: string;
  }>;
  merkle_root: string;
  server_signature: string;
  locked_at: string;
  // Pivot: witness server now mints on RVN testnet (post-pivot patch).
  scrId?: string | null;
  proofTxId?: string | null;
  proofChain?: string | null;
  mintError?: string | null;
  // Permanence anchors — populated by anchorPermanence on the witness
  // server for both 'basic' (Arweave only) and 'pinned' (IPFS + Arweave).
  lockTier?: 'basic' | 'pinned' | null;
  ipfsCid?: string | null;
  ipfsError?: string | null;
  arweaveTxId?: string | null;
  arweaveError?: string | null;
  [k: string]: unknown;
}

/**
 * Result shape returned by witness server's /api/confirm-and-execute.
 * The witness server's responses differ slightly per action:
 *   finalize/checkpoint → {success, action, projectId, paymentIntentId, lockedAt, note}
 *   chain-lock-*        → {success, action, projectId, scrId, proofTxId, proofChain,
 *                          mintError, lockTier, lockedAt}
 */
export interface ConfirmAndExecuteResult {
  success: boolean;
  action?: string;
  projectId?: string | number;
  paymentIntentId?: string;
  lockedAt?: string;
  note?: string;
  // Lock countersignature — returned for finalize, checkpoint, and the
  // chain-lock-* actions. Signed over {project_id, action, merkle_root,
  // witnessed_count, locked_at} so a checkpoint signature cannot be
  // replayed as a finalize signature.
  serverSignature?: string;
  merkleRoot?: string | null;
  witnessedCount?: number;
  // chain-lock fields
  scrId?: string | null;
  proofTxId?: string | null;
  proofChain?: string | null;
  mintError?: string | null;
  lockTier?: 'basic' | 'pinned';
  ipfsCid?: string | null;
  ipfsError?: string | null;
  arweaveTxId?: string | null;
  arweaveError?: string | null;
  error?: string;
  [k: string]: unknown;
}

export interface VerifyInput {
  project_id: string;
  local_chain?: Array<{ run_sequence: number; content_hash: string }>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WITNESS_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Witness POST ${path} ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${WITNESS_URL}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Witness GET ${path} ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

export const witness = {
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${WITNESS_URL}/health`);
      return res.ok;
    } catch {
      return false;
    }
  },

  async witnessIteration(input: WitnessIterationInput): Promise<WitnessIterationResult> {
    return postJson<WitnessIterationResult>('/api/witness', {
      project_id: input.projectId,
      project_name: input.projectName,
      run_sequence: input.runSequence,
      content_hash: input.contentHash,
      visual_hash: input.visualHash,
      client_timestamp: input.clientTimestamp ?? new Date().toISOString(),
      input_hash: input.inputHash,
      workflow_hash: input.workflowHash,
      model_fingerprints_hash: input.modelFingerprintsHash,
      // v2.2 — pre-v2.2 servers ignore this field harmlessly.
      machine_manifest_hash: input.machineManifestHash,
      // v2.5 — a PRE-WO-28 witness server ignores these three and
      // returns a 'v2' leaf. That is detectable, not silent: the caller
      // checks leaf_scheme === 'v2.5' before it records a derivative
      // leaf, so an un-redeployed witness yields no derivative leaf
      // rather than a leaf that omits the lineage it claims to carry.
      master_hash: input.masterHash,
      watermark_payload_hex: input.watermarkPayloadHex,
      ingredient_master_leaf_hash: input.ingredientMasterLeafHash,
    });
  },

  async listIterations(projectId: string): Promise<{
    project_id: string;
    iterations: Array<{
      witness_id: string;
      run_sequence: number;
      content_hash: string;
      server_timestamp: string;
      signature: string;
    }>;
    count: number;
  }> {
    return getJson(`/api/witness/${encodeURIComponent(projectId)}`);
  },

  async lockProject(
    projectId: string,
    merkleRoot?: string,
    tier: 'basic' | 'pinned' = 'basic',
  ): Promise<LockProjectResult> {
    // Pass the canonical (sorted-pair) Merkle root so the witness anchors
    // and derives the SCR-ID from the same root our verifier reproduces.
    // tier='pinned' tells handleLock to anchor IPFS + Arweave on top of
    // the RVN testnet mint (basic = RVN + Arweave token record only).
    return postJson<LockProjectResult>(`/api/lock/${encodeURIComponent(projectId)}`, {
      merkleRoot: merkleRoot ?? null,
      tier,
    });
  },

  /**
   * Stripe-verified lock execution. Witness server retrieves the
   * PaymentIntent from Stripe, verifies status='succeeded', verifies
   * metadata.action matches, verifies amount matches the expected fee,
   * then executes the lock and (for chain actions) mints the RVN
   * testnet asset.
   *
   * This is the canonical entry point — matches desktop's flow exactly.
   * Never call /api/lock/{projectId} directly from a paid path; it
   * skips Stripe verification.
   */
  async confirmAndExecute(input: {
    action: 'finalize' | 'checkpoint' | 'chain-lock-basic' | 'chain-lock-pinned';
    projectId: string;
    paymentIntentId: string;
    installationId?: string;
    merkleRoot?: string;
    preScrId?: string;
  }): Promise<ConfirmAndExecuteResult> {
    return postJson<ConfirmAndExecuteResult>('/api/confirm-and-execute', {
      paymentIntentId: input.paymentIntentId,
      action: input.action,
      projectId: input.projectId,
      lockTier:
        input.action === 'chain-lock-pinned' ? 'pinned'
        : input.action === 'chain-lock-basic' ? 'basic'
        : null,
      installationId: input.installationId,
      merkleRoot: input.merkleRoot,
      preScrId: input.preScrId,
    });
  },

  async verify(input: VerifyInput): Promise<{
    valid: boolean;
    server_root?: string;
    server_count?: number;
    [k: string]: unknown;
  }> {
    return postJson('/api/verify', input);
  },
};
