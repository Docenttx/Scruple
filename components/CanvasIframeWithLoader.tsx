'use client';

// Wraps the canvas iframe with a loading overlay so the user isn't
// staring at a blank page during Modal's cold-start (which can take
// 90-180s on a fresh container).

import { useState, useEffect, useRef } from 'react';

export default function CanvasIframeWithLoader({
  iframeId,
  src,
  title,
  machineName,
}: {
  iframeId: string;
  src: string;
  title: string;
  machineName: string;
}) {
  const [ready, setReady] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (ready) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [ready]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => setReady(true);
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, []);

  return (
    <div className="relative h-full">
      <iframe
        ref={iframeRef}
        id={iframeId}
        src={src}
        title={title}
        className="h-full w-full border-0 bg-scruple-bg"
        allow="clipboard-read; clipboard-write; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      />
      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-scruple-bg/95">
          <div className="mb-6 h-12 w-12 animate-spin rounded-full border-2 border-scruple-border border-t-scruple-accent-primary"></div>
          <div className="text-sm font-semibold text-scruple-accent-primary">
            Warming up ComfyUI on {machineName}
          </div>
          <div className="mt-2 max-w-md text-center text-xs text-scruple-text-secondary">
            Cold-start on a fresh container can take 90-180 seconds. The
            canvas will appear as soon as the ComfyUI process is ready.
          </div>
          <div className="mt-3 text-[11px] uppercase tracking-wider text-scruple-muted">
            elapsed · {elapsed}s
          </div>
        </div>
      )}
    </div>
  );
}
