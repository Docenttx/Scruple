// Duty 2 — watch. Surface `filesystem-watch`, fidelity `as-written`.
//
// This covers H-4 §2 path 1 in the case the gate cannot: SaveImage writes
// through folder_paths.get_save_image_path() (folder_paths.py:428, called
// from nodes.py:483) into the output directory, and a tenant with a shell in
// their own container reads the file without ever calling GET /view. A
// network gate sees nothing. Hash-on-close is what sees it.
//
// TAMPER-EVIDENT, NOT TAMPER-PROOF (§6), and the code should say so where
// someone reading it will believe it: hashing on close means a LATER EDIT IS
// A NEW CLOSE AND A NEW HASH. This surface does not prevent modification and
// is not asked to. It makes modification produce another event with another
// hash, and it is the reconciliation between those events — not this file —
// that turns that into a finding. §2 obligation 3 is explicit that the
// tenant's mount need not be read-only for that reason.
//
// ---------------------------------------------------------------------------
// NODE CANNOT SEE IN_CLOSE_WRITE. Say it, do not paper over it.
// ---------------------------------------------------------------------------
//
// §3's trigger is `IN_CLOSE_WRITE`, which is right: it is the inotify event
// that means "a writer that had this file open for writing has closed it",
// and it is the only one that distinguishes a finished file from a file being
// written. Node's fs.watch does not expose it. On Linux, libuv registers
// IN_ATTRIB | IN_CREATE | IN_MODIFY | IN_DELETE | IN_DELETE_SELF |
// IN_MOVED_TO | IN_MOVED_FROM and reports 'rename' / 'change'. There is no
// close event in the set and no flag that adds one.
//
// So the default source below APPROXIMATES close-write by quiescence: after
// the last 'change' for a path, wait `settleMs` with a stable size, then hash.
// Its two failure modes, both real:
//
//   * a writer that stalls longer than settleMs mid-file hashes a PARTIAL
//     file, and then produces a second event and a second hash when it
//     finishes. The record shows two hashes for one artifact — which reads
//     exactly like the tamper case it is not.
//   * a writer that finishes inside settleMs delays the leaf by settleMs.
//     The gate cannot serve those bytes in the meantime because /view goes
//     through the HTTP surface, which captures independently.
//
// `CloseWriteSource` is the seam for fixing this properly: an inotifywait(1)
// subprocess from inotify-tools, or a native addon, both of which CAN ask for
// IN_CLOSE_WRITE. Neither is a dependency this component takes today, and
// inotify-tools is not installed on the reference host. The interface is here
// so that fixing it is a constructor argument rather than a rewrite, and this
// comment is here so nobody reads `fs.watch` and believes it is §3.

import crypto from 'node:crypto';
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
} from '../../../../lib/capture/surface';
import { resolveWatchedVolumes, type WatchedVolume } from '../config';
import type { Correlator } from '../correlation';
import { mimeFromVendorConfig } from '../mime';

/** What the watcher needs from the OS. See the header for why this is an
 *  interface and not a call to fs.watch. */
export interface CloseWriteSource {
  /** Emit an absolute path each time a write to it is believed to have
   *  completed. */
  start(dir: string, onCloseWrite: (absPath: string) => void): void;
  stop(): void;
  /** How this source decides "closed" — recorded on the leaf so a verifier
   *  is told whether it is reading IN_CLOSE_WRITE or a quiescence timer. */
  readonly method: 'inotify-close-write' | 'fs-watch-quiescence';
}

export class QuiescenceSource implements CloseWriteSource {
  readonly method = 'fs-watch-quiescence' as const;
  private watcher: fs.FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private sizes = new Map<string, number>();

  constructor(private readonly settleMs: number) {}

  start(dir: string, onCloseWrite: (absPath: string) => void): void {
    // recursive is supported on Linux from Node 20. Without it, SaveImage's
    // `filename_prefix` subfolders (get_save_image_path splits a prefix on
    // '/') would be unwatched, and an artifact in a subdirectory is exactly
    // the artifact somebody is trying to hide.
    this.watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const abs = path.join(dir, filename.toString());
      this.arm(abs, onCloseWrite);
    });
  }

  private arm(abs: string, onCloseWrite: (p: string) => void): void {
    const existing = this.timers.get(abs);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(abs);
      let size: number;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) return;
        size = st.size;
      } catch {
        // Deleted between the event and the settle. Nothing was retrievable.
        this.sizes.delete(abs);
        return;
      }
      if (this.sizes.get(abs) !== size) {
        // Still growing. Re-arm rather than hash a partial file — the one
        // mitigation available for the failure mode named in the header.
        this.sizes.set(abs, size);
        this.arm(abs, onCloseWrite);
        return;
      }
      onCloseWrite(abs);
    }, this.settleMs);
    // Do not hold the event loop open on a settle timer.
    t.unref?.();
    this.timers.set(abs, t);
    try {
      this.sizes.set(abs, fs.statSync(abs).size);
    } catch {
      this.sizes.set(abs, -1);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.watcher?.close();
    this.watcher = null;
  }
}

export interface FsWatchOptions {
  /**
   * §10 C-8's directories, each with its TYPE. One watcher per root, and the
   * type travels to the leaf — see `egressFor` below for why that is not
   * decoration.
   */
  watchedVolumes?: readonly WatchedVolume[];
  /** @deprecated the pre-C-8 singular root. Becomes one `unspecified` volume. */
  outputVolume?: string;
  correlator: Correlator;
  outputVolumeDeclaredMime: string | null;
  /**
   * A single injected source. Legal ONLY for a single-root configuration: a
   * `CloseWriteSource` holds one watcher, so calling `start()` on one instance
   * for three roots would silently watch the last one and drop the other two.
   * Use `sourceFactory` for multiple roots.
   */
  source?: CloseWriteSource;
  /** One source per declared root. */
  sourceFactory?: () => CloseWriteSource;
  log?: (line: string) => void;
}

/**
 * `capture.egress` for a file, and the ONE place §10 C-8's type reaches the
 * evidence record.
 *
 * WHY `egress` AND NOT A NEW FIELD. `capture` is a fixed block whose every
 * member is inside the MAC preimage (`leaf.ts#preimageOf`), computed
 * identically by the component and by the ingest route. Adding a member is a
 * preimage change, which invalidates every provisioned component in the field
 * — the same trap §10's "not a defect" note closes for the HKDF asymmetry. So
 * the type rides in a field that already exists, already means "the route the
 * bytes left by", and is already authenticated by the MAC. `ws-gate.ts` uses
 * the same `<scheme>:<qualifier>:<value>` shape (`ws:binary:4`).
 *
 * A `temp/` write and an `output/` write are now different strings, which is
 * the whole content of C-8: `PreviewImage` writes full images to `temp/`, and
 * "a leaf exists for these bytes" was never the same claim as "the deployment
 * witnesses PreviewImage output".
 */
export function egressFor(volume: WatchedVolume, abs: string): string {
  return `file:${volume.type}:${path.relative(volume.path, abs)}`;
}

export class FsWatchSurface implements CaptureSurface {
  private ctx: CaptureSurfaceContext | null = null;
  /** The declared roots, resolved and validated (no nesting, no duplicate type). */
  readonly volumes: readonly WatchedVolume[];
  /** One per volume, index-aligned. */
  private readonly sources: readonly CloseWriteSource[];
  private readonly log: (line: string) => void;
  /** path → last content hash emitted. A repeat with the same hash is the
   *  same fact and does not spend a counter; a DIFFERENT hash is the §6
   *  tamper-evidence case and does. */
  private lastHash = new Map<string, string>();
  /** Resolves when every in-flight capture has finished — the tests need a
   *  deterministic point, and a drain on shutdown needs one too. */
  private inflight = new Set<Promise<void>>();

  constructor(private readonly opts: FsWatchOptions) {
    this.volumes = resolveWatchedVolumes(opts, 'FsWatchOptions');
    if (opts.source && this.volumes.length > 1) {
      throw new Error(
        'fs-watch: a single injected CloseWriteSource cannot watch ' +
          `${this.volumes.length} roots — it holds one watcher, so the second start() would ` +
          'replace the first and two of the three C-8 directories would go unwatched while ' +
          'the component reported healthy. Pass sourceFactory instead.',
      );
    }
    this.sources = this.volumes.map((_v, i) =>
      opts.sourceFactory
        ? opts.sourceFactory()
        : i === 0 && opts.source
          ? opts.source
          : new QuiescenceSource(250),
    );
    this.log = opts.log ?? ((l) => console.log(`[fs-watch] ${l}`));
  }

  name(): string {
    return 'comfyui-output-volume';
  }
  evidenceType(): string {
    return 'scruple.dev/evidence/output-volume-close/v1';
  }
  surface(): CaptureSurfaceKind {
    return 'filesystem-watch';
  }
  fidelity(): ObservationFidelity {
    // The bytes the host WROTE, not the bytes a consumer received. Equally
    // re-derivable by a third party holding the file, and tamper-evident only.
    return 'as-written';
  }
  hooks(): readonly CaptureHook[] {
    return ['artifact.produced'];
  }
  placement(): Placement {
    return 'sidecar-gate';
  }
  enforcement(): PlacementEnforcement {
    return 'isolated-namespace';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        egress: { type: 'string' },
        close_detection: { type: 'string' },
        correlation_method: { type: ['string', 'null'] },
        mime_source: { type: ['string', 'null'] },
      },
    };
  }

  async open(ctx: CaptureSurfaceContext): Promise<void> {
    this.ctx = ctx;
    for (const v of this.volumes) {
      if (!fs.existsSync(v.path)) {
        throw new Error(
          `fs-watch: watched volume '${v.type}' at ${v.path} does not exist. Refusing to open ` +
            'a watcher that observes nothing — a surface that silently fails to open is the ' +
            'ComfyUI WS gap by another name (lib/capture/surface.ts).',
        );
      }
    }
    this.volumes.forEach((v, i) => {
      this.sources[i].start(v.path, (abs) => {
        const p = this.onCloseWrite(v, this.sources[i], abs).catch((e) =>
          this.log(`capture failed for ${abs}: ${String(e)}`),
        );
        this.inflight.add(p);
        void p.finally(() => this.inflight.delete(p));
      });
    });
  }

  async observe(): Promise<void> {
    await this.settled();
  }

  /** Await every capture currently in flight. */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  async close(): Promise<void> {
    for (const s of this.sources) s.stop();
    await this.settled();
    this.ctx = null;
  }

  private async onCloseWrite(
    volume: WatchedVolume,
    source: CloseWriteSource,
    abs: string,
  ): Promise<void> {
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
    if (this.lastHash.get(abs) === contentHash) return;
    const previous = this.lastHash.get(abs);
    this.lastHash.set(abs, contentHash);
    if (previous) {
      this.log(
        `${abs} closed again with a DIFFERENT hash (${previous.slice(0, 12)} → ` +
          `${contentHash.slice(0, 12)}). Tamper-EVIDENT, not tamper-proof (§6): both ` +
          'events are recorded and reconciliation is what makes this a finding.',
      );
    }

    const basename = path.basename(abs);
    const att = this.opts.correlator.attribute(basename);
    // Declared by the writing node where the graph names one; otherwise the
    // vendor's blanket declaration for their own output volume; otherwise
    // undeclared. Never sniffed, never taken from the extension.
    const declared = att.mime ?? mimeFromVendorConfig(this.opts.outputVolumeDeclaredMime);

    await ctx.sink.emit({
      hook: 'artifact.produced',
      surface: 'filesystem-watch',
      correlationId: att.prompt?.promptId,
      bytes: {
        fidelity: 'as-written',
        contentHash,
        sizeBytes: size,
        ...(declared ? { mime: declared.mime } : {}),
      },
      evidence: {
        egress: egressFor(volume, abs),
        close_detection: source.method,
        workflow_hash: att.prompt?.workflowHash ?? null,
        input_hash: att.prompt?.inputHash ?? null,
        correlation_method: att.method,
        mime_source: declared?.source ?? null,
        kind: 'artifact',
        graph: att.prompt?.graph ?? undefined,
      },
      observedAt: new Date().toISOString(),
    });
  }
}

/** Streamed, not read into memory: a checkpoint in the output volume is
 *  gigabytes and this process must not be the thing that OOMs the sidecar. */
export function hashFile(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(abs);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}
