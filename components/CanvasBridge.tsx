'use client';

// WO-51 · postMessage bridge between scruple-web and the embedded
// canvas iframe (canvas.stooges.ai).
//
// Receives `scruple:queue-prompt` from the iframe (sent by the
// Scruple Queue Intercept extension when the user hits Queue). Posts
// the workflow JSON to /api/generate which forwards to ComfyDeploy's
// cloud GPU. Replies with `scruple:queue-result` so the canvas can
// toast success/failure.
//
// Also pushes `scruple:active-project` so the canvas extension knows
// which project iterations should land on.

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { logEvent } from '@/lib/store/logs';
import { useInterlock } from '@/lib/store/interlock';

interface QueuePromptMessage {
  type: 'scruple:queue-prompt';
  workflowApiJson: Record<string, unknown>;
  workflow?: unknown;
  batchCount?: number;
}

interface ReadyMessage {
  type: 'scruple:ready';
}

export default function CanvasBridge({
  iframeId,
  activeProjectId,
  activeProjectName,
}: {
  iframeId: string;
  activeProjectId?: number;
  activeProjectName?: string;
}) {
  const router = useRouter();
  const setInterlock = useInterlock(s => s.set);
  const lastSentProject = useRef<number | undefined>(undefined);

  // Send active-project state when the iframe announces ready,
  // and again whenever the activeProjectId prop changes.
  function sendActiveProject(target: Window | null) {
    if (!target) return;
    target.postMessage(
      {
        type: 'scruple:active-project',
        projectId: activeProjectId ?? null,
        projectName: activeProjectName ?? null,
      },
      '*',
    );
    lastSentProject.current = activeProjectId;
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

      // The iframe just loaded — push active project state.
      if (data.type === 'scruple:ready') {
        const ev = data as ReadyMessage;
        logEvent('info', 'canvas-bridge', 'iframe ready', ev);
        const iframe = document.getElementById(iframeId) as HTMLIFrameElement | null;
        sendActiveProject(iframe?.contentWindow ?? null);
        return;
      }

      // Queue intercept: route the workflow to ComfyDeploy.
      if (data.type === 'scruple:queue-prompt') {
        const ev = data as QueuePromptMessage;
        const iframe = document.getElementById(iframeId) as HTMLIFrameElement | null;
        const target = iframe?.contentWindow ?? null;

        logEvent('info', 'canvas-bridge', 'queue intercepted, dispatching to ComfyDeploy', {
          projectId: activeProjectId,
          batchCount: ev.batchCount ?? 1,
        });

        setInterlock(true, 'ComfyDeploy queue running');

        fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: activeProjectId,
            workflowApiJson: ev.workflowApiJson,
            workflow: ev.workflow,
          }),
        })
          .then(async res => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(data.detail || data.error || `HTTP ${res.status}`);
            }
            logEvent('info', 'canvas-bridge', 'iteration captured', data);
            target?.postMessage(
              {
                type: 'scruple:queue-result',
                ok: true,
                runSequence: data.runSequence,
              },
              '*',
            );
            router.refresh();
          })
          .catch(e => {
            logEvent('error', 'canvas-bridge', 'queue failed', e);
            target?.postMessage(
              {
                type: 'scruple:queue-result',
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              },
              '*',
            );
          })
          .finally(() => {
            setInterlock(false);
          });
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeProjectName, iframeId]);

  // Also re-push when the active project changes after the iframe was
  // already loaded.
  useEffect(() => {
    if (lastSentProject.current === activeProjectId) return;
    const iframe = document.getElementById(iframeId) as HTMLIFrameElement | null;
    sendActiveProject(iframe?.contentWindow ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeProjectName, iframeId]);

  return null;
}
