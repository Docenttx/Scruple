// Duty 2 for Kohya — watch. Surface `filesystem-watch`, hook `model.write`,
// fidelity `as-written`, leaf kind `model_write`.
//
// WHY THIS IS NOT src/surfaces/fs-watch.ts WITH A DIFFERENT DIRECTORY
//
// The ComfyUI watcher emits `hook: 'artifact.produced'` / `kind: 'artifact'`
// and asks the Correlator to attribute a filename to a prompt. Neither fits a
// checkpoint:
//
//   * A checkpoint is a `model.write`, and lib/leaf/registry.yaml keeps
//     `model_write` as a distinct leaf kind for a reason — what it commits to
//     is a set of weights, not a rendered artifact, and downstream tooling
//     (the LoRA sidecar emitter, provenance decomposition) binds to it.
//   * A safetensors file carries a STRUCTURAL FINGERPRINT that no image has:
//     the first 8 bytes are the header length, the header is JSON naming every
//     tensor with its shape and dtype. Hashing those bytes separately gives a
//     fingerprint that survives metadata-only edits elsewhere in the file. The
//     in-pod hook already computed this (`header_hash`), and losing it in the
//     move out of the pod would make the re-placement a net evidence
//     regression — the mistake STUDIO_P1-P8_GRADE.md records /v2/witness
//     making against the legacy canvas leaf.
//   * There is no prompt to correlate to. Kohya's correlation is a training
//     RUN, which arrives at the gate as a config, not as a graph.
//
// It DOES reuse `CloseWriteSource` / `QuiescenceSource` / `hashFile` from the
// ComfyUI watcher, because those are about the OS and not about the host, and
// §10 C-10's caveat carries across unchanged: Node cannot see IN_CLOSE_WRITE,
// the default source approximates it by quiescence, and a writer that stalls
// past the settle window hashes a partial file and then hashes it again —
// which reads exactly like the tamper case it is not.
//
// THAT CAVEAT IS WORSE HERE THAN IT IS FOR COMFYUI, and the number has to move
// with it. A PNG is written in milliseconds; a multi-gigabyte safetensors
// checkpoint is written over tens of seconds by a process that is also
// saturating the GPU, and a 250 ms settle window would slice most of them into
// several partial hashes. DEFAULT_CHECKPOINT_SETTLE_MS is 15 s for that
// reason, and it is a mitigation, not a fix: the fix is inotify's real
// IN_CLOSE_WRITE, which is what `CloseWriteSource` exists to accept.
//
// WHAT THIS SURFACE MAY NOT DO (CANON_SKELETON §5, PLACEMENT_AND_SURFACES §6.2)
// It does not decide a MIME. A safetensors header that parses tells you the
// file is well-formed; it does not make this code the party ENTITLED to
// declare a type. So the declaration comes from the vendor's config for the
// volume or it is absent, exactly as in the ComfyUI watcher, and never from
// the extension and never `application/octet-stream`.

import fs from 'node:fs';
import path from 'node:path';

import type {
  CaptureHook,
  CaptureSurface,
  CaptureSurfaceContext,
  CaptureSurfaceKind,
  ObservationFidelity,
  Placement,
  PlacementEnforcement,
} from '../../../lib/capture/surface';
import { hashFile, QuiescenceSource, type CloseWriteSource } from '../src/surfaces/fs-watch';
import { mimeFromVendorConfig } from '../src/mime';
import { hashHeaderBytes, readSafetensorsHeader, type SafetensorsHeader } from './safetensors';

/** See the header. Kohya checkpoints are written slowly and in one stream. */
export const DEFAULT_CHECKPOINT_SETTLE_MS = 15_000;

/** Extensions Kohya's save path produces. Everything else in the volume is an
 *  `artifact.produced` (sample images, logs) and is emitted as such — never
 *  dropped, because a file the watcher declines to emit is an invisible hole
 *  and H-4 §7 probe 4 exists to catch exactly that. */
const CHECKPOINT_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt']);

export interface CheckpointWatchOptions {
  /** The checkpoint output volume, mounted into the component (§2 ob. 3). */
  volume: string;
  /** The vendor's declaration for this volume, or null. Never guessed. */
  declaredMime?: string | null;
  /** Defaults to quiescence at DEFAULT_CHECKPOINT_SETTLE_MS. */
  source?: CloseWriteSource;
  /** The training run this volume belongs to, if the gate committed one.
   *  A thunk, because the run starts after the watcher opens. */
  runContext?: () => KohyaRunContext | null;
  log?: (line: string) => void;
}

/** What the gate learned on the way in, if a gate is deployed. Absent is a
 *  legitimate state and produces a leaf with no run commitment rather than a
 *  fabricated one. */
export interface KohyaRunContext {
  /** Canonical hash of the training config, via lib/leaf/hashes.ts on the
   *  server side. The component carries the config; it does not hash it into
   *  a field the server cannot recompute. */
  trainingConfig?: Record<string, unknown>;
  /** Dataset commitment, where the vendor's ingest path establishes one. */
  inputHash?: string | null;
  /** Base-model fingerprints the run started from. */
  modelFingerprintsHash?: string | null;
}

export class CheckpointWatchSurface implements CaptureSurface {
  private ctx: CaptureSurfaceContext | null = null;
  private readonly source: CloseWriteSource;
  private readonly log: (line: string) => void;
  private readonly lastHash = new Map<string, string>();
  private inflight = new Set<Promise<void>>();

  constructor(private readonly opts: CheckpointWatchOptions) {
    this.source = opts.source ?? new QuiescenceSource(DEFAULT_CHECKPOINT_SETTLE_MS);
    this.log = opts.log ?? ((l) => console.log(`[kohya-watch] ${l}`));
  }

  name(): string {
    return 'kohya-checkpoint-volume';
  }
  evidenceType(): string {
    return 'scruple.dev/evidence/kohya-checkpoint-close/v1';
  }
  surface(): CaptureSurfaceKind {
    return 'filesystem-watch';
  }
  fidelity(): ObservationFidelity {
    // The bytes the trainer WROTE. Re-derivable by anyone holding the file,
    // and tamper-evident only (H-4 §6).
    return 'as-written';
  }
  hooks(): readonly CaptureHook[] {
    return ['model.write', 'artifact.produced'];
  }
  placement(): Placement {
    // DECLARED. resolveKohyaPlacement() in profile.ts is what decides whether
    // the declaration survives its enforcement; this method is the claim, and
    // a surface's claim is never the last word (PLACEMENT_AND_SURFACES §4.2).
    return 'sidecar-gate';
  }
  enforcement(): PlacementEnforcement {
    // Deliberately the pessimistic value. The surface cannot see the topology
    // it was deployed into; the runner supplies the vendor's declaration.
    return 'none';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        egress: { type: 'string' },
        close_detection: { type: 'string' },
        header_hash: { type: ['string', 'null'] },
        structural_summary: { type: ['object', 'null'] },
        mime_source: { type: ['string', 'null'] },
        kind: { type: 'string' },
      },
    };
  }

  async open(ctx: CaptureSurfaceContext): Promise<void> {
    this.ctx = ctx;
    if (!fs.existsSync(this.opts.volume)) {
      throw new Error(
        `kohya-watch: ${this.opts.volume} does not exist. Refusing to open a watcher that ` +
          'observes nothing — a surface that silently fails to open is the ComfyUI WS gap ' +
          'by another name (lib/capture/surface.ts).',
      );
    }
    this.source.start(this.opts.volume, (abs) => {
      const p = this.onCloseWrite(abs).catch((e) =>
        this.log(`capture failed for ${abs}: ${String(e)}`),
      );
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
    });
  }

  async observe(): Promise<void> {
    await this.settled();
  }

  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  async close(): Promise<void> {
    this.source.stop();
    await this.settled();
    this.ctx = null;
  }

  private async onCloseWrite(abs: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    let size: number;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size === 0) return;
      size = st.size;
    } catch {
      return;
    }

    const contentHash = await hashFile(abs);
    const previous = this.lastHash.get(abs);
    if (previous === contentHash) return;
    this.lastHash.set(abs, contentHash);
    if (previous) {
      this.log(
        `${abs} closed again with a DIFFERENT hash (${previous.slice(0, 12)} → ` +
          `${contentHash.slice(0, 12)}). Both events are recorded. On a checkpoint this is ` +
          'AMBIGUOUS by construction (§10 C-10): a trainer that stalled past the settle ' +
          'window produces exactly the same pair of events as a tamper. Reconciliation ' +
          'resolves it; this line does not.',
      );
    }

    const isCheckpoint = CHECKPOINT_EXTENSIONS.has(path.extname(abs).toLowerCase());
    const header = isCheckpoint ? readSafetensorsHeader(abs) : null;
    const declared = mimeFromVendorConfig(this.opts.declaredMime ?? null);
    const run = this.opts.runContext?.() ?? null;

    await ctx.sink.emit({
      // The hook did not change when the placement did. This is the same
      // `model.write` the in-pod monkey-patch claimed; only who observes it,
      // and from where, is different (PLACEMENT_AND_SURFACES.md §7.2).
      hook: isCheckpoint ? 'model.write' : 'artifact.produced',
      surface: 'filesystem-watch',
      bytes: {
        fidelity: 'as-written',
        contentHash,
        sizeBytes: size,
        ...(declared ? { mime: declared.mime } : {}),
      },
      evidence: {
        kind: isCheckpoint ? 'model_write' : 'artifact',
        egress: `file:${path.relative(this.opts.volume, abs)}`,
        close_detection: this.source.method,
        mime_source: declared?.source ?? null,
        // The structural fingerprint the in-pod hook produced, preserved
        // across the move. Null when the file is not safetensors or its
        // header does not parse — an absent value, never a guessed one.
        header_hash: header ? hashHeaderBytes(header) : null,
        structural_summary: header ? summarise(header) : null,
        // Run commitment, when a gate established one. Absent is honest;
        // fabricated is not.
        input_hash: run?.inputHash ?? null,
        model_fingerprints_hash: run?.modelFingerprintsHash ?? null,
        // Named `graph` because that is what the submission field is called
        // and lib/leaf/hashes.ts hashGraphOrTraining accepts a training
        // config there. Renaming the wire field is not this WO's to do.
        graph: run?.trainingConfig,
        correlation_method: run ? 'training-run' : 'none',
      },
      observedAt: new Date().toISOString(),
    });
  }
}

/** Layer names, shapes and dtypes — no weights. H-4 §6 / P6 zero-content. */
function summarise(h: SafetensorsHeader): Record<string, unknown> {
  const tensors = Object.entries(h.json).filter(([k]) => k !== '__metadata__');
  return {
    layer_count: tensors.length,
    layers: tensors.slice(0, 50).map(([name, info]) => ({
      name,
      shape: (info as Record<string, unknown>)?.shape ?? null,
      dtype: (info as Record<string, unknown>)?.dtype ?? null,
    })),
    metadata: (h.json as Record<string, unknown>).__metadata__ ?? {},
  };
}
