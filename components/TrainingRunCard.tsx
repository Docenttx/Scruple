// TrainingRunCard — port of renderTrainingCard from desktop
// renderer/render-workspace.js. Renders one row of training_runs as a card
// with lineage, status, hash details, lock badge. Reverse-ordered list is
// the caller's responsibility (workspace puts newest at top).

import clsx from 'clsx';
import type { TrainingRunRow } from '@/lib/types';

function truncateHash(h: string | null | undefined): string {
  if (!h) return 'N/A';
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'Training…',
  complete: 'Complete',
  incomplete: 'Failed',
};

const LINEAGE_LABELS: Record<string, string> = {
  ROOT: 'Root',
  VERSION: 'Version',
  BRANCH: 'Branch',
};

export default function TrainingRunCard({
  run,
  allRuns,
}: {
  run: TrainingRunRow;
  allRuns: TrainingRunRow[];
}) {
  const isLocked = run.is_locked === 1;
  const lineageKey = (run.lineage_type ?? 'ROOT').toUpperCase();
  const lineageLabel = LINEAGE_LABELS[lineageKey] ?? 'Root';
  const statusLabel = STATUS_LABELS[run.status ?? 'pending'] ?? run.status ?? 'Pending';

  // "Locked chain" — parent run is itself locked. Visual cue: blue accent.
  const hasLockedAncestors =
    run.parent_run_id !== null &&
    allRuns.some(r => r.id === run.parent_run_id && r.is_locked === 1);

  const lineageTone = clsx(
    'rounded-full border px-2 py-0.5 text-2xs uppercase tracking-wider2',
    lineageKey === 'ROOT' && 'border-scruple-border-color text-scruple-text-secondary',
    lineageKey === 'VERSION' && 'border-scruple-accent-secondary/40 text-scruple-accent-secondary',
    lineageKey === 'BRANCH' && 'border-scruple-warn/40 text-scruple-warn',
  );

  const statusTone = clsx(
    'rounded px-2 py-0.5 text-2xs uppercase tracking-wider2',
    (run.status === 'complete') && 'border border-scruple-success/40 text-scruple-success',
    (run.status === 'running') && 'border border-scruple-accent-primary/40 text-scruple-accent-primary',
    (run.status === 'incomplete') && 'border border-scruple-danger/40 text-scruple-danger',
    (run.status === 'pending' || !run.status) && 'border border-scruple-border-color text-scruple-text-deep-muted',
  );

  const baseModel = run.base_model_path
    ? run.base_model_path.split(/[\\/]/).pop() || run.base_model_path
    : 'N/A';

  const completedAt = run.completed_at
    ? `Completed: ${new Date(run.completed_at).toLocaleString()}`
    : run.started_at
      ? `Started: ${new Date(run.started_at).toLocaleString()}`
      : `Created: ${new Date(run.created_at).toLocaleString()}`;

  return (
    <div
      className={clsx(
        'rounded-lg border bg-scruple-surface p-4 transition-colors',
        isLocked
          ? 'border-scruple-success/40'
          : hasLockedAncestors
            ? 'border-scruple-accent-secondary/30'
            : 'border-scruple-border-color',
      )}
      data-run-id={run.id}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={lineageTone} title={lineageKey}>{lineageLabel}</span>
          <span className="truncate font-mono text-xs text-scruple-text-primary">
            {run.output_filename || `Training #${run.id}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={statusTone}>{statusLabel}</span>
          {isLocked && (
            <span
              title="Locked"
              className="rounded-full border border-scruple-success/40 bg-scruple-success/10 px-2 py-0.5 text-2xs uppercase tracking-wider2 text-scruple-success"
            >
              ● Locked
            </span>
          )}
          {run.input_witness_id && (
            <span
              title="Witnessed"
              className="rounded-full border border-scruple-accent-primary/40 bg-scruple-accent-primary/10 px-2 py-0.5 text-2xs uppercase tracking-wider2 text-scruple-accent-primary"
            >
              Secured
            </span>
          )}
        </div>
      </div>

      {/* Lineage connector — parent run reference */}
      {run.parent_run_id !== null && (
        <div className="mt-2 flex items-center gap-2 text-2xs text-scruple-text-secondary">
          <span className="h-px flex-1 bg-scruple-border-color" aria-hidden />
          <span>→ from Run #{run.parent_run_id}</span>
        </div>
      )}

      {/* Details */}
      <dl className="mt-3 grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-2xs">
        <DetailRow label="Base Model">{baseModel}</DetailRow>
        <DetailRow label="Network">
          dim={run.network_dim ?? '?'}, α={run.network_alpha ?? '?'}
        </DetailRow>
        <DetailRow label="Dataset">
          {(run.image_count ?? 0)} images, {(run.caption_count ?? 0)} captions
        </DetailRow>
        {run.dataset_merkle && (
          <DetailRow label="Dataset Merkle">
            <code className="font-mono text-scruple-text-secondary">
              {truncateHash(run.dataset_merkle)}
            </code>
          </DetailRow>
        )}
        {run.header_hash && (
          <DetailRow label="Model Hash">
            <code className="font-mono text-scruple-text-secondary">
              {truncateHash(run.header_hash)}
            </code>
          </DetailRow>
        )}
        {run.parent_seal && (
          <DetailRow label="Parent Seal">
            <code className="font-mono text-scruple-text-secondary">
              {truncateHash(run.parent_seal)}
            </code>
          </DetailRow>
        )}
        {run.scr_id && (
          <DetailRow label="SCR ID" highlight>
            <span className="font-mono text-scruple-accent-primary">{run.scr_id}</span>
          </DetailRow>
        )}
        {run.ipfs_cid && (
          <DetailRow label="IPFS CID">
            <code className="font-mono text-scruple-text-secondary">
              {truncateHash(run.ipfs_cid)}
            </code>
          </DetailRow>
        )}
      </dl>

      {/* Timestamp */}
      <div className="mt-3 text-3xs text-scruple-text-deep-muted">{completedAt}</div>

      {/* Locked footer badge */}
      {isLocked && (
        <div className="mt-3 flex items-center gap-2 border-t border-scruple-border-color pt-2 text-2xs">
          <span className="rounded bg-scruple-success/15 px-1.5 py-0.5 font-bold uppercase tracking-wider2 text-scruple-success">
            LOCKED
          </span>
          {run.lock_txid && (
            <code
              className="truncate font-mono text-scruple-text-secondary"
              title={run.lock_txid}
            >
              TX: {truncateHash(run.lock_txid)}
            </code>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  children,
  highlight,
}: {
  label: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <>
      <dt className={clsx(
        'text-3xs uppercase tracking-widest',
        highlight ? 'text-scruple-accent-primary' : 'text-scruple-text-deep-muted',
      )}>
        {label}
      </dt>
      <dd className="text-scruple-text-primary">{children}</dd>
    </>
  );
}
