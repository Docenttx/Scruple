// GET /api/v2/builds — the published-builds registry (H-4 §4.3, §10 C-4).
//
// PUBLIC AND UNAUTHENTICATED, the same call GET /api/v2/receipt/{leaf_id}
// makes: a registry whose contents require the issuer's cooperation to
// read is not much of a registry. Every entry here is a statement we have
// already made about what we shipped, signed with a key whose public half
// is served alongside it, so a vendor can check their own build without an
// account and a verifier holding an old leaf can check it without us.
//
// READ-ONLY BY CONSTRUCTION. There is no POST. Publication is authorised
// by possession of the registry signing key and by nothing else — no /v2
// scope is the right credential, and a tenant must never be able to
// publish a build. The write path is lib/builds/cli.ts, which reads the
// key locally. See its header.

import { listBuilds, buildRegistryStatus } from '@/lib/builds/registry';
import { registryPublicKey } from '@/lib/builds/signing';
import { v2Ok } from '@/lib/v2/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const component = url.searchParams.get('component') ?? undefined;
  // Status is time-relative (withdrawal does not reach backwards), so the
  // reference instant is a parameter rather than an assumption.
  const at = url.searchParams.get('at') ?? undefined;

  const builds = listBuilds(component).map((b) => {
    const st = buildRegistryStatus(b.measurement, at);
    return {
      measurement: b.measurement,
      component: b.component_name,
      version: b.version,
      measurement_kind: b.measurement_kind,
      published_at: b.published_at,
      notes: b.notes,
      status: st.status,
      withdrawn_at: st.withdrawn_at,
      superseded_by: st.superseded_by,
      signature: {
        alg: b.signature_alg,
        key_id: b.signing_key_id,
        value: b.signature,
        entry_sha256: b.entry_sha256,
      },
    };
  });

  return v2Ok({
    // Served so the signatures above are checkable by whoever reads them.
    // `null` on a host that holds no signing key, stated rather than
    // omitted — "we cannot show you the key here" and "these are unsigned"
    // must not share a spelling.
    signing_key: registryPublicKey(),
    as_of: at ?? new Date().toISOString(),
    builds,
    // The sentence a vendor is entitled to have in front of them when
    // they read this list, in the words §4.3 uses.
    limit:
      'A modified build can claim any measurement string, including one on this list. ' +
      'What it cannot do is produce a valid MAC without its injected key, and where the ' +
      'vendor has attestable compute that key is sealed to the measurement. This registry ' +
      'is one half of that pairing and is not evidence on its own.',
  });
}
