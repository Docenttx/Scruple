'use client';

// Canvas session HUD — Canvas v2 (WO-6).
//
// Small overlay on the /canvas page: shows the active machine,
// elapsed time, estimated cost. Posts a heartbeat every 30s while
// alive. On unload, posts /end as a beacon so the Stripe PaymentIntent
// finalizes.

import { useEffect, useRef, useState } from 'react';

interface HUDProps {
  sessionId: string;
  machineName: string;
  hourlyRateCents: number;
}

export default function CanvasSessionHUD({
  sessionId,
  machineName,
  hourlyRateCents,
}: HUDProps) {
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef<number>(Date.now());

  // Heartbeat every 30s
  useEffect(() => {
    let alive = true;
    function tick() {
      if (!alive) return;
      fetch('/api/canvas/session/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            setError(body.error ?? `HTTP ${r.status}`);
            return;
          }
          const body = await r.json();
          if (typeof body.accumulated_seconds === 'number') {
            setElapsed(body.accumulated_seconds);
          }
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }
    tick();
    const interval = setInterval(tick, 30_000);
    // Also tick the visible counter every second from the local clock
    // so the UI feels live between server heartbeats.
    const local = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);

    function onUnload() {
      // Beacon — fire-and-forget, OK if it never returns
      try {
        const blob = new Blob([JSON.stringify({ sessionId })], { type: 'application/json' });
        navigator.sendBeacon('/api/canvas/session/end', blob);
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);

    return () => {
      alive = false;
      clearInterval(interval);
      clearInterval(local);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, [sessionId]);

  async function endSession() {
    if (!confirm('End the canvas session? Stripe will capture the actual usage cost.')) return;
    try {
      const res = await fetch('/api/canvas/session/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const cents = Math.ceil((elapsed * hourlyRateCents) / 3600);
  const dollars = (cents / 100).toFixed(2);
  const startedSecAgo = Math.floor((Date.now() - startedAt.current) / 1000);

  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-50 flex items-center gap-2 rounded-md border border-scruple-border bg-scruple-bg/95 px-3 py-1.5 text-[11px] font-mono shadow-lg backdrop-blur">
      <span className="text-scruple-muted">{machineName}</span>
      <span className="text-scruple-accent-primary">
        {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
      </span>
      <span className="text-scruple-muted">${dollars}</span>
      <button
        type="button"
        onClick={endSession}
        className="ml-1 rounded border border-red-500/40 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10"
      >
        End
      </button>
      {error && <span className="ml-1 text-[10px] text-red-400" title={`elapsed local ${startedSecAgo}s`}>!</span>}
    </div>
  );
}
