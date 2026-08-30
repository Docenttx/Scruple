// GET /api/v2/builds/unrecognised — the other half of "recorded, not
// rejected" (§10 C-4, WO-15).
//
// lib/ratchet/verify.ts accepts a leaf whose claimed build is not in the
// registry, because refusing it would destroy evidence of an artifact
// that already exists and would hand a suppression primitive to whoever
// can move a byte in the component. That decision is only defensible if
// the result is VISIBLE. A status nobody can read is the same as no
// status, and this estate has the proof on file: Kohya's pod hook no-opped
// when an env var was absent, and a capture path gone dark produced the
// same observable as a quiet afternoon.
//
// TENANT-SCOPED AND AUTHENTICATED, unlike the registry itself. The
// registry is a statement about what WE published; this is a report about
// what a vendor's components are running, which is theirs and nobody
// else's.

import { requireScope } from '@/lib/v2/auth';
import { v2Ok } from '@/lib/v2/http';
import { unrecognisedBuildEvents } from '@/lib/builds/registry';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const gate = requireScope(req, 'read');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  const limitParam = Number(new URL(req.url).searchParams.get('limit') ?? '200');
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 200;

  const rows = unrecognisedBuildEvents(limit, principal.userId);

  return v2Ok({
    count: rows.length,
    events: rows.map((r) => ({
      component_id: r.component_id,
      counter: r.counter,
      build_measurement: r.build_measurement,
      build_status: r.build_status,
      verified_at: r.verified_at,
    })),
    // Said in the response because the number on its own reads as an
    // error count, and it is not one.
    note:
      'These leaves VERIFIED. Their MACs were valid and their counters were in window; ' +
      'what did not check out is the build they claimed. `unpublished` means we have no ' +
      'record of shipping it; `withdrawn` and `superseded` mean we did and no longer ' +
      'recommend it. None of these invalidate the leaf — a rejected event would be a ' +
      'suppressed one, and a suppressed event is worse than a flagged one. Rows with no ' +
      'status at all are events ingested before the registry existed and are not listed: ' +
      'a question that was never asked is not an answer.',
  });
}
