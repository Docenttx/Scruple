'use client';

// ProjectShell — port of the desktop's main-content shell.
//
// Provides the view-pill toggle (Workspace / Canvas) and the
// "Viewing: <project>" label at the top of the main pane. Both views
// stay mounted simultaneously; toggling hides one and shows the other.
// This matches the desktop's `<webview partition="persist:comfyui">`
// behavior — the canvas keeps its workflow state across toggles
// because the iframe is never unmounted.
//
// The workspace pane is server-rendered (passed in via `children`);
// the canvas pane is a single iframe pointed at canvas.stooges.ai.

import { useState } from 'react';

type View = 'workspace' | 'canvas';

const CANVAS_URL = 'https://canvas.stooges.ai/';

export default function ProjectShell({
  projectName,
  children,
}: {
  projectName: string;
  children: React.ReactNode;
}) {
  const [view, setView] = useState<View>('workspace');

  return (
    <div className="flex h-full flex-col">
      {/* View toggle + viewing label */}
      <div className="flex items-center justify-between border-b border-scruple-border bg-scruple-surface px-6 py-2">
        <div className="flex items-center gap-1">
          <ViewPill active={view === 'workspace'} onClick={() => setView('workspace')}>
            Workspace
          </ViewPill>
          <ViewPill active={view === 'canvas'} onClick={() => setView('canvas')}>
            Canvas
          </ViewPill>
        </div>
        <span className="text-xs text-scruple-muted">
          Viewing: <span className="text-scruple-text">{projectName}</span>
        </span>
      </div>

      {/* Body — both views always in DOM; hidden via display:none for state preservation */}
      <div className="relative flex-1 overflow-hidden">
        <div
          className="absolute inset-0 overflow-auto"
          style={{ display: view === 'workspace' ? 'block' : 'none' }}
        >
          {children}
        </div>
        <div
          className="absolute inset-0"
          style={{ display: view === 'canvas' ? 'block' : 'none' }}
        >
          <iframe
            src={CANVAS_URL}
            title="ComfyUI canvas"
            className="h-full w-full border-0 bg-scruple-bg"
            // `allow` includes clipboard so node copy/paste works inside the iframe.
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        </div>
      </div>
    </div>
  );
}

function ViewPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md px-3 py-1 text-xs uppercase tracking-widest transition-colors ' +
        (active
          ? 'border border-scruple-accent bg-scruple-accent/20 text-scruple-text'
          : 'border border-transparent text-scruple-muted hover:text-scruple-text')
      }
    >
      {children}
    </button>
  );
}
