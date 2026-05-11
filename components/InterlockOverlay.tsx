'use client';

// WO-34 · Interlock overlay.
//
// Port of the desktop's interlock state — when a lock op is mid-flight,
// a greyed-out full-screen blocker appears with a spinner + the reason
// string (set by whichever component initiated the op). Prevents
// concurrent state-mutating actions and reassures the user something is
// happening for long ops (chain lock can take a minute+).
//
// Subscribes to lib/store/interlock.ts (already used by LockButtons
// + TrackingButton).

import { useInterlock } from '@/lib/store/interlock';

export default function InterlockOverlay() {
  const busy = useInterlock(s => s.busy);
  const reason = useInterlock(s => s.reason);

  if (!busy) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-lg border border-scruple-border bg-scruple-surface px-8 py-6 shadow-2xl">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-scruple-border border-t-scruple-accent" />
        <div className="text-center">
          <div className="text-sm font-medium text-scruple-text">
            {reason ?? 'Working…'}
          </div>
          <div className="mt-1 text-[11px] text-scruple-muted">
            Please don&apos;t close this window.
          </div>
        </div>
      </div>
    </div>
  );
}
