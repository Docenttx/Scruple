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
// Neither form defaults. `mime` is required because extension guessing is what
// broke .flac and .jxl; `profile` is validated against the enum for the same
// reason — a dashboard that silently fell back to the web shape when handed a
// typo would be drawing cloud compute inside a desktop app.

import type { NextRequest } from 'next/server';
import { capabilitiesFor, type HostId, type Modality } from '@/lib/v2/capabilities';
import {
  deploymentCapabilities,
  isDeploymentProfile,
  DEPLOYMENT_PROFILES,
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
    return v2Ok(deploymentCapabilities(profile));
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
