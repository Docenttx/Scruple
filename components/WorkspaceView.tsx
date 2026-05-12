// WorkspaceView — port of renderer/render-workspace.js (desktop).
// Header (name + status badge + active indicator + tracking button),
// stats row (iteration_count, merkle_root, scr_id), iteration grid,
// lock buttons.

import clsx from 'clsx';
import { LOCK_STATE_LABELS, type ProjectRow, type IterationRow } from '@/lib/types';
import TrackingButton from './TrackingButton';
import LockButtons from './LockButtons';
import IterationGridLive from './IterationGridLive';
import WorkflowField from './WorkflowField';
import GeneratePanel from './GeneratePanel';
import WorkflowUploader from './WorkflowUploader';

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
    // Desktop catalog §2 Layout: .workspace — max-width 1200px,
    // centered margin: 0 auto, 24px padding.
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-light text-scruple-text-primary">{project.name}</h1>
            <StatusBadge status={project.status} />
            {isActive && (
              // Desktop TRACKING badge: red, not green
              <span className="rounded-full border border-scruple-danger/40 bg-scruple-danger/15 px-2 py-0.5 text-2xs font-bold uppercase tracking-wider2 text-scruple-danger">
                ● Tracking
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-scruple-text-secondary">
            Created {new Date(project.created_at).toLocaleDateString()} · Type {project.type}
          </p>
          <div className="mt-2">
            <WorkflowField
              projectId={project.id}
              initialWorkflowId={project.comfy_workflow_id}
              disabled={isLocked}
            />
          </div>
        </div>
        <TrackingButton projectId={project.id} isActive={isActive} disabled={isLocked} />
      </div>

      {/* Generate panel + Workflow uploader (advanced users) */}
      {!isLocked && (
        <>
          <GeneratePanel
            projectId={project.id}
            workflowReady={!!project.comfy_workflow_id}
            disabled={isLocked}
          />
          <WorkflowUploader projectId={project.id} disabled={isLocked} />
        </>
      )}

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

      {/* Iterations — desktop uses CSS Grid auto-fill 280px minmax */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider2 text-scruple-text-secondary">
          Iterations
        </h2>
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
