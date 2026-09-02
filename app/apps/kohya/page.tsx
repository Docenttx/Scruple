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
//
// WO-30 — THE SECOND SURFACE, AND WHY THE BRANCH IS HERE AND NOT INSIDE THE
// IFRAME.
//
// `SCRUPLE_KOHYA_SURFACE` is not a preference; it is the configuration the tier
// is computed from (lib/apps/runpod-machines.ts). In `gui` it iframes Kohya's
// Gradio launcher, the tenant has code execution in the container, the
// placement is `unattested-client` and nothing observed in there may be
// witnessed. In `job-api` the pod exposes the capture component and nothing
// else, and the tenant's expressive power is exactly the whitelist in
// lib/apps/kohya/job-spec.ts.
//
// Those are two products with two evidence ceilings, so they are two renders.
// The same page deciding at runtime which one to draw is correct precisely
// BECAUSE the decision is the same one `runpod-session.ts` already made when it
// chose the image and the port — one function, `kohyaSurfaceMode()`, read in
// both places. A page that drew the job form against a GUI pod would be
// offering a surface the container does not have.
//
// The job API had no caller at all before this. docs/canon/demo-readiness/
// training.md §6 item 2: "the single smallest missing piece of product on the
// only path that reaches `server-library`."

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
import {
  RUNPOD_DEFAULT_MACHINE_ID,
  getRunpodMachineById,
  kohyaSurfaceMode,
} from '@/lib/apps/runpod-machines';
import { describeJobForm, defaultJobValues } from '@/lib/apps/kohya/form';
import { getApp } from '@/lib/apps/registry';
import JobSubmitPanel from './JobSubmitPanel';

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
  const surface = kohyaSurfaceMode();

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

  if (appSession && surface === 'job-api') {
    // The whitelist crosses to the browser as SHAPE ONLY — see
    // lib/apps/kohya/form.ts on why the form is generated rather than written,
    // and why job-spec.ts itself cannot be bundled for a client.
    return (
      <AppShell activeProjectId={active?.id} viewingProjectName={active?.name}>
        <JobSubmitPanel
          sessionId={appSession.id}
          sessionToken={appSession.signed_token}
          fields={describeJobForm()}
          defaults={defaultJobValues()}
          machineName={machine?.name ?? 'RunPod'}
          surface={surface}
        />
      </AppShell>
    );
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
