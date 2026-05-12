'use client';

// Pivot clone-6 · Provenance Terminal (sidebar panel).
//
// Sits below the ActiveProjectBanner. Reads the most-recent iteration's
// workflow JSON for the user's active project, surfaces up to 10
// human-meaningful rows (model, loras, prompts, sampler, steps, cfg,
// seed, dimensions, controlnets). The "checked" glyphs mean
// "recorded in the provenance chain" — visual-only in v1.
//
// Refreshes every 5s while an iteration is in flight; that's a
// good-enough cadence for the indicator to feel alive without
// hammering the DB. (SSE on /api/iterations/stream is already in
// place for the iteration grid; we could subscribe there too — defer
// until polling becomes a problem.)

import { useEffect, useState } from 'react';
import type { ProvenanceRow } from '@/lib/provenance/extract';

interface Snapshot {
  active: boolean;
  iterationId: number | null;
  runSequence?: number;
  leafHash?: string;
  ts?: string;
  rows: ProvenanceRow[];
}

const POLL_MS = 5_000;

export default function ProvenanceTerminal() {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const res = await fetch('/api/provenance/active', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as Snapshot;
        if (alive) setSnap(data);
      } catch {
        /* stale view is fine */
      }
    }
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!snap || !snap.active) return null;

  return (
    // Console aesthetic: monospace, cyan accent header, dark backing.
    // Mirrors the desktop's .debug-console + .iteration-list panel
    // hybrid — the "Scruple Terminal" pattern the user described.
    <div className="border-b border-scruple-border-color bg-scruple-bg-primary font-mono">
      <div className="px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between border-b border-scruple-border-color/50 pb-1">
          <span className="text-2xs font-bold uppercase tracking-wider2 text-scruple-accent-primary">
            ▸ Provenance
          </span>
          {snap.iterationId != null && (
            <span className="text-3xs text-scruple-text-deep-muted">
              #{snap.runSequence}·{snap.leafHash?.slice(0, 6)}
            </span>
          )}
        </div>

        {snap.rows.length === 0 ? (
          <div className="text-3xs italic text-scruple-text-deep-muted">
            {snap.iterationId == null
              ? '// no iterations yet'
              : '// no metadata for last run'}
          </div>
        ) : (
          <ul className="space-y-0 text-3xs leading-relaxed">
            {snap.rows.map((r, i) => (
              <li
                key={`${r.category}-${i}`}
                className="flex items-baseline gap-1.5"
                title={r.detail ?? r.value}
              >
                <span
                  className={`w-2 flex-shrink-0 ${r.checked ? 'text-scruple-success' : 'text-scruple-text-deep-muted'}`}
                >
                  {r.checked ? '✓' : '∙'}
                </span>
                <span className="w-14 flex-shrink-0 text-scruple-text-secondary">{r.category}</span>
                <span className="truncate text-scruple-text-primary">{r.value}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
