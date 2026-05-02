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

  async lockProject(projectId: string): Promise<LockProjectResult> {
    return postJson<LockProjectResult>(`/api/lock/${encodeURIComponent(projectId)}`, {});
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
