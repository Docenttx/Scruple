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
import type { AttestationBasis, CaptureProfile } from '@/lib/leaf/attestationBasis';
import type {
  ConfinementSource,
  StorageConfinement,
} from '@/lib/capture/storageConfinement';
import type {
  UncapturedReason,
  UpstreamContinuity,
  UpstreamSource,
} from '@/lib/capture/upstreamEpoch';
import {
  resolutionPreimageFields,
  type ResolutionHandles,
} from '@/lib/leaf/resolutionHandles';

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
  /**
   * RETRACTED AS PROVENANCE (WO-C1), AND HELD HERE AT null ON PURPOSE.
   *
   * `lib/leaf/captureClaims.ts` rejects any non-null value: a filesystem
   * observation may not create, complete or authenticate an artifact leaf.
   * The KEY stays in the preimage because dropping it would change the
   * canonical JSON and therefore every MAC across three implementations for
   * a cosmetic gain — and because keeping it makes the MAC cover the
   * ASSERTION THAT THERE IS NO CLOSE DETECTION. A proxy cannot add one in
   * flight without breaking the signature. Dead as provenance, load-bearing
   * as a negative. The observation itself rides in `capture.fs_diagnostic`,
   * which nothing below reads.
   */
  close_detection?: null;
  workflow_hash?: string | null;
  observed_at?: string | null;
  /** WO-C1. The three-valued basis. See @/lib/leaf/attestationBasis. */
  attestation_status?: AttestationBasis | null;
  /**
   * WO-C1. The profile the basis is conditional on, and it is IN THE
   * PREIMAGE for the same reason WO-C2 moves the resolution handles in: a
   * basis whose precondition travels unsigned is a basis an attacker
   * rewrites. `verified` is refused on 'desktop'; leave the profile out of
   * the MAC and that refusal is one byte away from being bypassed by
   * anything sitting between the component and this route.
   */
  profile?: CaptureProfile | null;
  /**
   * WO-C4. THE STORAGE CONFINEMENT MEASURED ON THIS EMISSION, and it is in
   * the preimage for the reason `profile` is.
   *
   * The council's chain: an uncaptured runaway write exhausts blocks on a
   * shared filesystem, the ratchet's local append cannot `fsync`, and because
   * the MAC is the blocking half of `emit()` the gate fails closed —
   * fail-closed becomes fail-stopped. The leaf records the condition; a
   * condition a proxy can rewrite to `confined` is not recorded.
   *
   * ⚑ `confinement_source` IS SIGNED SEPARATELY AND THAT IS NOT REDUNDANT.
   * The value says what was seen; the source says whether anything was. An
   * attacker who could promote `unknown` to `measured` would turn "nobody
   * looked" into "somebody checked", which is the whole distinction the
   * measured-or-unknown invariant exists to hold.
   */
  confinement?: StorageConfinement | null;
  confinement_source?: ConfinementSource | null;
  /**
   * WO-C5. WHO THE UPSTREAM WAS AND WHETHER ITS HISTORY RING SURVIVED, and
   * they are in the preimage for the reason `profile` and `confinement` are.
   *
   * The council owned this: "nothing in the component tracks upstream
   * identity ... we never ask ComfyUI who it is", and so a silent ComfyUI
   * restart resets `PromptQueue.history` and reads as a normal short history.
   * The whole value of the fix is that the restart becomes visible on the
   * evidence — and a `upstream_continuity: 'restarted'` that a party in the
   * middle can rewrite to `'continuous'` is not visible on anything.
   *
   * ⚑ `upstream_identity` IS NOT A RESTART SIGNAL AND IS A SEPARATE FIELD SO
   * THAT NOBODY READS IT AS ONE. `/system_stats` (server.py:646-685) carries
   * no boot id, no pid and no start time, so its digest is byte-identical
   * across a restart. It answers "which install", and `upstream_epoch` —
   * derived from the volatile `/history` ring — answers "which run".
   *
   * ⚑ BOTH LOW WATERMARKS, because `/history` is paged and non-atomic and
   * `task_done` can evict between pages. Architect asked for "the low
   * watermark at both query ends" by name; one number cannot carry it, and
   * the two differing is the measurement that an enumeration is not a closure.
   *
   * `upstream_source` is signed separately from the values for WO-C4's
   * reason: the values say what was seen, the source says whether anything
   * was.
   */
  upstream_identity?: string | null;
  upstream_epoch?: string | null;
  upstream_continuity?: UpstreamContinuity | null;
  upstream_low_watermark_open?: number | null;
  upstream_low_watermark_close?: number | null;
  upstream_uncaptured_reason?: UncapturedReason | null;
  upstream_source?: UpstreamSource | null;
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
  /**
   * WO-C2. THE RESOLUTION HANDLES, AND THEY ARE IN THE MAC.
   *
   * Architect's first settle condition, verbatim: the handles "must sit
   * inside the signed preimage, or an attacker who can rewrite an unsigned
   * endpoint redirects resolution to a service that will happily confirm
   * anything — the handle becomes the attack surface the proof used to
   * close."
   *
   * A TOP-LEVEL BLOCK, NOT A CAPTURE FIELD, because it is not an observation.
   * `capture` is what the component SAW; these say where the evidence for
   * what it saw is fetched and whose signature counts when you get there.
   * `lib/leaf/resolutionHandles.ts` refuses a handle sent anywhere else.
   */
  resolution?: Partial<ResolutionHandles> | null;
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
    profile: c.profile ?? null,
    // WO-C4. Null on a leaf from a placement with nothing to measure, which
    // is a different value from 'unknown' and is meant to be: null is "this
    // submission carried no such field at all" and belongs to the same
    // absent-is-null discipline as every key above it.
    confinement: c.confinement ?? null,
    confinement_source: c.confinement_source ?? null,
    // WO-C5. Seven keys, null when the submission carried none — the same
    // absent-is-null discipline, so a leaf from a placement with no upstream
    // to ask produces the same preimage SHAPE as one from a sidecar gate.
    upstream_identity: c.upstream_identity ?? null,
    upstream_epoch: c.upstream_epoch ?? null,
    upstream_continuity: c.upstream_continuity ?? null,
    upstream_low_watermark_open: c.upstream_low_watermark_open ?? null,
    upstream_low_watermark_close: c.upstream_low_watermark_close ?? null,
    upstream_uncaptured_reason: c.upstream_uncaptured_reason ?? null,
    upstream_source: c.upstream_source ?? null,
    // WO-C2. Always five keys, prefixed `resolution_`, null when the block is
    // absent. The absence is therefore SIGNED: a party between the component
    // and this route can no more add a witness endpoint than rewrite one.
    ...resolutionPreimageFields(s.resolution),
  };
}
