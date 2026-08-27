// GET /api/v2/capabilities?host=...&mime=...
//
// Canon D-7. Public and unauthenticated: applicability is not secret, and
// a client should be able to render its UI before the user has signed in.

import type { NextRequest } from 'next/server';
import { capabilitiesFor, type HostId, type Modality } from '@/lib/v2/capabilities';
import { v2Error, v2Ok } from '@/lib/v2/http';

export const dynamic = 'force-dynamic';

const HOSTS: readonly HostId[] = [
  'blender', 'fusion360', 'inventor', 'solidworks', 'meshroom', 'toonboom',
  'photoshop', 'illustrator', 'indesign', 'comfyui', 'kohya',
];

export async function GET(req: NextRequest) {
  const host = req.nextUrl.searchParams.get('host');
  const mime = req.nextUrl.searchParams.get('mime');

  if (!host || !HOSTS.includes(host as HostId)) {
    return v2Error('invalid_body', `\`host\` must be one of: ${HOSTS.join(', ')}.`, { got: host });
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
