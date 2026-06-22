// /canvas — top-level Canvas view.
//
// Two code paths, gated by user plan:
//
//   Free tier:   embeds the local on-host ComfyUI editor
//                (canvas.stooges.ai → :8188). Workflow composition
//                only — execution dispatches via the Scruple Queue
//                Intercept JS → /api/generate → per-request Modal.
//
//   Pro / Enterprise: embeds the user's own Modal-hosted ComfyUI
//                session (one container per user). Workflow editing
//                AND execution happen in the same container — no
//                node-set parity gap. Provenance via the canvas
//                intercept JS posting to /api/canvas/witness/*.
//                See docs/wo/2026-06-22-canvas-on-modal.md.
//
// Captures land on whichever project is currently set as active
// (Sidebar's ActiveProjectBanner). Activate a project from the
// sidebar first; otherwise Queue is disabled in the canvas.

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getActiveProject } from '@/lib/projects/actions';
import AppShell from '@/components/AppShell';
import CanvasBridge from '@/components/CanvasBridge';
import CanvasLauncher from '@/components/CanvasLauncher';
import { getUserPlan } from '@/lib/compute/userPlan';
import { getActiveCanvasSession } from '@/lib/canvas/session';

const FREE_CANVAS_URL = 'https://canvas.stooges.ai/';
const IFRAME_ID = 'scruple-canvas-iframe';

export default async function CanvasPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const active = await getActiveProject();
  const plan = getUserPlan(userId);
  const canvasSession = plan === 'free' ? null : getActiveCanvasSession(userId);

  // Pro/Enterprise with a live Modal session → iframe that.
  if (canvasSession) {
    return (
      <AppShell
        activeProjectId={active?.id}
        viewingProjectName={active?.name}
      >
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

  // Pro/Enterprise without a session → launcher card.
  if (plan !== 'free') {
    return (
      <AppShell
        activeProjectId={active?.id}
        viewingProjectName={active?.name}
      >
        <div className="flex h-full items-center justify-center bg-scruple-bg p-8">
          <CanvasLauncher plan={plan} />
        </div>
      </AppShell>
    );
  }

  // Free tier → local on-host CPU canvas, dispatch via /api/generate.
  return (
    <AppShell
      activeProjectId={active?.id}
      viewingProjectName={active?.name}
    >
      <div className="relative h-full">
        <iframe
          id={IFRAME_ID}
          src={FREE_CANVAS_URL}
          title="ComfyUI canvas (free tier)"
          className="h-full w-full border-0 bg-scruple-bg"
          allow="clipboard-read; clipboard-write; fullscreen"
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
