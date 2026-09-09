// THE HOST HOOK, HOST-AGNOSTIC — how a host declares itself, and what it may
// then say about bytes the gate can see but cannot read.
//
// WO-D6. Blender is consumer #1 of the ComfyUI integration, not a special case
// of it, and this module is what makes that sentence true in code rather than
// in a paragraph. There are exactly two levels and nothing in between:
//
//   LEVEL 1 — the host points its ComfyUI address at the gate. That is the
//     whole integration. It costs the host nothing, requires no code from us,
//     and captures the workflow, the uploads and the outputs, because every
//     ComfyUI bridge ever written speaks plain HTTP /prompt plus a websocket.
//     What it produces is an honest record that is SEMANTICALLY BLIND: an
//     anonymous PNG was uploaded, an anonymous PNG came back. The gate is
//     observing a wire; a wire does not carry the fact that those pixels were
//     the viewport of scene X at frame Y through camera Z.
//
//   LEVEL 2 — the host registers an adapter here. The adapter supplies the
//     meaning, and only the meaning. It does not observe bytes, it does not
//     open a socket and it does not touch a key.
//
// ⚑ THE LEVEL IS ON THE LEAF, AND LEVEL 1 SAYS SO. `capture.host_semantics` is
// three-valued and never null on a component leaf, and `buildLeaf` DEFAULTS it
// to 'blind' — so a deployment with no adapter does not emit a leaf that is
// quietly thinner than a Level-2 one, it emits a leaf that declares it had
// nobody to ask. Thinner-and-silent is the failure mode this whole design
// exists to refuse; see the three measurement-honesty states throughout.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT A NEW CONTRACT
// ---------------------------------------------------------------------------
//
// ./surface.ts already calls `ObservationSink` "the interface a vendor
// implements for a host we have not met". A host adapter is that interface
// COMPOSED, never a second one: `hostAdapterSink()` below returns an
// ObservationSink wrapping an ObservationSink, which is exactly what
// `ComponentDeps.sinkWrap` takes. Scruple Desktop Studio's `ModelStoreSink` is
// the same shape and predates this module.
//
// The consequence worth stating plainly: THE HOST DOES NOT WRITE THE SINK. It
// writes `semanticsFor()`, a pure function from an observation to a manifest,
// and the SDK writes everything around it. That is not politeness — it is
// CANON_SKELETON.md §5's adapter rule made structural. A host that wrote its
// own sink could construct an HTTP request, decide a MIME, drop an observation
// or spend a ratchet counter; a host that writes `semanticsFor` cannot reach
// any of those, because it never holds the inner sink at all.
//
// ---------------------------------------------------------------------------
// WHAT A REGISTRATION MAY NOT SAY
// ---------------------------------------------------------------------------
//
// A host declares WHAT IT IS. It does not declare HOW GOOD IT IS.
//
//   - `attestation` is refused as a registration key. `assuranceForHost()`
//     derives the grade from the resolved placement; a host that could hand in
//     its own `attestation: 'verified'` would be grading its own exam, which
//     is DEFECT-1 in PLACEMENT_AND_SURFACES.md one axis over.
//   - `declaredPlacement` IS accepted, and is called *declared* everywhere for
//     the same reason: `resolvePlacement()` degrades it against the
//     enforcement, and the gap between the two is the finding.
//
// ---------------------------------------------------------------------------
// REGISTRATION IS STATIC. See ./surface.ts's caveat, which binds identically:
// registration is an explicit call made at build or startup time by code we
// publish and measure. There is no dynamic plugin loading and there will not
// be one — an adapter loaded at runtime from a path the measured party can
// write to is `unattested-client` by definition, whatever it declares.
//
// Its Python mirror is packages/scruple-api/scruple_api/host_registry.py.
// Keep the two in sync by hand, the same way surface.ts and surface.py are.

import { sha256Hex } from '@/lib/scruple/hash';
import { canonicalize } from '@/lib/leaf/canonicalJson';
import {
  CAPTURE_HOOKS,
  CAPTURE_SURFACES,
  OBSERVATION_FIDELITIES,
  PLACEMENTS,
  PLACEMENT_ENFORCEMENTS,
  assuranceForHost,
  type CaptureHook,
  type CaptureObservation,
  type CaptureSurfaceKind,
  type HostAssurance,
  type HostCaptureProfile,
  type ObservationFidelity,
  type ObservationSink,
  type Placement,
  type PlacementEnforcement,
} from './surface';
import type { CapabilityClass, CustodyLocus } from './classes';

/* ────────────────────────────────────────────────────────────────────────
 * The level. Two values, derived, never asserted by a host.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * What a leaf says about who supplied its meaning. Three values, and the
 * middle one is the one a two-valued design would have lost.
 *
 *   'blind'     no adapter was registered for this component. The gate saw
 *               bytes on a wire and nothing named them. LEVEL 1.
 *   'declined'  an adapter WAS registered and had nothing to say about THIS
 *               observation — no announcement for this correlation id, or an
 *               announcement its own declared schema rejects. LEVEL 2, and
 *               the leaf is as thin as a Level-1 one. It must not be able to
 *               pass as either a Level-1 leaf or an enriched one.
 *   'supplied'  the adapter supplied semantics and they are on the leaf.
 *
 * 🔴 'declined' IS NOT A DEGRADED 'blind'. Collapsing them would make "we had
 * nobody to ask" and "we asked and got nothing" the same reading, and those
 * have different fixes: the first is an integration that was never done, the
 * second is an integration that is not working. Exactly the distinction
 * WO-C5's `not_queried` holds open one field over.
 */
export const HOST_SEMANTICS_STATES = ['blind', 'declined', 'supplied'] as const;
export type HostSemanticsState = (typeof HOST_SEMANTICS_STATES)[number];

export function isHostSemanticsState(v: unknown): v is HostSemanticsState {
  return typeof v === 'string' && (HOST_SEMANTICS_STATES as readonly string[]).includes(v);
}

export type HostCaptureLevel = 1 | 2;

/** DERIVED, never a field a host sets. Level 2 is "an adapter was in the
 *  path", which is true whether or not it had anything to say. */
export function hostCaptureLevel(state: HostSemanticsState): HostCaptureLevel {
  return state === 'blind' ? 1 : 2;
}

/* ────────────────────────────────────────────────────────────────────────
 * The declaration.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * How a host declares itself. Everything here is a STATEMENT OF FACT about
 * the integration; nothing here is a claim about its strength.
 *
 * This is deliberately a superset of `HostCaptureProfile`'s shape rather than
 * an extension of it: `hostProfileOf()` projects one into the other, and the
 * projection is where `attestation` is filled in by us instead of by them.
 */
export interface HostRegistration {
  /** Stable host id. Lowercase, and it is what lands in `capture.host`. */
  host: string;
  /** Which build of the host declared itself. A leaf that cannot say which
   *  version of an add-on produced its semantics cannot be triaged when that
   *  add-on turns out to have been reporting the wrong camera. */
  hostVersion: string;
  /** Stable adapter id. SEPARATE FROM THE HOST because one host has several:
   *  a viewport adapter and a render-queue adapter observe the same Blender
   *  and mean different things. */
  adapter: string;
  adapterVersion: string;
  /** Versioned predicate URI — `scruple.dev/evidence/<name>/v<N>`. It is on
   *  the leaf so a verifier knows which document `host_evidence` is before
   *  reading a byte of it. Unversioned is refused: an evidence shape that
   *  changes without changing its name is unreadable in hindsight. */
  evidenceType: string;
  /** Which §4 hooks this adapter can serve. Declared, checked here. */
  hooks: readonly CaptureHook[];
  /** Which surfaces the host's capture reaches it through. */
  surfaces: readonly CaptureSurfaceKind[];
  fidelity: ObservationFidelity;
  declaredPlacement: Placement;
  enforcement: PlacementEnforcement;
  /** JSON Schema of the host's own evidence shape (witness Attestor.Schema).
   *  Must be an object schema with a non-empty `required`: a schema that
   *  validates everything cannot make `declined` mean anything. */
  schema: HostEvidenceSchema;
  capabilityClasses?: readonly CapabilityClass[];
  custodyLocus?: CustodyLocus;
}

export interface HostEvidenceSchema {
  type: 'object';
  required: readonly string[];
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface RegisteredHost {
  registration: HostRegistration;
  profile: HostCaptureProfile;
  assurance: HostAssurance;
  registeredAt: string;
}

export type HostRegistrationCode =
  | 'host_id_malformed'
  | 'host_already_registered'
  | 'host_version_missing'
  | 'adapter_malformed'
  | 'evidence_type_unversioned'
  | 'hooks_empty'
  | 'hook_unknown'
  | 'surfaces_empty'
  | 'surface_unknown'
  | 'fidelity_unknown'
  | 'placement_unknown'
  | 'enforcement_unknown'
  | 'schema_not_an_object_schema'
  | 'schema_requires_nothing'
  | 'host_may_not_grade_itself';

export class HostRegistrationError extends Error {
  constructor(
    readonly code: HostRegistrationCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostRegistrationError';
  }
}

const HOST_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
/** `<authority>/evidence/<name>/v<N>`, the shape ./surface.ts's own surfaces
 *  already use ('scruple.dev/evidence/comfyui-http-gate/v1'). */
const EVIDENCE_TYPE = /^[a-z0-9][a-z0-9.-]*\/evidence\/[a-z0-9][a-z0-9-]*\/v[0-9]+$/;

/** Projects a registration into the profile the assurance function grades.
 *  `attestation` IS SET HERE, TO 'none', and never read off the registration —
 *  see the header. A host that ships attestable compute gets that recognised
 *  through `enforcement`, which is checked, not through a self-report. */
export function hostProfileOf(r: HostRegistration): HostCaptureProfile {
  return {
    host: r.host,
    hooks: r.hooks,
    surfaces: r.surfaces,
    fidelity: r.fidelity,
    declaredPlacement: r.declaredPlacement,
    enforcement: r.enforcement,
    attestation: 'none',
    ...(r.capabilityClasses ? { capabilityClasses: r.capabilityClasses } : {}),
    ...(r.custodyLocus ? { custodyLocus: r.custodyLocus } : {}),
  };
}

const hostRegistry = new Map<string, RegisteredHost>();

/**
 * Register a host. Explicit, static, build-time — see the module header.
 *
 * Every refusal below is a way a registration could be accepted and then mean
 * nothing on a leaf. None of them is a schema formality.
 */
export function registerHost(r: HostRegistration): RegisteredHost {
  if (typeof r.host !== 'string' || !HOST_ID.test(r.host)) {
    throw new HostRegistrationError(
      'host_id_malformed',
      `host id ${JSON.stringify(r.host)} is not a stable lowercase identifier. It lands in ` +
        '`capture.host` and in a MAC preimage, so it may not be a display name that changes ' +
        'when marketing does.',
    );
  }
  if (hostRegistry.has(r.host)) {
    throw new HostRegistrationError(
      'host_already_registered',
      `host '${r.host}' is already registered. Two adapters for one host is a legitimate ` +
        'configuration — register them under distinct host ids, or one leaf cannot say which ' +
        'of the two named it.',
    );
  }
  if (typeof r.hostVersion !== 'string' || r.hostVersion.trim() === '') {
    throw new HostRegistrationError(
      'host_version_missing',
      `host '${r.host}' declared no version. A leaf whose semantics came from an add-on that ` +
        'cannot be identified cannot be re-examined when that add-on turns out to have been ' +
        'reporting the wrong camera.',
    );
  }
  if (
    typeof r.adapter !== 'string' ||
    !HOST_ID.test(r.adapter) ||
    typeof r.adapterVersion !== 'string' ||
    r.adapterVersion.trim() === ''
  ) {
    throw new HostRegistrationError(
      'adapter_malformed',
      `host '${r.host}' must declare a stable lowercase \`adapter\` id and a non-empty ` +
        '`adapterVersion`. The adapter is a separate field from the host because one host has ' +
        'several — a viewport adapter and a render-queue adapter mean different things.',
    );
  }
  if (typeof r.evidenceType !== 'string' || !EVIDENCE_TYPE.test(r.evidenceType)) {
    throw new HostRegistrationError(
      'evidence_type_unversioned',
      `\`evidenceType\` ${JSON.stringify(r.evidenceType)} is not a versioned predicate URI of ` +
        'the form `<authority>/evidence/<name>/v<N>`. It is what tells a verifier which ' +
        'document `host_evidence` is; an evidence shape that changes without changing its ' +
        'name is unreadable in hindsight.',
    );
  }
  if (!Array.isArray(r.hooks) || r.hooks.length === 0) {
    throw new HostRegistrationError(
      'hooks_empty',
      `host '${r.host}' declares no hooks. ./surface.ts refuses a capture surface on the same ` +
        'ground: an adapter that serves no hook can never be reached, and a registration ' +
        'nothing can reach is a registration that looks like coverage and is not.',
    );
  }
  for (const h of r.hooks) {
    if (!(CAPTURE_HOOKS as readonly string[]).includes(h)) {
      throw new HostRegistrationError('hook_unknown', `unknown capture hook '${h}'`);
    }
  }
  if (!Array.isArray(r.surfaces) || r.surfaces.length === 0) {
    throw new HostRegistrationError(
      'surfaces_empty',
      `host '${r.host}' declares no surfaces. DEFECT-2 in PLACEMENT_AND_SURFACES.md is that a ` +
        'surface list cannot prove coverage; an EMPTY one does not even claim it.',
    );
  }
  for (const s of r.surfaces) {
    if (!(CAPTURE_SURFACES as readonly string[]).includes(s)) {
      throw new HostRegistrationError('surface_unknown', `unknown capture surface '${s}'`);
    }
  }
  if (!(OBSERVATION_FIDELITIES as readonly string[]).includes(r.fidelity)) {
    throw new HostRegistrationError('fidelity_unknown', `unknown fidelity '${r.fidelity}'`);
  }
  if (!(PLACEMENTS as readonly string[]).includes(r.declaredPlacement)) {
    throw new HostRegistrationError('placement_unknown', `unknown placement '${r.declaredPlacement}'`);
  }
  if (!(PLACEMENT_ENFORCEMENTS as readonly string[]).includes(r.enforcement)) {
    throw new HostRegistrationError('enforcement_unknown', `unknown enforcement '${r.enforcement}'`);
  }
  if (!r.schema || typeof r.schema !== 'object' || r.schema.type !== 'object') {
    throw new HostRegistrationError(
      'schema_not_an_object_schema',
      `host '${r.host}' must declare \`schema\` as a JSON Schema with \`type: "object"\`. It is ` +
        "the adapter's own statement of what its evidence contains, and the SDK checks each " +
        'announcement against it.',
    );
  }
  if (!Array.isArray(r.schema.required) || r.schema.required.length === 0) {
    throw new HostRegistrationError(
      'schema_requires_nothing',
      `host '${r.host}' declared a schema that requires nothing. A schema that validates ` +
        'everything makes `declined` unreachable, and an adapter that can never decline is an ' +
        'adapter whose `supplied` says nothing.',
    );
  }
  if ('attestation' in (r as unknown as Record<string, unknown>)) {
    throw new HostRegistrationError(
      'host_may_not_grade_itself',
      `host '${r.host}' sent an \`attestation\` on its registration. A host declares WHAT IT ` +
        'IS, never HOW GOOD IT IS: the outcome is derived from the RESOLVED placement by ' +
        '`assuranceForHost`, and a self-reported grade is the defect the placement axis exists ' +
        'to close.',
    );
  }

  const profile = hostProfileOf(r);
  const entry: RegisteredHost = {
    registration: r,
    profile,
    assurance: assuranceForHost(profile),
    registeredAt: new Date().toISOString(),
  };
  hostRegistry.set(r.host, entry);
  return entry;
}

export function registeredHosts(): string[] {
  return Array.from(hostRegistry.keys()).sort();
}

export function lookupHost(host: string): RegisteredHost | null {
  return hostRegistry.get(host) ?? null;
}

/** Test hook. Do not call from production code. */
export function _resetHostRegistryForTests(): void {
  hostRegistry.clear();
}

/* ────────────────────────────────────────────────────────────────────────
 * The adapter. One method, and it is a pure function.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * What a host implements. THE WHOLE INTERFACE.
 *
 * `semanticsFor` receives the observation the gate made and returns the
 * meaning the gate could not see, or null to decline. It may read whatever the
 * host's own transport gives it — a file the add-on dropped, an RPC back into
 * the host, a table it filled when the render started. The SDK takes no view
 * on that; transport is the adapter's business and the contract is the return
 * value.
 *
 * IT MAY NOT: mutate the observation, call the inner sink, construct an HTTP
 * request, decide a MIME, compute a MAC, spend a counter, or take a view on
 * whether the leaf is verified or passthrough. It CANNOT do the second — it is
 * never handed the inner sink — and the rest is CANON_SKELETON.md §5 binding
 * an adapter as it binds a surface.
 *
 * IT MAY THROW. `hostAdapterSink` catches, records `declined`, and delivers
 * the observation anyway: a host adapter bug must cost the leaf its semantics
 * and must never cost the artifact its leaf.
 */
export interface HostAdapter {
  readonly registration: HostRegistration;
  semanticsFor(o: CaptureObservation): Promise<Record<string, unknown> | null>;
}

/** Why an observation was declined, kept for the operator. NEVER SENT — an
 *  explanation on the wire is a field to be forged, the rule `basisReason`
 *  already follows in services/scruple-capture/src/leaf.ts. */
export interface HostEnrichmentRecord {
  observedAt: string;
  correlationId: string | null;
  contentHash: string | null;
  state: HostSemanticsState;
  /** 'supplied' · 'no-announcement' · 'schema:missing <k>' · 'threw: …' ·
   *  'already-present' */
  reason: string;
  hostEvidenceHash: string | null;
}

export interface HostAdapterSinkOptions {
  adapter: HostAdapter;
  inner: ObservationSink;
  log?: (line: string) => void;
}

/**
 * host_evidence_hash — binds the manifest the leaf carries.
 *
 * RFC 8785 over the whole document, unlike `hashModelFingerprints`, which is
 * top-level-sorted-only for a reason that does not apply here: that formula is
 * committed to in leaves that already exist and cannot be changed without
 * invalidating them. This field is new, so it gets the canonicalization the
 * others would have if they were being written today — which also means a
 * Python adapter and a TypeScript one agree on the bytes.
 *
 * Returns null for an absent or empty manifest, so callers store NULL rather
 * than the hash of `{}`. Same rule, same reason as `hashModelFingerprints`:
 * the hash of an empty object would assert that we asked the host and it
 * genuinely had nothing, which is what `declined` says and this must not.
 */
export function hashHostEvidence(
  evidence: Record<string, unknown> | null | undefined,
): { json: string; hash: string } | null {
  if (!evidence || Object.keys(evidence).length === 0) return null;
  const json = canonicalize(evidence);
  return { json, hash: sha256Hex(json) };
}

/**
 * THE COMPOSITION, AND THE SDK OWNS IT.
 *
 * Returns an `ObservationSink` to hand to `ComponentDeps.sinkWrap`. The host
 * never sees `inner`, so it cannot swallow an observation — both gate surfaces
 * await `sink.emit` before forwarding a byte and fail closed if it throws, so
 * a wrapper that dropped one would silently un-witness an artifact. Every path
 * below ends in a delegation.
 */
export function hostAdapterSink(opts: HostAdapterSinkOptions): ObservationSink & {
  readonly enrichments: HostEnrichmentRecord[];
} {
  const reg = opts.adapter.registration;
  const log = opts.log ?? ((l: string) => console.log(`[host-adapter] ${l}`));
  const enrichments: HostEnrichmentRecord[] = [];

  return {
    enrichments,
    async emit(o: CaptureObservation): Promise<void> {
      const ev = (o.evidence ?? {}) as Record<string, unknown>;
      const rec: HostEnrichmentRecord = {
        observedAt: o.observedAt,
        correlationId: o.correlationId ?? null,
        contentHash: (o.bytes as { contentHash?: string } | undefined)?.contentHash ?? null,
        state: 'declined',
        reason: 'no-announcement',
        hostEvidenceHash: null,
      };

      /**
       * DECLINE, AND SAY SO ON THE LEAF.
       *
       * ⚑ THIS IS THE HALF THAT IS EASY TO GET WRONG, so it is one function.
       * Delegating the observation UNCHANGED would leave the host fields
       * absent, `buildLeaf` would default `host_semantics` to 'blind', and a
       * Level-2 deployment whose adapter had nothing to say would be
       * indistinguishable on the evidence from a Level-1 one that had nobody
       * to ask. That collapse is the whole reason 'declined' exists.
       *
       * So a decline still NAMES the host, the adapter and the evidence type
       * — those are facts about the integration, true whether or not this
       * observation was announced — and carries no manifest and no hash,
       * which is what `declined` means.
       */
      const decline = (reason: string): Promise<void> => {
        rec.state = 'declined';
        rec.reason = reason;
        enrichments.push(rec);
        return opts.inner.emit({
          ...o,
          evidence: {
            ...ev,
            host: reg.host,
            host_adapter: `${reg.adapter}@${reg.adapterVersion}`,
            host_evidence_type: reg.evidenceType,
            host_semantics: 'declined',
          },
        });
      };

      // MAY NOT OVERWRITE. Two parties disagreeing about what an artifact
      // meant is a finding; silently preferring ours would erase it. Passed
      // through EXACTLY as it arrived — including its host fields.
      if (ev.host_semantics !== undefined || ev.host_evidence !== undefined) {
        rec.state = isHostSemanticsState(ev.host_semantics) ? ev.host_semantics : 'declined';
        rec.reason = 'already-present';
        enrichments.push(rec);
        return opts.inner.emit(o);
      }

      // NOT A HOOK THIS ADAPTER DECLARED. Registration said which §4 hooks it
      // serves; an adapter answering for a hook it never claimed is a
      // coverage claim nobody checked.
      if (!reg.hooks.includes(o.hook)) return decline(`hook-not-declared: ${o.hook}`);

      let evidence: Record<string, unknown> | null;
      try {
        evidence = await opts.adapter.semanticsFor(o);
      } catch (e) {
        // A host adapter bug costs the leaf its semantics. It does not cost
        // the artifact its leaf.
        log(`adapter threw: ${String((e as Error).message ?? e)}`);
        return decline(`threw: ${String((e as Error).message ?? e)}`);
      }

      if (evidence === null || evidence === undefined) return decline('no-announcement');

      // AGAINST THE ADAPTER'S OWN DECLARED SCHEMA. A partial announcement is
      // DECLINED rather than supplied-with-holes: the leaf either carries the
      // document the evidence type promises or it says it has none.
      const missing = reg.schema.required.filter((k) => evidence[k] === undefined);
      if (missing.length > 0) {
        log(`declining: announcement is missing ${missing.join(', ')}`);
        return decline(`schema:missing ${missing.join(',')}`);
      }

      const hashed = hashHostEvidence(evidence);
      if (!hashed) return decline('empty-announcement');

      rec.state = 'supplied';
      rec.reason = 'supplied';
      rec.hostEvidenceHash = hashed.hash;
      enrichments.push(rec);
      log(
        `${rec.contentHash?.slice(0, 12) ?? '(no bytes)'}: ${reg.host}/${reg.adapter} supplied ` +
          `${Object.keys(evidence).length} field(s) → host_evidence_hash=${hashed.hash.slice(0, 12)}`,
      );

      return opts.inner.emit({
        ...o,
        evidence: {
          ...ev,
          host: reg.host,
          host_adapter: `${reg.adapter}@${reg.adapterVersion}`,
          host_evidence_type: reg.evidenceType,
          host_semantics: 'supplied',
          host_evidence: evidence,
          host_evidence_hash: hashed.hash,
        },
      });
    },
  };
}
