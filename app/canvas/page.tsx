// /canvas — top-level Canvas view.
//
// Embeds the local ComfyUI editor (canvas.stooges.ai). The local
// ComfyUI runs CPU-only and is used only as the workflow composition
// surface — actual execution is dispatched to ComfyDeploy via the
// Scruple Queue Intercept extension (custom_nodes/scruple_nodes/js/),
// bridged through <CanvasBridge>.
//
// Captures land on whichever project is currently set as active
// (Sidebar's ActiveProjectBanner). Activate a project from the
// sidebar first; otherwise Queue is disabled in the canvas.

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getActiveProject } from '@/lib/projects/actions';
import AppShell from '@/components/AppShell';
import CanvasBridge from '@/components/CanvasBridge';

const CANVAS_URL = 'https://canvas.stooges.ai/';
const IFRAME_ID = 'scruple-canvas-iframe';

export default async function CanvasPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const active = await getActiveProject();

  return (
    <AppShell
      activeProjectId={active?.id}
      viewingProjectName={active?.name}
    >
      <div className="relative h-full">
        {!active && (
          <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-scruple-warn/40 bg-scruple-warn/10 px-3 py-1.5 text-[11px] text-scruple-warn">
            ⚠ No active project — Queue Prompt is disabled. Start Tracking a project from the sidebar.
          </div>
        )}
        <iframe
          id={IFRAME_ID}
          src={CANVAS_URL}
          title="ComfyUI canvas"
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
