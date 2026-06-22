'use client';

// Canvas launcher card — shown to Pro/Enterprise users when they
// don't have an active Modal canvas session. Click → POST
// /api/canvas/session → server mints a session and the page reloads
// into the iframe view.
//
// Surfaces the current Settings → Compute machine choice + warning
// banner if the per-machine MODAL_CANVAS_APP_URL_* env var is unset
// (i.e. modal deploy hasn't happened yet for this GPU class).

import { useEffect, useState } from 'react';
import { addToast } from '@/lib/toast';

interface ResolvedMachine {
  id: string;
  name: string;
  gpuClass: string;
  trustTier: string;
  monthlyEstimateUsd8hPerDay: number;
  coldStartSeconds: number;
}

export default function CanvasLauncher({ plan }: { plan: 'pro' | 'enterprise' }) {
  const [machine, setMachine] = useState<ResolvedMachine | null>(null);
  const [launching, setLaunching] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/compute', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { active?: ResolvedMachine; error?: string }) => {
        if (d.error) setErr(d.error);
        else if (d.active) setMachine(d.active);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function launch() {
    setLaunching(true);
    try {
      const res = await fetch('/api/canvas/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      addToast({ tone: 'success', title: 'Canvas launching…' });
      // Reload — server component then resolves the active session.
      window.location.reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      addToast({ tone: 'error', title: 'Could not launch canvas', detail: msg });
      setLaunching(false);
    }
  }

  return (
    <div className="w-full max-w-md rounded-lg border border-scruple-border bg-scruple-surface p-6">
      <h1 className="text-lg font-medium text-scruple-text">Launch Canvas</h1>
      <p className="mt-1 text-xs text-scruple-muted">
        Spins up a dedicated GPU container with the full Scruple ComfyUI
        node set. The container is yours alone for the session, scales
        down after 5 minutes of idle activity.
      </p>

      <div className="mt-4 rounded-md border border-scruple-border bg-scruple-bg p-3">
        {machine ? (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-scruple-text">{machine.name}</span>
              <span className="rounded border border-scruple-accent-primary/40 bg-scruple-accent-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-scruple-accent-primary">
                {plan}
              </span>
            </div>
            <ul className="mt-2 space-y-0.5 text-[10px] text-scruple-muted">
              <li>GPU: {machine.gpuClass}</li>
              <li>Trust tier: {machine.trustTier}</li>
              <li>Cold start: ~{machine.coldStartSeconds}s</li>
              <li>Est. cost (8h/day): ~${machine.monthlyEstimateUsd8hPerDay}/mo</li>
            </ul>
          </>
        ) : (
          <div className="text-xs text-scruple-muted">Loading machine details…</div>
        )}
      </div>

      {err && (
        <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-300">
          {err}
        </div>
      )}

      <button
        type="button"
        onClick={launch}
        disabled={launching || !machine || !!err}
        className="mt-4 w-full rounded-md border border-scruple-accent-primary bg-scruple-accent-primary/10 px-4 py-2 text-sm font-medium text-scruple-accent-primary transition-colors hover:bg-scruple-accent-primary/20 disabled:opacity-50"
      >
        {launching ? 'Launching…' : 'Launch Canvas'}
      </button>

      <p className="mt-3 text-[10px] text-scruple-muted">
        Change machine in <a href="/settings#compute" className="underline">Settings → Compute</a>.
      </p>
    </div>
  );
}
