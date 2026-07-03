// WorkspaceView — port of renderer/render-workspace.js (desktop).
// Read-only project state view. Prompts + workflow editing live on the
// /canvas page. Start/Stop Tracking lives in the sidebar project-footer.
//
// Structure (matching desktop main.css .workspace):
//
//   .workspace-header  ────────────────────────────────  (bottom border)
//     .workspace-title   h1 (28px bold) + StatusBadgeSolid + active-badge
//
//   .workspace-stats   3 .stat-box (tertiary bg, 28px bold value)
//
//   .workspace-merkle  separate tertiary-bg card with Merkle Root +
//                      SCR-ID rows (label | monospace value, SCR green)
//
//   Content (branched on project.type):
//     image    → IterationGridLive (covers txt2img/img2img/upscale/etc.)
//     video    → placeholder card "Video pipeline not yet implemented"
//     training → PreflightPanel + reverse-ordered TrainingRunCards
//
//   .workspace-lock-section (when !isActive)
//     Wrapped in tertiary-bg padded card. Hint above three buttons.

import { type ProjectRow, type IterationRow, type TrainingRunRow } from '@/lib/types';
import LockButtons from './LockButtons';
import IterationGridLive from './IterationGridLive';
import TrainingRunCard from './TrainingRunCard';
import PreflightPanel from './PreflightPanel';
import StatusBadgeSolid from './StatusBadgeSolid';

export default function WorkspaceView({
  project,
  iterations,
  trainingRuns,
  cadPreview,
}: {
  project: ProjectRow;
  iterations: IterationRow[];
  trainingRuns: TrainingRunRow[];
  /** Optional pre-content slot rendered inside the workspace body — the
   *  Fusion palette uses this to embed the Fusion cloud viewer iframe
   *  above the iteration grid. */
  cadPreview?: React.ReactNode;
}) {
  const isActive = project.is_active === 1;
  const hasIterations = iterations.length > 0;
  const hasTrainingRuns = trainingRuns.length > 0;
  const hasContent =
    project.type === 'training' ? hasTrainingRuns :
    project.type === 'image' ? hasIterations :
    project.type === 'cad' ? hasIterations :
    false;
  const currentRunId = trainingRuns.length > 0 ? trainingRuns[trainingRuns.length - 1].id : null;

  return (
    // .workspace — max-width 1200, 24px padding
    <div className="mx-auto max-w-[1200px] p-6">
      {/* .workspace-header — flex row, bottom border */}
      <div className="mb-6 flex items-start justify-between gap-4 border-b border-scruple-border-color pb-4">
        <div className="min-w-0">
          <h1 className="mb-2 text-[28px] font-semibold leading-tight text-scruple-text-primary">
            {project.name}
          </h1>
          <div className="flex items-center gap-2">
            <StatusBadgeSolid status={project.status} />
            {isActive && (
              <span
                className="inline-block rounded px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider"
                style={{ backgroundColor: '#e53935', color: '#ffffff' }}
              >
                ● Tracking
              </span>
            )}
            <span className="ml-2 text-xs text-scruple-text-secondary">
              Created {new Date(project.created_at).toLocaleDateString()} · Type {project.type}
            </span>
          </div>
        </div>
      </div>

      {/* .workspace-stats — flex row of stat-box */}
      <div className="mb-6 flex flex-wrap gap-4">
        <StatBox label={statLabelForType(project.type)} value={countForType(project, trainingRuns)} />
        <StatBox label="Witnessed" value={project.witnessed_count} />
        {project.scr_id && <StatBox label="SCR-ID" value={project.scr_id} highlight />}
      </div>

      {/* .workspace-merkle — separate card */}
      <div className="mb-6 rounded-lg bg-scruple-bg-tertiary p-4">
        <div className="flex items-center gap-3 py-2">
          <span className="min-w-[120px] text-xs text-scruple-text-secondary">Merkle Root</span>
          <code className="break-all rounded bg-scruple-bg-primary px-2 py-1 font-mono text-xs text-scruple-accent-primary">
            {project.merkle_root || '— not yet computed —'}
          </code>
        </div>
        {project.scr_id && (
          <div className="flex items-center gap-3 border-t border-scruple-border-color/50 py-2">
            <span className="min-w-[120px] text-xs text-scruple-text-secondary">SCR-ID</span>
            <code
              className="rounded bg-scruple-bg-primary px-2 py-1 font-mono text-xs"
              style={{ color: '#4caf50' }}
            >
              {project.scr_id}
            </code>
          </div>
        )}
        {project.pre_scr_id && !project.scr_id && (
          <div className="flex items-center gap-3 border-t border-scruple-border-color/50 py-2">
            <span className="min-w-[120px] text-xs text-scruple-text-secondary">Pre-SCR</span>
            <code className="rounded bg-scruple-bg-primary px-2 py-1 font-mono text-xs text-scruple-text-deep-muted">
              {project.pre_scr_id}
            </code>
          </div>
        )}
      </div>

      {/* Content — branches on project type */}
      {project.type === 'training' ? (
        <section className="mb-8">
          <h2 className="mb-4 text-lg font-semibold text-scruple-text-primary">Training Runs</h2>
          <PreflightPanel runId={currentRunId} />
          <div className="mt-4 space-y-3">
            {hasTrainingRuns ? (
              [...trainingRuns]
                .reverse()
                .map(run => (
                  <TrainingRunCard key={run.id} run={run} allRuns={trainingRuns} />
                ))
            ) : (
              <div className="rounded-lg bg-scruple-bg-tertiary p-12 text-center text-sm text-scruple-text-secondary">
                No training runs captured yet. Start training in Kohya to see them here.
              </div>
            )}
          </div>
        </section>
      ) : project.type === 'video' ? (
        <section className="mb-8">
          <h2 className="mb-4 text-lg font-semibold text-scruple-text-primary">Video</h2>
          <div className="rounded-lg bg-scruple-bg-tertiary p-12 text-center text-sm text-scruple-text-secondary">
            Video pipeline not yet implemented. This project type is reserved — capture support lands in a future release.
          </div>
        </section>
      ) : project.type === 'cad' ? (
        <>
          {cadPreview && <section className="mb-8">{cadPreview}</section>}
          <section className="mb-8">
            <h2 className="mb-4 text-lg font-semibold text-scruple-text-primary">Witnessed Edits</h2>
            {hasIterations ? (
              <div className="space-y-2">
                {[...iterations].reverse().map((it) => (
                  <div
                    key={it.id}
                    className="flex items-center justify-between rounded-lg bg-scruple-bg-tertiary px-4 py-2 text-sm"
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-10 text-right font-mono text-xs text-scruple-text-deep-muted">
                        #{it.run_sequence}
                      </span>
                      <code className="font-mono text-xs text-scruple-text-primary">
                        {it.leaf_hash.slice(0, 24)}…
                      </code>
                      {it.witnessed ? (
                        <span className="rounded bg-emerald-500/20 px-1.5 py-[1px] text-[10px] text-emerald-300">
                          signed
                        </span>
                      ) : (
                        <span className="rounded bg-amber-500/20 px-1.5 py-[1px] text-[10px] text-amber-300">
                          unsigned
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-scruple-text-deep-muted">
                      {new Date(it.timestamp).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg bg-scruple-bg-tertiary p-12 text-center text-sm text-scruple-text-secondary">
                No witnessed edits yet. Add a feature or save the design in Fusion to record the first leaf.
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="mb-8">
          <h2 className="mb-4 text-lg font-semibold text-scruple-text-primary">Iterations</h2>
          <IterationGridLive
            initial={iterations}
            projectId={project.id}
            isActive={isActive}
          />
        </section>
      )}

      {/* .workspace-lock-section — wrapped in tertiary-bg card */}
      {!isActive && (
        <section className="rounded-lg bg-scruple-bg-tertiary p-6">
          <h2 className="mb-2 text-lg font-semibold text-scruple-text-primary">Lock Project</h2>
          <p className="mb-4 text-sm text-scruple-text-secondary">
            {hasContent
              ? 'Finalize to permanently seal your creative history, or Checkpoint to preserve progress and keep working.'
              : hintForType(project.type)}
          </p>
          <LockButtons project={project} hasContent={hasContent} />
        </section>
      )}
    </div>
  );
}

// .stat-box — tertiary bg, 8px radius, 16px 24px padding, centered.
// .stat-value 28px bold. .stat-label 11px uppercase muted.
function StatBox({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
}) {
  return (
    <div className="min-w-[100px] flex-1 rounded-lg bg-scruple-bg-tertiary px-6 py-4 text-center">
      <div
        className={
          'text-[28px] font-bold leading-tight ' +
          (highlight ? 'font-mono text-scruple-accent-primary' : 'text-scruple-text-primary')
        }
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-scruple-text-secondary">
        {label}
      </div>
    </div>
  );
}

function statLabelForType(type: ProjectRow['type']): string {
  switch (type) {
    case 'training': return 'Training Runs';
    case 'video':    return 'Clips';
    case 'image':    return 'Iterations';
    case 'cad':      return 'Witnessed Edits';
  }
}

function countForType(project: ProjectRow, trainingRuns: TrainingRunRow[]): number {
  if (project.type === 'training') return trainingRuns.length;
  return project.iteration_count;
}

function hintForType(type: ProjectRow['type']): string {
  switch (type) {
    case 'training': return 'Complete at least one training run to enable locking.';
    case 'video':    return 'Video capture is not yet implemented — locking will be enabled once at least one clip is captured.';
    case 'image':    return 'Generate at least one iteration to enable locking.';
    case 'cad':      return 'Witness at least one edit to enable locking.';
  }
}
