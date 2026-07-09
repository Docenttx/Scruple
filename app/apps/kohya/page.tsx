// /apps/kohya — Kohya training tab (Studio app 3).
//
// WO docs/wo/2026-07-06-kohya-runpod-app.md — Phase 2.
//
// Same shape as /canvas but runs on RunPod. When the user lands:
//   1) resolve their existing active session, or mint one via
//      lib/apps/session.ts (which spawns a RunPod pod + waits for
//      Gradio port + returns the *.proxy.runpod.net URL)
//   2) iframe /kohya-proxy/<sessionId>/ so the HTTP+WS proxy layer
//      is the provenance gate
//   3) surface a clear error card if RUNPOD_API_KEY is missing OR pod
//      spawn times out
//
// A single active session per user (like Canvas).

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getActiveProject } from '@/lib/projects/actions';
import AppShell from '@/components/AppShell';
import CanvasIframeWithLoader from '@/components/CanvasIframeWithLoader';
import {
  getActiveAppSession,
  mintAppSession,
  proxyUrlForAppSession,
} from '@/lib/apps/session';
import { RUNPOD_DEFAULT_MACHINE_ID, getRunpodMachineById } from '@/lib/apps/runpod-machines';
import { getApp } from '@/lib/apps/registry';

const IFRAME_ID = 'scruple-kohya-iframe';

interface KohyaMintFailure {
  code: 'no_runpod_key' | 'no_template' | 'spawn_timeout' | 'unknown';
  message: string;
}

export default async function KohyaPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const app = getApp('kohya');
  const active = await getActiveProject();
  const machineId = RUNPOD_DEFAULT_MACHINE_ID;
  const machine = getRunpodMachineById(machineId);

  if (!app?.enabled) {
    return (
      <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
        <div className="flex h-full items-center justify-center bg-scruple-bg p-8">
          <div className="max-w-md rounded-md border border-amber-500/40 bg-amber-500/10 p-6 text-center">
            <h2 className="text-base font-medium text-amber-200">Kohya not configured</h2>
            <p className="mt-2 text-xs text-amber-200/80">
              RUNPOD_API_KEY is not set on this deployment. The Kohya training
              tab spawns pods on RunPod on demand; without an API key the app
              is disabled.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  let appSession = getActiveAppSession(userId, 'kohya');
  let mintFailure: KohyaMintFailure | null = null;
  if (!appSession) {
    try {
      const minted = await mintAppSession(userId, 'kohya', machineId);
      appSession = {
        id: minted.id,
        user_id: userId,
        app_id: 'kohya',
        backend: 'runpod',
        machine_id: machineId,
        endpoint_id: '', // unused in the page render
        endpoint_url: minted.endpointUrl,
        hourly_rate_cents: minted.hourlyRateCents,
        signed_token: minted.signedToken,
        started_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        expires_at: minted.expiresAt,
        status: 'active',
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let code: KohyaMintFailure['code'] = 'unknown';
      if (/RUNPOD_API_KEY/.test(msg)) code = 'no_runpod_key';
      else if (/TEMPLATE_ID/.test(msg)) code = 'no_template';
      else if (/did not expose port/.test(msg)) code = 'spawn_timeout';
      mintFailure = { code, message: msg };
    }
  }

  if (appSession) {
    const proxyUrl = proxyUrlForAppSession('kohya', appSession.id);
    return (
      <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
        <CanvasIframeWithLoader
          iframeId={IFRAME_ID}
          src={proxyUrl}
          title={`Kohya training — ${machine?.name ?? machineId}`}
          machineName={machine?.name ?? 'RunPod'}
        />
      </AppShell>
    );
  }

  return (
    <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
      <div className="flex h-full items-center justify-center bg-scruple-bg p-8">
        <div className="max-w-md rounded-md border border-red-500/40 bg-red-500/10 p-6 text-center">
          <h2 className="text-base font-medium text-red-200">
            Couldn&apos;t start Kohya
          </h2>
          <p className="mt-2 text-xs text-red-200/80">
            {mintFailure?.message ?? 'Unknown error'}
          </p>
          <p className="mt-3 text-[11px] uppercase tracking-wider text-red-300/60">
            code · {mintFailure?.code ?? 'unknown'}
          </p>
        </div>
      </div>
    </AppShell>
  );
}
