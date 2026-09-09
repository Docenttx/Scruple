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
import {
  resolveAttestationBasis,
  type AttestationBasis,
  type CaptureProfile,
  type QuoteBinding,
} from '../../../lib/leaf/attestationBasis';
import {
  resolutionPreimageFields,
  type ResolutionHandles,
} from '../../../lib/leaf/resolutionHandles';
import type { CaptureObservation, PlacementEnforcement } from '../../../lib/capture/surface';
import type { HostSemanticsState } from '../../../lib/capture/hostRegistry';
import type {
  ConfinementSource,
  StorageConfinement,
  StorageMeasurement,
} from '../../../lib/capture/storageConfinement';
// WO-C5. Who the upstream is, and whether its history ring is the same ring.
import {
  UNQUERIED_UPSTREAM,
  type UncapturedReason,
  type UpstreamContinuity,
  type UpstreamObservation,
  type UpstreamSource,
} from '../../../lib/capture/upstreamEpoch';
import type { PreimageFields } from '../../../lib/ratchet/ratchet';

export interface LeafContext {
  componentId: string;
  buildMeasurement: string;
  baselineRef: string | null;
  /**
   * WO-C1. The trust profile this component runs at, derived from the
   * EFFECTIVE placement (`profileFor()`), never self-declared. The basis is
   * conditional on it, and it rides in the MAC preimage so it cannot be
   * rewritten between here and the route.
   */
  profile: CaptureProfile;
  /** What actually keeps the measured party out of the capture process. */
  enforcement: PlacementEnforcement;
  /**
   * THE QUOTE IS FETCHED PER EMISSION, NOT PER PROCESS, and the function
   * type is the whole reason. `verified` requires a quote that binds to THIS
   * emission — a freshness nonce from outside the box, covering this event.
   * A value captured at startup could only ever bind the startup, which is
   * the config-inherited field class the council already refused for
   * `pinned_build`. Returns null when the placement has no attestable
   * compute: that is `passthrough`, not a failure.
   */
  quoteFor?: (o: CaptureObservation) => QuoteBinding | null;
  /**
   * WO-C2. WHERE THIS LEAF'S EVIDENCE RESOLVES, and whose signature counts
   * when a verifier gets there. Both ride in the MAC preimage.
   *
   * The endpoint is the /v2 API this component submits to — the service that
   * fronts the witness and holds the `checkpoints` table the Merkle path and
   * the raw quote are fetched from. It is required, because a leaf that names
   * no witness cannot have its evidence resolved by anybody and the whole
   * point of leaving the proof out of the leaf was that the leaf says where
   * the proof is.
   */
  witnessEndpoint: string;
  /**
   * The authority identity — the witness's signing key id. null when none has
   * been enrolled with this component, which is a real state and not a
   * default: the route then refuses any `checkpoint_id` on this leaf, because
   * an endpoint with no authority resolves to whoever answers the URL.
   */
  witnessAuthority: string | null;
  /**
   * PER EMISSION, for the reason `quoteFor` is: a checkpoint id read once at
   * startup could only ever describe the startup. Returns nulls today —
   * nothing can name a checkpoint while the Merkle blocker stands (WO-C6),
   * and `lib/leaf/resolutionHandles.ts` rule 7 refuses one that tries.
   */
  checkpointsFor?: (o: CaptureObservation) => {
    checkpointId: string | null;
    prevCheckpointId: string | null;
    prevCheckpointQuoteTime: string | null;
  } | null;
  /**
   * WO-C3. The retention policy this component's leaves are emitted under —
   * the DIGEST of the enrolled policy object, which binds the evidence
   * retention duration and the clock it is counted on.
   *
   * ⚑ THE COMPONENT HOLDS THE DIGEST AND NOT THE POLICY. It cannot resolve
   * its own digest and is not meant to: the server holds the enrolled object,
   * and a component whose configured window disagrees with the policy it names
   * is REFUSED at ingest rather than quietly believed. Enrolment is a
   * deployment decision, and a component that could write its own policy could
   * grant itself an unbounded settlement window.
   */
  retentionPolicyDigest: string;
  /**
   * How long this component's unresolved gaps stay open, in seconds. Must be
   * the `settlement_window_s` of the policy above; `lib/leaf/settlement.ts`
   * checks that the resulting deadline lands where a NAMED CLOCK puts the end
   * of that window, and refuses it otherwise.
   */
  settlementWindowSeconds: number;
  /**
   * WO-C4. THE DEVICE IDENTITY BEHIND `stateDir` AND THE WATCHED VOLUMES,
   * RE-READ AT EMISSION.
   *
   * A function for the same reason `quoteFor` and `checkpointsFor` are:
   * Architect ruled that "a startup-only check is a config-inherited fact by
   * the time the leaf is emitted — volumes can be remounted or bind-mounted
   * after boot, which is exactly the inheritance pattern we killed on
   * `pinned_build`." Startup refusal guards the boot case; this guards the
   * running case, and it is only the running case if it is called here.
   *
   * Absent means this placement has nothing to measure — no watched volume,
   * so no sharing question — and the leaf then says `unknown`/`unknown`
   * rather than claiming a confinement nobody established.
   */
  confinementFor?: () => StorageMeasurement;
  /**
   * WO-C5. WHO THE UPSTREAM IS AND WHETHER ITS HISTORY RING SURVIVED, as of
   * the newest completed bracket, evaluated against THIS emission's clock.
   *
   * A function, like `quoteFor`, `checkpointsFor` and `confinementFor` — but
   * for a reason that differs from theirs in one important way, and the
   * difference is written down in `UpstreamTracker`'s class header rather
   * than hidden here. The network read is NOT performed inside this call:
   * `emit()` is the blocking half of the gate, and a component that blocked
   * its capture path on an HTTP round trip to the process it is watching
   * would stop capturing exactly when that process misbehaves. What IS
   * performed here is the STALENESS CHECK — the tracker degrades continuity
   * to `unknown` and the reason to `interval_not_covered` when its newest
   * bracket does not cover this leaf's interval. A reading with a disclosed
   * age is a measurement; a reading whose age is silently assumed is the
   * config-inherited pattern WO-C4 closed.
   *
   * Absent means this placement has no upstream process to ask — the
   * server-library placement, where the vendor's handler IS the observation.
   * The leaf then says `not_queried`, which the council insisted must stay
   * distinguishable from "not enumerated because evicted/restarted".
   */
  upstreamFor?: (observedAtMs: number) => UpstreamObservation;
}

/** What the surface put on the observation's `evidence`. */
export interface ObservationEvidence {
  workflow_hash?: string | null;
  input_hash?: string | null;
  model_fingerprints_hash?: string | null;
  machine_manifest_hash?: string | null;
  mime_source?: string | null;
  correlation_method?: string | null;
  /**
   * WO-C1. DIAGNOSTIC CORROBORATION ONLY. What the filesystem watcher saw —
   * `IN_CLOSE_WRITE`, `fs-watch-quiescence`, whatever it actually had. It
   * used to be `close_detection` and to travel in the MAC preimage as
   * provenance; the council retracted that ("filesystem observations are not
   * freeze-gate authentication and `close_detection` is rejected as
   * provenance") and `lib/leaf/captureClaims.ts` now returns 422 for any
   * non-null `close_detection`.
   *
   * It is CARRIED rather than dropped, for the reason `header_hash` below is
   * carried: an observation that reaches the wire can be promoted later, one
   * the component never sent cannot be recovered at all. It creates and
   * completes nothing.
   */
  fs_diagnostic?: string | null;
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
  /**
   * WO-D6. WHO SUPPLIED THE MEANING, AND WHETHER ANYBODY DID.
   *
   * The gate observes a wire. A wire carries bytes and a workflow; it does not
   * carry the fact that those pixels were the viewport of scene X at frame Y
   * through camera Z. `lib/capture/hostRegistry.ts` is the two-level hook that
   * closes that: Level 1 is a host pointing its ComfyUI address at the gate
   * and getting a record that is honestly semantically blind, Level 2 is a
   * registered adapter supplying what the gate cannot see.
   *
   * ⚑ `host_semantics` IS NOT OPTIONAL ON THE LEAF EVEN THOUGH IT IS OPTIONAL
   * HERE. `buildLeaf` defaults it to 'blind', so a component with no adapter
   * emits a leaf that DECLARES it had nobody to ask rather than one that is
   * quietly thinner than a Level-2 leaf. Optional here, three-valued there.
   */
  host?: string | null;
  host_adapter?: string | null;
  host_evidence_type?: string | null;
  host_semantics?: HostSemanticsState | null;
  /** The manifest behind `host_evidence_hash`. Only the hash enters the MAC;
   *  the manifest is what makes the stored leaf legible — the same split
   *  `model_fingerprints` / `model_fingerprints_hash` already uses. */
  host_evidence?: Record<string, unknown> | null;
  host_evidence_hash?: string | null;
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
  /** PINNED AT null. See ObservationEvidence.fs_diagnostic and
   *  lib/leaf/componentPreimage.ts — the key stays in the MAC so the absence
   *  is signed, and no value may ever fill it. */
  close_detection: null;
  workflow_hash: string | null;
  observed_at: string;
  /** WO-C1. Three-valued, never null on a leaf this component emits. */
  attestation_status: AttestationBasis;
  /** WO-C1. In the MAC preimage; the basis is conditional on it. */
  profile: CaptureProfile;
  /**
   * WO-C4. WHERE THE RATCHET'S STATE LIVES RELATIVE TO THE WATCHED VOLUMES,
   * measured on THIS emission. In the MAC preimage, because a confinement
   * claim a party in the middle can rewrite is a confinement claim.
   *
   * `unknown` is a real value and not a failure mode to be tidied away: a
   * reading that could not be taken is not a degraded state and is certainly
   * not a clean one.
   */
  confinement: StorageConfinement;
  /** WO-C4. `measured` or `unknown`, and there is no third. Configuration,
   *  inheritance and defaults cannot populate a fact. */
  confinement_source: ConfinementSource;
  /**
   * WO-C5. WHICH COMFYUI INSTALL ANSWERED, digested from /system_stats.
   *
   * ⚑ NOT A RESTART SIGNAL, and the field is separate from the epoch so that
   * nobody reads it as one. server.py:646-685 returns no boot id, no pid and
   * no start time — a /system_stats digest is BYTE-IDENTICAL across a
   * restart. It changes when the operator upgrades ComfyUI or repoints the
   * gate, which is worth recording for its own sake and is a different fact.
   */
  upstream_identity: string | null;
  /**
   * WO-C5. WHICH RUN ANSWERED, derived from the /history ring. THIS is the
   * restart signal: `PromptQueue.history` is process state, so an epoch id
   * pinned to a surviving entry cannot outlive the process that held it.
   */
  upstream_epoch: string | null;
  /** WO-C5. `continuous` | `restarted` | `unknown`, never null on a leaf this
   *  component emits. `unknown` is a real answer — an idle upstream and a
   *  restarted idle upstream are the same reading. */
  upstream_continuity: UpstreamContinuity;
  /**
   * WO-C5. The oldest retained prompt number at the OPEN and at the CLOSE of
   * the bracket. Both, because `/history` is paged and non-atomic
   * (server.py:888-900, execution.py:1282) and `task_done` can evict between
   * pages: the two differing is the measurement that an enumeration is not a
   * closure. Architect asked for "the low watermark at BOTH query ends" by
   * name, and one number cannot carry it.
   */
  upstream_low_watermark_open: number | null;
  upstream_low_watermark_close: number | null;
  /** WO-C5. Why an absence set drawn from `/history` is or is not a closure.
   *  Five values, and the council's condition is that `not_queried` never
   *  collapses into `evicted_or_restarted`. */
  upstream_uncaptured_reason: UncapturedReason;
  /** WO-C5. `measured` or `unknown`. One source for the block, not one per
   *  field — WO-C1's rule: twelve fields pointing at one basis still read as
   *  twelve measurements to anyone not following the pointer. */
  upstream_source: UpstreamSource;
  /** UNCOVERED BY THE MAC, like header_hash. Diagnostic only. */
  fs_diagnostic?: string | null;
  /** UNCOVERED BY THE MAC, and that is not an oversight — see
   *  ObservationEvidence.header_hash. `preimageOf()` below does not read it,
   *  and neither does the server's `componentPreimage()`. */
  header_hash?: string | null;
  /**
   * WO-D6. THE HOST HOOK'S LEVEL, ON EVERY LEAF, AND ALL FIVE ARE SIGNED.
   *
   * They are in the preimage for the reason `profile` and `confinement` are:
   * the value of saying "this record is semantically blind" is entirely that
   * a party in the middle cannot quietly change it to "a registered Blender
   * adapter said this was scene X" — nor the reverse, which is the attack
   * that matters more. `host_evidence_hash` binds the manifest so the
   * document and the claim cannot be separated.
   *
   * `host_semantics` is three-valued and NEVER null on a leaf this component
   * emits. 'blind' is Level 1 — nobody was registered. 'declined' is Level 2
   * with nothing to say about THIS observation, which is a different
   * operational condition with a different fix and must not read as 'blind'.
   */
  host: string | null;
  host_adapter: string | null;
  host_evidence_type: string | null;
  host_semantics: HostSemanticsState;
  host_evidence_hash: string | null;
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
  /** WO-D6. The host's own evidence document, whose digest rides in
   *  `capture.host_evidence_hash`. TOP-LEVEL, not a capture field, for the
   *  reason `model_fingerprints` is: `capture` is what the COMPONENT saw, and
   *  this is what the HOST said. The route recomputes the hash from it and
   *  refuses a submission whose two halves disagree. */
  host_evidence?: Record<string, unknown>;
  machine_manifest_hash?: string;
  /** The route recomputes workflow_hash from this (lib/leaf/hashes.ts), so a
   *  verifier can check it against capture.workflow_hash. */
  graph?: Record<string, unknown>;
  capture: CaptureBlock;
  /**
   * WO-C2. The resolution handles, top-level and inside the MAC. Never a
   * capture field: `capture` is what the component SAW, and these say where
   * the evidence for it is fetched. The server refuses a handle sent
   * anywhere else — including inside `capture`, where the preimage reads by
   * key and would silently skip it.
   */
  resolution: ResolutionHandles;
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
    profile: s.capture.profile,
    // WO-C4. Both, and both signed. The value says what was measured; the
    // source says whether anything was. A `confinement` a proxy could rewrite
    // to `confined`, or a `confinement_source` it could promote from
    // `unknown` to `measured`, would be worth exactly nothing.
    confinement: s.capture.confinement,
    confinement_source: s.capture.confinement_source,
    // WO-C5. All seven, and all signed. The council moved restart detection
    // into the component precisely so a silent restart stops looking like a
    // quiet afternoon; an epoch or a continuity value a party in the middle
    // could rewrite would put it straight back. `upstream_source` is signed
    // separately from the values for WO-C4's reason: the values say what was
    // seen, the source says whether anything was.
    upstream_identity: s.capture.upstream_identity,
    upstream_epoch: s.capture.upstream_epoch,
    upstream_continuity: s.capture.upstream_continuity,
    upstream_low_watermark_open: s.capture.upstream_low_watermark_open,
    upstream_low_watermark_close: s.capture.upstream_low_watermark_close,
    upstream_uncaptured_reason: s.capture.upstream_uncaptured_reason,
    upstream_source: s.capture.upstream_source,
    // WO-D6. Five keys, always present, and 'blind' is a VALUE rather than an
    // absence — a leaf that said nothing about its level would be read as
    // Level 1 by a verifier and as "the field had not shipped yet" by an
    // older one, and those must not be the same reading.
    host: s.capture.host,
    host_adapter: s.capture.host_adapter,
    host_evidence_type: s.capture.host_evidence_type,
    host_semantics: s.capture.host_semantics,
    host_evidence_hash: s.capture.host_evidence_hash,
    // WO-C2. Five keys, always present, null when unknown — so a party in the
    // middle can neither rewrite a handle nor add one. Architect's settle
    // condition: moving the proof out of the leaf makes the pointer to the
    // proof security-critical.
    ...resolutionPreimageFields(s.resolution),
  };
}

export interface BuiltLeaf {
  submission: Submission;
  preimage: PreimageFields;
  /** Why the basis on this leaf is what it is. Logged, never sent: it is an
   *  explanation, and an explanation on the wire is a field to be forged. */
  basisReason: string;
  /** WO-C4. Why the confinement value is what it is. Logged on change by the
   *  Submitter, never sent — same rule as `basisReason`. */
  confinementReason: string;
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

  // WO-C1. RESOLVED HERE, PER EMISSION, and not read off a field the
  // component set once at startup. Today it returns `stale` for every
  // profile — the witness and the verifier do not pass shared Merkle
  // vectors, so no checkpoint can be claimed settled (WO-C6, Appendix C
  // item 0). It is still computed rather than hardcoded, because a constant
  // is what a future contributor deletes without noticing what it was for.
  const basis = resolveAttestationBasis({
    profile: ctx.profile,
    enforcement: ctx.enforcement,
    quote: ctx.quoteFor ? ctx.quoteFor(o) : null,
  });

  const checkpoints = ctx.checkpointsFor ? ctx.checkpointsFor(o) : null;

  // WO-C4. MEASURED HERE, ON THIS EMISSION, off raw stat(2) — never read from
  // a value the component computed at startup. See LeafContext.confinementFor.
  const storage = ctx.confinementFor ? ctx.confinementFor() : null;

  // WO-C5. EVALUATED HERE, AGAINST THIS LEAF'S OBSERVATION TIME, so that a
  // bracket which no longer covers the interval degrades to
  // `interval_not_covered` rather than being carried forward as though it
  // still described the present. No upstream to ask is `not_queried` — a
  // different operational condition from every other value here, with a
  // different fix, which is the whole reason the council asked for the
  // distinction.
  const upstream = ctx.upstreamFor
    ? ctx.upstreamFor(Date.parse(o.observedAt))
    : UNQUERIED_UPSTREAM;

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
    ...(ev.host_evidence ? { host_evidence: ev.host_evidence } : {}),
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
      // NEVER ev.<anything>. The key is signed and the value is fixed.
      close_detection: null,
      workflow_hash: workflowHash,
      observed_at: o.observedAt,
      attestation_status: basis.basis,
      profile: ctx.profile,
      // WO-C4. No confinement source at all is `unknown`/`unknown`. It is not
      // `confined`: a component with nothing to measure has measured nothing,
      // and the two must not read the same to a verifier.
      confinement: storage?.confinement ?? 'unknown',
      confinement_source: storage?.source ?? 'unknown',
      // WO-C5. Spread, not assembled field by field: the observation IS the
      // seven keys, and a second field list here would be a second answer to
      // drift against `UpstreamObservation`.
      ...upstream,
      // WO-D6. ⚑ DEFAULTED TO 'blind', WHICH IS THE WHOLE POINT OF PUTTING IT
      // HERE RATHER THAN IN THE ADAPTER. An adapter cannot forget to declare
      // its absence, because the absence is declared by the code that runs
      // when there is no adapter. A Level-1 deployment therefore emits a leaf
      // that SAYS it is semantically blind, instead of one that is merely
      // thinner than a Level-2 leaf in ways only a comparison would reveal.
      host: ev.host ?? null,
      host_adapter: ev.host_adapter ?? null,
      host_evidence_type: ev.host_evidence_type ?? null,
      host_semantics: ev.host_semantics ?? 'blind',
      host_evidence_hash: ev.host_evidence_hash ?? null,
      ...(ev.fs_diagnostic ? { fs_diagnostic: ev.fs_diagnostic } : {}),
      ...(ev.header_hash ? { header_hash: ev.header_hash } : {}),
    },
    // WO-C2. Resolved per emission like the basis, and for the same reason.
    // Today the checkpoint half is null on every leaf.
    resolution: {
      witness_endpoint: ctx.witnessEndpoint,
      witness_authority: ctx.witnessAuthority,
      checkpoint_id: checkpoints?.checkpointId ?? null,
      prev_checkpoint_id: checkpoints?.prevCheckpointId ?? null,
      prev_checkpoint_quote_time: checkpoints?.prevCheckpointQuoteTime ?? null,
      // WO-C3. WHEN THIS LEAF'S SILENCE BECOMES A FINDING.
      //
      // Computed PER EMISSION from this machine's clock, and that is stated
      // plainly rather than hidden: it is a CLAIM. The council refused a
      // deadline "derived from a locally-set timestamp" as a config-inherited
      // field, and the answer is not that the component stops declaring one —
      // it is the only party that knows its own window — but that the server
      // CHECKS the claim against a named clock before storing it, and computes
      // the terminal `expired` only from that clock. A component two hours
      // fast is refused here, at ingest, rather than believed.
      settlement_deadline: new Date(
        Date.parse(o.observedAt) + ctx.settlementWindowSeconds * 1000,
      ).toISOString(),
      retention_policy_digest: ctx.retentionPolicyDigest,
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

  return {
    submission,
    preimage: preimageOf(submission),
    mimeDeclared: Boolean(bytes.mime),
    basisReason: basis.reason,
    confinementReason:
      storage?.reason ?? 'no storage surface was measurable from this placement',
  };
}
