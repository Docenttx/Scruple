// IterationGrid — port of desktop .iterations-grid + .iteration-card.
//
// Card layout (top → bottom):
//   .iteration-image  — 180px tall, full width, object-cover, bg-primary
//   .iteration-details (12px padding):
//     .iteration-header — flex: #N (16px bold) ↔ witnessed marker
//     .iteration-hash   — "Leaf:" label + monospace truncated code
//     .iteration-time   — 10px muted timestamp
//
// Card itself: tertiary bg, 8px radius, overflow hidden, no border;
// hover lifts -2px with shadow. Grid: auto-fill 280px minmax.

import type { IterationRow } from '@/lib/types';

function truncate(h: string, n = 16) {
  return h.length > n ? `${h.slice(0, n)}…` : h;
}

export default function IterationGrid({ iterations }: { iterations: IterationRow[] }) {
  if (iterations.length === 0) {
    return (
      <div className="rounded-lg bg-scruple-bg-tertiary p-12 text-center text-sm text-scruple-text-secondary">
        No iterations captured yet. Generate images in ComfyUI to see them here.
      </div>
    );
  }

  return (
    // grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap 16px
    <div className="grid grid-cols-iters gap-4">
      {iterations.map((it) => (
        <article
          key={it.id}
          className="overflow-hidden rounded-lg bg-scruple-bg-tertiary transition-all duration-fast hover:-translate-y-0.5 hover:shadow-card"
        >
          {/* .iteration-image — 180px tall, object-cover */}
          <div className="flex h-[180px] w-full items-center justify-center overflow-hidden bg-scruple-bg-primary">
            {it.output_hash ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/artifact/${it.output_hash}`}
                alt={`Iteration ${it.run_sequence}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-5xl opacity-30">[IMG]</span>
            )}
          </div>

          {/* .iteration-details — 12px padding */}
          <div className="p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-base font-semibold text-scruple-text-primary">
                #{it.run_sequence}
              </span>
              <div className="flex items-center gap-1.5">
                {it.witnessed === 1 && (
                  <span
                    title="Witnessed"
                    className="text-xs text-scruple-success"
                  >
                    ● witnessed
                  </span>
                )}
              </div>
            </div>
            <div className="mb-1 text-[11px] text-scruple-text-secondary">
              <span>Leaf: </span>
              <code className="rounded bg-scruple-bg-primary px-1.5 py-0.5 text-scruple-accent-primary">
                {truncate(it.leaf_hash, 12)}
              </code>
            </div>
            <div className="text-[10px] text-scruple-text-deep-muted">
              {new Date(it.timestamp).toLocaleString()}
            </div>
            {it.prompt && (
              <div className="mt-1 truncate text-[11px] text-scruple-text-secondary" title={it.prompt}>
                {it.prompt}
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
