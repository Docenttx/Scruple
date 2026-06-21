// Public, unauthenticated provenance receipt at /receipt/SCR_XXXXXX.
// Renders project metadata + Merkle proof + witness signatures so any
// visitor can verify a project's claim.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { conn } from '@/lib/db/sqlite';
import {
  LOCK_STATE_LABELS,
  type ProjectRow,
  type IterationRow,
  type MerkleNodeRow,
  type TrainingRunRow,
} from '@/lib/types';
import type { InputArtifactRecord } from '@/lib/iterations/ingest';

export const dynamic = 'force-dynamic';

export default function ReceiptPage({ params }: { params: { scrId: string } }) {
  const { scrId } = params;
  // Local lock derives a 6-hex suffix from the Merkle root; chain lock
  // (witness server handleLock + handleConfirmAndExecute) derives an
  // 8-hex suffix. Accept either so chain-locked SCR-IDs render.
  if (!/^(SCR|SCRB)_[A-F0-9]{6,8}$/.test(scrId)) notFound();

  const project = conn()
    .prepare(`SELECT * FROM projects WHERE scr_id = ? OR pre_scr_id = ?`)
    .get(scrId, scrId) as ProjectRow | undefined;
  if (!project) notFound();

  const iterations = conn()
    .prepare(`SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence ASC`)
    .all(project.id) as IterationRow[];

  const nodes = conn()
    .prepare(`SELECT * FROM merkle_nodes WHERE project_id = ? ORDER BY level ASC, position ASC`)
    .all(project.id) as MerkleNodeRow[];

  const trainingRuns = conn()
    .prepare(
      `SELECT id, project_id, run_sequence, status, created_at, completed_at,
              output_filename, output_path, model_hash, header_hash, header_size,
              tensor_count, structural_summary, scr_id
         FROM training_runs
        WHERE project_id = ? AND (model_hash IS NOT NULL OR header_hash IS NOT NULL)
        ORDER BY run_sequence ASC`,
    )
    .all(project.id) as TrainingRunRow[];

  const witnessedCount = iterations.filter((i) => i.witnessed === 1).length;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="border-b border-scruple-border pb-6">
        <Link href="/" className="text-xs text-scruple-muted hover:text-scruple-text">
          ← Scruple Web
        </Link>
        <h1 className="mt-2 text-3xl font-light">{project.name}</h1>
        <div className="mt-1 flex items-center gap-3 text-xs text-scruple-muted">
          <span className="font-mono text-scruple-accent">{scrId}</span>
          <span>·</span>
          <span>{LOCK_STATE_LABELS[project.status]}</span>
          {project.locked_at && (
            <>
              <span>·</span>
              <span>locked {new Date(project.locked_at).toLocaleString()}</span>
            </>
          )}
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
        <Stat label="Iterations" value={String(project.iteration_count)} />
        <Stat label="Witnessed" value={`${witnessedCount} / ${iterations.length}`} />
        <Stat label="Merkle depth" value={String(maxDepth(nodes))} />
        <Stat label="Type" value={project.type} />
      </section>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-scruple-muted">Merkle root</h2>
        <pre className="mt-2 overflow-x-auto rounded-md border border-scruple-border bg-scruple-surface p-3 text-[11px] font-mono">
          {project.merkle_root || '—'}
        </pre>
        {project.witness_signature && (
          <>
            <h2 className="mt-4 text-xs uppercase tracking-widest text-scruple-muted">
              Witness server signature (chain anchor)
            </h2>
            <pre className="mt-2 overflow-x-auto rounded-md border border-scruple-border bg-scruple-surface p-3 text-[11px] font-mono">
              {project.witness_signature}
            </pre>
          </>
        )}
        {(project as { lock_server_signature?: string | null }).lock_server_signature && (
          <>
            <h2 className="mt-4 text-xs uppercase tracking-widest text-scruple-muted">
              Lock countersignature (Scruple second-party seal)
            </h2>
            <p className="mt-1 text-[10px] text-scruple-muted">
              HMAC the witness server returned on the <em>lock event itself</em>
              (signed over <span className="font-mono">{'{'} project_id, action, merkle_root, witnessed_count, locked_at {'}'}</span>).
              Distinct from each iteration&apos;s per-record signature. Action is
              in the signed tuple, so a checkpoint signature cannot be replayed
              as a finalize signature.
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md border border-scruple-border bg-scruple-surface p-3 text-[11px] font-mono">
              {(project as { lock_server_signature?: string | null }).lock_server_signature}
            </pre>
            {(project as { lock_locked_at_witnessed?: string | null }).lock_locked_at_witnessed && (
              <p className="mt-1 text-[10px] text-scruple-muted">
                witnessed-locked at{' '}
                <span className="font-mono">
                  {(project as { lock_locked_at_witnessed?: string | null }).lock_locked_at_witnessed}
                </span>
              </p>
            )}
          </>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-scruple-muted">
          Iterations ({iterations.length})
        </h2>
        <p className="mt-1 text-[10px] text-scruple-muted">
          Each iteration is one Merkle leaf under the root above. v2 leaves
          commit the full record (inputs, workflow, order, time);
          <span className="font-mono"> leaf_hash = sha256(canonical(record))</span>.
          v1 leaves commit only the output bytes;
          <span className="font-mono"> leaf_hash = output_hash</span>.
        </p>
        <div className="mt-3 space-y-3">
          {iterations.map((it) => (
            <IterationCard key={it.id} it={it} />
          ))}
        </div>
      </section>

      {/* Verification recipe — how an outsider with the asset ID + this
          page can independently re-derive each leaf and the Merkle root,
          then match it against the on-chain anchor. This IS the third-
          party proof; nothing about it requires trusting Scruple. */}
      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-scruple-muted">
          Verification recipe
        </h2>
        <div className="mt-2 rounded-md border border-scruple-border bg-scruple-surface p-3 text-[11px]">
          <p className="text-scruple-text">
            Anyone with the SCR-ID can verify this receipt end-to-end:
          </p>
          <ol className="ml-4 mt-2 list-decimal space-y-2 text-scruple-muted">
            <li>
              For each iteration, recompute the leaf:
              <ul className="ml-4 mt-1 list-disc space-y-1">
                <li>
                  <span className="font-mono">v1</span>:{' '}
                  <span className="font-mono">leaf_hash == sha256(output_bytes)</span>.
                  Confirm <span className="font-mono">output_hash</span> matches the bytes
                  served from <span className="font-mono">/api/artifact/[output_hash]</span>.
                </li>
                <li>
                  <span className="font-mono">v2</span>:{' '}
                  <span className="font-mono">
                    leaf_hash == sha256(canonical(record))
                  </span>
                  {' '}where{' '}
                  <span className="font-mono">
                    record = {'{'} run_sequence, output_hash, input_hash, workflow_hash,
                    model_fingerprints_hash, server_timestamp, prev_record_hash {'}'}
                  </span>
                  . Canonical = compact JSON (no spaces), fixed field order,
                  raw UTF-8 (no <span className="font-mono">\u</span>-escapes).
                  Matches Node{' '}
                  <span className="font-mono">JSON.stringify</span>; in Python use{' '}
                  <span className="font-mono">json.dumps(obj, separators=(&apos;,&apos;,&apos;:&apos;), ensure_ascii=False)</span>.
                </li>
                <li>
                  Recompute <span className="font-mono">model_fingerprints_hash</span> as{' '}
                  <span className="font-mono">sha256(canonical(manifest))</span> where{' '}
                  <span className="font-mono">manifest</span> is the &quot;Model files loaded&quot; map
                  with keys sorted ascending. Each file&apos;s <span className="font-mono">content_hash</span>
                  {' '}must equal sha256 of the actual model bytes loaded by the runner. This is what
                  detects a file-swap on the Modal volume between runs — re-hashing the file at the
                  same path will diverge from the recorded value.
                </li>
              </ul>
            </li>
            <li>
              Recompute <span className="font-mono">input_hash</span> as{' '}
              <span className="font-mono">sha256(canonical(provider, prompt, spec, input_artifact_hashes))</span>.
              Confirm each input artifact hash matches its bytes.
            </li>
            <li>
              Build the sorted-pair Merkle tree over the leaves in
              run_sequence order. Confirm the root matches{' '}
              <span className="font-mono">{project.merkle_root || '(none yet)'}</span>.
            </li>
            <li>
              Pull the on-chain anchor at <span className="font-mono">{scrId}</span>
              {project.rvn_txid ? <> (RVN tx <span className="font-mono">{project.rvn_txid.slice(0, 16)}…</span>)</> : null}.
              Its committed root must equal the root above. If it does, every
              field shown — inputs, workflow, output, order, time — is provably
              untampered as of the on-chain timestamp.
            </li>
          </ol>
          <p className="mt-3 text-[10px] text-scruple-muted">
            HMAC <code>witness_signature</code> on each row is Scruple&apos;s
            per-record seal (symmetric); the on-chain mint wallet is the
            public issuer identity. The leaf preimages above are what the
            mint commits to.
          </p>
        </div>
      </section>

      {/* Pivot E6: execution attestation summary — promotes the trust ladder
          (D-016) to the receipt. */}
      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-scruple-muted">
          Execution attestation
        </h2>
        <AttestationSummary iterations={iterations} />
      </section>

      {trainingRuns.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-widest text-scruple-muted">
            Model fingerprints ({trainingRuns.length})
          </h2>
          <p className="mt-1 text-[10px] text-scruple-muted">
            Each training output is fingerprinted with two independent hashes — a
            full-bytes SHA-256 (<span className="font-mono">content</span>) and a
            SHA-256 of the safetensors header (<span className="font-mono">structural</span>).
            Anyone holding the file can verify either or both.
          </p>
          <div className="mt-3 space-y-3">
            {trainingRuns.map(run => (
              <ModelFingerprintCard key={run.id} run={run} />
            ))}
          </div>
        </section>
      )}

      {(project.rvn_txid || project.ipfs_cid || project.arweave_uri) && (
        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-widest text-scruple-muted">
            On-chain references
          </h2>
          <div className="mt-2 space-y-1 text-xs">
            {project.rvn_txid && <div>RVN tx: <span className="font-mono">{project.rvn_txid}</span></div>}
            {project.ipfs_cid && <div>IPFS CID: <span className="font-mono">{project.ipfs_cid}</span></div>}
            {project.arweave_uri && <div>Arweave: <span className="font-mono">{project.arweave_uri}</span></div>}
          </div>
        </section>
      )}

      <footer className="mt-12 border-t border-scruple-border pt-4 text-[10px] text-scruple-muted">
        Provenance receipt generated by Scruple Web. Patent Pending.
      </footer>
    </main>
  );
}

function IterationCard({ it }: { it: IterationRow }) {
  // Parse the input-artifact manifest (training images, init image, etc.)
  // so we can render kind / filename / hash per input. The bytes themselves
  // live at /api/artifact/[hash], content-addressed by the input bytes.
  let inputs: InputArtifactRecord[] = [];
  if (it.input_artifacts) {
    try {
      inputs = JSON.parse(it.input_artifacts) as InputArtifactRecord[];
    } catch {
      inputs = [];
    }
  }
  const scheme = it.leaf_scheme ?? 'v1';
  const backend = (it as { execution_backend?: string | null }).execution_backend ?? null;
  const computeMachineId = (it as { compute_machine_id?: string | null }).compute_machine_id ?? null;
  return (
    <div className="rounded-md border border-scruple-border bg-scruple-surface p-3 text-[11px]">
      {/* header row: # · scheme · timestamp · backend · machine · output_kind */}
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-scruple-text">#{it.run_sequence}</span>
        <SchemeBadge scheme={scheme} />
        <span className="rounded-full border border-scruple-border bg-scruple-bg px-1.5 py-0.5 font-mono text-[9px] text-scruple-muted">
          {it.output_kind}
        </span>
        <BackendBadge backend={backend} />
        <MachineBadge machineId={computeMachineId} />
        <span className="ml-auto text-[10px] text-scruple-muted">
          {new Date(it.timestamp).toLocaleString()}
        </span>
      </div>

      {/* hash grid: leaf, output, input, workflow, model fingerprints */}
      <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1">
        <HashRow label="leaf_hash" value={it.leaf_hash} />
        <HashRow label="output_hash" value={it.output_hash} muted />
        <HashRow label="input_hash" value={it.input_hash} muted />
        {scheme === 'v2' && it.workflow_hash && (
          <HashRow label="workflow_hash" value={it.workflow_hash} muted />
        )}
        {scheme === 'v2' && it.model_fingerprints_hash && (
          <HashRow label="models_hash" value={it.model_fingerprints_hash} muted />
        )}
      </dl>

      {/* model files loaded in-container — pins the actual weights that
          produced this run; later re-hash of the file at the same path
          detects any swap. */}
      <ModelFingerprintsBlock raw={it.model_fingerprints} />

      {/* input artifacts */}
      {inputs.length > 0 && (
        <div className="mt-2">
          <div className="text-[9px] uppercase tracking-widest text-scruple-muted">
            Input artifacts ({inputs.length})
          </div>
          <ul className="mt-1 space-y-0.5">
            {inputs.map((a) => (
              <li key={a.hash} className="flex items-baseline gap-2 text-[10px]">
                <span className="rounded border border-scruple-border bg-scruple-bg px-1 py-0.5 font-mono text-[9px] text-scruple-muted">
                  {a.kind}
                </span>
                <span className="font-mono text-scruple-muted">
                  {a.filename ?? '(unnamed)'}
                </span>
                <span className="ml-auto font-mono text-[9px] text-scruple-muted">
                  {a.hash.slice(0, 16)}…
                </span>
                <span className="text-[9px] text-scruple-muted">{formatBytes(a.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* witness footer */}
      <div className="mt-2 flex items-baseline gap-2 border-t border-scruple-border pt-2 text-[10px]">
        {it.witness_id ? (
          <>
            <span className="text-scruple-muted">witness</span>
            <span className="font-mono text-scruple-success">{it.witness_id}</span>
            {it.witness_signature && (
              <span className="font-mono text-scruple-muted" title={it.witness_signature}>
                · sig {it.witness_signature.slice(0, 12)}…
              </span>
            )}
          </>
        ) : (
          <span className="text-scruple-muted">unwitnessed</span>
        )}
      </div>
    </div>
  );
}

interface ModelFingerprintEntry {
  content_hash?: string | null;
  header_hash?: string | null;
  header_size?: number | null;
  bytes?: number;
  mtime?: number;
}

function ModelFingerprintsBlock({ raw }: { raw: string | null }) {
  if (!raw) return null;
  let manifest: Record<string, ModelFingerprintEntry> = {};
  try {
    manifest = JSON.parse(raw) as Record<string, ModelFingerprintEntry>;
  } catch { return null; }
  const entries = Object.entries(manifest);
  if (entries.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-[9px] uppercase tracking-widest text-scruple-muted">
        Model files loaded ({entries.length})
      </div>
      <ul className="mt-1 space-y-1">
        {entries.map(([path, fp]) => (
          <li key={path} className="rounded border border-scruple-border bg-scruple-bg px-2 py-1 text-[10px]">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-scruple-text">{path}</span>
              {fp.bytes != null && (
                <span className="ml-auto text-[9px] text-scruple-muted">{formatBytes(fp.bytes)}</span>
              )}
            </div>
            <div className="mt-0.5 grid grid-cols-[80px_1fr] gap-x-2 gap-y-0.5 text-[9px]">
              {fp.content_hash && (
                <>
                  <span className="uppercase tracking-widest text-scruple-muted">content</span>
                  <span className="break-all font-mono text-scruple-muted" title={fp.content_hash}>{fp.content_hash}</span>
                </>
              )}
              {fp.header_hash && (
                <>
                  <span className="uppercase tracking-widest text-scruple-muted">header</span>
                  <span className="break-all font-mono text-scruple-muted" title={fp.header_hash}>{fp.header_hash}</span>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HashRow({ label, value, muted }: { label: string; value: string | null; muted?: boolean }) {
  return (
    <>
      <dt className="text-[9px] uppercase tracking-widest text-scruple-muted">{label}</dt>
      <dd
        className={`break-all font-mono text-[10px] ${muted ? 'text-scruple-muted' : 'text-scruple-text'}`}
        title={value ?? ''}
      >
        {value ?? '—'}
      </dd>
    </>
  );
}

function SchemeBadge({ scheme }: { scheme: 'v1' | 'v2' }) {
  const cls =
    scheme === 'v2'
      ? 'border-scruple-accent/40 bg-scruple-accent/10 text-scruple-accent'
      : 'border-scruple-border bg-scruple-bg text-scruple-muted';
  return (
    <span className={`rounded-full border px-1.5 py-0.5 font-mono text-[9px] ${cls}`} title={
      scheme === 'v2'
        ? 'Leaf hashes the full record (inputs + workflow + order + time)'
        : 'Legacy leaf — hashes only the output bytes'
    }>
      leaf:{scheme}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-scruple-border bg-scruple-surface px-3 py-2">
      <div className="text-[9px] uppercase tracking-widest text-scruple-muted">{label}</div>
      <div className="mt-1 text-sm">{value}</div>
    </div>
  );
}

function BackendBadge({ backend }: { backend: string | null }) {
  if (!backend) return <span className="text-scruple-muted">—</span>;
  const styles: Record<string, string> = {
    'modal-tee': 'border-scruple-success/40 bg-scruple-success/10 text-scruple-success',
    'modal-test': 'border-scruple-warn/40 bg-scruple-warn/10 text-scruple-warn',
    comfydeploy: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-400',
    'local-tunnel': 'border-scruple-border bg-scruple-bg text-scruple-text',
  };
  const cls = styles[backend] ?? 'border-scruple-border bg-scruple-bg text-scruple-muted';
  return (
    <span className={`rounded-full border px-1.5 py-0.5 font-mono text-[9px] ${cls}`}>
      {backend}
    </span>
  );
}

/**
 * Stage 1 of Settings → Compute: surface the catalog id the user
 * selected at the time of this iteration. Legacy rows (NULL) render
 * as "T4 (legacy)" because every pre-Stage-1 iteration ran on the
 * single shared Modal T4 endpoint.
 */
function MachineBadge({ machineId }: { machineId: string | null }) {
  const label = machineId ?? 'T4 (legacy)';
  const cls = machineId
    ? 'border-scruple-accent-primary/40 bg-scruple-accent-primary/10 text-scruple-accent-primary'
    : 'border-scruple-border bg-scruple-bg text-scruple-muted';
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 font-mono text-[9px] ${cls}`}
      title={machineId ? `compute machine: ${machineId}` : 'iteration predates Settings → Compute (Stage 1)'}
    >
      {label}
    </span>
  );
}

function AttestationSummary({ iterations }: { iterations: Array<{ execution_backend?: string | null; execution_attestation?: string | null }> }) {
  const backends = new Map<string, number>();
  let attested = 0;
  for (const it of iterations) {
    const b = it.execution_backend ?? 'unknown';
    backends.set(b, (backends.get(b) ?? 0) + 1);
    if (it.execution_attestation) attested += 1;
  }
  if (backends.size === 1 && backends.has('unknown')) {
    return (
      <p className="mt-2 text-xs text-scruple-muted">
        These iterations predate the execution-backend recording (Pivot Phase E).
        The chain still witnesses the bytes, but doesn&apos;t carry per-iteration
        backend attribution.
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-2">
      <div className="rounded-md border border-scruple-border bg-scruple-surface p-3 text-xs">
        <div className="flex items-baseline justify-between">
          <span>Trust ceiling for this project</span>
          <strong>
            {attested === iterations.length && iterations.length > 0
              ? 'L1 + L2 + L3 (hardware-attested)'
              : attested > 0
                ? 'Mixed — some iterations attested'
                : 'L1 + L2 (chain isolation + witness)'}
          </strong>
        </div>
        <div className="mt-1 text-[10px] text-scruple-muted">
          L1 capture isolation (server-side hashing) + L2 witness chain
          {attested > 0 ? ` + L3 hardware attestation on ${attested}/${iterations.length} iterations` : ''}.
        </div>
      </div>
      <ul className="space-y-1 text-[11px]">
        {Array.from(backends.entries()).map(([backend, count]) => (
          <li key={backend} className="flex items-center justify-between rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5">
            <span><BackendBadge backend={backend === 'unknown' ? null : backend} /></span>
            <span className="text-scruple-muted">{count} iteration{count === 1 ? '' : 's'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function maxDepth(nodes: MerkleNodeRow[]): number {
  return nodes.reduce((max, n) => Math.max(max, n.level), 0);
}

interface StructuralSummaryJSON {
  tensorCount?: number;
  totalParamCount?: number;
  dtypes?: string[];
  shapesSketch?: Record<string, string>;
  modelTypeGuess?: string;
  fileSize?: number;
  headerSize?: number;
  metadata?: Record<string, string>;
}

function ModelFingerprintCard({ run }: { run: TrainingRunRow }) {
  let summary: StructuralSummaryJSON | null = null;
  if (run.structural_summary) {
    try {
      summary = JSON.parse(run.structural_summary) as StructuralSummaryJSON;
    } catch {
      summary = null;
    }
  }
  const guess = summary?.modelTypeGuess ?? '—';
  const tensorCount = run.tensor_count ?? summary?.tensorCount ?? null;
  const params = summary?.totalParamCount;
  const fileSize = summary?.fileSize;
  const dtypes = summary?.dtypes;
  return (
    <div className="rounded-md border border-scruple-border bg-scruple-surface p-3 text-xs">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="rounded-full border border-scruple-accent/40 bg-scruple-accent/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-scruple-accent">
            {guess}
          </span>
          <span className="font-mono text-[11px] text-scruple-text">
            {run.output_filename ?? `run #${run.run_sequence}`}
          </span>
        </div>
        <span className="text-[10px] text-scruple-muted">
          run #{run.run_sequence}
          {run.completed_at && ` · ${new Date(run.completed_at).toLocaleDateString()}`}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-[10px] uppercase tracking-widest text-scruple-muted">content hash</dt>
        <dd className="font-mono text-scruple-text">
          {run.model_hash ? `${run.model_hash.slice(0, 16)}…${run.model_hash.slice(-8)}` : '—'}
        </dd>
        <dt className="text-[10px] uppercase tracking-widest text-scruple-muted">structural hash</dt>
        <dd className="font-mono text-scruple-text">
          {run.header_hash ? `${run.header_hash.slice(0, 16)}…${run.header_hash.slice(-8)}` : '—'}
        </dd>
        {tensorCount !== null && (
          <>
            <dt className="text-[10px] uppercase tracking-widest text-scruple-muted">tensors</dt>
            <dd className="font-mono text-scruple-text">{tensorCount.toLocaleString()}</dd>
          </>
        )}
        {params !== undefined && (
          <>
            <dt className="text-[10px] uppercase tracking-widest text-scruple-muted">parameters</dt>
            <dd className="font-mono text-scruple-text">{formatParamCount(params)}</dd>
          </>
        )}
        {fileSize !== undefined && (
          <>
            <dt className="text-[10px] uppercase tracking-widest text-scruple-muted">file size</dt>
            <dd className="font-mono text-scruple-text">{formatBytes(fileSize)}</dd>
          </>
        )}
        {dtypes && dtypes.length > 0 && (
          <>
            <dt className="text-[10px] uppercase tracking-widest text-scruple-muted">dtypes</dt>
            <dd className="font-mono text-scruple-text">{dtypes.join(', ')}</dd>
          </>
        )}
      </dl>

    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatParamCount(n: number): string {
  if (n < 1_000_000) return n.toLocaleString();
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  return `${(n / 1_000_000_000).toFixed(2)} B`;
}
