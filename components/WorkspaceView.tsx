// WorkspaceView — port of renderer/render-workspace.js (desktop).
// Header (name + status badge + active indicator + tracking button),
// stats row (iteration_count, merkle_root, scr_id), iteration grid,
// lock buttons.

import clsx from 'clsx';
import { LOCK_STATE_LABELS, type ProjectRow, type IterationRow } from '@/lib/types';
import TrackingButton from './TrackingButton';
import LockButtons from './LockButtons';
import IterationGridLive from './IterationGridLive';

function truncateHash(h: string | null): string {
  if (!h) return 'N/A';
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export default function WorkspaceView({
  project,
  iterations,
}: {
  project: ProjectRow;
  iterations: IterationRow[];
}) {
  const isActive = project.is_active === 1;
  const hasContent = iterations.length > 0;
  const isLocked = project.status !== 'unlocked' && project.status !== 'checkpointed';

  return (
    <div className="flex flex-col gap-8 p-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-light">{project.name}</h1>
            <StatusBadge status={project.status} />
            {isActive && (
              <span className="rounded-full border border-scruple-success/40 bg-scruple-success/10 px-2 py-0.5 text-[10px] text-scruple-success">
                ● Tracking
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-scruple-muted">
            Created {new Date(project.created_at).toLocaleDateString()} · Type {project.type}
          </p>
        </div>
        <TrackingButton projectId={project.id} isActive={isActive} disabled={isLocked} />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 md:grid-cols-4">
        <Stat label="Iterations" value={String(project.iteration_count)} />
        <Stat label="Merkle Root" value={truncateHash(project.merkle_root)} mono />
        {project.scr_id ? (
          <Stat label="SCR ID" value={project.scr_id} highlight mono />
        ) : (
          <Stat label="SCR ID" value="—" />
        )}
        <Stat label="Witnessed" value={String(project.witnessed_count)} />
      </div>

      {/* Iterations */}
      <section>
        <h2 className="mb-3 text-xs uppercase tracking-widest text-scruple-muted">Iterations</h2>
        <IterationGridLive
          initial={iterations}
          projectId={project.id}
          isActive={isActive}
        />
      </section>

      {/* Lock section */}
      {!isActive && (
        <section>
          <h2 className="mb-3 text-xs uppercase tracking-widest text-scruple-muted">
            Lock project
          </h2>
          <LockButtons project={project} hasContent={hasContent} />
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={clsx(
        'rounded-md border px-3 py-2',
        highlight
          ? 'border-scruple-accent/40 bg-scruple-accent/5'
          : 'border-scruple-border bg-scruple-surface',
      )}
    >
      <div className="text-[10px] uppercase tracking-widest text-scruple-muted">{label}</div>
      <div className={clsx('mt-1 text-sm', mono && 'font-mono')}>{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: keyof typeof LOCK_STATE_LABELS }) {
  const tone = clsx(
    'rounded px-2 py-0.5 text-[10px]',
    status === 'unlocked' && 'border border-scruple-border text-scruple-muted',
    status === 'checkpointed' && 'border border-scruple-warn/40 text-scruple-warn',
    status === 'local_locked' && 'border border-scruple-success/40 text-scruple-success',
    status === 'chain_locked' && 'border border-scruple-accent/40 text-scruple-accent',
    (status === 'persistent_locked' || status === 'permanent_locked') &&
      'border border-scruple-accent text-scruple-accent',
  );
  return <span className={tone}>{LOCK_STATE_LABELS[status]}</span>;
}
