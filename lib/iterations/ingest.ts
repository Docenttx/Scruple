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
// WO-1 — the three derived hashes moved to lib/leaf/hashes.ts so that
// /api/v2/witness computes the SAME preimage rather than a second one
// that merely resembles it. The formulas are byte-identical to what was
// inline here; the module header says why they must not be tidied.
import {
  hashModelFingerprints,
  hashRunInputs,
  hashWorkflow,
} from '@/lib/leaf/hashes';
import { storeArtifact, artifactPath } from '@/lib/scruple/artifacts';
// WO-27 — the COMPONENT's loader table, called, not copied. Same rule the
// canvas correlator (lib/canvas/correlate.ts) states in its header: the
// decision logic is imported so canvas, the sidecar and ingest agree on what
// an input-loading node is by construction rather than by review.
import { referencedInputNames } from '../../services/scruple-capture/src/correlation';
import { signIngestedArtifact, type C2paIngestOutcome } from '@/lib/iterations/signOnIngest';
// WO-25 — the SHARED seal check, not a second one.
//
// docs/canon/INTEGRATION_LIFECYCLE.md §10 item 6 recorded the gap this
// closes: canvas ingests here rather than through POST /api/v2/witness, so
// every leaf this module wrote carried `seal_state = NULL` — honest ("the
// question was never asked") and not an answer. `checkDeploymentSeal()` is
// the function the /v2 route already calls; importing it rather than
// reimplementing the fold is the whole of STUDIO_IS_AN_EXEMPLAR.md's rule
// applied here: Studio consumes, it does not donate.
import { checkDeploymentSeal, type SealStamp } from '@/lib/seal/registry';
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
  /**
   * WO-25 — WHICH REGISTERED DEPLOYMENT PRODUCED THIS LEAF, and which
   * tenant owns it.
   *
   * Optional, and its absence is a FACT rather than a default: a caller
   * that names no deployment gets `undeclared`, which migration 046
   * coined for exactly this population ("canvas and the plugins carry no
   * component and no deployment"). `unregistered` — something was said
   * and we do not recognise it — stays a different word for a different
   * event, and neither is `NULL`, which now means only "written before
   * the question existed".
   *
   * The pair is supplied by the caller and never read from a request.
   * `/api/v2/witness` takes the deployment id off the wire and must check
   * it against the calling tenant, because otherwise a tenant could stamp
   * their leaves with somebody else's `sealed`. Here the owner is a
   * server-side constant (lib/canvas/deployment.ts) precisely so that no
   * request can name one.
   */
  deployment?: { deploymentId: string; tenantId: string } | null;
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
  /**
   * WO-25 — the seal state this leaf was written under, as of its own
   * timestamp, and the `seal_ref` only when that state is `sealed`.
   *
   * Returned rather than merely persisted for `witnessed`'s reason, which
   * this file already states one field up: a result that says nothing
   * about it lets every caller report success identically. Canvas's
   * capture row and the proxy's response header are downstream of this.
   */
  seal: SealStamp;
  /**
   * WO-27 — input_hash, and whether it DECLINED.
   *
   * `inputHash === null` with `unboundInputs` non-empty is the honest
   * "the graph loaded something whose bytes never reached us"; `null`
   * with an empty list is a surface that never had a workflow at all.
   * Returned for `witnessed`'s reason: a result that says nothing about
   * it lets every caller report success identically.
   */
  inputHash: string | null;
  /** Names the graph loaded that no supplied input artifact accounts for. */
  unboundInputs: string[];
  /** WO-27 — what the C2PA signer did, if it was asked at all. */
  c2pa: C2paIngestOutcome;
}

/**
 * File extension for an output/input by kind + content-type.
 *
 * WO-27. The old version had two separate ways to be wrong about video and
 * both were reachable from the same door:
 *
 *   - `kind === 'video'` collapsed everything that was not webm to `.mp4`,
 *     so a `video/quicktime` clip was stored as `.mp4`.
 *   - the image tail knew `mp4` but not `webm`, `quicktime` or `gif`, so a
 *     `video/webm` that arrived with `outputKind` UNPASSED — which is every
 *     `/api/generate` run, see the route — fell through to `.png`. A WebM
 *     named `.png` is the artifact the demo-readiness survey found.
 *
 * The fix for the second is the pass-through in the routes; the fix for BOTH
 * is that the extension now comes from the declared content type first, via
 * a table, and the kind only decides the fallback when the type says nothing.
 */
const EXT_BY_CONTENT_TYPE: ReadonlyArray<[RegExp, string]> = [
  [/webm/, 'webm'],
  [/quicktime|\bmov\b/, 'mov'],
  [/mp4|m4v/, 'mp4'],
  [/matroska/, 'mkv'],
  [/gif/, 'gif'],
  [/apng/, 'apng'],
  [/jpeg|jpg/, 'jpg'],
  [/webp/, 'webp'],
  [/png/, 'png'],
  [/tiff/, 'tif'],
  [/avif/, 'avif'],
  [/svg/, 'svg'],
  [/flac/, 'flac'],
];

/** Fallback when the content type declares nothing usable. */
const EXT_BY_KIND: Readonly<Record<OutputKind | 'input', string>> = Object.freeze({
  image: 'png',
  video: 'mp4',
  checkpoint: 'safetensors',
  cad: 'f3d',
  input: 'png',
});

export function extFor(kind: OutputKind | 'input', contentType: string): string {
  const ct = (contentType || '').toLowerCase();
  for (const [re, ext] of EXT_BY_CONTENT_TYPE) if (re.test(ct)) return ext;
  // application/octet-stream carries no type. A checkpoint says so by kind;
  // anything else keeps the kind's fallback rather than being called a model.
  if (ct.includes('octet-stream') && (kind === 'checkpoint' || kind === 'input')) {
    return 'safetensors';
  }
  return EXT_BY_KIND[kind] ?? 'bin';
}

/** ComfyUI writes and reads inputs under a bare name, but a graph may carry
 *  a subfolder (`clipspace/x.png`). Compare on the last segment. */
function basenameOf(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] ?? name;
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

  // workflow_hash binds the ComfyUI graph that produced the output. Sync
  // executeRun puts it under spec.providerExtras.workflowApiJson; async
  // pollRunJob does the same after T4. NULL when the path has no workflow.
  //
  // MUST use canonical (sorted-key, whitespace-free) JSON — not default
  // JSON.stringify — so any auditor with the same workflow JSON reproduces
  // the same hash regardless of key insertion order in their serializer.
  //
  // Resolved BEFORE input_hash because the graph is what says whether this
  // run had inputs at all — see the binding check immediately below.
  let workflowHash: string | null = null;
  const wf = (p.spec as unknown as { providerExtras?: { workflowApiJson?: unknown } })?.providerExtras?.workflowApiJson;
  if (wf) workflowHash = hashWorkflow(wf);

  // ── input_hash: BIND IT, OR DECLINE. NEVER ASSERT AN EMPTY SET ────────
  //
  // WO-27. `hashRunInputs` is always non-null: given no inputs it hashes
  // `{..., inputs: []}`, which is an AFFIRMATIVE claim — "we enumerated the
  // inputs and there were none." Three of the four generation doors signed
  // exactly that on every img2vid run that definitely had an input frame.
  //
  // The component's own correlator already states the rule this path broke,
  // in services/scruple-capture/src/correlation.ts inputHashFor():
  //
  //   "NULL RATHER THAN THE HASH OF `[]` … asserting that about a workflow
  //    whose LoadImage points at a file the tenant put there by hand is a
  //    false statement in a signed record."
  //
  // WHAT IS *NOT* DONE HERE, and it matters. `hashRunInputs` is a PREIMAGE
  // and is left byte-identical: making it return null for an empty list
  // would turn every existing txt2img leaf's input_hash into NULL, and a
  // txt2img run genuinely HAS no input artifacts — `inputs: []` is true of
  // it. The decline is therefore decided from the GRAPH, not from the list:
  //
  //   graph references no input artifact      → hash. A true empty set.
  //   graph references names, all bound       → hash. A true bound set.
  //   graph references a name we never saw    → NULL. We do not know.
  //
  // An absent input and an empty input list are now different leaves, which
  // is the whole point.
  const referencedInputs = wf ? referencedInputNames(wf) : [];
  const boundNames = new Set(
    inputArtifacts
      .map((a) => (a.filename ? basenameOf(a.filename) : null))
      .filter((n): n is string => n !== null),
  );
  const unboundInputs = referencedInputs.filter((n) => !boundNames.has(basenameOf(n)));
  const inputHash =
    unboundInputs.length > 0
      ? null
      : hashRunInputs({
          provider: p.provider,
          prompt: p.prompt,
          spec: p.spec,
          inputs: inputArtifacts.map((a) => ({ kind: a.kind, hash: a.hash })),
        });

  // model_fingerprints_hash binds the actual weights loaded for this run.
  // Canonicalize the manifest (keys sorted ascending) so the hash is
  // reproducible by any verifier with the same manifest. NULL → ''  so the
  // canonical record always has a stable shape.
  const fingerprints = hashModelFingerprints(p.modelFingerprints);
  const modelFingerprintsHash: string | null = fingerprints?.hash ?? null;
  const modelFingerprintsJson: string | null = fingerprints?.json ?? null;

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
      // `?? undefined` and not `?? outputHash` or `?? ''`: a declined
      // input_hash is ABSENT from the witnessed record, which is what
      // `null` in the column means too. Sending an empty string would put
      // a value in the preimage that asserts something.
      inputHash: inputHash ?? undefined,
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

  // ── WO-25: the seal stamp, resolved AS OF THIS LEAF'S OWN INSTANT ──
  //
  // `now` and not `Date.now()` at read time, for 045's reason carried into
  // 046: a seal issued later does not retro-bless this leaf and a reseal
  // later does not retro-condemn it. The fold takes the instant as an
  // argument precisely so that a historical leaf keeps verifying across a
  // reseal.
  //
  // `checkDeploymentSeal` never throws and never rejects — refusing an
  // ingest here would not un-produce the artifact, it would convert a
  // flagged fact into a silence. A fault on our side lands as `unchecked`,
  // which is a recorded failure and never a pass.
  const seal = checkDeploymentSeal(
    p.deployment?.tenantId ?? p.userId,
    p.deployment?.deploymentId ?? null,
    now,
  );

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
           container_machine_manifest,
           deployment_id, seal_state, seal_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.projectId,
        next,
        now,
        leafHash,
        inputHash,
        outputHash,
        previousHash,
        JSON.stringify({
          generationSpec: p.spec,
          contentType: p.imageContentType,
          // WO-27 — WHY input_hash is what it is, on the row itself.
          //
          // A NULL input_hash is otherwise indistinguishable from a row
          // written before the question existed. Recorded only when the
          // graph referenced something, so a txt2img row is unchanged.
          ...(referencedInputs.length > 0
            ? {
                inputBinding: {
                  referenced: referencedInputs,
                  bound: [...boundNames].sort(),
                  unbound: unboundInputs,
                  declined: unboundInputs.length > 0,
                },
              }
            : {}),
        }),
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
        seal.deployment_id,
        seal.state,
        // NULL unless `sealed`. Migration 046 carries the argument: a leaf
        // written during `resealing` was not written under an approval,
        // and stamping the last approved seal on it would read as
        // "approved under X" — the one thing that is not true of it.
        seal.seal_ref,
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

  // ── WO-27: give the C2PA signer a caller ──────────────────────────────
  //
  // Non-blocking and behind a flag, for the same reason the witness call is
  // non-blocking: a signing failure must not un-produce the artifact. See
  // lib/iterations/signOnIngest.ts for why it is a flag and not a default.
  const c2pa = await signIngestedArtifact({
    userId: p.userId,
    projectId: p.projectId,
    iterationId: id,
    assetPath: artifactPath(outputHash),
    contentType: p.imageContentType,
    outputKind,
    leafHash,
    leafScheme,
    witnessed: witnessResult !== null,
    workflowHash,
    modelFingerprintsHash,
    machineManifestHash,
    hasGenerativeInputs: inputArtifacts.length > 0 || referencedInputs.length > 0,
  });

  return {
    iteration,
    leafHash,
    runSequence,
    storagePointer,
    inputArtifacts,
    witnessed: witnessResult !== null,
    leafScheme,
    seal,
    inputHash,
    unboundInputs,
    c2pa,
  };
}
