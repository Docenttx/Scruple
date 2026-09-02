// From an observation to a submission, and from a submission to its MAC
// preimage.
//
// THE LEAF SHAPE IS NOT DEFINED HERE. lib/leaf/registry.yaml is the source of
// truth for every field and every preimage; lib/leaf/hashes.ts computes the
// derived hashes and is imported, not reimplemented, for the reason its own
// header gives — two implementations of a preimage are two preimages, and a
// hash mismatch looks exactly like a tampered file. This module assembles
// fields the registry already defines, adds the component envelope from §4.3,
// and adds one block the registry does not yet have a home for: `capture`,
// which is what the COMPONENT saw, as distinct from what the leaf commits to.
//
// ---------------------------------------------------------------------------
// ONE FUNCTION PRODUCES THE PREIMAGE, AND THE SERVER CALLS THE SAME ONE
// ---------------------------------------------------------------------------
//
// §4.1 wrote `mac = HMAC-SHA256(M_n, canonical_preimage)` and never said what
// canonical_preimage contains — §10 C-1 fixed the ENCODING (UTF-8 JSON, keys
// sorted by Unicode code point, compact, floats refused) but not the FIELD
// SET. A component that MACs fields the server cannot reconstruct from the
// submission has a MAC that verifies nothing about the leaf.
//
// So `preimageOf()` takes the submission itself, and both sides call it: the
// component before sending, the server on receipt, over the same JSON. There
// is no second field list to drift.
//
// FLOATS NEVER APPEAR. The workflow graph is full of them — cfg: 8.0,
// denoise: 1.0 — and Python `repr` and JS `Number#toString` do not agree on
// every double. Only its HASH enters the preimage. Every other value here is
// a string, a safe integer, or null.

import { hashWorkflow } from '../../../lib/leaf/hashes';
import type { CaptureObservation } from '../../../lib/capture/surface';
import type { PreimageFields } from '../../../lib/ratchet/ratchet';

export interface LeafContext {
  componentId: string;
  buildMeasurement: string;
  attestationStatus: 'verified' | 'passthrough' | null;
  baselineRef: string | null;
}

/** What the surface put on the observation's `evidence`. */
export interface ObservationEvidence {
  workflow_hash?: string | null;
  input_hash?: string | null;
  model_fingerprints_hash?: string | null;
  machine_manifest_hash?: string | null;
  mime_source?: string | null;
  correlation_method?: string | null;
  close_detection?: string | null;
  /** The ComfyUI route or frame type the bytes left by. Recorded so a
   *  coverage gap shows up as an absent VALUE rather than an absent event. */
  egress?: string | null;
  kind?: LeafKind;
  /** WO-30. The manifest BEHIND `model_fingerprints_hash`, when the surface
   *  holds it. Only the hash enters the MAC; the manifest is what makes the
   *  stored leaf legible, because `iterations.model_fingerprints` is the only
   *  column that records WHICH weights a run loaded. */
  model_fingerprints?: Record<string, Record<string, unknown>> | null;
  /** WO-30. The safetensors structural fingerprint of the bytes that were
   *  WRITTEN. It has no leaf field — `lib/leaf/registry.yaml` has no
   *  `header_hash` and neither does the /v2 Zod body — so it rides in the
   *  capture block, uncovered by the MAC, exactly as the Python SDK sends it
   *  (`MODEL_WRITE_HOOK.md` §4.2). Carried rather than dropped: a field that
   *  reaches the wire can be covered later; one the component never sent
   *  cannot be recovered at all. */
  header_hash?: string | null;
}

export type LeafKind = 'document_save' | 'artifact' | 'graph_execute' | 'model_write';

/** What the component saw, as opposed to what the leaf commits to. */
export interface CaptureBlock {
  surface: string;
  hook: string;
  fidelity: string;
  size_bytes: number | null;
  mime_source: string | null;
  correlation_id: string | null;
  correlation_method: string | null;
  egress: string | null;
  close_detection: string | null;
  workflow_hash: string | null;
  observed_at: string;
  attestation_status: 'verified' | 'passthrough' | null;
  /** UNCOVERED BY THE MAC, and that is not an oversight — see
   *  ObservationEvidence.header_hash. `preimageOf()` below does not read it,
   *  and neither does the server's `componentPreimage()`. */
  header_hash?: string | null;
}

export interface ComponentEnvelope {
  component_id: string;
  build_measurement: string;
  counter: number;
  attestation: { provider: string; quote_ref: string | null };
}

/** The POST /api/v2/witness body. `mac` is absent until the counter is spent. */
export interface Submission {
  baseline_ref: string | null;
  kind: LeafKind;
  content_hash: string;
  /** ABSENT, NOT DEFAULTED, when nothing was entitled to declare a type. */
  mime?: string;
  input_hash?: string;
  model_fingerprints_hash?: string;
  /** The manifest the hash above covers. The route recomputes the hash from
   *  it and REFUSES if the two disagree, which is the point of sending both. */
  model_fingerprints?: Record<string, Record<string, unknown>>;
  machine_manifest_hash?: string;
  /** The route recomputes workflow_hash from this (lib/leaf/hashes.ts), so a
   *  verifier can check it against capture.workflow_hash. */
  graph?: Record<string, unknown>;
  capture: CaptureBlock;
  component: ComponentEnvelope;
  mac?: string;
}

/**
 * The field set the ratchet MACs. Called by the component before sending and
 * by the server on receipt, over the same submission.
 *
 * `graph` is deliberately excluded and its hash included: the graph carries
 * floats, and a float in a MAC preimage is a MAC that fails unreproducibly
 * and only sometimes (§10 C-1).
 */
export function preimageOf(s: Submission): PreimageFields {
  return {
    component_id: s.component.component_id,
    counter: s.component.counter,
    build_measurement: s.component.build_measurement,
    attestation_provider: s.component.attestation.provider,
    baseline_ref: s.baseline_ref,
    kind: s.kind,
    content_hash: s.content_hash,
    mime: s.mime ?? null,
    input_hash: s.input_hash ?? null,
    model_fingerprints_hash: s.model_fingerprints_hash ?? null,
    machine_manifest_hash: s.machine_manifest_hash ?? null,
    surface: s.capture.surface,
    hook: s.capture.hook,
    fidelity: s.capture.fidelity,
    size_bytes: s.capture.size_bytes,
    mime_source: s.capture.mime_source,
    correlation_id: s.capture.correlation_id,
    correlation_method: s.capture.correlation_method,
    egress: s.capture.egress,
    close_detection: s.capture.close_detection,
    workflow_hash: s.capture.workflow_hash,
    observed_at: s.capture.observed_at,
    attestation_status: s.capture.attestation_status,
  };
}

export interface BuiltLeaf {
  submission: Submission;
  preimage: PreimageFields;
  /** False when nothing was entitled to declare a MIME. See the note below. */
  mimeDeclared: boolean;
}

export function buildLeaf(
  o: CaptureObservation,
  ctx: LeafContext,
  counter: number,
  graph?: Record<string, unknown>,
): BuiltLeaf {
  const ev = (o.evidence ?? {}) as ObservationEvidence;
  const bytes = o.bytes;
  if (!bytes) throw new Error('buildLeaf: observation carries no bytes');

  const workflowHash = ev.workflow_hash ?? (graph ? hashWorkflow(graph) : null);

  const submission: Submission = {
    baseline_ref: ctx.baselineRef,
    kind: ev.kind ?? 'artifact',
    content_hash: bytes.contentHash,
    // MIME IS OMITTED, NEVER DEFAULTED.
    //
    // app/api/v2/witness/route.ts validates `mime: z.string().min(1)` and
    // WILL REJECT a submission without one. That is a real gap between H-4 §7
    // probe 4 — "a file written into the output volume produces a leaf" — and
    // the ingest contract, and it is left visible rather than closed with
    // `application/octet-stream`: CANON_SKELETON §5 property 1 says a surface
    // that cannot determine a MIME must emit without one and let the SDK
    // refuse, rather than supply a placeholder. The event is still MACed, a
    // counter is still spent, and the entry stays queued until the route can
    // accept an undeclared type. See submitter.ts.
    ...(bytes.mime ? { mime: bytes.mime } : {}),
    ...(ev.input_hash ? { input_hash: ev.input_hash } : {}),
    ...(ev.model_fingerprints_hash ? { model_fingerprints_hash: ev.model_fingerprints_hash } : {}),
    ...(ev.model_fingerprints ? { model_fingerprints: ev.model_fingerprints } : {}),
    ...(ev.machine_manifest_hash ? { machine_manifest_hash: ev.machine_manifest_hash } : {}),
    ...(graph ? { graph } : {}),
    capture: {
      surface: o.surface,
      hook: o.hook,
      fidelity: bytes.fidelity,
      size_bytes: bytes.sizeBytes ?? null,
      mime_source: ev.mime_source ?? null,
      correlation_id: o.correlationId ?? null,
      correlation_method: ev.correlation_method ?? null,
      egress: ev.egress ?? null,
      close_detection: ev.close_detection ?? null,
      workflow_hash: workflowHash,
      observed_at: o.observedAt,
      attestation_status: ctx.attestationStatus,
      ...(ev.header_hash ? { header_hash: ev.header_hash } : {}),
    },
    component: {
      component_id: ctx.componentId,
      build_measurement: ctx.buildMeasurement,
      counter,
      // 'none' rather than an invented provider. §4.3 lists it as a legal
      // value, and saying it is how the leaf reports its own strength: no
      // attestable compute, so the IK is software-protected, the build↔key
      // binding is an assertion, and the leaf is `passthrough`.
      attestation: { provider: 'none', quote_ref: null },
    },
  };

  return { submission, preimage: preimageOf(submission), mimeDeclared: Boolean(bytes.mime) };
}
