// Compute backend abstraction (Pivot polish — formalizes what was
// implicit in /api/generate).
//
// A ComputeBackend takes a workflow_api_json + a context and returns
// the result of running it on a GPU. Today there's two implementations:
//   - modalRunner  (lib/compute/modal.ts) — Scruple-managed Modal app
//   - comfyDeploy  (lib/providers/comfydeploy.ts) — BYO ComfyDeploy
//
// Future implementations the interface anticipates:
//   - modalRunnerCold     (free tier; scaledown=10s)
//   - modalRunnerWarm     (pro tier; scaledown=600s) — current default
//   - modalRunnerAttested (premium; H100 CC mode)
//   - modalRunnerByo      (BYO Modal — user's own workspace + tokens)
//   - localTunnel         (Scruple Agent on user's GPU — far future)

export type TrustTier = 'L1+L2' | 'L1+L2+L3' | 'L1.5';
//   L1   — capture isolation (server-side hashing)
//   L2   — witness chain
//   L3   — hardware-attested execution (TEE)
//   L1.5 — chain isolation but execution on user-controlled hardware
//          (the local-tunnel case)

export interface ComputeContext {
  /** Caller-owned identifier for the run. Surfaces in telemetry. */
  callerJobId?: string;
  /** When relevant: which user is this run for. */
  userId?: string;
  /** For BYO Modal: override the endpoint URL on a per-call basis. */
  endpointUrl?: string;
}

export interface ComputeResult {
  ok: boolean;
  /** Backend-native job id (Modal prompt_id, ComfyDeploy run_id, etc.). */
  jobId: string;
  imageBytes: Buffer;
  contentType: string;
  durationMs: number;
  /** Hardware attestation payload when the backend is TEE-attested.
   *  Null when the backend doesn't issue one. */
  attestation: Record<string, unknown> | null;
  /** Backend-native GPU label, e.g. "T4", "A100", "H100-CC". */
  gpu: string;
  /** What the output IS — defaults to 'image' when the backend omits it. */
  outputKind?: 'image' | 'video' | 'checkpoint';
  /** Runner-side output filename (its extension informs content type). */
  outputFilename?: string;
  /** In-container fingerprints of every model file loaded by the workflow.
   *  Keyed by volume-relative path (e.g.
   *  'checkpoints/v1-5-pruned-emaonly.safetensors'); each entry carries
   *  the full-file sha256 (content_hash), safetensors header sha256
   *  (header_hash), header_size, and total bytes. Folded into the v2
   *  canonical record so the on-chain anchor commits the actual weights
   *  that produced this run — not just the filename the workflow asked for. */
  modelFingerprints?: Record<string, {
    content_hash?: string | null;
    header_hash?: string | null;
    header_size?: number | null;
    bytes?: number;
    mtime?: number;
  }>;
  /** WO-B1 — sha256 hex of the CONTAINER-side machine manifest (comfyui
   *  version + custom-node pack commit_shas + pack content hashes). When
   *  present, ingest.ts prefers this over the DB-lookup default so the
   *  leaf's machine_manifest_hash pins what the runner actually had, not
   *  the descriptor's declared refs. Null when the backend can't resolve it. */
  containerMachineManifestHash?: string | null;
  /** WO-B1 — the raw manifest object the runner enumerated. Persisted on
   *  iterations for trust-label rendering (WO-B2) and human inspection.
   *  NOT part of any signed preimage — the hash above is what's signed. */
  containerMachineManifest?: Record<string, unknown> | null;
  /** WO-69 — the exact JSON string the runner hashed. Persist this rather
   *  than re-serializing the object: JSON.stringify and Python's json.dumps
   *  agree only for documents with no floats and no non-ASCII. */
  containerMachineManifestCanonical?: string | null;
  /** Populated when ok=false. */
  rawError?: string;
}

export interface ComputeBackend {
  /** Short identifier used in telemetry + `iterations.execution_backend`. */
  readonly name: string;
  /** Stable trust tier the receipt should claim for runs through this backend. */
  readonly trustTier: TrustTier;
  /** Whether the backend has the configuration it needs to be called.
   *  Returns false → callers should pick a fallback or surface a clear error. */
  isConfigured(ctx?: ComputeContext): boolean;
  /** Submit a workflow_api_json and return the result. Synchronous from
   *  the caller's POV (the backend handles polling). */
  runWorkflow(
    workflowApiJson: Record<string, unknown>,
    ctx?: ComputeContext,
    /** Optional input files placed in the runner's input dir before run. */
    inputs?: Array<{ filename: string; bytes_b64: string }>,
  ): Promise<ComputeResult>;
}

export class ComputeError extends Error {
  constructor(
    public readonly backendName: string,
    public readonly code: 'no_endpoint' | 'auth' | 'transport' | 'remote_error' | 'invalid_input',
    message: string,
  ) {
    super(`[compute:${backendName}:${code}] ${message}`);
  }
}
