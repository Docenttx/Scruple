// /canvas — top-level Canvas view.
//
// Canvas v2 (WO-2): tier-gating removed. Every signed-in user gets a
// per-user Modal-hosted ComfyUI container. If there's no active
// session yet, the page renders a minimal Start-canvas affordance —
// WO-5 will replace this with auto-mint via the HTTP+WS proxy. The
// existing on-host `canvas.stooges.ai` Free-tier fallback is retired
// from the product surface; users without paid GPU should use
// Scruple Studio Desktop (separate codebase).

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getActiveProject } from '@/lib/projects/actions';
import AppShell from '@/components/AppShell';
import CanvasBridge from '@/components/CanvasBridge';
import { getActiveCanvasSession } from '@/lib/canvas/session';

const IFRAME_ID = 'scruple-canvas-iframe';

export default async function CanvasPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const active = await getActiveProject();
  const canvasSession = getActiveCanvasSession(userId);

  if (canvasSession) {
    return (
      <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
        <div className="relative h-full">
          <iframe
            id={IFRAME_ID}
            src={canvasSession.modal_url}
            title={`ComfyUI canvas — ${canvasSession.machine_id}`}
            className="h-full w-full border-0 bg-scruple-bg"
            allow="clipboard-read; clipboard-write; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          />
          <CanvasBridge
            iframeId={IFRAME_ID}
            activeProjectId={active?.id}
            activeProjectName={active?.name}
          />
        </div>
      </AppShell>
    );
  }

  // No session yet — minimal Start affordance. WO-5 replaces this with
  // auto-mint behavior + the HTTP+WS proxy.
  return (
    <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
      <div className="flex h-full items-center justify-center bg-scruple-bg p-8">
        <StartCanvasCard />
      </div>
    </AppShell>
  );
}

function StartCanvasCard() {
  return (
    <form
      action="/api/canvas/session"
      method="POST"
      className="max-w-md rounded-md border border-scruple-border bg-scruple-surface p-6 text-center"
    >
      <h2 className="text-base font-medium">Start a Canvas Session</h2>
      <p className="mt-2 text-xs text-scruple-muted">
        Per-second billing on Modal GPU. Stripe pre-authorizes 1 hour and captures only
        your actual usage when you end the session.
      </p>
      <button
        type="submit"
        className="mt-4 rounded bg-scruple-accent-primary px-4 py-2 text-sm text-scruple-bg hover:opacity-90"
      >
        Start Canvas
      </button>
      <p className="mt-3 text-[10px] opacity-50">
        Pick your default machine in{' '}
        <a href="/settings#compute" className="underline">
          Settings → Compute
        </a>
        .
      </p>
    </form>
  );
}
