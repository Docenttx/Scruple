// The field set a capture component's ratchet MACs — one definition, three
// implementations, and a test that fails when they disagree.
//
// §4.1 wrote `mac = HMAC-SHA256(M_n, canonical_preimage)` and never said what
// canonical_preimage CONTAINS. §10 C-1 fixed the encoding (UTF-8 JSON, keys
// sorted by Unicode code point, compact separators, floats refused) and left
// the field set open. A component that MACs fields the server cannot
// reconstruct from the submission has a MAC that verifies nothing about the
// leaf — it authenticates the component and says nothing about the event.
//
// So the rule the sidecar WO set, and this file carries into the route:
// ONE FUNCTION PRODUCES THE PREIMAGE AND EVERY PARTY CALLS THE SAME ONE,
// over the same submission JSON. There is no second field list to drift.
//
// WHERE THE THREE IMPLEMENTATIONS ARE
//
//   here                                          the server, at ingest
//   services/scruple-capture/src/leaf.ts          the sidecar component
//   packages/scruple-host-sdk/.../server_library.py   the server-library
//                                                 component, in Python
//
// The sidecar's `preimageOf()` is the original and this is deliberately
// identical to it, field for field. It is copied rather than imported
// because a Next.js route importing out of `services/` would couple the web
// build to a container's source tree — and copying a field list is exactly
// the thing that goes wrong quietly, so `test/v2/component-auth.test.ts`
// imports BOTH and asserts they produce the same object for the same
// submission. When the sidecar's module can be reduced to a re-export of
// this one, it should be; until then the test is what holds them together,
// the same way test/vectors/ratchet-vectors.json holds the key schedule
// together across two languages.
//
// FLOATS NEVER APPEAR. A workflow graph is full of them (cfg: 8.0,
// denoise: 1.0) and Python `repr` and JS `Number#toString` do not agree on
// every double, so only the graph's HASH enters the preimage. Every value
// below is a string, a safe integer, or null.
//
// ABSENT IS NULL, NOT OMITTED. A key dropped from the object changes the
// canonical JSON and therefore the MAC, so a submission that carries no
// `capture` block must produce the same preimage shape as one whose capture
// fields are empty. The `server-library` placement has no separate observer
// — the vendor's handler is the observation — so it legitimately fills that
// block with less than the sidecar does, and the difference must be a null
// in a stable shape rather than a different shape.

import type { PreimageFields } from '@/lib/ratchet/ratchet';

/** What the component saw, as distinct from what the leaf commits to. */
export interface ComponentCaptureBlock {
  surface?: string | null;
  hook?: string | null;
  fidelity?: string | null;
  size_bytes?: number | null;
  mime_source?: string | null;
  correlation_id?: string | null;
  correlation_method?: string | null;
  egress?: string | null;
  close_detection?: string | null;
  workflow_hash?: string | null;
  observed_at?: string | null;
  attestation_status?: 'verified' | 'passthrough' | null;
}

export interface ComponentEnvelope {
  component_id: string;
  build_measurement?: string | null;
  counter: number;
  attestation?: { provider?: string | null; quote_ref?: string | null } | null;
}

/** The subset of POST /api/v2/witness that enters the MAC. */
export interface ComponentSubmission {
  baseline_ref?: string | null;
  kind?: string | null;
  content_hash: string;
  /** ABSENT, NOT DEFAULTED, when nothing was entitled to declare a type. */
  mime?: string | null;
  input_hash?: string | null;
  model_fingerprints_hash?: string | null;
  machine_manifest_hash?: string | null;
  capture?: ComponentCaptureBlock | null;
  component: ComponentEnvelope;
}

export function componentPreimage(s: ComponentSubmission): PreimageFields {
  const c = s.capture ?? {};
  return {
    component_id: s.component.component_id,
    counter: s.component.counter,
    build_measurement: s.component.build_measurement ?? null,
    attestation_provider: s.component.attestation?.provider ?? null,
    baseline_ref: s.baseline_ref ?? null,
    kind: s.kind ?? null,
    content_hash: s.content_hash,
    mime: s.mime ?? null,
    input_hash: s.input_hash ?? null,
    model_fingerprints_hash: s.model_fingerprints_hash ?? null,
    machine_manifest_hash: s.machine_manifest_hash ?? null,
    surface: c.surface ?? null,
    hook: c.hook ?? null,
    fidelity: c.fidelity ?? null,
    size_bytes: c.size_bytes ?? null,
    mime_source: c.mime_source ?? null,
    correlation_id: c.correlation_id ?? null,
    correlation_method: c.correlation_method ?? null,
    egress: c.egress ?? null,
    close_detection: c.close_detection ?? null,
    workflow_hash: c.workflow_hash ?? null,
    observed_at: c.observed_at ?? null,
    attestation_status: c.attestation_status ?? null,
  };
}
