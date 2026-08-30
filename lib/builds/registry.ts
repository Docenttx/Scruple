// The published-builds registry (H-4 §4.3, §10 C-4 — WO-15).
//
// WHAT C-4 SAID WAS MISSING, in its own words: "'The server can check the
// claimed build is one we shipped' presumes a published-builds registry
// that does not exist. Until it does, the claimed measurement is recorded
// per event and `build_changed` is flagged against the provisioned value —
// which is DRIFT DETECTION, NOT PROVENANCE."
//
// This is the thing to check against. Publication writes an immutable,
// signed row; withdrawal and supersession are separately signed events
// appended beside it; and status is a FOLD OF THOSE EVENTS AS OF A TIME,
// never a mutable column. Migration 045's header carries the argument for
// that shape and it is not repeated here.
//
// ─────────────────────────────────────────────────────────────────────
// THE DECISION THIS FILE EXISTS TO MAKE: AN UNKNOWN BUILD IS RECORDED,
// NOT REJECTED.
//
// The obvious reading of §4.3 is that a leaf claiming a build we never
// shipped should be refused. It should not, and the reasons are the same
// ones §4.2 already accepted for counter gaps:
//
//   1. REFUSING THE LEAF DOES NOT UN-PRODUCE THE ARTIFACT. The bytes
//      exist; the component is telling us about them. A rejection turns
//      "an artifact witnessed under an unrecognised build" — a flagged,
//      dated, investigable fact — into "an artifact with nothing said
//      about it", which is the exact hole H-4 exists to close. §4.2 made
//      this trade already: "if a gap invalidated the leaves around it,
//      suppressing one event would become a way to attack the vendor's
//      whole record."
//
//   2. IT WOULD HAND THAT ATTACK TO ANYONE WHO CAN MOVE A BYTE. If an
//      unknown measurement is fatal, then changing one byte of the
//      component makes every subsequent leaf vanish WITH THE SERVER'S
//      COOPERATION. The party best placed to do that is the tenant, whom
//      §1 already treats as the adversary. Rejection would build a
//      suppression primitive and call it strictness.
//
//   3. THE FALSE POSITIVE HAS NO RECOVERY PATH IN THE VENDOR'S HANDS. A
//      legitimate early adopter mid-rollout, a hotfix that beat the
//      registry entry, a measurement taken over a source tree that a
//      vendor patched for their own environment — each is an honest
//      component that would go dark mid-run and present as a component
//      bug. That is the failure mode §10 C-5 describes for provisioning,
//      reproduced on the hot path.
//
//   4. REJECTION IS AN ENUMERATION ORACLE. Accept/refuse on a claimed
//      string tells an unauthenticated-enough caller which measurements
//      we have published. Recording answers identically either way.
//
//   5. AND IT BUYS NOTHING AGAINST THE ATTACKER IT IS AIMED AT. A
//      modified build can claim a PUBLISHED measurement string just as
//      easily as an unpublished one — §4.3's own stated limit. So a
//      rejection rule filters exactly one population: the honest and
//      unrecognised. The security is in the MAC, not the string.
//
// WHAT "RECORDED" HAS TO MEAN FOR THIS TO BE HONEST: the status is
// written to `component_events.build_status` at ingest (durable, per
// event, never inferred later), returned on `VerifyOk.build_status`, and
// served by GET /api/v2/builds/unrecognised. An unknown build is VISIBLE.
// It is never silently fine.
// ─────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { conn } from '@/lib/db/sqlite';
import { canonicalPreimage, type PreimageFields } from '@/lib/ratchet/ratchet';
import {
  SIGNATURE_ALG,
  registrySigner,
  verifyDetached,
  type RegistrySigner,
} from './signing';

export class BuildRegistryError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'malformed_measurement'
      | 'already_published'
      | 'unknown_build'
      | 'future_publication'
      | 'bad_event',
  ) {
    super(message);
  }
}

export const MEASUREMENT_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * `undeclared` is not a build problem. It is a leaf that carried no
 * component envelope at all (canvas, the plugins) or one that declared no
 * measurement. Migration 043 spells the same distinction for
 * `component_verified`: "no component" and "component unchecked" must not
 * share a spelling.
 */
export type BuildStatus = 'published' | 'withdrawn' | 'superseded' | 'unpublished';
/**
 * `unchecked` is the registry's own failure, named rather than swallowed.
 *
 * checkClaimedBuild() runs inside verifySubmission(), before the
 * transaction. If a bug or an unavailable table let it THROW, a registry
 * fault would 500 a submission that MACed correctly — turning an outage on
 * our side into a lost leaf, which is the precise failure this whole work
 * order exists to refuse. So it cannot throw; and a check that could not
 * run must not be recorded as a check that passed, so it gets its own word
 * and appears on the unrecognised report like any other non-`published`
 * status. §7's rule for probes, applied to ourselves: an inconclusive is
 * never a pass.
 */
export type BuildCheck = BuildStatus | 'undeclared' | 'unchecked';

export interface PublishedBuild {
  measurement: string;
  component_name: string;
  version: string;
  measurement_kind: 'source-tree' | 'image-digest';
  published_at: string;
  notes: string | null;
  signature_alg: string;
  signing_key_id: string;
  signature: string;
  entry_sha256: string;
  recorded_at: string;
}

export interface BuildLifecycleEvent {
  id: number;
  measurement: string;
  event: 'withdrawn' | 'superseded' | 'reinstated';
  superseded_by: string | null;
  reason: string | null;
  effective_at: string;
  signature_alg: string;
  signing_key_id: string;
  signature: string;
  entry_sha256: string;
  recorded_at: string;
}

export interface BuildStatusReport {
  measurement: string;
  /** A publication row exists at all. False is the whole of `unpublished`. */
  known: boolean;
  status: BuildStatus;
  as_of: string;
  /** Withdrawal and supersession are INDEPENDENT facts, folded separately
   *  — see foldEvents() for why collapsing them into one status field and
   *  applying events in order is a bug rather than a simplification. */
  withdrawn_at: string | null;
  superseded_by: string | null;
  entry: PublishedBuild | null;
  events: BuildLifecycleEvent[];
}

const nowIso = () => new Date().toISOString();

/**
 * Every instant in this module is stored and compared in ONE form.
 *
 * Status is a fold over `effective_at <= as_of`, and that comparison is
 * lexicographic — in SQL and in the TypeScript alike. '2026-08-05T00:00:00Z'
 * and '2026-08-05T00:00:00.000Z' name the same moment and sort differently,
 * so a registry that stored whatever an operator typed would order its own
 * events wrong and answer the as-of question wrong, occasionally, in a way
 * that depends on how someone spelled a date. §10 C-1 is the same lesson
 * about the MAC preimage: leaving a format undefined does not make it
 * flexible, it makes it two formats.
 *
 * So: parse, and re-emit as `Date#toISOString()` — always UTC, always
 * millisecond precision. An unparseable instant is refused rather than
 * stored as a string that sorts arbitrarily.
 */
function normaliseInstant(v: string, field: string): string {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) {
    throw new BuildRegistryError(
      `${field} is not a parseable instant: ${JSON.stringify(v)}. Use ISO 8601 UTC.`,
      'bad_event',
    );
  }
  return new Date(t).toISOString();
}

/* ── preimages ───────────────────────────────────────────────────────── */
//
// canonicalPreimage() is lib/ratchet/ratchet.ts's, unchanged and not
// reimplemented: code-point key order, floats refused, JSON.stringify of
// scalars only. §10 C-1 records what it cost to leave that undefined once;
// a second canonicalisation in the estate would be a second format.

function publicationPreimage(b: {
  measurement: string;
  component_name: string;
  version: string;
  measurement_kind: string;
  published_at: string;
  notes: string | null;
}): Buffer {
  const fields: PreimageFields = {
    type: 'scruple/build-publication/v1',
    measurement: b.measurement,
    component_name: b.component_name,
    version: b.version,
    measurement_kind: b.measurement_kind,
    published_at: b.published_at,
    notes: b.notes,
  };
  return canonicalPreimage(fields);
}

function lifecyclePreimage(e: {
  measurement: string;
  event: string;
  superseded_by: string | null;
  reason: string | null;
  effective_at: string;
}): Buffer {
  const fields: PreimageFields = {
    type: 'scruple/build-lifecycle/v1',
    measurement: e.measurement,
    event: e.event,
    superseded_by: e.superseded_by,
    reason: e.reason,
    effective_at: e.effective_at,
  };
  return canonicalPreimage(fields);
}

const sha256Hex = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/* ── publication ─────────────────────────────────────────────────────── */

export interface PublishInput {
  measurement: string;
  componentName: string;
  version: string;
  measurementKind?: 'source-tree' | 'image-digest';
  publishedAt?: string;
  notes?: string | null;
  /** Injectable so tests do not need a process-wide environment variable
   *  and so a future HSM-backed signer drops in without touching this
   *  file. Defaults to the configured key, which throws when absent. */
  signer?: RegistrySigner;
}

export function publishBuild(input: PublishInput): PublishedBuild {
  if (!MEASUREMENT_RE.test(input.measurement)) {
    throw new BuildRegistryError(
      `Not a measurement: ${JSON.stringify(input.measurement)}. Expected ` +
        '"sha256:" followed by 64 lowercase hex characters, the shape ' +
        'services/scruple-capture/src/build-measurement.ts emits.',
      'malformed_measurement',
    );
  }
  const publishedAt = input.publishedAt ? normaliseInstant(input.publishedAt, 'published_at') : nowIso();
  // A publication dated in the future would make buildRegistryStatus()
  // answer `unpublished` for a build that IS in the registry, which is the
  // one conflation this vocabulary cannot express. Refused here so the
  // ingest-side status never has to carry the ambiguity.
  if (Date.parse(publishedAt) > Date.now() + 60_000) {
    throw new BuildRegistryError(
      'published_at is in the future. A publication that has not happened yet is not a ' +
        'publication, and a registry that admits one cannot tell "we never shipped this" ' +
        'from "we ship it on Tuesday".',
      'future_publication',
    );
  }

  const signer = input.signer ?? registrySigner();
  const row = {
    measurement: input.measurement,
    component_name: input.componentName,
    version: input.version,
    measurement_kind: input.measurementKind ?? 'source-tree',
    published_at: publishedAt,
    notes: input.notes ?? null,
  };
  const preimage = publicationPreimage(row);

  const existing = getBuild(input.measurement);
  if (existing) {
    throw new BuildRegistryError(
      `${input.measurement} is already published as ${existing.component_name} ` +
        `${existing.version} at ${existing.published_at}. The table is immutable-append: ` +
        'to change a build\'s standing, append a lifecycle event.',
      'already_published',
    );
  }

  const entry: PublishedBuild = {
    ...row,
    measurement_kind: row.measurement_kind as 'source-tree' | 'image-digest',
    signature_alg: SIGNATURE_ALG,
    signing_key_id: signer.keyId,
    signature: signer.sign(preimage),
    entry_sha256: sha256Hex(preimage),
    recorded_at: nowIso(),
  };

  conn()
    .prepare(
      `INSERT INTO published_builds
         (measurement, component_name, version, measurement_kind, published_at, notes,
          signature_alg, signing_key_id, signature, entry_sha256, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.measurement,
      entry.component_name,
      entry.version,
      entry.measurement_kind,
      entry.published_at,
      entry.notes,
      entry.signature_alg,
      entry.signing_key_id,
      entry.signature,
      entry.entry_sha256,
      entry.recorded_at,
    );

  return entry;
}

/* ── lifecycle ───────────────────────────────────────────────────────── */

export interface LifecycleInput {
  measurement: string;
  event: 'withdrawn' | 'superseded' | 'reinstated';
  supersededBy?: string | null;
  reason?: string | null;
  effectiveAt?: string;
  signer?: RegistrySigner;
}

export function appendBuildEvent(input: LifecycleInput): BuildLifecycleEvent {
  const entry = getBuild(input.measurement);
  if (!entry) {
    throw new BuildRegistryError(
      `${input.measurement} was never published, so there is nothing to withdraw or ` +
        'supersede. Publish it first, or leave it unpublished — those are different facts.',
      'unknown_build',
    );
  }
  if (input.event === 'superseded' && !input.supersededBy) {
    throw new BuildRegistryError(
      'A supersession must name the build that replaces this one. "Superseded by nothing" ' +
        'is a withdrawal wearing a softer word, and a vendor reading it would roll forward ' +
        'to a build that does not exist.',
      'bad_event',
    );
  }
  if (input.supersededBy && !getBuild(input.supersededBy)) {
    throw new BuildRegistryError(
      `The superseding build ${input.supersededBy} is not itself published.`,
      'unknown_build',
    );
  }

  const effectiveAt = input.effectiveAt ? normaliseInstant(input.effectiveAt, 'effective_at') : nowIso();

  // A withdrawal dated in the future takes effect NEVER, as far as every
  // read is concerned, and is indistinguishable from a withdrawal that
  // silently did nothing. Withdrawal is the one signal in this design that
  // must never be a no-op — a mistyped date would leave a build we meant to
  // pull reading `published` to every component and every vendor. If
  // scheduled withdrawal is ever wanted it should be a named concept with
  // its own surface, not a side effect of a date field. (Small tolerance
  // for clock skew between an operator's box and this one.)
  if (Date.parse(effectiveAt) > Date.now() + 60_000) {
    throw new BuildRegistryError(
      'effective_at is in the future. A withdrawal that has not taken effect reads exactly ' +
        'like one that silently did nothing, which is the failure mode this estate has ' +
        'already paid for once.',
      'bad_event',
    );
  }
  // And it may not predate the publication it acts on. Backdating a
  // withdrawal to before `published_at` would be a way to reach back and
  // restate leaves that were ingested under a published build — the exact
  // retroactivity the as-of fold exists to prevent, arriving through the
  // front door.
  if (effectiveAt < entry.published_at) {
    throw new BuildRegistryError(
      `effective_at (${effectiveAt}) is before this build was published ` +
        `(${entry.published_at}). A lifecycle event cannot reach back past the publication ` +
        'it acts on; leaves ingested under a published build keep what they were ingested ' +
        'under.',
      'bad_event',
    );
  }

  const signer = input.signer ?? registrySigner();
  const body = {
    measurement: input.measurement,
    event: input.event,
    superseded_by: input.supersededBy ?? null,
    reason: input.reason ?? null,
    effective_at: effectiveAt,
  };
  const preimage = lifecyclePreimage(body);
  const recordedAt = nowIso();

  const r = conn()
    .prepare(
      `INSERT INTO published_build_events
         (measurement, event, superseded_by, reason, effective_at,
          signature_alg, signing_key_id, signature, entry_sha256, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      body.measurement,
      body.event,
      body.superseded_by,
      body.reason,
      body.effective_at,
      SIGNATURE_ALG,
      signer.keyId,
      signer.sign(preimage),
      sha256Hex(preimage),
      recordedAt,
    );

  return buildEvents(input.measurement).find((e) => e.id === Number(r.lastInsertRowid))!;
}

export const withdrawBuild = (
  measurement: string,
  reason: string,
  opts: { effectiveAt?: string; signer?: RegistrySigner } = {},
) => appendBuildEvent({ measurement, event: 'withdrawn', reason, ...opts });

export const supersedeBuild = (
  measurement: string,
  supersededBy: string,
  opts: { reason?: string; effectiveAt?: string; signer?: RegistrySigner } = {},
) => appendBuildEvent({ measurement, event: 'superseded', supersededBy, ...opts });

export const reinstateBuild = (
  measurement: string,
  reason: string,
  opts: { effectiveAt?: string; signer?: RegistrySigner } = {},
) => appendBuildEvent({ measurement, event: 'reinstated', reason, ...opts });

/* ── reads ───────────────────────────────────────────────────────────── */

export function getBuild(measurement: string): PublishedBuild | undefined {
  return conn()
    .prepare(`SELECT * FROM published_builds WHERE measurement = ?`)
    .get(measurement) as PublishedBuild | undefined;
}

export function buildEvents(measurement: string, asOfRaw?: string): BuildLifecycleEvent[] {
  const asOf = asOfRaw ? normaliseInstant(asOfRaw, 'as_of') : undefined;
  const sql = asOf
    ? `SELECT * FROM published_build_events
        WHERE measurement = ? AND effective_at <= ?
        ORDER BY effective_at ASC, id ASC`
    : `SELECT * FROM published_build_events
        WHERE measurement = ?
        ORDER BY effective_at ASC, id ASC`;
  const args = asOf ? [measurement, asOf] : [measurement];
  return conn().prepare(sql).all(...args) as BuildLifecycleEvent[];
}

export function listBuilds(componentName?: string): PublishedBuild[] {
  const sql = componentName
    ? `SELECT * FROM published_builds WHERE component_name = ? ORDER BY published_at DESC`
    : `SELECT * FROM published_builds ORDER BY published_at DESC`;
  return conn()
    .prepare(sql)
    .all(...(componentName ? [componentName] : [])) as PublishedBuild[];
}

/**
 * Fold the lifecycle events into a standing.
 *
 * WITHDRAWAL AND SUPERSESSION ARE TRACKED SEPARATELY AND DELIBERATELY.
 * Folding them into one status variable, last-event-wins, has a bug that
 * only shows up in the field: a build withdrawn on Monday and superseded
 * on Tuesday — an ordinary sequence, since you usually ship a replacement
 * after you pull something — would come out `superseded`, i.e. UNWITHDRAWN
 * by a routine housekeeping event. Withdrawal must only be undone by an
 * explicit `reinstated`. So: a withdrawal flag with one correcting event,
 * and a supersession pointer, folded independently and summarised at the
 * end, with withdrawal winning the summary because it is the stronger
 * statement.
 */
function foldEvents(events: BuildLifecycleEvent[]): {
  withdrawnAt: string | null;
  supersededBy: string | null;
} {
  let withdrawnAt: string | null = null;
  let supersededBy: string | null = null;
  for (const e of events) {
    if (e.event === 'withdrawn') withdrawnAt = e.effective_at;
    else if (e.event === 'reinstated') withdrawnAt = null;
    else if (e.event === 'superseded') supersededBy = e.superseded_by;
  }
  return { withdrawnAt, supersededBy };
}

/**
 * What the registry says about a measurement AS OF A TIME.
 *
 * `asOf` is the whole point, and it is what makes "a withdrawn build
 * still verifies leaves signed before withdrawal" a mechanism rather
 * than a promise. A verifier holding a leaf verified at T asks this
 * function with T; a withdrawal that took effect after T is not in the
 * fold and cannot reach backwards. Withdrawal changes what a component
 * should be RUNNING; it does not retroactively unpublish what it was
 * running at the time.
 */
export function buildRegistryStatus(measurement: string, asOf?: string): BuildStatusReport {
  const at = asOf ? normaliseInstant(asOf, 'as_of') : nowIso();
  const entry = getBuild(measurement);
  if (!entry) {
    return {
      measurement,
      known: false,
      status: 'unpublished',
      as_of: at,
      withdrawn_at: null,
      superseded_by: null,
      entry: null,
      events: [],
    };
  }
  if (entry.published_at > at) {
    // Publication is dated, and a leaf from before it was not produced by
    // a published build however true that becomes later. publishBuild()
    // refuses future dates so this can only be reached by asking about a
    // past instant.
    return {
      measurement,
      known: true,
      status: 'unpublished',
      as_of: at,
      withdrawn_at: null,
      superseded_by: null,
      entry,
      events: [],
    };
  }

  const events = buildEvents(measurement, at);
  const { withdrawnAt, supersededBy } = foldEvents(events);
  const status: BuildStatus = withdrawnAt ? 'withdrawn' : supersededBy ? 'superseded' : 'published';
  return {
    measurement,
    known: true,
    status,
    as_of: at,
    withdrawn_at: withdrawnAt,
    superseded_by: supersededBy,
    entry,
    events,
  };
}

/**
 * The ingest-facing one-liner. Never throws, never rejects, never defaults
 * to something reassuring.
 */
export function checkClaimedBuild(measurement: string | null | undefined, asOf?: string): BuildCheck {
  if (!measurement) return 'undeclared';
  if (!MEASUREMENT_RE.test(measurement)) return 'unpublished';
  try {
    return buildRegistryStatus(measurement, asOf).status;
  } catch {
    // Deliberately swallowed HERE and nowhere else, because the caller is
    // mid-verification of a leaf that already MACed correctly. The fault is
    // ours and the vendor's evidence must not pay for it — but it is
    // recorded as `unchecked` rather than waved through, and it shows up on
    // GET /api/v2/builds/unrecognised alongside everything else that is not
    // a clean `published`.
    return 'unchecked';
  }
}

/* ── signature verification ──────────────────────────────────────────── */

export function verifyPublicationSignature(entry: PublishedBuild, publicKeyHex: string): boolean {
  const preimage = publicationPreimage(entry);
  if (sha256Hex(preimage) !== entry.entry_sha256) return false;
  return verifyDetached(preimage, entry.signature, publicKeyHex);
}

export function verifyLifecycleSignature(e: BuildLifecycleEvent, publicKeyHex: string): boolean {
  const preimage = lifecyclePreimage(e);
  if (sha256Hex(preimage) !== e.entry_sha256) return false;
  return verifyDetached(preimage, e.signature, publicKeyHex);
}

/* ── the visibility surface ──────────────────────────────────────────── */

export interface UnrecognisedBuildRow {
  component_id: string;
  tenant_id: string;
  counter: number;
  build_measurement: string | null;
  build_status: string | null;
  verified_at: string;
}

/**
 * Every verified event whose claimed build was NOT `published` at ingest.
 *
 * This is the other half of the record-rather-than-reject decision. A
 * status nobody can read is the same as no status, and Kohya is the
 * standing proof in this estate: the pod hook no-opped when an env var was
 * absent and a capture path gone dark produced the same observable as a
 * quiet afternoon.
 *
 * NULL `build_status` is excluded on purpose — those are rows written
 * before migration 045, where the registry was not consulted at all. They
 * are not evidence of an unrecognised build; they are evidence of a
 * question that was never asked.
 */
export function unrecognisedBuildEvents(
  limit = 200,
  tenantId?: string,
): UnrecognisedBuildRow[] {
  // The tenant filter is IN the query rather than applied to its result:
  // filtering a limited list gives one tenant a report that is empty
  // because another tenant's components filled the page, which reads as
  // "nothing to see" and is the one thing this endpoint must never say by
  // accident.
  return conn()
    .prepare(
      `SELECT e.component_id, c.tenant_id, e.counter, e.build_measurement,
              e.build_status, e.verified_at
         FROM component_events e
         JOIN components c ON c.component_id = e.component_id
        WHERE e.build_status IS NOT NULL AND e.build_status <> 'published'
          AND (? IS NULL OR c.tenant_id = ?)
        ORDER BY e.verified_at DESC
        LIMIT ?`,
    )
    .all(tenantId ?? null, tenantId ?? null, limit) as UnrecognisedBuildRow[];
}
