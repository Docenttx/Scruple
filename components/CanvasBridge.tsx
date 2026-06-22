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

      // Queue intercept: spawn the Modal call async, then poll status.
      // The POST returns 202 with a jobId in <1s (no Cloudflare 100s
      // timeout to worry about). We then poll /api/generate/status every
      // 3s until terminal. Preemption retries are handled server-side.
      if (data.type === 'scruple:queue-prompt') {
        const ev = data as QueuePromptMessage;
        const iframe = document.getElementById(iframeId) as HTMLIFrameElement | null;
        const target = iframe?.contentWindow ?? null;

        logEvent('info', 'canvas-bridge', 'queue intercepted, dispatching to ComfyDeploy', {
          projectId: activeProjectId,
          batchCount: ev.batchCount ?? 1,
        });

        setInterlock(true, 'ComfyDeploy queue running');

        const failQueue = (err: string) => {
          logEvent('error', 'canvas-bridge', 'queue failed', { error: err });
          target?.postMessage(
            { type: 'scruple:queue-result', ok: false, error: err },
            '*',
          );
          setInterlock(false);
        };

        const succeedQueue = (runSequence: number | null) => {
          target?.postMessage(
            { type: 'scruple:queue-result', ok: true, runSequence },
            '*',
          );
          router.refresh();
          setInterlock(false);
        };

        (async () => {
          let dispatchRes: Response;
          try {
            dispatchRes = await fetch('/api/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                projectId: activeProjectId,
                workflowApiJson: ev.workflowApiJson,
                workflow: ev.workflow,
              }),
            });
          } catch (e) {
            failQueue(e instanceof Error ? e.message : String(e));
            return;
          }
          const dispatchBody = await dispatchRes.json().catch(() => ({}));
          if (!dispatchRes.ok || !dispatchBody.jobId) {
            failQueue(dispatchBody.detail || dispatchBody.error || `dispatch HTTP ${dispatchRes.status}`);
            return;
          }
          const jobId = dispatchBody.jobId as string;
          logEvent('info', 'canvas-bridge', 'job started', { jobId });

          // Poll. Max 15 minutes (300 attempts × 3s). Server may re-spawn
          // on preemption — we stay polling.
          const MAX_ATTEMPTS = 300;
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            await new Promise(r => setTimeout(r, 3000));
            let statusRes: Response;
            try {
              statusRes = await fetch(`/api/generate/status?jobId=${encodeURIComponent(jobId)}`);
            } catch (e) {
              // Transient network blip — keep polling
              continue;
            }
            if (!statusRes.ok) {
              failQueue(`status HTTP ${statusRes.status}`);
              return;
            }
            const sb = await statusRes.json().catch(() => ({}));
            if (sb.status === 'done') {
              logEvent('info', 'canvas-bridge', 'iteration captured', sb);
              succeedQueue(sb.runSequence ?? null);
              return;
            }
            if (sb.status === 'failed') {
              failQueue(sb.error || 'generation failed');
              return;
            }
            // status === 'running' → keep polling. Logging every 5th
            // attempt (~15s) so the log isn't noisy.
            if (attempt % 5 === 0) {
              logEvent('info', 'canvas-bridge', 'still running', {
                jobId,
                elapsedSec: sb.elapsedSec,
                retryCount: sb.retryCount,
              });
            }
          }
          failQueue('client polling timed out (15 min)');
        })();
      }

      // ── Canvas-on-Modal witness events ────────────────────────────────
      // Fired by scruple-canvas-witness.js inside the per-user Modal
      // ComfyUI iframe. Workflow EXECUTES inside the iframe (Modal has
      // the GPU); we just attach provenance after the fact.
      //
      // start    — workflow JSON captured at /prompt time
      // complete — output bytes captured at execution_success time
      //
      // Both POST to scruple-web's /api/canvas/witness/* and pipe into
      // the existing ingestIteration pipeline. See
      // docs/wo/2026-06-22-canvas-on-modal.md.
      if (data.type === 'scruple:canvas-witness-start') {
        const ev = data as {
          session_token: string;
          project_id: number;
          prompt_id: string;
          workflow_api_json: Record<string, unknown>;
        };
        fetch('/api/canvas/witness/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_token: ev.session_token,
            project_id: ev.project_id,
            prompt_id: ev.prompt_id,
            workflow_api_json: ev.workflow_api_json,
          }),
        }).catch(e => {
          logEvent('error', 'canvas-bridge', 'witness/start fetch failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        return;
      }

      if (data.type === 'scruple:canvas-witness-complete') {
        const ev = data as {
          session_token: string;
          prompt_id: string;
          output_bytes_b64: string;
          output_content_type: string;
          output_kind?: 'image' | 'video' | 'checkpoint';
          output_filename?: string;
        };
        const iframe = document.getElementById(iframeId) as HTMLIFrameElement | null;
        const target = iframe?.contentWindow ?? null;
        (async () => {
          const res = await fetch('/api/canvas/witness/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ev),
          }).catch(e => null);
          if (!res || !res.ok) {
            const body = res ? await res.json().catch(() => ({})) : {};
            const error = body.error || body.detail || `HTTP ${res?.status ?? 'network'}`;
            target?.postMessage({ type: 'scruple:queue-result', ok: false, error }, '*');
            return;
          }
          const body = await res.json().catch(() => ({}));
          target?.postMessage(
            {
              type: 'scruple:queue-result',
              ok: true,
              runSequence: body.run_sequence ?? null,
              leafHash: body.leaf_hash ?? null,
            },
            '*',
          );
          router.refresh();
        })();
        return;
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
