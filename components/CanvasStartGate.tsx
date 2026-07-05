'use client';

// Defers Modal container cold-start until the user explicitly clicks
// "Start Canvas". Until then, no GPU is spun up — Modal proxy calls
// only fire after the click.
//
// Also handles the HUD price-ticker: only starts counting when the
// canvas is truly running.

import { useState } from 'react';

interface Props {
  sessionId: string;
  machineName: string;
  hourlyRateCents: number;
  proxyUrl: string;
  iframeId: string;
  Bridge: React.ComponentType<{ iframeId: string; activeProjectId?: number; activeProjectName?: string }>;
  HUD: React.ComponentType<{ sessionId: string; machineName: string; hourlyRateCents: number }>;
  activeProjectId?: number;
  activeProjectName?: string;
}

export default function CanvasStartGate({
  sessionId,
  machineName,
  hourlyRateCents,
  proxyUrl,
  iframeId,
  Bridge,
  HUD,
  activeProjectId,
  activeProjectName,
}: Props) {
  const [started, setStarted] = useState(false);

  if (!started) {
    return (
      <div className="flex h-full items-center justify-center bg-scruple-bg p-8">
        <div className="max-w-md rounded-md border border-scruple-border bg-scruple-surface p-6 text-center">
          <h2 className="text-lg font-semibold text-scruple-accent-primary">
            Canvas ready — {machineName}
          </h2>
          <p className="mt-3 text-xs leading-relaxed text-scruple-text-secondary">
            Compute stays cold until you press <strong>Start</strong>. The GPU
            container spins up on your first click, and the ticker only begins
            counting from that moment.
          </p>
          <div className="mt-4 text-[11px] uppercase tracking-wider text-scruple-muted">
            Rate when running · ${(hourlyRateCents / 100).toFixed(2)} / hour
          </div>
          <button
            type="button"
            onClick={() => setStarted(true)}
            className="mt-6 rounded bg-scruple-accent-primary px-5 py-2 text-sm font-semibold text-scruple-bg hover:opacity-90"
          >
            Start Canvas
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <iframe
        id={iframeId}
        src={proxyUrl}
        title={`ComfyUI canvas — ${machineName}`}
        className="h-full w-full border-0 bg-scruple-bg"
        allow="clipboard-read; clipboard-write; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      />
      <Bridge
        iframeId={iframeId}
        activeProjectId={activeProjectId}
        activeProjectName={activeProjectName}
      />
      <HUD
        sessionId={sessionId}
        machineName={machineName}
        hourlyRateCents={hourlyRateCents}
      />
    </div>
  );
}
