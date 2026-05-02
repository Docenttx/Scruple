// IterationGrid — workspace iteration cards. Real ingestion lands in WO-14;
// this renders whatever rows exist in `iterations`.

import type { IterationRow } from '@/lib/types';

function truncate(h: string, n = 16) {
  return h.length > n ? `${h.slice(0, n)}…` : h;
}

export default function IterationGrid({ iterations }: { iterations: IterationRow[] }) {
  if (iterations.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-scruple-border bg-scruple-surface/50 p-12 text-center">
        <p className="text-sm text-scruple-muted">
          No iterations yet. Start tracking and generate an image to capture the first iteration.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {iterations.map((it) => (
        <article
          key={it.id}
          className="overflow-hidden rounded-md border border-scruple-border bg-scruple-surface"
        >
          <div className="aspect-square bg-scruple-bg">
            {it.output_hash ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/artifact/${it.output_hash}`}
                alt={`Iteration ${it.run_sequence}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-scruple-muted">
                no image
              </div>
            )}
          </div>
          <div className="p-2 text-[10px]">
            <div className="flex items-center justify-between">
              <span className="text-scruple-text">#{it.run_sequence}</span>
              {it.witnessed === 1 && (
                <span title="Witnessed" className="text-scruple-success">
                  ◇
                </span>
              )}
            </div>
            <div className="mt-1 font-mono text-scruple-muted">leaf {truncate(it.leaf_hash, 12)}</div>
            <div className="text-scruple-muted">
              {new Date(it.timestamp).toLocaleTimeString()}
            </div>
            {it.prompt && (
              <div className="mt-1 truncate text-scruple-muted" title={it.prompt}>
                {it.prompt}
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
