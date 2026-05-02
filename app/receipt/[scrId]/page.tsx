// Public, unauthenticated provenance receipt at /receipt/SCR_XXXXXX.
// Renders project metadata + Merkle proof + witness signatures so any
// visitor can verify a project's claim.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { conn } from '@/lib/db/sqlite';
import { LOCK_STATE_LABELS, type ProjectRow, type IterationRow, type MerkleNodeRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default function ReceiptPage({ params }: { params: { scrId: string } }) {
  const { scrId } = params;
  if (!/^(SCR|SCRB)_[A-F0-9]{6}$/.test(scrId)) notFound();

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
              Witness server signature
            </h2>
            <pre className="mt-2 overflow-x-auto rounded-md border border-scruple-border bg-scruple-surface p-3 text-[11px] font-mono">
              {project.witness_signature}
            </pre>
          </>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-scruple-muted">
          Iterations ({iterations.length})
        </h2>
        <div className="mt-2 overflow-x-auto rounded-md border border-scruple-border">
          <table className="w-full text-[11px]">
            <thead className="bg-scruple-surface text-scruple-muted">
              <tr>
                <th className="px-2 py-2 text-left">#</th>
                <th className="px-2 py-2 text-left">leaf hash</th>
                <th className="px-2 py-2 text-left">timestamp</th>
                <th className="px-2 py-2 text-left">witness</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-scruple-border">
              {iterations.map((it) => (
                <tr key={it.id}>
                  <td className="px-2 py-2 font-mono">{it.run_sequence}</td>
                  <td className="px-2 py-2 font-mono text-scruple-muted">
                    {it.leaf_hash.slice(0, 24)}…
                  </td>
                  <td className="px-2 py-2 text-scruple-muted">
                    {new Date(it.timestamp).toLocaleString()}
                  </td>
                  <td className="px-2 py-2 font-mono text-[10px]">
                    {it.witness_id ? (
                      <span className="text-scruple-success">{it.witness_id.slice(0, 16)}…</span>
                    ) : (
                      <span className="text-scruple-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-scruple-border bg-scruple-surface px-3 py-2">
      <div className="text-[9px] uppercase tracking-widest text-scruple-muted">{label}</div>
      <div className="mt-1 text-sm">{value}</div>
    </div>
  );
}

function maxDepth(nodes: MerkleNodeRow[]): number {
  return nodes.reduce((max, n) => Math.max(max, n.level), 0);
}
