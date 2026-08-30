// The integration lifecycle: integrating → verifying → sealed, and
// `resealing` when an approved deployment changes (WO-22).
//
// docs/canon/INTEGRATION_LIFECYCLE.md is the founder direction. Its
// sequence is a mechanism here and not a suggestion: `sealed` is REFUSED
// from `integrating`, because "you cannot hash a moving target" and step 2
// is where the failures are supposed to happen.
//
// ─────────────────────────────────────────────────────────────────────
// THIS IS lib/builds/registry.ts's SHAPE, DELIBERATELY AND WITHOUT A
// SECOND STORY.
//
// WO-15 already solved withdrawal-without-breaking-history: an immutable
// signed row per artefact, append-only signed events beside it, and a
// status that is a FOLD AS OF A TIME rather than a mutable column. Every
// line of that argument applies here with `reseal` where `withdraw` was,
// and migration 046's header carries it. The same Ed25519 signer
// (lib/builds/signing.ts) signs both, because a seal and a publication are
// the same kind of statement — SCRUPLE SAYS THIS, at this instant — and a
// second key with a second lifecycle would be a second story about what
// our signature means.
//
// ─────────────────────────────────────────────────────────────────────
// THE DECISION THIS FILE EXISTS TO MAKE: A LEAF FROM AN UNSEALED
// PIPELINE IS STAMPED, NOT REFUSED.
//
// Step 2 of the lifecycle exists to produce real leaves from a pipeline
// that is not yet approved. Those leaves are valid records of what
// happened and they are NOT claims to the standard, and both halves have
// to be true at once. So:
//
//   * `checkDeploymentSeal()` never throws and never rejects. It is
//     called from the ingest path, where refusing destroys evidence of an
//     artifact that already exists — §4.2's trade, made again.
//   * The state it returns is written onto the leaf row and returned on
//     the response, so "recorded" means something a reader can act on
//     rather than a log line. GET /api/v2/seal/unsealed is the report,
//     the exact shape GET /api/v2/builds/unrecognised has.
//   * `sealed` is the only state that may claim the standard. Compliance
//     stays binary (Standard §5); the state says which side of the line a
//     deployment is on. IT IS NOT A TIER.
// ─────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { conn } from '@/lib/db/sqlite';
import { canonicalPreimage, type PreimageFields } from '@/lib/ratchet/ratchet';
import {
  SIGNATURE_ALG,
  registrySigner,
  verifyDetached,
  type RegistrySigner,
} from '@/lib/builds/signing';
import {
  manifestJson,
  parseManifestJson,
  pipelineMeasurement,
  type PipelineManifest,
} from './measure';
import {
  CONSEQUENTIAL_CHANGE_BUDGET,
  classifyManifestChange,
  sealExpiry,
  type ChangeClass,
} from './materiality';

export class SealError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'unknown_deployment'
      | 'already_registered'
      | 'unknown_seal'
      | 'already_sealed'
      | 'bad_event'
      | 'illegal_transition',
  ) {
    super(message);
  }
}

/** The four states of a deployment. */
export const SEAL_STATES = ['integrating', 'verifying', 'sealed', 'resealing'] as const;
export type SealState = (typeof SEAL_STATES)[number];

/**
 * What a leaf may be stamped with. The three extra words are 045's three
 * extra words, for 045's three reasons, and none of them is new:
 *
 *   `unregistered` — a deployment was DECLARED and we have no record of
 *     it under this tenant. The analogue of `unpublished`: declared, and
 *     not ours. (045 needed the same distinction and drew the same line.)
 *   `undeclared` — nothing was declared. Canvas and the plugins carry no
 *     component and no deployment; "nothing was said" and "something was
 *     said and we do not recognise it" must not share a spelling.
 *   `unchecked` — OUR failure, named rather than swallowed. An
 *     inconclusive is never a pass.
 */
export type SealCheck = SealState | 'unregistered' | 'undeclared' | 'unchecked';

export type LifecycleEventName =
  | 'integrating'
  | 'verifying'
  | 'sealed'
  | 'material_change'
  | 'drift';

export interface Deployment {
  deployment_id: string;
  tenant_id: string;
  label: string | null;
  created_at: string;
}

export interface DeploymentSeal {
  seal_ref: string;
  deployment_id: string;
  pipeline_measurement: string;
  measurement_profile: string;
  manifest_json: string;
  sealed_at: string;
  notes: string | null;
  signature_alg: string;
  signing_key_id: string;
  signature: string;
  recorded_at: string;
}

export interface LifecycleEvent {
  id: number;
  deployment_id: string;
  event: LifecycleEventName;
  seal_ref: string | null;
  change_class: ChangeClass | null;
  reason: string | null;
  effective_at: string;
  signature_alg: string;
  signing_key_id: string;
  signature: string;
  entry_sha256: string;
  recorded_at: string;
}

/** Why a sealed deployment is in `resealing`. Null when it is not. */
export type ResealCause = 'material_change' | 'drift_budget' | 'term_expired';

export interface SealStatusReport {
  deployment_id: string;
  known: boolean;
  state: SealState;
  as_of: string;
  /** The seal in force, and NULL unless `state === 'sealed'`. See
   *  migration 046 for why a `resealing` deployment does not carry one. */
  seal_ref: string | null;
  sealed_at: string | null;
  seal_expires_at: string | null;
  reseal_cause: ResealCause | null;
  /** Signed `drift` events since the seal took effect. */
  drift_since_seal: number;
  drift_budget: number;
  /**
   * The one question the lifecycle exists to answer, spelled out rather
   * than left for a caller to derive from `state === 'sealed'` and get
   * subtly wrong somewhere.
   */
  claims_standard: boolean;
  events: LifecycleEvent[];
}

const nowIso = () => new Date().toISOString();

/** 045's rule, unchanged: one stored form, because the fold compares
 *  `effective_at` lexicographically and two spellings of one instant sort
 *  differently. */
function normaliseInstant(v: string, field: string): string {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) {
    throw new SealError(
      `${field} is not a parseable instant: ${JSON.stringify(v)}. Use ISO 8601 UTC.`,
      'bad_event',
    );
  }
  return new Date(t).toISOString();
}

/* ── preimages ───────────────────────────────────────────────────────── */
//
// canonicalPreimage() is the ratchet's, unchanged: code-point key order,
// floats refused. §10 C-1 records what a second canonicalisation costs.

function sealPreimage(s: {
  deployment_id: string;
  pipeline_measurement: string;
  measurement_profile: string;
  // SIGN WHAT YOU STORE. The first cut of this preimage carried only the
  // entry COUNT, on the reasoning that the measurement is a digest over
  // the manifest and so signing the measurement signs the manifest. It
  // does not: the measurement is over the NORMALISED ENTRY SET, and
  // `manifest_json` is the bytes a verifier actually reads to learn what
  // was approved. A row whose manifest_json was swapped for a different
  // one still verified, because nothing signed had changed. The test that
  // found it is the one asserting an edited manifest fails BOTH checks.
  //
  // So the stored bytes are committed to directly, and
  // verifySealMeasurement() stays a separate check because the two
  // failures are different incidents: "the manifest was edited" versus
  // "the manifest does not produce the measurement it claims".
  manifest_sha256: string;
  sealed_at: string;
  notes: string | null;
}): Buffer {
  const fields: PreimageFields = {
    type: 'scruple/deployment-seal/v1',
    deployment_id: s.deployment_id,
    pipeline_measurement: s.pipeline_measurement,
    measurement_profile: s.measurement_profile,
    manifest_sha256: s.manifest_sha256,
    sealed_at: s.sealed_at,
    notes: s.notes,
  };
  return canonicalPreimage(fields);
}

function lifecyclePreimage(e: {
  deployment_id: string;
  event: string;
  seal_ref: string | null;
  change_class: string | null;
  reason: string | null;
  effective_at: string;
}): Buffer {
  const fields: PreimageFields = {
    type: 'scruple/deployment-lifecycle/v1',
    deployment_id: e.deployment_id,
    event: e.event,
    seal_ref: e.seal_ref,
    change_class: e.change_class,
    reason: e.reason,
    effective_at: e.effective_at,
  };
  return canonicalPreimage(fields);
}

const sha256Hex = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/* ── reads ───────────────────────────────────────────────────────────── */

export function getDeployment(deploymentId: string): Deployment | undefined {
  return conn()
    .prepare(`SELECT * FROM deployments WHERE deployment_id = ?`)
    .get(deploymentId) as Deployment | undefined;
}

export function listDeployments(tenantId?: string): Deployment[] {
  const sql = tenantId
    ? `SELECT * FROM deployments WHERE tenant_id = ? ORDER BY created_at DESC`
    : `SELECT * FROM deployments ORDER BY created_at DESC`;
  return conn()
    .prepare(sql)
    .all(...(tenantId ? [tenantId] : [])) as Deployment[];
}

export function getSeal(sealRef: string): DeploymentSeal | undefined {
  return conn()
    .prepare(`SELECT * FROM deployment_seals WHERE seal_ref = ?`)
    .get(sealRef) as DeploymentSeal | undefined;
}

export function listSeals(deploymentId: string): DeploymentSeal[] {
  return conn()
    .prepare(`SELECT * FROM deployment_seals WHERE deployment_id = ? ORDER BY sealed_at ASC`)
    .all(deploymentId) as DeploymentSeal[];
}

export function lifecycleEvents(deploymentId: string, asOfRaw?: string): LifecycleEvent[] {
  const asOf = asOfRaw ? normaliseInstant(asOfRaw, 'as_of') : undefined;
  const sql = asOf
    ? `SELECT * FROM deployment_lifecycle_events
        WHERE deployment_id = ? AND effective_at <= ?
        ORDER BY effective_at ASC, id ASC`
    : `SELECT * FROM deployment_lifecycle_events
        WHERE deployment_id = ?
        ORDER BY effective_at ASC, id ASC`;
  return conn()
    .prepare(sql)
    .all(...(asOf ? [deploymentId, asOf] : [deploymentId])) as LifecycleEvent[];
}

/* ── registration ────────────────────────────────────────────────────── */

export interface RegisterInput {
  deploymentId: string;
  tenantId: string;
  label?: string | null;
  at?: string;
  signer?: RegistrySigner;
}

/**
 * Register a deployment and open its record with a signed `integrating`
 * event.
 *
 * There is deliberately NO HTTP ROUTE for this or for anything else that
 * writes here, and the reason is WO-15's word for word: publication —
 * approval, in this file — "would have to be authorised by something, and
 * the only thing that legitimately authorises it is possession of the
 * signing key". A tenant-scoped credential is not the right credential
 * for a tenant's own approval. A vendor moving their own deployment to
 * `sealed` is a vendor grading their own exam, and letting them move to
 * `verifying` but not `sealed` would be a half-measure with an extra
 * route. `app/api/v2/seal/**` is read-only; lib/seal/cli.ts is the write
 * path and it reads the key locally.
 */
export function registerDeployment(input: RegisterInput): Deployment {
  if (getDeployment(input.deploymentId)) {
    throw new SealError(
      `${input.deploymentId} is already registered. Deployment ids are the identity a leaf ` +
        'carries; reusing one would merge two vendors\' histories into one fold.',
      'already_registered',
    );
  }
  const at = input.at ? normaliseInstant(input.at, 'at') : nowIso();
  if (Date.parse(at) > Date.now() + 60_000) {
    throw new SealError('A deployment cannot be registered in the future.', 'bad_event');
  }
  const signer = input.signer ?? registrySigner();

  conn()
    .prepare(
      `INSERT INTO deployments (deployment_id, tenant_id, label, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.deploymentId, input.tenantId, input.label ?? null, at);

  appendLifecycleEvent({
    deploymentId: input.deploymentId,
    event: 'integrating',
    reason: 'registered',
    effectiveAt: at,
    signer,
  });

  return getDeployment(input.deploymentId)!;
}

/** Bind a capture component to a deployment, so a leaf carrying the
 *  component envelope resolves to a lifecycle without the caller having
 *  to name one. */
export function bindComponent(componentId: string, deploymentId: string): void {
  if (!getDeployment(deploymentId)) {
    throw new SealError(`${deploymentId} is not registered.`, 'unknown_deployment');
  }
  conn()
    .prepare(`UPDATE components SET deployment_id = ? WHERE component_id = ?`)
    .run(deploymentId, componentId);
}

export function componentDeployment(componentId: string): string | null {
  const row = conn()
    .prepare(`SELECT deployment_id FROM components WHERE component_id = ?`)
    .get(componentId) as { deployment_id: string | null } | undefined;
  return row?.deployment_id ?? null;
}

/* ── issuing a seal ──────────────────────────────────────────────────── */

export interface IssueSealInput {
  deploymentId: string;
  manifest: PipelineManifest;
  sealedAt?: string;
  notes?: string | null;
  signer?: RegistrySigner;
}

/**
 * Write the immutable, signed seal row. THIS DOES NOT MOVE THE STATE.
 *
 * Issuing and applying are two acts because they answer two questions —
 * "what was approved" and "from when" — and 045's whole argument is that
 * a signed artefact and its standing over time must not live on one row.
 * Call `applySeal()` to append the `sealed` event.
 */
export function issueSeal(input: IssueSealInput): DeploymentSeal {
  if (!getDeployment(input.deploymentId)) {
    throw new SealError(
      `${input.deploymentId} is not registered, so there is no pipeline to seal.`,
      'unknown_deployment',
    );
  }
  const sealedAt = input.sealedAt ? normaliseInstant(input.sealedAt, 'sealed_at') : nowIso();
  if (Date.parse(sealedAt) > Date.now() + 60_000) {
    throw new SealError(
      'sealed_at is in the future. An approval that has not happened is not an approval, ' +
        'and a registry that admits one cannot tell "never sealed" from "sealed on Tuesday".',
      'bad_event',
    );
  }

  const measurement = pipelineMeasurement(input.manifest);
  const json = manifestJson(input.manifest);
  const body = {
    deployment_id: input.deploymentId,
    pipeline_measurement: measurement,
    measurement_profile: 'scruple/pipeline-measurement/v1',
    manifest_sha256: crypto.createHash('sha256').update(json, 'utf8').digest('hex'),
    sealed_at: sealedAt,
    notes: input.notes ?? null,
  };
  const preimage = sealPreimage(body);
  // The identity IS the digest of the signed bytes — see migration 046
  // for why there is no separate `entry_sha256` column on this table.
  const sealRef = 'sha256:' + sha256Hex(preimage);

  if (getSeal(sealRef)) {
    throw new SealError(
      `This exact seal already exists (${sealRef}). Two identical approvals of one ` +
        'configuration at one instant are one approval; to re-approve, seal at a new instant.',
      'already_sealed',
    );
  }

  const signer = input.signer ?? registrySigner();
  conn()
    .prepare(
      `INSERT INTO deployment_seals
         (seal_ref, deployment_id, pipeline_measurement, measurement_profile,
          manifest_json, sealed_at, notes, signature_alg, signing_key_id, signature, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sealRef,
      body.deployment_id,
      body.pipeline_measurement,
      body.measurement_profile,
      json,
      body.sealed_at,
      body.notes,
      SIGNATURE_ALG,
      signer.keyId,
      signer.sign(preimage),
      nowIso(),
    );

  return getSeal(sealRef)!;
}

/* ── lifecycle events ────────────────────────────────────────────────── */

export interface LifecycleInput {
  deploymentId: string;
  event: LifecycleEventName;
  sealRef?: string | null;
  changeClass?: ChangeClass | null;
  reason?: string | null;
  effectiveAt?: string;
  signer?: RegistrySigner;
}

export function appendLifecycleEvent(input: LifecycleInput): LifecycleEvent {
  const dep = getDeployment(input.deploymentId);
  if (!dep) {
    throw new SealError(
      `${input.deploymentId} is not registered. Register it first — "not registered" and ` +
        '"registered and integrating" are different facts and a leaf is stamped with which.',
      'unknown_deployment',
    );
  }
  const effectiveAt = input.effectiveAt
    ? normaliseInstant(input.effectiveAt, 'effective_at')
    : nowIso();

  // 045's rule, and 045's reason: a lifecycle event dated in the future
  // takes effect never, as far as every read is concerned, and is
  // indistinguishable from one that silently did nothing.
  if (Date.parse(effectiveAt) > Date.now() + 60_000) {
    throw new SealError(
      'effective_at is in the future. An event that has not taken effect reads exactly like ' +
        'one that silently did nothing. The one scheduled transition this design has — the ' +
        'seal term — is a named concept with its own field, not an operator-typed date.',
      'bad_event',
    );
  }
  if (effectiveAt < dep.created_at) {
    throw new SealError(
      `effective_at (${effectiveAt}) predates the deployment's registration ` +
        `(${dep.created_at}). A deployment cannot have done something before it existed.`,
      'bad_event',
    );
  }

  const existing = lifecycleEvents(input.deploymentId);

  // WHY MONOTONIC effective_at, WHERE 045 ALLOWS ANY ORDER.
  //
  // Build lifecycle events are independent facts folded independently, so
  // insertion order cannot change the answer. These are a SEQUENCE:
  // `sealed` is legal after `verifying` and illegal after `integrating`,
  // and that legality is checked against the state as of the event's own
  // instant. An event inserted BEHIND the newest one re-orders the fold
  // and can make an already-recorded transition illegal after the fact —
  // history rewritten by an append, which is the one thing an append-only
  // table is supposed to make impossible. Backdating INTO THE GAP since
  // the last event is still allowed, because a decision taken at 09:00
  // and recorded at 11:00 must be able to say 09:00.
  const newest = existing[existing.length - 1];
  if (newest && effectiveAt < newest.effective_at) {
    throw new SealError(
      `effective_at (${effectiveAt}) is before the most recent lifecycle event ` +
        `(${newest.event} at ${newest.effective_at}). Lifecycle events are a sequence, not ` +
        'a set: inserting one behind another re-orders the fold and can retroactively ' +
        'invalidate a transition that was legal when it was recorded.',
      'bad_event',
    );
  }

  const prior = foldAsOf(existing, effectiveAt);

  if (input.event === 'integrating') {
    if (existing.length > 0) {
      throw new SealError(
        'A deployment begins integrating once. A second `integrating` would reset the fold ' +
          'and clear an outstanding material change — a history eraser wearing the name of a ' +
          'beginning. To re-open an approved pipeline, declare the material change.',
        'illegal_transition',
      );
    }
  }

  let sealRef: string | null = input.sealRef ?? null;
  let changeClass: ChangeClass | null = input.changeClass ?? null;

  if (input.event === 'sealed') {
    if (!sealRef) {
      throw new SealError(
        'A `sealed` event must name the seal that took effect. "Sealed against nothing" is ' +
          'an approval with no approved configuration behind it.',
        'bad_event',
      );
    }
    const seal = getSeal(sealRef);
    if (!seal || seal.deployment_id !== input.deploymentId) {
      throw new SealError(
        `${sealRef} is not a seal issued for ${input.deploymentId}.`,
        'unknown_seal',
      );
    }
    if (effectiveAt < seal.sealed_at) {
      throw new SealError(
        `A seal cannot take effect (${effectiveAt}) before it was issued (${seal.sealed_at}).`,
        'bad_event',
      );
    }
    // THE ORDER IS THE POINT. INTEGRATION_LIFECYCLE.md: "Only once it is
    // compliant and working is the pipeline measured and the
    // configuration approved." A pipeline that has never been through
    // end-to-end testing has no evidence behind its seal, and admitting
    // integrating → sealed would make step 2 optional in exactly the way
    // a vendor under time pressure would want it to be.
    if (prior.state === 'integrating') {
      throw new SealError(
        'A deployment cannot go from `integrating` straight to `sealed`. Step 2 — end-to-end ' +
          'testing, with real leaves flowing from an unsealed pipeline — is where the ' +
          'failures are supposed to happen. Record `verifying` first.',
        'illegal_transition',
      );
    }
    // AND: RE-ASSERTING THE CONFIGURATION YOU JUST SAID YOU CHANGED IS
    // NOT AN APPROVAL. When the outstanding reseal was caused by a
    // declared material change, a `sealed` event naming the seal already
    // in force would clear it while approving nothing new — 045's
    // "superseded by nothing is a withdrawal wearing a softer word", in
    // the other direction.
    //
    // It is allowed when the cause is the TERM or the DRIFT BUDGET,
    // because re-sealing an unchanged configuration is exactly what a
    // renewal is — EMV's maintenance approval, and the reason the term
    // is defensible at all.
    if (
      prior.state === 'resealing' &&
      prior.reseal_cause === 'material_change' &&
      prior.seal_in_force === sealRef
    ) {
      throw new SealError(
        `${sealRef} is already the seal in force, and this deployment is resealing because a ` +
          'material change was declared against it. Re-asserting the same measurement would ' +
          'clear that declaration while approving nothing. Issue a seal over the changed ' +
          'configuration.',
        'illegal_transition',
      );
    }
  } else if (sealRef) {
    throw new SealError(
      `A \`${input.event}\` event does not name a seal.`,
      'bad_event',
    );
  }

  if (input.event === 'material_change' || input.event === 'drift') {
    if (prior.state !== 'sealed' && prior.state !== 'resealing') {
      throw new SealError(
        `A ${input.event} event is only meaningful against an approved configuration, and ` +
          `${input.deploymentId} is ${prior.state}. Before a seal exists there is nothing to ` +
          'change materially — that is what integrating IS.',
        'illegal_transition',
      );
    }
    changeClass = input.event === 'material_change' ? 'material' : 'consequential';
  } else if (changeClass) {
    throw new SealError(
      `A \`${input.event}\` event does not carry a change class.`,
      'bad_event',
    );
  }

  const signer = input.signer ?? registrySigner();
  const body = {
    deployment_id: input.deploymentId,
    event: input.event,
    seal_ref: sealRef,
    change_class: changeClass,
    reason: input.reason ?? null,
    effective_at: effectiveAt,
  };
  const preimage = lifecyclePreimage(body);

  const r = conn()
    .prepare(
      `INSERT INTO deployment_lifecycle_events
         (deployment_id, event, seal_ref, change_class, reason, effective_at,
          signature_alg, signing_key_id, signature, entry_sha256, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      body.deployment_id,
      body.event,
      body.seal_ref,
      body.change_class,
      body.reason,
      body.effective_at,
      SIGNATURE_ALG,
      signer.keyId,
      signer.sign(preimage),
      sha256Hex(preimage),
      nowIso(),
    );

  return lifecycleEvents(input.deploymentId).find((e) => e.id === Number(r.lastInsertRowid))!;
}

export const enterVerification = (
  deploymentId: string,
  reason?: string,
  opts: { effectiveAt?: string; signer?: RegistrySigner } = {},
) => appendLifecycleEvent({ deploymentId, event: 'verifying', reason: reason ?? null, ...opts });

export const applySeal = (
  deploymentId: string,
  sealRef: string,
  opts: { reason?: string; effectiveAt?: string; signer?: RegistrySigner } = {},
) => appendLifecycleEvent({ deploymentId, event: 'sealed', sealRef, ...opts });

export const declareMaterialChange = (
  deploymentId: string,
  reason: string,
  opts: { effectiveAt?: string; signer?: RegistrySigner } = {},
) => appendLifecycleEvent({ deploymentId, event: 'material_change', reason, ...opts });

export const recordDrift = (
  deploymentId: string,
  reason: string,
  opts: { effectiveAt?: string; signer?: RegistrySigner } = {},
) => appendLifecycleEvent({ deploymentId, event: 'drift', reason, ...opts });

/**
 * Classify a proposed manifest against the seal in force and append the
 * event the classification calls for.
 *
 * This is what makes lib/seal/materiality.ts a rule rather than an essay:
 * the definition is executed, and the verdict is recorded on a signed
 * event so an auditor reads the judgement instead of re-deriving it from
 * two manifests years later.
 */
export function declareManifestChange(input: {
  deploymentId: string;
  proposed: PipelineManifest;
  effectiveAt?: string;
  signer?: RegistrySigner;
}): { verdict: ReturnType<typeof classifyManifestChange>; event: LifecycleEvent | null } {
  const status = sealStatus(input.deploymentId, input.effectiveAt);
  const inForce = status.seal_ref ?? lastSealRef(input.deploymentId, input.effectiveAt);
  if (!inForce) {
    throw new SealError(
      `${input.deploymentId} has no seal in force, so there is nothing to classify a change ` +
        'against. An unsealed pipeline changes freely — that is what integrating is.',
      'illegal_transition',
    );
  }
  const approved = parseManifestJson(getSeal(inForce)!.manifest_json);
  const verdict = classifyManifestChange(approved, input.proposed);
  const reason = verdict.reasons.join('; ');

  if (verdict.class === 'material') {
    return {
      verdict,
      event: declareMaterialChange(input.deploymentId, reason, {
        effectiveAt: input.effectiveAt,
        signer: input.signer,
      }),
    };
  }
  if (verdict.class === 'consequential') {
    return {
      verdict,
      event: recordDrift(input.deploymentId, reason, {
        effectiveAt: input.effectiveAt,
        signer: input.signer,
      }),
    };
  }
  // Administrative. Nothing inside the boundary moved, so there is
  // nothing to record against the seal — and recording a no-op as an
  // event would put noise in a fold whose whole value is that every row
  // in it changed something.
  return { verdict, event: null };
}

/* ── the fold ────────────────────────────────────────────────────────── */

interface Fold {
  state: SealState;
  seal_in_force: string | null;
  sealed_at: string | null;
  seal_expires_at: string | null;
  reseal_cause: ResealCause | null;
  drift_since_seal: number;
}

/**
 * Fold the events into a standing, AS OF an instant.
 *
 * `asOf` is the whole point, and it is what makes "historical leaves keep
 * verifying across a reseal" a mechanism rather than a promise. A leaf
 * written at T asks this with T; a material change declared at T+1 is not
 * in the fold and cannot reach backwards. A reseal changes what the
 * deployment must be RUNNING. It does not retroactively unapprove what it
 * was running.
 *
 * THREE THINGS PUT A DEPLOYMENT IN `resealing`, and only the first is an
 * event:
 *
 *   `material_change`  a declared change inside the boundary. Cleared
 *                      ONLY by an explicit `sealed` — 045's rule that a
 *                      strong statement is undone by a named event and
 *                      never as a side effect of a routine one. Note it
 *                      is folded as a FLAG rather than as a state
 *                      assignment, for exactly the reason 045 folds
 *                      withdrawal separately from supersession: a
 *                      last-event-wins fold would let a routine event
 *                      quietly clear the strongest statement on the
 *                      record.
 *   `drift_budget`     CONSEQUENTIAL_CHANGE_BUDGET signed `drift` events
 *                      since the seal. The bound that makes exempting
 *                      dependency bumps defensible instead of unlimited.
 *   `term_expired`     SEAL_TERM_DAYS since `sealed_at`. Derived from the
 *                      seal's own signed instant and a constant of the
 *                      scheme — not a mutable column, and not a
 *                      future-dated event, which 045 refuses for good
 *                      reasons that this respects rather than routes
 *                      around.
 */
function foldAsOf(all: LifecycleEvent[], asOf: string): Fold {
  let state: SealState = 'integrating';
  let sealInForce: string | null = null;
  let sealedAt: string | null = null;
  let materialOutstanding = false;
  let drift = 0;

  for (const e of all) {
    if (e.effective_at > asOf) break;
    switch (e.event) {
      case 'integrating':
        state = 'integrating';
        break;
      case 'verifying':
        state = 'verifying';
        break;
      case 'sealed':
        state = 'sealed';
        sealInForce = e.seal_ref;
        sealedAt = e.effective_at;
        materialOutstanding = false;
        drift = 0;
        break;
      case 'material_change':
        materialOutstanding = true;
        break;
      case 'drift':
        drift += 1;
        break;
    }
  }

  const expiresAt = sealedAt ? sealExpiry(sealedAt) : null;
  let cause: ResealCause | null = null;
  if (state === 'sealed') {
    if (materialOutstanding) cause = 'material_change';
    else if (drift >= CONSEQUENTIAL_CHANGE_BUDGET) cause = 'drift_budget';
    else if (expiresAt && asOf >= expiresAt) cause = 'term_expired';
    if (cause) state = 'resealing';
  }

  return {
    state,
    seal_in_force: sealInForce,
    sealed_at: sealedAt,
    seal_expires_at: expiresAt,
    reseal_cause: cause,
    drift_since_seal: drift,
  };
}

/** The last seal a `sealed` event put in force at or before `asOf`,
 *  whether or not it is still current. */
function lastSealRef(deploymentId: string, asOf?: string): string | null {
  const dep = getDeployment(deploymentId);
  if (!dep) return null;
  const at = asOf ? normaliseInstant(asOf, 'as_of') : nowIso();
  return foldAsOf(lifecycleEvents(deploymentId), at).seal_in_force;
}

export function sealStatus(deploymentId: string, asOf?: string): SealStatusReport {
  const at = asOf ? normaliseInstant(asOf, 'as_of') : nowIso();
  const dep = getDeployment(deploymentId);
  if (!dep) {
    return {
      deployment_id: deploymentId,
      known: false,
      state: 'integrating',
      as_of: at,
      seal_ref: null,
      sealed_at: null,
      seal_expires_at: null,
      reseal_cause: null,
      drift_since_seal: 0,
      drift_budget: CONSEQUENTIAL_CHANGE_BUDGET,
      claims_standard: false,
      events: [],
    };
  }
  const events = lifecycleEvents(deploymentId, at);
  const f = foldAsOf(events, at);
  return {
    deployment_id: deploymentId,
    known: true,
    state: f.state,
    as_of: at,
    // NULL unless `sealed`. Migration 046 carries the argument: a leaf
    // written during `resealing` was not written under an approval, and
    // stamping the last one on it would read as though it were.
    seal_ref: f.state === 'sealed' ? f.seal_in_force : null,
    sealed_at: f.sealed_at,
    seal_expires_at: f.seal_expires_at,
    reseal_cause: f.reseal_cause,
    drift_since_seal: f.drift_since_seal,
    drift_budget: CONSEQUENTIAL_CHANGE_BUDGET,
    claims_standard: f.state === 'sealed',
    events,
  };
}

/* ── the ingest-facing check ─────────────────────────────────────────── */

export interface SealStamp {
  deployment_id: string | null;
  state: SealCheck;
  seal_ref: string | null;
}

/**
 * What to stamp on a leaf. NEVER THROWS, never rejects, never defaults to
 * something reassuring.
 *
 * Called from inside POST /api/v2/witness. If it could throw, a fault on
 * our side would 500 a submission that MACed correctly, turning our
 * outage into the vendor's lost leaf — the precise failure `unchecked`
 * exists to refuse. §7's rule for probes, applied to ourselves: an
 * inconclusive is never a pass.
 *
 * The tenant check is here rather than at the caller because a
 * deployment_id is a bare string on the wire: without it, a tenant could
 * stamp their leaves with somebody else's `sealed`.
 */
export function checkDeploymentSeal(
  tenantId: string,
  deploymentId: string | null | undefined,
  asOf?: string,
): SealStamp {
  if (!deploymentId) return { deployment_id: null, state: 'undeclared', seal_ref: null };
  try {
    const dep = getDeployment(deploymentId);
    if (!dep || dep.tenant_id !== tenantId) {
      // DECLARED AND NOT OURS. 045's `unpublished`, one level up: it is
      // not `undeclared` (something was said) and it is not `unchecked`
      // (nothing failed on our side). Recorded, not rejected — refusing
      // the leaf would not un-produce the artifact, and a typo'd
      // deployment id would become a way to lose evidence.
      return { deployment_id: deploymentId, state: 'unregistered', seal_ref: null };
    }
    const st = sealStatus(deploymentId, asOf);
    return { deployment_id: deploymentId, state: st.state, seal_ref: st.seal_ref };
  } catch {
    return { deployment_id: deploymentId, state: 'unchecked', seal_ref: null };
  }
}

/* ── signature and measurement verification ──────────────────────────── */

export function verifySealSignature(seal: DeploymentSeal, publicKeyHex: string): boolean {
  const preimage = sealPreimage({
    deployment_id: seal.deployment_id,
    pipeline_measurement: seal.pipeline_measurement,
    measurement_profile: seal.measurement_profile,
    manifest_sha256: crypto.createHash('sha256').update(seal.manifest_json, 'utf8').digest('hex'),
    sealed_at: seal.sealed_at,
    notes: seal.notes,
  });
  // The identity is the digest of the signed bytes, so a row whose
  // contents were edited cannot keep its ref. Checking this first
  // localises "the row was edited" apart from "the signature is bad",
  // which are different incidents — 045's reason for `entry_sha256`,
  // obtained here without a second column.
  if ('sha256:' + sha256Hex(preimage) !== seal.seal_ref) return false;
  return verifyDetached(preimage, seal.signature, publicKeyHex);
}

/** Recompute the measurement from the stored manifest. A seal whose
 *  manifest does not produce its own signed measurement is a signed
 *  number with the wrong evidence stapled to it. */
export function verifySealMeasurement(seal: DeploymentSeal): boolean {
  try {
    return pipelineMeasurement(parseManifestJson(seal.manifest_json)) === seal.pipeline_measurement;
  } catch {
    return false;
  }
}

export function verifyLifecycleSignature(e: LifecycleEvent, publicKeyHex: string): boolean {
  const preimage = lifecyclePreimage({
    deployment_id: e.deployment_id,
    event: e.event,
    seal_ref: e.seal_ref,
    change_class: e.change_class,
    reason: e.reason,
    effective_at: e.effective_at,
  });
  if (sha256Hex(preimage) !== e.entry_sha256) return false;
  return verifyDetached(preimage, e.signature, publicKeyHex);
}

/* ── the visibility surface ──────────────────────────────────────────── */

export interface UnsealedLeafRow {
  leaf_id: number;
  deployment_id: string | null;
  seal_state: string | null;
  seal_ref: string | null;
  component_id: string | null;
  timestamp: string;
}

/**
 * Every leaf whose seal state was not `sealed` at the moment it was
 * written.
 *
 * This is the other half of "stamped, not refused", and it is the shape
 * GET /api/v2/builds/unrecognised already has for the same reason: a
 * status nobody can read is the same as no status. Kohya is the standing
 * proof — the pod hook no-opped when an env var was absent, and a capture
 * path gone dark produced the same observable as a quiet afternoon.
 *
 * NULL `seal_state` is excluded on purpose: those are leaves written
 * before migration 046, where the lifecycle was not consulted at all. A
 * question that was never asked is not an answer.
 */
export function unsealedLeaves(limit = 200, tenantId?: string): UnsealedLeafRow[] {
  return conn()
    .prepare(
      `SELECT i.id AS leaf_id, i.deployment_id, i.seal_state, i.seal_ref,
              i.component_id, i.timestamp
         FROM iterations i
         JOIN projects p ON p.id = i.project_id
        WHERE i.seal_state IS NOT NULL AND i.seal_state <> 'sealed'
          AND (? IS NULL OR p.user_id = ?)
        ORDER BY i.timestamp DESC
        LIMIT ?`,
    )
    .all(tenantId ?? null, tenantId ?? null, limit) as UnsealedLeafRow[];
}
