// Shared types for Scruple Web. Source of truth for both DB row shapes
// (mirroring lib/db/migrations/001_core.sql) and API/UI contracts.

export type LockState =
  | 'unlocked'
  | 'checkpointed'
  | 'local_locked'
  | 'chain_locked'
  | 'persistent_locked'
  | 'permanent_locked';

export const LOCK_STATE_LABELS: Record<LockState, string> = {
  unlocked: 'Unlocked',
  checkpointed: 'Checkpointed',
  local_locked: 'Finalized',
  chain_locked: 'Chain Locked',
  persistent_locked: 'Persistent Locked',
  permanent_locked: 'Permanent Locked',
};

export type ProjectType = 'txt2img' | 'training';

export type ProviderName = 'fal' | 'comfydeploy' | 'manual';

// ── DB row shapes ──────────────────────────────────────────────────────────

export interface ProjectRow {
  id: number;
  user_id: string;
  name: string;
  type: ProjectType;
  status: LockState;
  created_at: string;
  updated_at: string | null;
  locked_at: string | null;
  iteration_count: number;
  merkle_root: string | null;
  scr_id: string | null;
  pre_scr_id: string | null;
  package_hash: string | null;
  rvn_txid: string | null;
  arweave_uri: string | null;
  ipfs_cid: string | null;
  final_control_index: number | null;
  is_active: 0 | 1;
  witnessed_count: number;
  witness_signature: string | null;
  is_archived: 0 | 1;
  comfy_workflow_id: string | null;
}

export interface IterationRow {
  id: number;
  project_id: number;
  run_sequence: number;
  timestamp: string;
  leaf_hash: string;
  input_hash: string | null;
  output_hash: string | null;
  previous_hash: string | null;
  control_index: number | null;
  metadata: string | null;          // JSON string
  source_file: string | null;       // artifacts/<prefix>/<hash>
  image_filename: string | null;
  prompt: string | null;
  provider: ProviderName | null;
  provider_job_id: string | null;
  witnessed: 0 | 1;
  witness_id: string | null;
  witness_timestamp: string | null;
  witness_signature: string | null;
}

export interface MerkleNodeRow {
  id: number;
  project_id: number;
  level: number;
  position: number;
  hash: string;
  left_child_hash: string | null;
  right_child_hash: string | null;
}

export interface UserRow {
  id: string;
  name: string | null;
  email: string;
  email_verified: string | null;
  image: string | null;
  created_at: string;
  provider_keys: string;            // JSON string
}

// ── Decoded provider keys (after JSON.parse + decrypt) ──────────────────────

export interface ProviderKeys {
  fal?: string;
  comfydeploy?: string;
}

// ── API contracts ──────────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  type: ProjectType;
}

export interface GenerationSpec {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfgScale?: number;
  // Provider-specific extras pass through
  providerExtras?: Record<string, unknown>;
}

export interface GenerationResult {
  jobId: string;
  imageBytes: Buffer;
  contentType: string;
  // Whatever metadata the provider returns; opaque to us
  providerMetadata?: Record<string, unknown>;
}

export interface IngestPayload {
  projectId: number;
  provider: ProviderName;
  providerJobId: string;
  prompt: string;
  generationSpec: GenerationSpec;
  imageBytes: string;               // base64
  imageContentType: string;
  imageFilename?: string;
}

export interface LockPackageManifest {
  version: 1;
  scrupleVersion: string;
  projectId: number;
  projectName: string;
  scrId: string;
  preScr: string | null;
  merkleRoot: string;
  iterations: Array<{
    runSequence: number;
    leafHash: string;
    inputHash: string | null;
    outputHash: string | null;
    timestamp: string;
    witnessId: string | null;
    witnessSignature: string | null;
  }>;
  merkleNodes: Array<{
    level: number;
    position: number;
    hash: string;
    leftChildHash: string | null;
    rightChildHash: string | null;
  }>;
  builtAt: string;
}
