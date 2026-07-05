// /canvas — top-level Canvas view.
//
// Canvas v2 (WO-5+WO-6): server-side mint + Stripe pre-auth hold +
// iframe proxy. Single render branch; the user lands and either gets
// a live session OR a clear error card (no card / Modal not deployed
// / Stripe down).

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getActiveProject } from '@/lib/projects/actions';
import AppShell from '@/components/AppShell';
import CanvasBridge from '@/components/CanvasBridge';
import CanvasSessionHUD from '@/components/CanvasSessionHUD';
import {
  getActiveCanvasSession,
  mintCanvasSessionWithBilling,
  proxyUrlForSession,
  CanvasMintError,
  type CanvasSessionRow,
} from '@/lib/canvas/session';
import {
  resolveActiveMachine,
} from '@/lib/compute/getActiveMachine';
import { getMachineById } from '@/lib/compute/machines';

const IFRAME_ID = 'scruple-canvas-iframe';

interface MintFailure {
  code: 'no_card' | 'stripe_down' | 'not_deployed' | 'unknown';
  message: string;
}

export default async function CanvasPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const active = await getActiveProject();
  const machine = resolveActiveMachine(userId).machine;

  let canvasSession: CanvasSessionRow | null = getActiveCanvasSession(userId);
  let mintFailure: MintFailure | null = null;
  if (!canvasSession) {
    try {
      const minted = await mintCanvasSessionWithBilling(userId, machine.id, session?.user?.email);
      canvasSession = {
        id: minted.id,
        user_id: userId,
        machine_id: machine.id,
        modal_url: minted.modalUrl,
        signed_token: minted.signedToken,
        started_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        expires_at: minted.expiresAt,
        status: 'active',
      };
    } catch (e) {
      if (e instanceof CanvasMintError) {
        mintFailure = { code: e.code, message: e.message };
      } else {
        mintFailure = {
          code: 'unknown',
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }

  if (canvasSession) {
    const proxyUrl = proxyUrlForSession(canvasSession.id);
    const m = getMachineById(canvasSession.machine_id) ?? machine;
    return (
      <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
        <div className="relative h-full">
          <iframe
            id={IFRAME_ID}
            src={proxyUrl}
            title={`ComfyUI canvas — ${m.name}`}
            className="h-full w-full border-0 bg-scruple-bg"
            allow="clipboard-read; clipboard-write; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          />
          <CanvasBridge
            iframeId={IFRAME_ID}
            activeProjectId={active?.id}
            activeProjectName={active?.name}
          />
          <CanvasSessionHUD
            sessionId={canvasSession.id}
            machineName={m.name}
            hourlyRateCents={m.hourlyRateCents}
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
      <div className="flex h-full items-center justify-center bg-scruple-bg p-8">
        <MintFailureCard failure={mintFailure ?? { code: 'unknown', message: '' }} />
      </div>
    </AppShell>
  );
}

function MintFailureCard({ failure }: { failure: MintFailure }) {
  if (failure.code === 'no_card') {
    return (
      <div className="max-w-md rounded-md border border-amber-500/40 bg-amber-500/10 p-6 text-center">
        <h2 className="text-base font-medium text-amber-200">Add a payment method</h2>
        <p className="mt-2 text-xs text-amber-200/80">
          Canvas sessions are billed per second. Add a card to start a session.
          Stripe holds 1 hour of compute and captures only the actual usage.
        </p>
        <a
          href="/settings#payment"
          className="mt-4 inline-block rounded bg-scruple-accent-primary px-4 py-2 text-sm text-scruple-bg hover:opacity-90"
        >
          Settings → Payment
        </a>
      </div>
    );
  }
  if (failure.code === 'not_deployed') {
    return (
      <div className="max-w-md rounded-md border border-red-500/40 bg-red-500/10 p-6 text-center">
        <h2 className="text-base font-medium text-red-200">Canvas unavailable</h2>
        <p className="mt-2 text-xs text-red-200/80">
          The Modal canvas app isn&apos;t deployed for your chosen machine yet.
        </p>
        <p className="mt-3 text-[11px] text-red-200/60">{failure.message}</p>
        <a href="/settings#compute" className="mt-3 inline-block text-xs underline">
          Pick a different machine →
        </a>
      </div>
    );
  }
  return (
    <div className="max-w-md rounded-md border border-red-500/40 bg-red-500/10 p-6 text-center">
      <h2 className="text-base font-medium text-red-200">Could not start canvas</h2>
      <p className="mt-2 text-xs text-red-200/80">{failure.message || 'Unknown error'}</p>
    </div>
  );
}
