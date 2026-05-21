// Witness server client. Wraps the live HTTP API at WITNESS_SERVER_URL
// (default http://127.0.0.1:5799). Source of truth for the protocol is
// /opt/scruple-witness/server.js on this host.

const WITNESS_URL = process.env.WITNESS_SERVER_URL || 'http://127.0.0.1:5799';

export interface WitnessIterationInput {
  projectId: string;       // free-form; we use scruple-web project IDs as strings
  projectName?: string;
  runSequence: number;
  contentHash: string;     // SHA-256 of the iteration's leaf content (hex)
  visualHash?: string;
  clientTimestamp?: string;
}

export interface WitnessIterationResult {
  witness_id: string;
  server_timestamp: string;
  signature: string;
  // Whatever else the server returns
  [k: string]: unknown;
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

  async lockProject(projectId: string, merkleRoot?: string): Promise<LockProjectResult> {
    // Pass the canonical (sorted-pair) Merkle root so the witness anchors
    // and derives the SCR-ID from the same root our verifier reproduces.
    return postJson<LockProjectResult>(`/api/lock/${encodeURIComponent(projectId)}`, {
      merkleRoot: merkleRoot ?? null,
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
