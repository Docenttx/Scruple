// GET /api/v2/builds/{measurement}[?at=ISO8601]
//
// "Was this build published WHEN MY LEAF WAS SIGNED?" — the question a
// verifier holding an old leaf actually has, and the reason the registry
// records withdrawal as a dated event rather than as a mutable column.
// Without `at`, a withdrawal would answer for every leaf that build ever
// produced, retroactively, which is the failure §4.2 already refused for
// counter gaps: a later fact must not be able to invalidate earlier
// evidence.
//
// Unpublished answers 200, not 404. `{"status":"unpublished"}` is an
// answer about a measurement; a 404 is an answer about a URL, and a
// client cannot tell it from a typo or a route that moved.

import { buildRegistryStatus, MEASUREMENT_RE } from '@/lib/builds/registry';
import { registryPublicKey } from '@/lib/builds/signing';
import { v2Error, v2Ok } from '@/lib/v2/http';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ measurement: string }> },
) {
  const { measurement } = await params;
  const decoded = decodeURIComponent(measurement);
  if (!MEASUREMENT_RE.test(decoded)) {
    return v2Error(
      'invalid_body',
      'Not a measurement. Expected "sha256:" followed by 64 lowercase hex characters — ' +
        'the shape services/scruple-capture/src/build-measurement.ts emits and the ' +
        'provisioning route validates.',
      { got: decoded },
    );
  }

  const at = new URL(req.url).searchParams.get('at') ?? undefined;
  const st = buildRegistryStatus(decoded, at);

  return v2Ok({
    measurement: st.measurement,
    known: st.known,
    status: st.status,
    as_of: st.as_of,
    withdrawn_at: st.withdrawn_at,
    superseded_by: st.superseded_by,
    entry: st.entry
      ? {
          component: st.entry.component_name,
          version: st.entry.version,
          measurement_kind: st.entry.measurement_kind,
          published_at: st.entry.published_at,
          notes: st.entry.notes,
          signature: {
            alg: st.entry.signature_alg,
            key_id: st.entry.signing_key_id,
            value: st.entry.signature,
            entry_sha256: st.entry.entry_sha256,
          },
        }
      : null,
    // Every lifecycle event that had taken effect by `as_of`, each with
    // its own signature. A withdrawal you cannot check is a rumour.
    events: st.events.map((e) => ({
      event: e.event,
      effective_at: e.effective_at,
      superseded_by: e.superseded_by,
      reason: e.reason,
      signature: {
        alg: e.signature_alg,
        key_id: e.signing_key_id,
        value: e.signature,
        entry_sha256: e.entry_sha256,
      },
    })),
    signing_key: registryPublicKey(),
  });
}
