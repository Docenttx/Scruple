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

// Project type — migration 012 consolidated the previous txt2img enum
// into a single 'image' type that covers txt2img/img2img/upscale/etc
// (workflow specifics live in canvas nodes). 'video' is registered now
// but its UI is a placeholder until the video pipeline lands.
export type ProjectType = 'image' | 'video' | 'training';

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
  // Pivot (migration 006)
  execution_backend: string | null;
  execution_attestation: string | null;  // JSON
  storage_pointer: string | null;        // JSON
  // Typed artifacts (migration 014)
  output_kind: 'image' | 'video' | 'checkpoint';
  output_content_type: string | null;
  output_bytes: number | null;
  input_artifacts: string;                // JSON array (InputArtifactRecord[])
  // v2 full-record leaf (migration 016)
  workflow_hash: string | null;           // sha256(canonical(workflowApiJson))
  leaf_scheme: 'v1' | 'v2' | 'v2.2';      // v1=leaf_hash==output_hash, v2=record_hash, v2.2=adds machine_manifest_hash
  // Model fingerprinting (migration 017)
  model_fingerprints: string | null;       // JSON manifest {path: {content_hash, header_hash, ...}}
  model_fingerprints_hash: string | null;  // sha256(canonical(manifest)) — folded into v2 leaf preimage
  // Compute Stage 1 (migration 019)
  compute_machine_id: string | null;       // catalog id from lib/compute/machines.ts; NULL on legacy rows (T4)
  // Canvas v2 (migration 021 / WO-3 + WO-8 + WO-9)
  machine_manifest_hash?: string | null;   // v2.2 — pinned-manifest hash committed to leaf preimage
  workflow_publication?: 'full' | 'hash-only' | 'witness-only'; // WO-9 redaction control (default 'full')
}

// Project-row extension columns added by migration 018. Defined here
// so ProjectRow callers see them at the type level; the existing
// ProjectRow stays back-compat via interface merging below.
export interface ProjectRowLockSignatureExt {
  /** HMAC the witness server returned on the lock event itself
   *  (finalize / checkpoint / chain-lock-*). Distinct from the
   *  per-iteration witness_signature on each leaf. */
  lock_server_signature: string | null;
  /** ISO timestamp the witness server stamped onto the lock event. */
  lock_locked_at_witnessed: string | null;
}
declare module './types' {
  // Augment ProjectRow without rewriting its existing definition.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProjectRow extends ProjectRowLockSignatureExt {}
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

// Subset of training_runs needed for receipt + workspace + fingerprint UI.
// Full row has 50+ kohya/lineage columns we don't read at render time.
export interface TrainingRunRow {
  id: number;
  project_id: number;
  run_sequence: number;
  status: string | null;                  // pending | running | complete | incomplete
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  // Output artifact
  output_filename: string | null;
  output_path: string | null;
  model_hash: string | null;              // = contentHash (full SHA-256 of file bytes)
  header_hash: string | null;             // = structuralHash (SHA-256 of safetensors header)
  header_size: number | null;
  tensor_count: number | null;
  structural_summary: string | null;      // JSON; see StructuralSummary in model-fingerprint.ts
  // Inputs
  base_model_path: string | null;
  dataset_merkle: string | null;
  image_count: number | null;
  caption_count: number | null;
  // Network hyperparameters
  network_dim: number | null;
  network_alpha: number | null;
  // Lineage (Phase 7)
  parent_run_id: number | null;
  lineage_type: 'ROOT' | 'VERSION' | 'BRANCH' | string | null;
  parent_seal: string | null;
  input_witness_id: string | null;
  // Lock state
  is_locked: 0 | 1 | null;
  lock_txid: string | null;
  ipfs_cid: string | null;
  scr_id: string | null;
}
