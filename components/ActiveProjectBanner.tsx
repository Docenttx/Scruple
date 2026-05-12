// WO-31 + UI clone phase 2 · Active-project sidebar banner.
//
// Port of the desktop's renderActiveProjectSidebar() — surfaces the
// currently-tracked project at the top of the sidebar so the user
// always knows where new captures will land.
//
// Desktop styling (catalog §3 "Active Project Banner / Tracking Tile"):
//   TRACKING label is RED (#ef4444) — not green. The pulsing dot is
//   also red. The whole banner uses rgba(239,68,68,0.15) tinted bg with
//   a red border. Matches the desktop's "recording in progress" feel.
//
// Below: project name, status badge, iteration count, SCR-ID (if any),
// thumbnail strip (up to 4 recent), and a STOP button (text-only, red
// border, hover-inverts).

import Link from 'next/link';
import { LOCK_STATE_LABELS, type ProjectRow, type IterationRow } from '@/lib/types';
import StopTrackingButton from './StopTrackingButton';

export default function ActiveProjectBanner({
  project,
  recentIterations,
}: {
  project: ProjectRow;
  recentIterations: IterationRow[];
}) {
  return (
    <div className="border-b border-scruple-border-color bg-scruple-danger/15 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wider2 text-scruple-danger">
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-scruple-danger opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-scruple-danger" />
          </span>
          Tracking
        </span>
        <StopTrackingButton />
      </div>

      <Link
        href={`/projects/${project.id}`}
        className="block rounded-md px-1.5 py-1 transition-colors hover:bg-scruple-bg-primary/40"
      >
        <div className="truncate text-sm font-medium text-scruple-text-primary">
          {project.name}
        </div>
        <div className="mt-1 flex items-center gap-2 text-2xs text-scruple-text-secondary">
          <span className="rounded-full border border-scruple-border-color bg-scruple-bg-primary px-1.5 py-0.5">
            {LOCK_STATE_LABELS[project.status] ?? project.status}
          </span>
          <span>·</span>
          <span>{project.iteration_count} iter</span>
          {project.scr_id && (
            <>
              <span>·</span>
              <span className="font-mono text-scruple-accent-primary">{project.scr_id}</span>
            </>
          )}
        </div>
      </Link>

      {recentIterations.length > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-1">
          {recentIterations.slice(0, 4).map(it => (
            <div
              key={it.id}
              className="aspect-square overflow-hidden rounded border border-scruple-border-color bg-scruple-bg-primary"
              title={`#${it.run_sequence}`}
            >
              {it.leaf_hash ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/artifact/${it.leaf_hash}`}
                  alt={`Iteration ${it.run_sequence}`}
                  className="h-full w-full object-cover"
                />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
