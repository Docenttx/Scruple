// Shared iteration ingest.
//
// Pivot version (Phase S8): write artifact bytes to the user's chosen
// storage provider (Drive / OneDrive / GitHub) instead of the local
// `artifacts/` filesystem. Scruple-web records only the leaf_hash + the
// storage_pointer + chain metadata. Local copy is purged shortly after
// upload by the retention sweeper.
//
// Backward-compat: if no provider is connected, falls back to the
// existing local-FS path (lib/scruple/artifacts.storeArtifact). This
// keeps the lock pipeline + dev mode workable while users decide on a
// storage backend.

import { conn } from '@/lib/db/sqlite';
import { sha256Hex } from '@/lib/scruple/hash';
import { hashWorkflow } from '@/lib/scruple/canonicalWorkflow';
import { storeArtifact } from '@/lib/scruple/artifacts';
import { logTelemetry, estimateCostCents } from '@/lib/telemetry/log';
import { getActiveProvider } from '@/lib/storage/dispatch';
import { witness } from '@/lib/scruple/witness';
import { getDefaultPublicationMode } from '@/lib/settings/user';
import type {
  GenerationSpec,
  IterationRow,
  ProviderName,
} from '@/lib/types';
import type { StoragePointer } from '@/lib/storage/types';

export type OutputKind = 'image' | 'video' | 'checkpoint' | 'cad';

export type InputArtifactKind =
  | 'init_image'
  | 'control_image'
  | 'source_image'
  | 'training_image'
  | 'base_checkpoint'
  | 'other';

/** An input that fed a run — hashed + stored alongside the output. */
export interface IngestInputArtifact {
  kind: InputArtifactKind;
  bytes: Buffer;
  filename?: string | null;
  contentType: string;
}

/** Manifest entry persisted in iterations.input_artifacts (JSON). */
export interface InputArtifactRecord {
  kind: InputArtifactKind;
  hash: string;
  filename: string | null;
  content_type: string;
  bytes: number;
  storage_pointer: StoragePointer | null;
}

export interface IngestParams {
  userId: string;
  projectId: number;
  provider: ProviderName;
  providerJobId: string;
  prompt: string;
  spec: GenerationSpec;
  /** The output artifact bytes (image/video/checkpoint). */
  imageBytes: Buffer;
  /** Output mime/type, e.g. image/png, video/mp4, application/octet-stream. */
  imageContentType: string;
  imageFilename?: string | null;
  /** What the output IS. Defaults to 'image' (txt2img backward-compat). */
  outputKind?: OutputKind;
  /** Inputs that fed this run — reference images, training sets, base ckpt. */
  inputs?: IngestInputArtifact[];
  /** Backend that ran this generation (Pivot — set by /api/generate). */
  executionBackend?: 'modal-tee' | 'modal-test' | 'comfydeploy' | 'local-tunnel' | null;
  /** TEE attestation receipt, if available. */
  executionAttestation?: Record<string, unknown> | null;
  /** In-container fingerprints of every model file loaded by the workflow.
   *  Keyed by volume-relative path. Folded into the v2 canonical record
   *  (as `model_fingerprints_hash = sha256(canonical(...))`) so the
   *  on-chain anchor commits the exact weights that produced this run —
   *  not just the filename string the workflow asked for. */
  modelFingerprints?: Record<string, {
    content_hash?: string | null;
    header_hash?: string | null;
    header_size?: number | null;
    bytes?: number;
    mtime?: number;
  }>;
  /** Compute machine catalog id (`lib/compute/machines.ts`) that ran
   *  this iteration. NULL for legacy rows (which always ran on T4
   *  via the pre-Stage-1 single Modal endpoint). */
  computeMachineId?: string | null;
  /** Per-user machine manifest hash (v2.2 leaf preimage component).
   *  Resolved from canvas_sessions.machine_id → machines.manifest_hash
   *  by the caller. NULL for /api/generate path (per-request runner has
   *  no user-customizable manifest yet). */
  machineManifestHash?: string | null;
  /** WO-B1 — sha256 of the CONTAINER's actual machine manifest, computed
   *  by the runner from the file system it ran on (real commit_shas +
   *  content_hashes per pack, not the declarative descriptor). When
   *  present, preferred over the DB-lookup default because it pins what
   *  the runner ACTUALLY had, not what the descriptor claimed. */
  containerMachineManifestHash?: string | null;
  /** WO-B1 — the RAW manifest object the runner enumerated. Persisted
   *  on iterations.container_machine_manifest for trust-label rendering
   *  (WO-B2) and human inspection. NOT part of any signed preimage. */
  containerMachineManifest?: Record<string, unknown> | null;
}

export interface IngestResult {
  iteration: IterationRow;
  leafHash: string;
  runSequence: number;
  storagePointer: StoragePointer | null;
  inputArtifacts: InputArtifactRecord[];
  /**
   * Whether the witness server actually witnessed this iteration.
   *
   * Capture is deliberately non-blocking: if the witness server is
   * unreachable the iteration still lands, with leaf_scheme='v1' and
   * witnessed=0. That is a design choice, not a bug. What WAS a bug is
   * that the result said nothing about it, so every caller reported
   * success identically either way — and Standard §5 makes compliance
   * binary. Callers must surface a false here rather than imply a
   * witness that never happened.
   */
  witnessed: boolean;
  /** 'v1' means the witness server was unreachable and leafHash is the raw output hash. */
  leafScheme: 'v1' | 'v2' | 'v2.2';
}

/** File extension for an output/input by kind + content-type. */
function extFor(kind: OutputKind | 'input', contentType: string): string {
  if (kind === 'video') return contentType.includes('webm') ? 'webm' : 'mp4';
  if (kind === 'checkpoint') return 'safetensors';
  if (kind === 'cad') return 'f3d';
  if (contentType.includes('jpeg')) return 'jpg';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('mp4')) return 'mp4';
  if (contentType.includes('octet-stream')) return 'safetensors';
  return 'png';
}

export async function ingestIteration(p: IngestParams): Promise<IngestResult> {
  const outputKind: OutputKind = p.outputKind ?? 'image';
  const outputHash = sha256Hex(p.imageBytes);
  // leafHash is *not* outputHash anymore in v2 — the witness server
  // computes leaf_hash = sha256(canonical(record)), where record commits
  // to inputs, workflow, order, and time too. We fill leafHash in after
  // the witness call below; if the witness is unreachable we fall back to
  // v1 semantics (leafHash = outputHash, leaf_scheme='v1', witnessed=0).
  const provider = getActiveProvider(p.userId);

  // ── Inputs: hash + store + (optionally) upload each, build manifest ──
  // Every input that fed the run is content-addressed the same way the
  // output is — this is what makes input provenance verifiable. For LoRA
  // training the whole image SET arrives here as many training_image
  // entries; for img2img/upscale a single init/source image.
  const inputArtifacts: InputArtifactRecord[] = [];
  for (const inp of p.inputs ?? []) {
    const hash = sha256Hex(inp.bytes);
    storeArtifact(hash, inp.bytes);
    let pointer: StoragePointer | null = null;
    if (provider) {
      const ext = extFor('input', inp.contentType);
      try {
        const up = await provider.uploadFile(
          p.userId,
          `inputs/${hash.slice(0, 12)}.${ext}`,
          inp.bytes,
          inp.contentType,
        );
        pointer = up.pointer;
      } catch (e) {
        console.error('[ingest] input upload failed, kept local FS only', e);
      }
    }
    inputArtifacts.push({
      kind: inp.kind,
      hash,
      filename: inp.filename ?? null,
      content_type: inp.contentType,
      bytes: inp.bytes.length,
      storage_pointer: pointer,
    });
  }

  // input_hash binds the run's inputs: the request canonical + every input
  // artifact hash. Re-deriving it later proves the inputs are unchanged.
  const inputCanonical = JSON.stringify({
    provider: p.provider,
    prompt: p.prompt,
    spec: p.spec,
    inputs: inputArtifacts.map((a) => ({ kind: a.kind, hash: a.hash })),
  });
  const inputHash = sha256Hex(inputCanonical);

  // workflow_hash binds the ComfyUI graph that produced the output. Sync
  // executeRun puts it under spec.providerExtras.workflowApiJson; async
  // pollRunJob does the same after T4. NULL when the path has no workflow.
  //
  // MUST use canonical (sorted-key, whitespace-free) JSON — not default
  // JSON.stringify — so any auditor with the same workflow JSON reproduces
  // the same hash regardless of key insertion order in their serializer.
  let workflowHash: string | null = null;
  const wf = (p.spec as unknown as { providerExtras?: { workflowApiJson?: unknown } })?.providerExtras?.workflowApiJson;
  if (wf) workflowHash = hashWorkflow(wf);

  // model_fingerprints_hash binds the actual weights loaded for this run.
  // Canonicalize the manifest (keys sorted ascending) so the hash is
  // reproducible by any verifier with the same manifest. NULL → ''  so the
  // canonical record always has a stable shape.
  let modelFingerprintsHash: string | null = null;
  let modelFingerprintsJson: string | null = null;
  if (p.modelFingerprints && Object.keys(p.modelFingerprints).length > 0) {
    const sortedKeys = Object.keys(p.modelFingerprints).sort();
    const canonical: Record<string, unknown> = {};
    for (const k of sortedKeys) canonical[k] = p.modelFingerprints[k];
    modelFingerprintsJson = JSON.stringify(canonical);
    modelFingerprintsHash = sha256Hex(modelFingerprintsJson);
  }

  // Pivot S8: write output to user's storage. Falls back to local FS if no
  // provider is connected (dev / pre-onboarding state). Storage paths are
  // keyed by OUTPUT hash (content-addressed by the actual bytes), NOT by
  // leaf_hash — leaf_hash is the Merkle leaf identity (record_hash for v2)
  // and is not the address of any stored byte stream.
  let storagePointer: StoragePointer | null = null;
  if (provider) {
    const ext = extFor(outputKind, p.imageContentType);
    const path = `iterations/${outputHash.slice(0, 12)}.${ext}`;
    try {
      const { pointer } = await provider.uploadFile(
        p.userId,
        path,
        p.imageBytes,
        p.imageContentType,
      );
      storagePointer = pointer;
    } catch (e) {
      console.error('[ingest] storage upload failed, falling back to local FS', e);
    }
  }
  // Always keep a local copy short-term — the iteration grid serves
  // from /api/artifact/[hash] which hits this. Retention sweeper purges
  // these after the storage upload is confirmed (Pivot S12).
  storeArtifact(outputHash, p.imageBytes);

  // ── Witness BEFORE insert so the v2 record-hash leaf lands directly ──
  // Allocate the run_sequence outside the tx so we can witness with it.
  // (Single-writer-per-project is the implicit assumption everywhere else;
  // a uniqueness violation would surface as an INSERT failure below.)
  const next = (conn()
    .prepare(`SELECT COALESCE(MAX(run_sequence), 0) + 1 AS n FROM iterations WHERE project_id = ?`)
    .get(p.projectId) as { n: number }).n;
  const projectRow = conn()
    .prepare(`SELECT name FROM projects WHERE id = ?`)
    .get(p.projectId) as { name?: string } | undefined;

  // v2.2 — machine_manifest_hash resolution ladder (most trusted first):
  //  1. containerMachineManifestHash (WO-B1) — computed by the runner
  //     from actual on-disk pack commit_shas + content hashes. This IS
  //     what ran; strongly preferred.
  //  2. machineManifestHash explicitly passed by the caller (e.g. the
  //     canvas-proxy path resolves the per-user Machine row).
  //  3. DB-lookup default — the user's most recent ready machine
  //     (falls back to shared default).
  let machineManifestHash =
    p.containerMachineManifestHash ??
    p.machineManifestHash ??
    null;
  if (machineManifestHash === null) {
    const mrow = conn()
      .prepare(
        `SELECT manifest_hash FROM machines
          WHERE (user_id = ? OR user_id IS NULL)
            AND archived_at IS NULL
          ORDER BY user_id IS NULL ASC, created_at DESC LIMIT 1`,
      )
      .get(p.userId) as { manifest_hash: string } | undefined;
    machineManifestHash = mrow?.manifest_hash ?? null;
  }

  // Auto-witness every ingested iteration. Per [[D-002]] this IS the
  // provenance; lock-time Merkle/anchoring builds on the per-iteration
  // witnesses. For v2 the server returns leaf_hash = sha256(canonical
  // record) — that's what gets Merkled, so the RVN-anchored root commits
  // inputs + workflow + order + time, not just the output. Degradable: if
  // the witness server is unreachable, the iteration still lands with
  // leaf_scheme='v1' (leaf_hash = output_hash) and witnessed=0 so the
  // capture path doesn't block on witness-server health.
  let witnessResult: Awaited<ReturnType<typeof witness.witnessIteration>> | null = null;
  try {
    witnessResult = await witness.witnessIteration({
      projectId: String(p.projectId),
      projectName: projectRow?.name ?? `project-${p.projectId}`,
      runSequence: next,
      contentHash: outputHash,
      inputHash,
      workflowHash: workflowHash ?? undefined,
      modelFingerprintsHash: modelFingerprintsHash ?? undefined,
      machineManifestHash: machineManifestHash ?? undefined,
    });
  } catch (e) {
    console.error('[ingest] auto-witness failed (iteration will land with witnessed=0):', e);
  }

  const leafHash = witnessResult?.leaf_hash ?? outputHash;
  const leafScheme: 'v1' | 'v2' | 'v2.2' = witnessResult?.leaf_scheme ?? 'v1';

  const now = new Date().toISOString();
  const tx = conn().transaction(() => {
    const previousHash = (conn()
      .prepare(
        `SELECT leaf_hash FROM iterations WHERE project_id = ? ORDER BY run_sequence DESC LIMIT 1`,
      )
      .get(p.projectId) as { leaf_hash: string } | undefined)?.leaf_hash ?? null;

    const result = conn()
      .prepare(
        `INSERT INTO iterations (
           project_id, run_sequence, timestamp, leaf_hash, input_hash, output_hash,
           previous_hash, metadata, source_file, image_filename, prompt, provider, provider_job_id,
           execution_backend, execution_attestation, storage_pointer,
           output_kind, output_content_type, output_bytes, input_artifacts,
           workflow_hash, leaf_scheme,
           model_fingerprints, model_fingerprints_hash,
           witnessed, witness_id, witness_timestamp, witness_signature,
           compute_machine_id, machine_manifest_hash, workflow_publication,
           container_machine_manifest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.projectId,
        next,
        now,
        leafHash,
        inputHash,
        outputHash,
        previousHash,
        JSON.stringify({ generationSpec: p.spec, contentType: p.imageContentType }),
        outputHash,
        p.imageFilename ?? null,
        p.prompt,
        p.provider,
        p.providerJobId,
        p.executionBackend ?? null,
        p.executionAttestation ? JSON.stringify(p.executionAttestation) : null,
        storagePointer ? JSON.stringify(storagePointer) : null,
        outputKind,
        p.imageContentType,
        p.imageBytes.length,
        JSON.stringify(inputArtifacts),
        workflowHash,
        leafScheme,
        modelFingerprintsJson,
        modelFingerprintsHash,
        witnessResult ? 1 : 0,
        witnessResult?.witness_id ?? null,
        witnessResult?.server_timestamp ?? null,
        witnessResult?.signature ?? null,
        p.computeMachineId ?? null,
        machineManifestHash,
        getDefaultPublicationMode(p.userId),
        p.containerMachineManifest ? JSON.stringify(p.containerMachineManifest) : null,
      );

    conn()
      .prepare(`UPDATE projects SET iteration_count = iteration_count + 1, updated_at = ? WHERE id = ?`)
      .run(now, p.projectId);

    if (witnessResult) {
      conn()
        .prepare(`UPDATE projects SET witnessed_count = witnessed_count + 1 WHERE id = ?`)
        .run(p.projectId);
    }

    return { id: result.lastInsertRowid as number, runSequence: next };
  });

  const { id, runSequence } = tx();

  const iteration = conn()
    .prepare(`SELECT * FROM iterations WHERE id = ?`)
    .get(id) as IterationRow;

  try {
    logTelemetry({
      userId: p.userId,
      projectId: p.projectId,
      iterationId: id,
      provider: p.provider,
      providerJobId: p.providerJobId,
      prompt: p.prompt,
      spec: p.spec as unknown as Record<string, unknown>,
      costCents: estimateCostCents(p.provider),
      success: true,
    });
  } catch (e) {
    console.error('[telemetry] insert failed', e);
  }

  return {
    iteration,
    leafHash,
    runSequence,
    storagePointer,
    inputArtifacts,
    witnessed: witnessResult !== null,
    leafScheme,
  };
}
