// GET /api/v2/capabilities
//
// Canon D-7. Public and unauthenticated: applicability is not secret, and
// a client should be able to render its UI before the user has signed in.
//
// TWO QUESTIONS, ONE ENDPOINT, because they are the same question at two
// scales and the sentence above is the reason for both:
//
//   ?host=blender&mime=image/png   which MODALITIES apply to this file on this
//                                  host — lib/v2/capabilities.ts.
//   ?profile=desktop | web         which REGIONS apply to this DEPLOYMENT —
//                                  lib/v2/deployment.ts. Desktop reports local
//                                  ComfyUI/Kohya, the vault and the model
//                                  store; web reports Modal and RunPod. The
//                                  dashboard at /studio renders from this and
//                                  from nothing else, so the two shapes are
//                                  one component tree reading one answer.
//
//   &host_apps=comfyui,blender     ⚑ WO-E5. WHAT THE HOST SAYS IS ON THE BOX.
//                                  Also read from `x-scruple-host-apps`, which
//                                  is how the desktop window actually sends it.
//                                  One region — `blender` — applies only when
//                                  the host announced one, because whether
//                                  there is a Blender on someone's machine is
//                                  not a fact a server has. Absent means
//                                  ABSENT, not empty; see lib/v2/deployment.ts.
//
// Neither form defaults. `mime` is required because extension guessing is what
// broke .flac and .jxl; `profile` is validated against the enum for the same
// reason — a dashboard that silently fell back to the web shape when handed a
// typo would be drawing cloud compute inside a desktop app. `host_apps` is
// validated the same way and for the same reason: an id nobody here knows is
// REFUSED, never dropped, because a dropped id makes "the host has no Blender"
// and "the host said Blender in a way we did not parse" the same answer.

import type { NextRequest } from 'next/server';
import { capabilitiesFor, type HostId, type Modality } from '@/lib/v2/capabilities';
import {
  deploymentCapabilities,
  isDeploymentProfile,
  isHostAppId,
  DEPLOYMENT_PROFILES,
  HOST_APP_IDS,
  type HostAppId,
} from '@/lib/v2/deployment';
import { v2Error, v2Ok } from '@/lib/v2/http';

export const dynamic = 'force-dynamic';

const HOSTS: readonly HostId[] = [
  'blender', 'fusion360', 'inventor', 'solidworks', 'meshroom', 'toonboom',
  'photoshop', 'illustrator', 'indesign', 'comfyui', 'kohya',
];

export async function GET(req: NextRequest) {
  const host = req.nextUrl.searchParams.get('host');
  const mime = req.nextUrl.searchParams.get('mime');
  const profile = req.nextUrl.searchParams.get('profile');

  // The deployment question. Asked without a host, because it is not about one.
  if (!host && profile !== null) {
    if (!isDeploymentProfile(profile)) {
      return v2Error(
        'invalid_body',
        `\`profile\` must be one of: ${DEPLOYMENT_PROFILES.join(', ')}.`,
        { got: profile },
      );
    }
    // The query form is for a shell and for a developer without an Electron
    // build; the header is what the window sends, on every request, without a
    // URL anyone can hand-edit. Same precedent as `x-scruple-profile`.
    const raw =
      req.nextUrl.searchParams.get('host_apps') ?? req.headers.get('x-scruple-host-apps');
    let announced: HostAppId[] | null = null;
    if (raw !== null) {
      const parts = raw.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
      const unknown = parts.filter((x) => !isHostAppId(x));
      if (unknown.length > 0) {
        return v2Error(
          'invalid_body',
          `\`host_apps\` must be a comma-separated subset of: ${HOST_APP_IDS.join(', ')}.`,
          { unknown },
        );
      }
      // Deduplicated, order preserved. An empty announcement is an
      // announcement — "I looked and found nothing" — and is not `null`.
      announced = [...new Set(parts)] as HostAppId[];
    }
    return v2Ok(deploymentCapabilities(profile, announced));
  }

  if (!host || !HOSTS.includes(host as HostId)) {
    return v2Error(
      'invalid_body',
      `\`host\` must be one of: ${HOSTS.join(', ')}. ` +
        `For the deployment's own regions instead, ask \`?profile=${DEPLOYMENT_PROFILES.join('|')}\`.`,
      { got: host },
    );
  }
  if (!mime) {
    return v2Error(
      'invalid_body',
      '`mime` is required. Declare the media type explicitly — do not let it be inferred. Extension-based guessing is what broke .flac and .jxl signing.',
    );
  }

  const modalities = capabilitiesFor(host as HostId, mime);
  return v2Ok({
    host,
    mime,
    modalities: modalities satisfies Array<{ modality: Modality }>,
  });
}
