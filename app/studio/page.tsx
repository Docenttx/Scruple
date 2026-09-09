// /studio — one route, two shapes.
//
// WO-D5's gate: this same route renders a desktop-shaped dashboard when
// capabilities report local apps and a web-shaped one when they report
// Modal/RunPod. Nothing below branches on the deployment; it branches on the
// ANSWER, which is why there is one component tree and not two.
//
// ---------------------------------------------------------------------------
// HOW THE DEPLOYMENT ANNOUNCES ITSELF
// ---------------------------------------------------------------------------
//
// A served app is the web deployment. That is not a guess — it is what the
// server IS. Desktop Studio is the exception, so Desktop Studio is what has to
// speak up: scruple-desktop/app/main-modular.js sets `x-scruple-profile:
// desktop` on every request its BrowserWindow session makes, which means the
// header is on the document request, on the client navigations and on the API
// calls, without a query parameter anyone can hand-edit into the URL bar.
//
// `?profile=` is honoured too, and deliberately: it is how a web developer
// looks at the desktop shape without an Electron build, and it is how
// scripts/d5-gate.sh checks both shapes come off the same route.
//
// ⚑ AN UNKNOWN VALUE IS REFUSED, NOT COERCED. A typo'd profile renders a
// refusal, not the web shape — the same rule `mime` follows on this API, for
// the same reason: a silent fallback is a wrong answer that looks like a right
// one.
//
// ---------------------------------------------------------------------------
// IT ASKS THE REAL ENDPOINT
// ---------------------------------------------------------------------------
//
// This calls GET /api/v2/capabilities over HTTP rather than importing
// `deploymentCapabilities()` directly. Importing would be faster and would
// prove less: the WO says the dashboard renders from the endpoint, and a page
// that renders from a function call would keep working if the endpoint were
// broken or removed.

import { headers } from 'next/headers';
import {
  isDeploymentProfile,
  DEPLOYMENT_PROFILES,
  type DeploymentCapabilities,
} from '@/lib/v2/deployment';
import StudioDashboard from '@/components/studio/StudioDashboard';

export const dynamic = 'force-dynamic';

export default async function StudioPage({
  searchParams,
}: {
  searchParams: { profile?: string };
}) {
  const h = headers();
  const declared = searchParams?.profile ?? h.get('x-scruple-profile');

  if (declared != null && !isDeploymentProfile(declared)) {
    return (
      <Refusal
        title="Unknown deployment profile"
        detail={`“${declared}” is not one of: ${DEPLOYMENT_PROFILES.join(', ')}. Nothing is rendered rather than the wrong shape being rendered.`}
      />
    );
  }
  const profile = declared ?? 'web';

  const host = h.get('host') ?? '127.0.0.1:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('127.0.0.1') || host.startsWith('localhost') ? 'http' : 'https');
  const url = `${proto}://${host}/api/v2/capabilities?profile=${encodeURIComponent(profile)}`;

  let caps: DeploymentCapabilities;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const body = await r.json();
    // v2Ok returns the object at the top level — there is no `data` envelope on
    // this API (lib/v2/http.ts). The shape check is on a field the answer must
    // have, so a 200 carrying an error body still lands in the refusal.
    if (!r.ok || !Array.isArray(body?.regions)) {
      return (
        <Refusal
          title="The capabilities endpoint refused"
          detail={`${url} answered ${r.status}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}`}
        />
      );
    }
    caps = body as DeploymentCapabilities;
  } catch (err) {
    // A dashboard that drew a default shape when it could not reach the server
    // would be the one thing this design refuses: a UI asserting applicability
    // it never obtained.
    return (
      <Refusal
        title="No answer from the capabilities endpoint"
        detail={`${url}: ${String((err as Error)?.message ?? err)}`}
      />
    );
  }

  return <StudioDashboard caps={caps} />;
}

function Refusal({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="scruple-canon workspace" data-profile="refused">
      <div className="app-container">
        <main className="main-content">
          <div className="active-project empty" data-region="refusal">
            <div className="placeholder">
              <div className="icon">⛑</div>
              <div className="text">{title}</div>
              <div className="hint">{detail}</div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
