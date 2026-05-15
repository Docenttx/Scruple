// WorkspaceView — port of renderer/render-workspace.js (desktop).
// Read-only project state view. Prompts + workflow editing live on the
// /canvas page — the workspace observes what gets captured, it does not
// dispatch generation.
//
// Header (name + status badge + tracking badge + Start/Stop Tracking),
// stats row (count / Merkle Root / SCR-ID),
// content section that branches on project.type:
//   image    → IterationGridLive (covers txt2img/img2img/upscale/etc.)
//   video    → placeholder "Video pipeline not yet implemented"
//   training → PreflightPanel + reverse-ordered TrainingRunCards
// Lock section (when not actively tracking) — Finalize/Checkpoint/Chain.

import clsx from 'clsx';
import { LOCK_STATE_LABELS, type ProjectRow, type IterationRow, type TrainingRunRow } from '@/lib/types';
import TrackingButton from './TrackingButton';
import LockButtons from './LockButtons';
import IterationGridLive from './IterationGridLive';
import TrainingRunCard from './TrainingRunCard';
import PreflightPanel from './PreflightPanel';

function truncateHash(h: string | null): string {
  if (!h) return 'N/A';
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export default function WorkspaceView({
  project,
  iterations,
  trainingRuns,
}: {
  project: ProjectRow;
  iterations: IterationRow[];
  trainingRuns: TrainingRunRow[];
}) {
  const isActive = project.is_active === 1;
  const hasIterations = iterations.length > 0;
  const hasTrainingRuns = trainingRuns.length > 0;
  const hasContent =
    project.type === 'training' ? hasTrainingRuns :
    project.type === 'image' ? hasIterations :
    false; // video has no content concept yet
  const isLocked = project.status !== 'unlocked' && project.status !== 'checkpointed';
  const currentRunId = trainingRuns.length > 0 ? trainingRuns[trainingRuns.length - 1].id : null;

  return (
    // Desktop catalog §2 Layout: .workspace — max-width 1200px,
    // centered margin: 0 auto, 24px padding.
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6">
      {/* Header — workspace-title (left) + workspace-actions (right) */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
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
        </div>
        <div className="shrink-0">
          <TrackingButton projectId={project.id} isActive={isActive} disabled={isLocked} />
        </div>
      </div>

      {/* Stats — desktop has 3 max (count / Merkle / SCR) */}
      <div className="grid grid-cols-3 gap-4">
        <Stat label={statLabelForType(project.type)} value={String(countForType(project, trainingRuns))} />
        <Stat label="Merkle Root" value={truncateHash(project.merkle_root)} mono />
        {project.scr_id ? (
          <Stat label="SCR ID" value={project.scr_id} highlight mono />
        ) : (
          <Stat label="SCR ID" value="—" />
        )}
      </div>

      {/* Content — branches on project type */}
      {project.type === 'training' ? (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider2 text-scruple-text-secondary">
            Training Runs
          </h2>
          <PreflightPanel runId={currentRunId} />
          <div className="mt-4 space-y-3">
            {hasTrainingRuns ? (
              [...trainingRuns]
                .reverse()
                .map(run => (
                  <TrainingRunCard key={run.id} run={run} allRuns={trainingRuns} />
                ))
            ) : (
              <div className="rounded-md border border-dashed border-scruple-border-color bg-scruple-surface/50 p-8 text-center">
                <p className="text-sm text-scruple-text-deep-muted">
                  No training runs captured yet. Start training in Kohya to see them here.
                </p>
              </div>
            )}
          </div>
        </section>
      ) : project.type === 'video' ? (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider2 text-scruple-text-secondary">
            Video
          </h2>
          <div className="rounded-md border border-dashed border-scruple-border-color bg-scruple-surface/50 p-8 text-center">
            <p className="text-sm text-scruple-text-deep-muted">
              Video pipeline not yet implemented. This project type is reserved — capture support lands in a future release.
            </p>
          </div>
        </section>
      ) : (
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
      )}

      {/* Lock section */}
      {!isActive && (
        <section>
          <h2 className="mb-3 text-xs uppercase tracking-widest text-scruple-muted">
            Lock project
          </h2>
          {!hasContent && (
            <p className="mb-3 rounded-md border border-scruple-border bg-scruple-surface/50 p-3 text-xs text-scruple-muted">
              {hintForType(project.type)}
            </p>
          )}
          <LockButtons project={project} hasContent={hasContent} />
        </section>
      )}
    </div>
  );
}

function statLabelForType(type: ProjectRow['type']): string {
  switch (type) {
    case 'training': return 'Training Runs';
    case 'video':    return 'Clips';
    case 'image':    return 'Iterations';
  }
}

function countForType(project: ProjectRow, trainingRuns: TrainingRunRow[]): number {
  if (project.type === 'training') return trainingRuns.length;
  // image + video both use iteration_count for now (video is placeholder).
  return project.iteration_count;
}

function hintForType(type: ProjectRow['type']): string {
  switch (type) {
    case 'training': return 'Complete at least one training run to enable locking.';
    case 'video':    return 'Video capture is not yet implemented — locking will be enabled once at least one clip is captured.';
    case 'image':    return 'Generate at least one iteration to enable locking.';
  }
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
