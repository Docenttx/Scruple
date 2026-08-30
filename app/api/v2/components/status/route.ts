// GET /api/v2/components/status — the reconciliation view (H-4 §4.2).
//
// The question a vendor cannot currently ask about their own estate: is
// anything I deployed no longer witnessing, and is anything it captured
// missing from the record? STUDIO_P1-P8_GRADE.md is the reason the
// question needs a surface — Kohya's silent no-op and the canvas path's
// swallowed ingest failure both make a dead capture path look exactly
// like a quiet afternoon, and neither is visible from anywhere.
//
// AUTH follows lib/v2/auth.ts, unchanged: bearer API key, `read` scope,
// no session cookie. `read` rather than a new scope because this is
// exactly what `read` is for — it changes nothing, and every key that
// already carries it (including the pre-scopes keys principalFrom()
// grants 'read' to) should be able to see whether its own components are
// alive. The tenant boundary is the principal's user id, applied inside
// lib/reconcile/status.ts as an argument rather than as a filter a
// caller can forget.
//
// GET, not POST, and therefore cacheable-looking — so it is explicitly
// force-dynamic. A cached liveness answer is worse than no liveness
// answer: it is a silent component reading live.

import type { NextRequest } from 'next/server';
import { requireScope } from '@/lib/v2/auth';
import { v2Error, v2Ok } from '@/lib/v2/http';
import { componentStatus, reconcileTenant } from '@/lib/reconcile/status';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const gate = requireScope(req, 'read');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  const url = new URL(req.url);
  const componentId = url.searchParams.get('component_id');
  const includeRetired = url.searchParams.get('include_retired') === '1';

  if (componentId) {
    const one = componentStatus(principal.userId, componentId);
    if (!one) {
      // A component in another tenant's estate answers exactly as a
      // component that does not exist. The difference is useful to
      // someone enumerating ids and useless to the owner, who cannot act
      // on it either way — the same reasoning principalFrom() applies to
      // key lookup.
      return v2Error(
        'not_found',
        'No such component in this tenant. Check the id, or provision it via POST /api/v2/components/provision.',
      );
    }
    return v2Ok({ component: one });
  }

  const report = reconcileTenant(principal.userId, { includeRetired });
  return v2Ok({
    ...report,
    // Said in the payload because a reader has no other way to know, and
    // an unqualified "silent: 0" invites more trust than it has earned.
    notes: {
      liveness:
        'Computed on read from last_seen_at and the component heartbeat window, so it is ' +
        'never stale. `episodes` come from the explicitly invoked reconciliation sweep and ' +
        'are empty until it has run; liveness itself does not depend on that.',
      gaps:
        'A gap is a counter the component produced and did not deliver. Gaps do not ' +
        'invalidate the leaves around them (§4.2) — a suppressed event must not be able to ' +
        'attack the vendor record. A gap that later drains is resolved, never deleted.',
      build:
        'claimed vs provisioned is DRIFT DETECTION, not provenance (§10 C-4): there is no ' +
        'published-builds registry yet, so a claimed measurement can only be compared with ' +
        'the one this component provisioned under.',
    },
  });
}
