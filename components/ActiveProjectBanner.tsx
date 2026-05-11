// WO-31 · Active-project sidebar banner.
//
// Port of the desktop's renderActiveProjectSidebar() — surfaces the
// currently-tracked project at the top of the sidebar so the user
// always knows where new captures will land. Shows:
//
//   TRACKING  (green pulse)
//   <project name>           <Stop>
//   <status badge>
//   N iter · SCR_XXXXXX
//   [thumb] [thumb] [thumb] [thumb]
//
// Thumbnails are the most-recent up-to-4 iterations, served via the
// existing /api/artifact/[hash] route. Click banner = navigate to the
// project workspace.

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
    <div className="border-b border-scruple-border bg-gradient-to-b from-scruple-success/10 to-transparent px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-scruple-success">
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-scruple-success opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-scruple-success" />
          </span>
          Tracking
        </span>
        <StopTrackingButton />
      </div>

      <Link
        href={`/projects/${project.id}`}
        className="block rounded-md p-1.5 transition hover:bg-scruple-bg"
      >
        <div className="truncate text-sm text-scruple-text">{project.name}</div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-scruple-muted">
          <span className="rounded-full border border-scruple-border bg-scruple-bg px-1.5 py-0.5">
            {LOCK_STATE_LABELS[project.status] ?? project.status}
          </span>
          <span>·</span>
          <span>{project.iteration_count} iter</span>
          {project.scr_id && (
            <>
              <span>·</span>
              <span className="font-mono">{project.scr_id}</span>
            </>
          )}
        </div>
      </Link>

      {recentIterations.length > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-1">
          {recentIterations.slice(0, 4).map(it => (
            <div
              key={it.id}
              className="aspect-square overflow-hidden rounded border border-scruple-border bg-scruple-bg"
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
