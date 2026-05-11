'use client';

// WO-35 · Debug console drawer.
//
// Slide-up bottom panel showing last-100 log entries. Toggle via the
// floating button in the bottom-right corner (port of desktop's
// sidebar-footer "Debug" button). Color-coded by level. Click "Clear"
// to wipe.

import { useLogs } from '@/lib/store/logs';

const LEVEL_STYLE: Record<string, string> = {
  info: 'text-scruple-muted',
  debug: 'text-scruple-muted/60',
  warn: 'text-scruple-warn',
  error: 'text-scruple-danger',
};

export default function DebugConsole() {
  const entries = useLogs(s => s.entries);
  const open = useLogs(s => s.open);
  const toggle = useLogs(s => s.toggle);
  const clear = useLogs(s => s.clear);

  return (
    <>
      {/* Floating toggle */}
      <button
        type="button"
        onClick={toggle}
        title="Debug console"
        aria-label="Debug console"
        className="fixed bottom-3 right-3 z-50 flex h-8 items-center gap-1.5 rounded-md border border-scruple-border bg-scruple-surface px-2.5 text-[10px] uppercase tracking-widest text-scruple-muted shadow-lg hover:border-scruple-accent hover:text-scruple-text"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${entries.some(e => e.level === 'error') ? 'bg-scruple-danger' : entries.some(e => e.level === 'warn') ? 'bg-scruple-warn' : 'bg-scruple-muted'}`} />
        Debug
        {entries.length > 0 && (
          <span className="ml-1 rounded-full bg-scruple-bg px-1 font-mono text-[9px]">
            {entries.length}
          </span>
        )}
      </button>

      {/* Drawer */}
      {open && (
        <div className="fixed bottom-0 left-0 right-0 z-40 h-72 border-t border-scruple-border bg-scruple-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-scruple-border px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-widest text-scruple-muted">
              Debug Console · {entries.length} entries
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clear}
                className="text-[11px] text-scruple-muted hover:text-scruple-text"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={toggle}
                className="text-scruple-muted hover:text-scruple-text"
                aria-label="Close"
              >
                ×
              </button>
            </div>
          </div>
          <div className="h-[calc(100%-32px)] overflow-auto bg-scruple-bg px-3 py-2 font-mono text-[11px] leading-tight">
            {entries.length === 0 ? (
              <p className="text-scruple-muted">No log entries yet. Errors and notable events will appear here.</p>
            ) : (
              entries.slice().reverse().map((e, i) => (
                <div key={i} className="flex gap-2 py-0.5">
                  <span className="shrink-0 text-scruple-muted/60">{e.ts.slice(11, 19)}</span>
                  <span className={`shrink-0 w-12 text-[10px] uppercase ${LEVEL_STYLE[e.level] ?? ''}`}>
                    {e.level}
                  </span>
                  <span className="shrink-0 text-scruple-muted">[{e.source}]</span>
                  <span className={LEVEL_STYLE[e.level] ?? 'text-scruple-text'}>{e.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
