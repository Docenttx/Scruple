// Receipt page at /receipt/SCR_XXXXXX. Renders project metadata + Merkle
// proof + witness signatures.
//
// PRIVACY MODEL (2026-07-14): the receipt is user-controlled by design.
// Public reachability is granted ONLY when the artist has affirmatively
// published (IPFS-pinned = projects.ipfs_cid IS NOT NULL). Otherwise the
// page is owner-only — third parties must obtain the receipt package from
// the artist directly. This matches the stated Scruple design intent:
// the only things Scruple affirmatively makes public are the on-chain
// markers (RVN asset ID, Arweave TX ID). Everything else stays with the
// artist unless they opt to pin.
//
// See docs/wo/RECEIPT_PRIVACY_CLEANUP.md for the design rationale.

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { conn } from '@/lib/db/sqlite';
import { auth } from '@/lib/auth/auth';
import {
  LOCK_STATE_LABELS,
  type ProjectRow,
  type IterationRow,
  type MerkleNodeRow,
  type TrainingRunRow,
} from '@/lib/types';
import type { InputArtifactRecord } from '@/lib/iterations/ingest';
import { readL2Attestation, type L2Attestation } from '@/lib/l2/attestation';
import { fetchTrustList } from '@/lib/trust/comfyorg';
import { labelManifest, type LabeledCustomNode } from '@/lib/trust/label';

export const dynamic = 'force-dynamic';

// Match the set enforced by /api/projects/[id]/lora-sidecar.c2pa —
// sidecar is served only for projects that have chain-anchored data.
const LOCKED_STATUSES = new Set([
  'local_locked',
  'chain_locked',
  'persistent_locked',
  'permanent_locked',
]);

export default async function ReceiptPage({ params }: { params: { scrId: string } }) {
  const { scrId } = params;
  // Local lock derives a 6-hex suffix from the Merkle root; chain lock
  // (witness server handleLock + handleConfirmAndExecute) derives an
  // 8-hex suffix. Accept either so chain-locked SCR-IDs render.
  if (!/^(SCR|SCRB)_[A-F0-9]{6,8}$/.test(scrId)) notFound();

  const project = conn()
    .prepare(`SELECT * FROM projects WHERE scr_id = ? OR pre_scr_id = ?`)
    .get(scrId, scrId) as ProjectRow | undefined;
  if (!project) notFound();

  // Privacy gate — see file header. Public if the artist has pinned to
  // IPFS (their affirmative publication action). Otherwise owner-only.
  const isPubliclyReachable = Boolean(project.ipfs_cid);
  if (!isPubliclyReachable) {
    const session = await auth();
    const requesterId = (session?.user as { id?: string } | undefined)?.id;
    const isOwner = requesterId && requesterId === project.user_id;
    if (!isOwner) {
      // 404 rather than 401/403 — don't confirm the SCR-ID exists to a
      // third party who can't view it. Preserves plausible deniability
      // about the receipt's existence at this URL.
      notFound();
    }
  }

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

  const l2 = readL2Attestation(scrId, project.pre_scr_id);

  // WO-B2 — fetch ComfyOrg trust list ONCE per receipt render, then
  // label each iteration's stored container_machine_manifest. The
  // fetcher is cached in-process (1h TTL) and returns [] on network
  // failure so trust labeling is best-effort and never blocks the page.
  const trustList = await fetchTrustList();
  const trustByIter = new Map<number, LabeledCustomNode[]>();
  for (const it of iterations) {
    const raw = (it as { container_machine_manifest?: string | null }).container_machine_manifest;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { custom_nodes?: unknown };
      if (Array.isArray(parsed.custom_nodes)) {
        trustByIter.set(it.id, labelManifest(parsed.custom_nodes as never, trustList));
      }
    } catch { /* skip malformed rows */ }
  }

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
            <IterationCard key={it.id} it={it} labeledNodes={trustByIter.get(it.id) ?? null} />
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
          {project.type === 'training' && LOCKED_STATUSES.has(project.status) && (
            <div className="mt-4 rounded-md border border-scruple-accent/40 bg-scruple-accent/[0.03] p-3 print:break-inside-avoid">
              <div className="flex items-baseline justify-between">
                <h3 className="text-[10px] uppercase tracking-widest text-scruple-accent">
                  C2PA sidecar
                </h3>
                <a
                  href={`/api/projects/${project.id}/lora-sidecar.c2pa`}
                  download
                  className="rounded border border-scruple-accent/60 bg-scruple-accent/10 px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-scruple-accent hover:bg-scruple-accent/20"
                >
                  download .c2pa
                </a>
              </div>
              <p className="mt-2 text-[10px] text-scruple-muted">
                A COSE_Sign1-signed C2PA sidecar that binds this trained model to
                its dataset, hyperparameters, and blockchain anchor. Attach it
                alongside the <span className="font-mono">.safetensors</span> file
                when redistributing — any C2PA reader can verify the signature
                and any auditor can walk the chain of custody offline without
                contacting Scruple.
              </p>
              <p className="mt-2 text-[10px] text-scruple-muted">
                Verify with{' '}
                <span className="font-mono">python3 scripts/verify-c2pa-reader.py &lt;sidecar&gt;</span>
                {' '}or any c2pa-python 0.36+ reader on{' '}
                <span className="font-mono">application/c2pa</span>.
              </p>
            </div>
          )}
        </section>
      )}

      {l2 && <L2AttestationSection l2={l2} />}

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

function IterationCard({
  it,
  labeledNodes,
}: {
  it: IterationRow;
  labeledNodes: LabeledCustomNode[] | null;
}) {
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
  // Canvas v2 (WO-9): publication mode controls which hashes are
  // PUBLICLY shown. The leaf preimage always commits everything;
  // this is presentation only.
  const publication: 'full' | 'hash-only' | 'witness-only' =
    (it as { workflow_publication?: 'full' | 'hash-only' | 'witness-only' }).workflow_publication ?? 'full';
  const showWorkflowHash = publication === 'full';
  const showInputHash = publication === 'full';
  const showModelHash = publication === 'full' || publication === 'hash-only';
  const showOutputHash = publication !== 'witness-only';
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

      {/* hash grid — redacted per publication mode (Canvas v2 WO-9).
          full        : all hashes shown
          hash-only   : leaf + output + manifest; workflow + input redacted
          witness-only: leaf + timestamp only ("we saw the artist sign this") */}
      <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1">
        <HashRow label="leaf_hash" value={it.leaf_hash} />
        {showOutputHash && <HashRow label="output_hash" value={it.output_hash} muted />}
        {showInputHash && <HashRow label="input_hash" value={it.input_hash} muted />}
        {showWorkflowHash && (scheme === 'v2' || scheme === 'v2.2') && it.workflow_hash && (
          <HashRow label="workflow_hash" value={it.workflow_hash} muted />
        )}
        {showModelHash && (scheme === 'v2' || scheme === 'v2.2') && it.model_fingerprints_hash && (
          <HashRow label="models_hash" value={it.model_fingerprints_hash} muted />
        )}
      </dl>
      {publication !== 'full' && (
        <p className="mt-1 text-[10px] text-scruple-muted">
          Publication: <span className="font-mono">{publication}</span> —
          {publication === 'hash-only'
            ? ' workflow + input hashes withheld; output + manifest published.'
            : ' artist witness only; recipe and output hash withheld.'}
        </p>
      )}

      {/* model files loaded in-container — pins the actual weights that
          produced this run; later re-hash of the file at the same path
          detects any swap. */}
      <ModelFingerprintsBlock raw={it.model_fingerprints} />

      {/* raw workflow (node choice + wiring + params) — the human-authorship
          claim. Hidden by publication='hash-only' | 'witness-only'.
          Rendered from iterations.metadata.generationSpec.providerExtras.workflowApiJson,
          which is stored raw at ingest time. Never redacted here — the
          publication check above governs whether we render it at all. */}
      {showWorkflowHash && <WorkflowBlock raw={it.metadata} />}

      {/* custom-node trust badges (WO-B2). Best-effort; skips render when
          the runner didn't produce a container_machine_manifest yet OR
          when the ComfyOrg trust-list fetch failed. */}
      {labeledNodes && labeledNodes.length > 0 && (
        <TrustBadgesBlock labeled={labeledNodes} />
      )}

      {/* Watermark derivative + two-download UX (WATERMARK_DESIGN v1.2).
          When a watermarked derivative exists, present both the clean
          master and the released (watermarked) version with clear labels.
          Downstream pipeline work → Master. Public distribution → Release. */}
      <WatermarkAndDownloadBlock it={it} />

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

interface ComfyNodeShape {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

const WATERMARK_TIER_NAMES: Record<number, string> = {
  1: 'C2PA-signed',
  2: 'Checkpoint',
  3: 'Local-lock',
  4: 'Chain-lock (basic)',
  5: 'Chain-lock (pinned)',
};

/**
 * Two-download UX + watermark badge for a single iteration. When a
 * watermarked derivative exists, show BOTH the clean master (for
 * re-editing / re-generation / training input) and the release
 * (watermarked, for public distribution / evidence). Also renders the
 * watermark tier + payload as a badge so verifiers can confirm at a
 * glance. See WATERMARK_DESIGN_v1.md §4.3 (master preservation
 * invariant) and §7.5 (two-download UX).
 */
function WatermarkAndDownloadBlock({ it }: { it: IterationRow }) {
  // Extract watermark fields — some may be undefined on older rows
  // (pre-migration 038) or on iterations that were never watermarked.
  const wm = it as unknown as {
    watermark_derivative_hash?: string | null;
    watermark_payload_hex?: string | null;
    watermark_scheme_version?: number | null;
    watermark_tier?: number | null;
    watermark_signed_at?: string | null;
  };
  const hasDerivative = Boolean(wm.watermark_derivative_hash);
  const tierName = wm.watermark_tier != null ? WATERMARK_TIER_NAMES[wm.watermark_tier] : null;

  // Master download always present. Release only when a derivative exists.
  return (
    <div className="mt-2 border-t border-scruple-border pt-2">
      <div className="text-[9px] uppercase tracking-widest text-scruple-muted">
        Downloads
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-3 text-[10px]">
        {it.output_hash && (
          <a
            href={`/api/artifact/${it.output_hash}`}
            download
            className="rounded border border-scruple-border bg-scruple-bg px-2 py-1 font-mono text-scruple-text hover:bg-scruple-surface"
            title="Clean master bytes — no watermark. Use for re-editing, re-generation, LoRA training input, or any pipeline that would fight a perceptual watermark."
          >
            Master (clean) — {it.output_hash.slice(0, 12)}…
          </a>
        )}
        {hasDerivative && wm.watermark_derivative_hash && (
          <a
            href={`/api/artifact/${wm.watermark_derivative_hash}`}
            download
            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono text-emerald-300 hover:bg-emerald-500/20"
            title="Watermarked release — signed derivative. Use for public distribution, evidence packages, and court-admissible artifacts."
          >
            Release (watermarked) — {wm.watermark_derivative_hash.slice(0, 12)}…
          </a>
        )}
      </div>
      {hasDerivative && (
        <div className="mt-1 flex flex-wrap items-baseline gap-2 text-[9px] text-scruple-muted">
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-emerald-300">
            watermark v{wm.watermark_scheme_version} · tier {wm.watermark_tier} · {tierName}
          </span>
          {wm.watermark_payload_hex && (
            <span className="font-mono" title={wm.watermark_payload_hex}>
              payload {wm.watermark_payload_hex.slice(0, 8)}…
            </span>
          )}
          {wm.watermark_signed_at && (
            <span>signed {new Date(wm.watermark_signed_at).toLocaleString()}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders the raw ComfyUI workflow_api_json for this iteration:
 * a compact "N nodes" summary + a collapsible <details> containing the
 * full JSON. The workflow is the human-authorship claim — the operator
 * chose these specific nodes, wired them THIS way, and set these params.
 *
 * Reads from iterations.metadata.generationSpec.providerExtras.workflowApiJson,
 * which is persisted raw at ingest time (lib/iterations/ingest.ts:308).
 */
function WorkflowBlock({ raw }: { raw: string | null }) {
  if (!raw) return null;
  let workflow: Record<string, ComfyNodeShape> | null = null;
  try {
    const meta = JSON.parse(raw) as {
      generationSpec?: { providerExtras?: { workflowApiJson?: unknown } };
    };
    const wf = meta?.generationSpec?.providerExtras?.workflowApiJson;
    if (wf && typeof wf === 'object' && !Array.isArray(wf)) {
      workflow = wf as Record<string, ComfyNodeShape>;
    }
  } catch {
    /* stored metadata is malformed — silently skip */
  }
  if (!workflow) return null;
  const entries = Object.entries(workflow);
  if (entries.length === 0) return null;

  // Node inventory: unique class_types with counts, natural sort.
  const inventory: Record<string, number> = {};
  for (const [, node] of entries) {
    const key = node.class_type ?? '(unknown)';
    inventory[key] = (inventory[key] ?? 0) + 1;
  }
  const nodeTypeSummary = Object.entries(inventory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => (count > 1 ? `${type} ×${count}` : type));

  const fullJson = JSON.stringify(workflow, null, 2);

  return (
    <details className="mt-2 rounded border border-scruple-border bg-scruple-bg text-[10px]">
      <summary className="cursor-pointer px-2 py-1.5 text-scruple-text hover:bg-scruple-surface">
        <span className="text-[9px] uppercase tracking-widest text-scruple-muted">Workflow</span>
        <span className="ml-2 font-mono">{entries.length} nodes</span>
        <span className="ml-2 text-scruple-muted">·</span>
        <span className="ml-2 font-mono text-scruple-muted">
          {nodeTypeSummary.slice(0, 4).join(', ')}
          {nodeTypeSummary.length > 4 && ` + ${nodeTypeSummary.length - 4} more`}
        </span>
      </summary>
      <div className="border-t border-scruple-border p-2">
        <p className="mb-1 text-[9px] text-scruple-muted">
          The ComfyUI graph — node choice, wiring, and parameters — that produced this output.
          workflow_hash above is sha256 of the canonical (sorted-key) serialization of this JSON.
        </p>
        <pre className="max-h-96 overflow-auto rounded bg-scruple-surface p-2 font-mono text-[9px]">
          {fullJson}
        </pre>
      </div>
    </details>
  );
}

/**
 * Renders ComfyOrg trust-set badges for the container_machine_manifest.
 * Purely a viewer-side label — the trust list is fetched at page render
 * time, NOT folded into the signed leaf. See lib/trust/comfyorg.ts.
 *
 * The color scheme: trusted (green), listed (yellow), unknown (muted).
 * The design intent is that "unknown" is not a rejection — it just means
 * the pack isn't on ComfyOrg's list right now.
 */
function TrustBadgesBlock({ labeled }: { labeled: LabeledCustomNode[] }) {
  const trusted = labeled.filter((n) => n.trust === 'trusted').length;
  const listed = labeled.filter((n) => n.trust === 'listed').length;
  const unknown = labeled.filter((n) => n.trust === 'unknown').length;
  return (
    <details className="mt-2 rounded border border-scruple-border bg-scruple-bg text-[10px]">
      <summary className="cursor-pointer px-2 py-1.5 text-scruple-text hover:bg-scruple-surface">
        <span className="text-[9px] uppercase tracking-widest text-scruple-muted">
          Node trust
        </span>
        <span className="ml-2 font-mono text-scruple-muted">
          {trusted > 0 && <span className="text-emerald-400">{trusted} trusted</span>}
          {trusted > 0 && (listed > 0 || unknown > 0) && ' · '}
          {listed > 0 && <span className="text-amber-400">{listed} listed</span>}
          {listed > 0 && unknown > 0 && ' · '}
          {unknown > 0 && <span className="text-scruple-muted">{unknown} unknown</span>}
        </span>
      </summary>
      <div className="border-t border-scruple-border p-2">
        <p className="mb-1 text-[9px] text-scruple-muted">
          Custom-node packs cross-checked against the ComfyOrg trust list at
          the time this receipt was rendered.
          <strong className="text-scruple-muted">
            {' '}
            The trust label is a viewer-side annotation only — it is NOT part
            of the signed leaf preimage
          </strong>{' '}
          (which would fossilize a moving list). Trust status can change over
          time as ComfyOrg adds or removes packs.
        </p>
        <ul className="mt-1 space-y-0.5">
          {labeled.map((n, i) => (
            <li
              key={`${n.pack}-${i}`}
              className="flex items-baseline gap-2 rounded border border-scruple-border bg-scruple-surface px-2 py-1"
            >
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                  n.trust === 'trusted'
                    ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : n.trust === 'listed'
                      ? 'border border-amber-500/40 bg-amber-500/10 text-amber-300'
                      : 'border border-scruple-border bg-scruple-bg text-scruple-muted'
                }`}
                title={
                  n.trust === 'trusted'
                    ? 'Pack appears on ComfyOrg trust list; commit matches list-latest (or list has no commit pin)'
                    : n.trust === 'listed'
                      ? 'Pack is on the list but the container ran a different commit than the list-latest'
                      : 'Pack is not on the ComfyOrg trust list. Not necessarily bad — just not blessed.'
                }
              >
                {n.trust}
              </span>
              <span className="font-mono text-scruple-text">{n.pack}</span>
              {n.commit_sha && (
                <span className="ml-2 font-mono text-[9px] text-scruple-muted" title={n.commit_sha}>
                  @ {n.commit_sha.slice(0, 8)}
                </span>
              )}
              {n.trust_repository && (
                <span className="ml-2 text-[9px] text-scruple-muted">
                  {n.trust_repository.replace(/^https?:\/\/(?:www\.)?github\.com\//, '')}
                </span>
              )}
              {n.trust_tags && n.trust_tags.length > 0 && (
                <span className="ml-2 text-[9px] text-emerald-300">
                  {n.trust_tags.join(' · ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </details>
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

function SchemeBadge({ scheme }: { scheme: 'v1' | 'v2' | 'v2.2' }) {
  const cls =
    scheme === 'v2.2'
      ? 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300'
      : scheme === 'v2'
        ? 'border-scruple-accent/40 bg-scruple-accent/10 text-scruple-accent'
        : 'border-scruple-border bg-scruple-bg text-scruple-muted';
  const title =
    scheme === 'v2.2'
      ? 'Leaf hashes the full record + the pinned-manifest hash (workflow toolchain bound to provenance)'
      : scheme === 'v2'
        ? 'Leaf hashes the full record (inputs + workflow + order + time)'
        : 'Legacy leaf — hashes only the output bytes';
  return (
    <span className={`rounded-full border px-1.5 py-0.5 font-mono text-[9px] ${cls}`} title={title}>
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

function L2AttestationSection({ l2 }: { l2: L2Attestation }) {
  return (
    <section className="mt-8 rounded-md border-2 border-scruple-accent/60 bg-scruple-accent/[0.03] p-4 print:break-inside-avoid">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs uppercase tracking-widest text-scruple-accent">
          L2 Attestation
        </h2>
        <span className="text-[10px] text-scruple-muted">
          C2PA Assurance Level 2 · SEV-SNP substrate
        </span>
      </div>
      <p className="mt-1 text-[10px] text-scruple-muted">
        Every iteration output is C2PA-signed by a distinct ES256 key (creative-work-level provenance).
        The witness Merkle root is separately signed by an Ed25519 key (attestation-level).
        Both keys are attested to run in an AMD SEV-SNP Confidential VM with SoftHSM
        key confinement (see §6.1.2 + §6.2.2 of the C2PA GPSR).
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 text-[11px] md:grid-cols-2">
        {/* C2PA signer */}
        <div className="rounded border border-scruple-border bg-scruple-surface p-3">
          <div className="text-[10px] uppercase tracking-widest text-scruple-muted">
            C2PA signer (per-iteration cert)
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1">
            <dt className="col-span-1 text-[10px] uppercase text-scruple-muted">subject</dt>
            <dd className="col-span-2 font-mono text-[10px] text-scruple-text">{l2.c2pa.signer_cert_subject}</dd>
            <dt className="col-span-1 text-[10px] uppercase text-scruple-muted">issuer</dt>
            <dd className="col-span-2 font-mono text-[10px] text-scruple-text">{l2.c2pa.signer_cert_issuer}</dd>
            <dt className="col-span-1 text-[10px] uppercase text-scruple-muted">root CA</dt>
            <dd className="col-span-2 font-mono text-[10px] text-scruple-text">{l2.c2pa.root_ca_subject}</dd>
            <dt className="col-span-1 text-[10px] uppercase text-scruple-muted">pubkey sha256</dt>
            <dd className="col-span-2 font-mono text-[10px] text-scruple-text break-all">{l2.c2pa.signer_pubkey_sha256}</dd>
            <dt className="col-span-1 text-[10px] uppercase text-scruple-muted">chain sha256</dt>
            <dd className="col-span-2 font-mono text-[10px] text-scruple-text break-all">{l2.c2pa.cert_chain_sha256}</dd>
          </dl>
          <p className="mt-2 text-[10px] italic text-scruple-muted">{l2.c2pa.profile_notes}</p>
        </div>

        {/* Witness signer */}
        <div className="rounded border border-scruple-border bg-scruple-surface p-3">
          <div className="text-[10px] uppercase tracking-widest text-scruple-muted">
            Witness checkpoint signer (Merkle root cert)
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1">
            <dt className="col-span-1 text-[10px] uppercase text-scruple-muted">algorithm</dt>
            <dd className="col-span-2 font-mono text-[10px] text-scruple-text">{l2.witness.signer_pubkey_alg}</dd>
            <dt className="col-span-1 text-[10px] uppercase text-scruple-muted">pubkey sha256</dt>
            <dd className="col-span-2 font-mono text-[10px] text-scruple-text break-all">{l2.witness.signer_pubkey_sha256}</dd>
            <dt className="col-span-1 text-[10px] uppercase text-scruple-muted">sign-input prefix</dt>
            <dd className="col-span-2 font-mono text-[10px] text-scruple-text">{l2.witness.sign_input_prefix}</dd>
            <dt className="col-span-1 text-[10px] uppercase text-scruple-muted">signature</dt>
            <dd className="col-span-2 break-all font-mono text-[10px] text-scruple-text">{l2.witness.signature_b64.slice(0, 24)}…{l2.witness.signature_b64.slice(-16)}</dd>
          </dl>
        </div>
      </div>

      {/* SEV-SNP substrate */}
      <div className="mt-3 rounded border border-scruple-border bg-scruple-surface p-3">
        <div className="text-[10px] uppercase tracking-widest text-scruple-muted">
          SEV-SNP substrate (AMD hardware Root of Trust)
        </div>
        <dl className="mt-2 grid grid-cols-4 gap-x-2 gap-y-1 text-[10px]">
          <dt className="col-span-1 uppercase text-scruple-muted">measurement</dt>
          <dd className="col-span-3 break-all font-mono text-scruple-text">{l2.sev_snp_substrate.vm_measurement_hex}</dd>
          <dt className="col-span-1 uppercase text-scruple-muted">chip id</dt>
          <dd className="col-span-3 break-all font-mono text-scruple-text">{l2.sev_snp_substrate.chip_id_hex}</dd>
          <dt className="col-span-1 uppercase text-scruple-muted">reported TCB</dt>
          <dd className="col-span-3 font-mono text-scruple-text">{l2.sev_snp_substrate.reported_tcb_hex}</dd>
          <dt className="col-span-1 uppercase text-scruple-muted">VCEK sha256</dt>
          <dd className="col-span-3 break-all font-mono text-scruple-text">{l2.sev_snp_substrate.vcek_der_sha256}</dd>
          <dt className="col-span-1 uppercase text-scruple-muted">bound pubkey</dt>
          <dd className="col-span-3 break-all font-mono text-scruple-text">{l2.sev_snp_substrate.signer_pubkey_bound_sha256}</dd>
        </dl>
        <p className="mt-2 text-[10px] text-scruple-muted">
          Evidence bundle: <span className="font-mono">{l2.sev_snp_substrate.evidence_relpath}</span>
        </p>
      </div>

      {/* Bundle Merkle root — the ONE hash anchored on-chain */}
      <div className="mt-3 rounded border-2 border-scruple-accent/60 bg-scruple-surface p-3">
        <div className="text-[10px] uppercase tracking-widest text-scruple-accent">
          Full-send bundle root
        </div>
        <div className="mt-2 grid grid-cols-4 gap-x-2 gap-y-1 text-[10px]">
          <dt className="col-span-1 uppercase text-scruple-muted">merkle root</dt>
          <dd className="col-span-3 break-all font-mono text-scruple-text">{l2.merkle_root_sha256}</dd>
          <dt className="col-span-1 uppercase text-scruple-muted">bundle sha256</dt>
          <dd className="col-span-3 break-all font-mono text-scruple-text">{l2.bundle_root}</dd>
          <dt className="col-span-1 uppercase text-scruple-muted">bundle folder</dt>
          <dd className="col-span-3 font-mono text-scruple-text">{l2.bundle_relpath}</dd>
          <dt className="col-span-1 uppercase text-scruple-muted">leaves</dt>
          <dd className="col-span-3 text-scruple-text">{l2.leaves.length} iterations, each C2PA-signed and Merkle-included</dd>
        </div>
      </div>

      <p className="mt-3 text-[10px] text-scruple-muted">
        Decomposition: given the RVN asset data hash, walk to <span className="font-mono">BUNDLE.merkle-root.txt</span> →
        <span className="font-mono"> witness/checkpoint.json</span> → each leaf preimage →
        <span className="font-mono"> iterations/N/output.png</span> +
        <span className="font-mono"> output.c2pa.png</span>. Verify signatures with
        <span className="font-mono"> l2/c2pa-cert-chain.pem</span> +
        <span className="font-mono"> l2/witness-ed25519-pubkey.pem</span>. Verify substrate against
        <span className="font-mono"> l2/sev-snp-substrate/</span>.
      </p>
    </section>
  );
}

function formatParamCount(n: number): string {
  if (n < 1_000_000) return n.toLocaleString();
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  return `${(n / 1_000_000_000).toFixed(2)} B`;
}
