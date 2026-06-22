// /canvas — top-level Canvas view.
//
// Canvas v2 (WO-5): single render branch. Authenticated user lands →
// server-side auto-mint (or reuse) a canvas session → iframe the
// scruple-web proxy URL. The Modal URL never reaches the browser; the
// proxy at /canvas-proxy/[sessionId]/ is the provenance gate.
//
// Free product (Scruple Studio Desktop) is a separate codebase; the
// on-host canvas.stooges.ai is retired from the product surface.

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getActiveProject } from '@/lib/projects/actions';
import AppShell from '@/components/AppShell';
import CanvasBridge from '@/components/CanvasBridge';
import {
  getActiveCanvasSession,
  mintCanvasSession,
  proxyUrlForSession,
} from '@/lib/canvas/session';
import { resolveActiveMachine } from '@/lib/compute/getActiveMachine';

const IFRAME_ID = 'scruple-canvas-iframe';

export default async function CanvasPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const active = await getActiveProject();

  // Reuse existing session if any, else mint. WO-6 will add Stripe
  // PaymentIntent creation + a card-required gate inside this flow.
  let canvasSession = getActiveCanvasSession(userId);
  let mintError: string | null = null;
  if (!canvasSession) {
    try {
      const machineId = resolveActiveMachine(userId).machine.id;
      const minted = mintCanvasSession(userId, machineId);
      canvasSession = {
        id: minted.id,
        user_id: userId,
        machine_id: machineId,
        modal_url: minted.modalUrl,
        signed_token: minted.signedToken,
        started_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        expires_at: minted.expiresAt,
        status: 'active',
      };
    } catch (e) {
      mintError = e instanceof Error ? e.message : String(e);
    }
  }

  if (canvasSession) {
    const proxyUrl = proxyUrlForSession(canvasSession.id);
    return (
      <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
        <div className="relative h-full">
          <iframe
            id={IFRAME_ID}
            src={proxyUrl}
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

  // Mint failed (typically: Modal canvas app not yet deployed for the
  // user's chosen machine). Surface the operator-facing message.
  return (
    <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
      <div className="flex h-full items-center justify-center bg-scruple-bg p-8">
        <div className="max-w-md rounded-md border border-red-500/40 bg-red-500/10 p-6 text-center">
          <h2 className="text-base font-medium text-red-200">Canvas unavailable</h2>
          <p className="mt-2 text-xs text-red-200/80">
            Could not start a canvas session: {mintError ?? 'unknown error'}
          </p>
          <p className="mt-3 text-[11px] text-red-200/60">
            Pick a different machine in{' '}
            <a href="/settings#compute" className="underline">
              Settings → Compute
            </a>{' '}
            or contact the operator to deploy the Modal canvas app for this GPU.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
