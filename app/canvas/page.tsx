// /canvas — top-level Canvas view.
//
// Embeds the local ComfyUI editor (canvas.stooges.ai). Captures from
// the canvas land on whichever project is currently set as active
// (see Sidebar's ActiveProjectBanner). To compose a workflow against
// a specific project, activate that project from the sidebar first.

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getActiveProject } from '@/lib/projects/actions';
import AppShell from '@/components/AppShell';

const CANVAS_URL = 'https://canvas.stooges.ai/';

export default async function CanvasPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const active = await getActiveProject();

  return (
    <AppShell
      activeProjectId={active?.id}
      viewingProjectName={active?.name}
    >
      <div className="h-full">
        <iframe
          src={CANVAS_URL}
          title="ComfyUI canvas"
          className="h-full w-full border-0 bg-scruple-bg"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      </div>
    </AppShell>
  );
}
