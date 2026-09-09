// THE VAULT, AS A CAPTURE SURFACE.
//
// docs/DESIGN.md keeps the MODEL from `app-legacy/lock/lock-local-lock.js` —
// "a set of files at a moment" — and replaces the implementation. The model is
// worth keeping because it is the one measurement a server-side gate
// structurally cannot make: "a gate observes a wire and never sees a
// directory."
//
// WHAT A VAULT IS, PRECISELY, AND WHY IT IS `filesystem-watch`
// ------------------------------------------------------------------
// The surface axis names the MECHANISM OF OBSERVATION, not the trigger:
// "Observed as a completed file." That is what this does. It is not a watcher
// — there is no inotify, no quiescence timer, no second event when a file is
// rewritten — and the difference is worth being blunt about, because it
// changes what the record is worth:
//
//   `FsWatchSurface` is tamper-EVIDENT over time. A later edit is a later
//   close and a later hash, and reconciliation between the two is the finding.
//
//   A VAULT IS A SNAPSHOT. It says what was in this directory at one moment
//   and says nothing whatever about the moment after. `observedAt` is that
//   moment and is the only interval this surface can speak for.
//
// Both are `filesystem-watch` because both hash completed files off a
// filesystem, and surface DOES NOT AFFECT ASSURANCE — it affects COVERAGE
// (lib/capture/surface.ts). A vault covers a directory at an instant; that is
// its coverage, and pretending otherwise by inventing a fifth surface value
// would put a coverage claim in the field a verifier reads for mechanism.
//
// PLACEMENT IS DECLARED HONESTLY AND IT IS THE WEAK ONE
// ------------------------------------------------------------------
// `unattested-client` / `none`. The user has root on this box and can edit
// this file. That resolves to the `desktop` profile, where `verified` is
// unrepresentable three ways over (lib/leaf/attestationBasis.ts). This surface
// does not choose its own basis — `buildLeaf` resolves it per emission — and
// the honest answer today is `stale`, because the Merkle blocker stands.
//
// WHAT THIS FILE MAY NOT DO, and does not
// ------------------------------------------------------------------
// §5's rule for adapters binds surfaces identically: no HTTP request, no
// payment, no MIME decision, no applicability decision, no retry, no MAC, no
// ratchet counter, no verdict on whether a leaf is verified or passthrough.
// Every one of those is on the far side of `ctx.sink`. Grep this file for
// `fetch`, `crypto.createHmac`, `mime =` — none of them is here.

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
} from './sdk';
import { countedHash, type CountedRead } from './countedRead';
import { Declaration, DECLARATION_FILENAME } from './declaration';
import { absent, indeterminate, isMeasured, measured, type Measurement } from './measurement';

/** Default ceiling: 64 MiB. A configuration value, stated out loud rather than
 *  buried — the right number is a deployment decision and the wrong number is
 *  a silent one. */
export const DEFAULT_CEILING_BYTES = 64 * 1024 * 1024;

export type VaultOutcome =
  | 'captured'
  | 'refused_mime_undeclared'
  | 'refused_mime_declared_absent'
  | 'refused_over_ceiling'
  | 'refused_unreadable';

/** One file in the vault, and what happened to it. Every one of these reaches
 *  the manifest; none is dropped. */
export interface VaultEntry {
  /** Posix-relative to the vault root. The key the declaration is read with. */
  path: string;
  outcome: VaultOutcome;
  mime: Measurement<string>;
  contentHash: Measurement<string>;
  /** Bytes THIS PROCESS COUNTED. `absent` when the file was refused before it
   *  was read — a deliberate non-measurement, which is not the same fact as a
   *  read that could not be completed. */
  bytesCounted: Measurement<number>;
  /** What stat(2) claimed. A hint from the file's owner, recorded as such. */
  statSize: Measurement<number>;
  /** Set when the two above disagree, or when a read was stopped. */
  note: string | null;
}

export interface VaultObservationReport {
  vaultDir: string;
  vaultId: string;
  observedAt: string;
  ceilingBytes: number;
  declaredBy: string;
  /** The declaration's own digest. It types the set and is therefore not IN
   *  the set — but it is hashed, so the manifest binds it. */
  declarationHash: Measurement<string>;
  entries: VaultEntry[];
  /** Named by the declaration and not present on disk. A vault that lost a
   *  file must not look like a vault that never had one. */
  declaredButAbsent: string[];
  /** Directories skipped. Recorded so the count of entries is the count of
   *  files and not the count of things this surface understood. */
  skippedDirectories: string[];
}

export interface VaultSurfaceOptions {
  vaultDir: string;
  /** A stable id for this vault run. Becomes every observation's
   *  correlationId, which is what makes N leaves one event. */
  vaultId: string;
  ceilingBytes?: number;
  log?: (line: string) => void;
}

export class VaultSurface implements CaptureSurface {
  private ctx: CaptureSurfaceContext | null = null;
  private declaration: Declaration | null = null;
  private readonly log: (line: string) => void;
  readonly ceilingBytes: number;
  /** Filled by observe(). The sidecar reads it to build the manifest. */
  report: VaultObservationReport | null = null;

  constructor(private readonly opts: VaultSurfaceOptions) {
    this.ceilingBytes = opts.ceilingBytes ?? DEFAULT_CEILING_BYTES;
    this.log = opts.log ?? ((l) => console.log(`[vault] ${l}`));
    if (!Number.isInteger(this.ceilingBytes) || this.ceilingBytes <= 0) {
      throw new Error(`vault: ceiling must be a positive integer, got ${String(this.ceilingBytes)}`);
    }
  }

  name(): string {
    return 'scruple-desktop-vault';
  }
  evidenceType(): string {
    return 'scruple.dev/evidence/desktop-vault-snapshot/v1';
  }
  surface(): CaptureSurfaceKind {
    return 'filesystem-watch';
  }
  fidelity(): ObservationFidelity {
    // The exact bytes on disk. A third party holding the vault re-hashes any
    // file and matches the leaf — which is the whole claim, and the reason
    // this is not `induced`: nothing here causes a serialization.
    return 'as-written';
  }
  hooks(): readonly CaptureHook[] {
    return ['artifact.produced'];
  }
  placement(): Placement {
    // Declared, and deliberately the weak one. The measured party owns this
    // machine and can edit this file.
    return 'unattested-client';
  }
  enforcement(): PlacementEnforcement {
    return 'none';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['vault_id', 'vault_path', 'mime_source'],
      properties: {
        vault_id: { type: 'string' },
        vault_path: { type: 'string' },
        egress: { type: 'string' },
        mime_source: { type: ['string', 'null'] },
        correlation_method: { type: ['string', 'null'] },
      },
    };
  }

  /**
   * Acquire the position: the directory has to be there and the declaration
   * has to be readable. THROWS otherwise — "a surface that silently fails to
   * open is the ComfyUI WS gap by another name."
   */
  async open(ctx: CaptureSurfaceContext): Promise<void> {
    const dir = path.resolve(this.opts.vaultDir);
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch (e) {
      throw new Error(`vault: cannot stat ${dir}: ${String((e as NodeJS.ErrnoException).code ?? e)}`);
    }
    if (!st.isDirectory()) throw new Error(`vault: ${dir} is not a directory`);
    this.declaration = Declaration.read(dir);
    this.ctx = ctx;
    this.log(`opened ${dir} · ceiling ${this.ceilingBytes} bytes · declared_by ${this.declaration.declaredBy}`);
  }

  /**
   * Take the snapshot and emit one observation per ACCEPTED file.
   *
   * A refused file emits NOTHING to the sink and that is the point of the
   * manifest: `buildLeaf` requires bytes, and a leaf whose `content_hash` is a
   * placeholder would be worse than no leaf. The refusal is not lost — it is
   * an entry in `report`, the manifest is built from `report`, and the
   * manifest is itself witnessed. See app/vault/run.ts.
   */
  async observe(): Promise<void> {
    const ctx = this.ctx;
    const declaration = this.declaration;
    if (!ctx || !declaration) throw new Error('vault: observe() before open()');

    const dir = path.resolve(this.opts.vaultDir);
    const observedAt = new Date().toISOString();
    const entries: VaultEntry[] = [];
    const skipped: string[] = [];

    // Sorted, depth-first, by byte order of the posix relative path. The ORDER
    // IS PART OF THE RECORD: the manifest lists entries in it, so two machines
    // reading the same directory produce the same document.
    const rels: string[] = [];
    const walk = (abs: string, rel: string) => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          skipped.push(childRel);
          walk(path.join(abs, e.name), childRel);
        } else if (e.isFile()) {
          rels.push(childRel);
        } else {
          // A socket, a fifo, a dangling symlink. Named, not silently dropped.
          skipped.push(`${childRel} (not a regular file)`);
        }
      }
    };
    walk(dir, '');
    rels.sort();

    // The declaration types the set, so it is not a member of the set it types
    // — including it would ask it to declare itself. It is HASHED anyway and
    // the digest goes in the manifest, which is what stops "excluded" from
    // meaning "unbound". The legacy vault excluded `provenance.json` by name
    // and never hashed it.
    const declHash = await countedHash(path.join(dir, DECLARATION_FILENAME), this.ceilingBytes);

    for (const rel of rels) {
      if (rel === DECLARATION_FILENAME) continue;
      entries.push(await this.measureOne(dir, rel, declaration, ctx));
    }

    const present = new Set(rels);
    this.report = {
      vaultDir: dir,
      vaultId: this.opts.vaultId,
      observedAt,
      ceilingBytes: this.ceilingBytes,
      declaredBy: declaration.declaredBy,
      declarationHash: declHash.contentHash
        ? measured(declHash.contentHash, `${DECLARATION_FILENAME} (counted read)`)
        : indeterminate(DECLARATION_FILENAME, declHash.reason ?? 'unreadable'),
      entries,
      declaredButAbsent: declaration.declaredPaths().filter((p) => !present.has(p)),
      skippedDirectories: skipped,
    };

    const captured = entries.filter((e) => e.outcome === 'captured').length;
    this.log(
      `snapshot ${this.opts.vaultId}: ${entries.length} files, ${captured} captured, ` +
        `${entries.length - captured} refused, ${this.report.declaredButAbsent.length} declared-but-absent`,
    );
  }

  private async measureOne(
    dir: string,
    rel: string,
    declaration: Declaration,
    ctx: CaptureSurfaceContext,
  ): Promise<VaultEntry> {
    const abs = path.join(dir, rel);
    const mime = declaration.mimeFor(rel);

    // ── REFUSAL COMES FIRST, AND IT COMES BEFORE THE READ ──────────────
    // Not an optimisation. A file nobody typed is a file this vault is not
    // taking a measurement of, and hashing it anyway would leave a
    // `content_hash` in the record with no leaf pointing at it — a
    // measurement nobody asked for, sitting where a reader expects one that
    // was witnessed.
    if (!isMeasured(mime)) {
      const outcome: VaultOutcome =
        mime.state === 'absent' ? 'refused_mime_declared_absent' : 'refused_mime_undeclared';
      let statSize: Measurement<number>;
      try {
        statSize = measured(fs.statSync(abs).size, 'stat(2)');
      } catch (e) {
        statSize = indeterminate('stat(2)', String((e as NodeJS.ErrnoException).code ?? e));
      }
      this.log(`REFUSED ${rel}: ${outcome} — ${mime.reason}`);
      return {
        path: rel,
        outcome,
        mime,
        contentHash: absent(
          'vault',
          'refused before the bytes were read; no digest was taken. Not a failed ' +
            'measurement — a measurement this surface declined to make.',
        ),
        bytesCounted: absent('vault', 'the file was not read'),
        statSize,
        note: null,
      };
    }

    const read: CountedRead = await countedHash(abs, this.ceilingBytes);

    if (read.outcome !== 'read') {
      // OVER THE CEILING, OR UNREADABLE. Both are `indeterminate`, and they
      // are different reasons for it: we tried, we counted, and we could not
      // finish. Distinct from the refusals above, where we did not try.
      const outcome: VaultOutcome =
        read.outcome === 'over_ceiling' ? 'refused_over_ceiling' : 'refused_unreadable';
      this.log(`REFUSED ${rel}: ${outcome} — ${read.reason}`);
      return {
        path: rel,
        outcome,
        mime,
        contentHash: indeterminate('counted read', read.reason ?? read.outcome),
        // THE COUNT SURVIVES THE REFUSAL. It is the whole difference between
        // "over the ceiling" and "skipped": a number this process observed.
        bytesCounted: measured(read.bytesCounted, 'counted read (stopped)'),
        statSize:
          read.statSize === null
            ? indeterminate('stat(2)', 'could not stat')
            : measured(read.statSize, 'stat(2)'),
        note: read.reason,
      };
    }

    // ── ACCEPTED. One observation, into the sink, and nowhere else. ────
    await ctx.sink.emit({
      hook: 'artifact.produced',
      surface: 'filesystem-watch',
      correlationId: this.opts.vaultId,
      bytes: {
        fidelity: 'as-written',
        contentHash: read.contentHash!,
        sizeBytes: read.bytesCounted,
        mime: mime.value,
      },
      evidence: {
        kind: 'artifact',
        egress: `vault:file:${rel}`,
        mime_source: 'vault-declaration',
        correlation_method: 'vault-snapshot',
        vault_id: this.opts.vaultId,
        vault_path: rel,
      },
      observedAt: new Date().toISOString(),
    });

    return {
      path: rel,
      outcome: 'captured',
      mime,
      contentHash: measured(read.contentHash!, 'counted read'),
      bytesCounted: measured(read.bytesCounted, 'counted read'),
      statSize:
        read.statSize === null
          ? indeterminate('stat(2)', 'could not stat')
          : measured(read.statSize, 'stat(2)'),
      note: read.sizeDisagreement,
    };
  }

  async close(): Promise<void> {
    this.ctx = null;
    this.declaration = null;
  }
}
