// The validator for what a component's `capture` block is allowed to claim.
//
// WO-C1. "Enforce in the validator, not in prose" is the sentence this file
// exists to satisfy, and the council earned the right to insist on it: the
// filesystem trigger was retracted in round 4, reinstated in round 6 by the
// same seat that retracted it, and three watchers missed the reinstatement.
// A rule that lives only in a paragraph gets re-enabled by the next
// contributor as a shortcut. A rule that returns 422 does not.
//
// PURE. No database, no environment, no network. The route calls it after
// `requireScope` and before anything writes.
//
// ---------------------------------------------------------------------------
// RULE 1 — `close_detection` IS REJECTED AS A PROVENANCE OR COMPLETION FIELD
// ---------------------------------------------------------------------------
//
// §1: "Filesystem observations are not freeze-gate authentication and
// `close_detection` is rejected as provenance." Round 11: "`IN_CLOSE_WRITE`,
// quiescence, and `fs-watch.ts` observations must not create, complete, or
// authenticate artifact leaves ... The validator must reject `close_detection`
// as a provenance or completion field, so this cannot return as a dead schema
// dependency."
//
// THE FIELD STAYS IN THE MAC PREIMAGE, PINNED AT null, and that is deliberate.
// Removing the key would change the canonical JSON and therefore every MAC,
// splitting the three preimage implementations for a cosmetic gain. Keeping it
// at null means the MAC covers the ASSERTION THAT THERE IS NO CLOSE DETECTION —
// a proxy cannot add one in flight without breaking the signature. The field is
// dead as provenance and load-bearing as a negative.
//
// Where does the observation go instead? `capture.fs_diagnostic`, which is
// NOT read by componentPreimage() and is stored as diagnostic corroboration.
// fs-watch may keep observing. It may not complete a leaf.
//
// ---------------------------------------------------------------------------
// RULE 2 — A NEW v1 LEAF MUST NOT EMIT `attestation_status: null`
// ---------------------------------------------------------------------------
//
// A capture block is what makes a leaf a component leaf, so a capture block is
// the boundary between "new v1 leaf" and "legacy". Canvas and the desktop
// plugins send no capture block; their leaves record no basis and
// `basisForTrust()` reads them as 'unknown'. That is honest — the question was
// never asked of them. A component that DOES send a capture block is emitting
// under this design and must say what conditions its measured fields.
//
// ---------------------------------------------------------------------------
// RULE 3 — `verified` ON THE DESKTOP PROFILE IS REJECTED
// ---------------------------------------------------------------------------
//
// The runtime half of "unrepresentable, not merely unlikely". The type-level
// half is `BasisOn<'desktop'>` in ./attestationBasis.ts, and it is not enough
// on its own: types do not survive JSON, and this is JSON.
//
// A submission that declares `verified` with NO profile is refused for the
// same reason absent-is-never-verified applies on the read side. An
// undeclared profile is not a claim of a strong one.
//
// ---------------------------------------------------------------------------
// RULE 4 — AND WHILE THE MERKLE BLOCKER STANDS, `stale` IS THE ONLY BASIS
// ---------------------------------------------------------------------------
//
// Appendix C item 0. This is the rule most likely to be read as excessive, so:
// it is the ⚑ line of WO-C1 ("Until WO-C6 lands, every new leaf emits
// `stale`") enforced where a prose version would rot. It applies ONLY to
// submissions carrying a capture block — the leaves emitted under this design.
// Nothing that witnesses today without one is affected.
//
// It lifts by flipping CHECKPOINT_VECTORS_SETTLED, which is WO-C6's
// deliverable and no test's.
//
// ---------------------------------------------------------------------------
// RULE 5 — STORAGE CONFINEMENT IS DECLARED, AND ONLY `measured` MAY BE A CLAIM
// ---------------------------------------------------------------------------
//
// WO-C4. The council settled that the `stateDir`/`outputVolume` device
// identity is re-read AT EMISSION and carried as `source: measured | unknown`,
// and that degraded operation is permitted only when the session's leaves are
// "explicitly tagged `confinement: \"degraded_shared_storage\"` with
// `source: measured`" — never a silent degradation of a required capture
// session.
//
// Three things this rule refuses, and each of them is a way the tag could be
// present and worth nothing:
//
//   a. a capture-bearing leaf with NO confinement field. Rule 2's argument
//      exactly: a component emitting under this design must say what it
//      measured, and `unknown` is available for a placement that measured
//      nothing. Absent is not `unknown` — absent is a component that was
//      never asked.
//   b. a substantive value with `confinement_source` anything but `measured`.
//      `confined` on an unmeasured source is a claim of a boundary nobody
//      observed, which is the config-inherited fact class this whole design
//      refuses. So is a degraded value: the visibility requirement attaches
//      to a MEASUREMENT, and a degraded tag nobody measured cannot discharge
//      it.
//   c. `unknown` paired with `measured`. There is no measurement that
//      concludes nothing was measured.
//
// And, as with `close_detection`, a confinement field sent ONE LEVEL UP is
// refused rather than ignored — `componentPreimage()` reads it out of
// `capture` and would silently skip a top-level one, so a caller who moved it
// there would be sending a field that is outside the MAC and looks inside it.

// ---------------------------------------------------------------------------
// RULE 6 — THE UPSTREAM'S IDENTITY AND EPOCH ARE DECLARED, AND `not_queried`
//          MAY NOT STAND IN FOR `evicted_or_restarted`
// ---------------------------------------------------------------------------
//
// WO-C5. The council owned restart detection in hand round 6 §2 — "nothing in
// the component tracks upstream identity ... we never ask ComfyUI who it is"
// — and Architect set the condition this rule enforces, in round 5:
//
//   "'not enumerated' is right, but the reason field needs to distinguish
//   restart/eviction (bounded, detectable if you record the history epoch
//   identity and the low watermark at both query ends) from 'history simply
//   not queried' — otherwise the volatile source degrades to unknown for both
//   the recoverable and unrecoverable cases and YOU LOSE THE ONLY SIGNAL THAT
//   WOULD TELL AN OPERATOR TO SHORTEN THEIR QUERY INTERVAL."
//
// Five refusals, and each is a way the fields could be present and worth
// nothing:
//
//   a. ABSENT on a capture-bearing leaf. Rule 2's and rule 5's argument
//      exactly. `unknown`/`not_queried` is available for a placement with no
//      upstream to ask; absent is a component that was never asked.
//   b. A SUBSTANTIVE CONTINUITY (`continuous` or `restarted`) with
//      `upstream_source` anything but `measured`. Both directions matter:
//      `continuous` unmeasured claims a continuity nobody established, and
//      `restarted` unmeasured is an alarm nobody rang.
//   c. `unknown` PAIRED WITH `measured` IS PERMITTED HERE, and that is the one
//      place this rule differs from rule 5 — deliberately, because the facts
//      differ. A storage `unknown` means the stat failed, so no measurement
//      exists. An upstream `unknown` is frequently the CONCLUSION OF a
//      measurement: an idle history at both ends of an interval genuinely
//      cannot distinguish a restart from a quiet afternoon, and a component
//      that looked and found that is telling the truth. What is refused is the
//      inverse — see (d).
//   d. `upstream_source: "unknown"` WITH ANY REASON OTHER THAN `not_queried`
//      or `history_unavailable`. Those two are the only reasons that describe
//      not having a measurement. `enumerated` on an unmeasured source is an
//      enumeration nobody performed, and `evicted_or_restarted` on one is the
//      exact collapse Architect refused: the recoverable case wearing the
//      unmeasured case's clothes.
//   e. `not_queried` WITH AN EPOCH, or `enumerated` WITH NO WATERMARK AT
//      EITHER END. Both are internally contradictory: a component that asked
//      nothing cannot have pinned an epoch, and an enumeration that read no
//      watermark at either end of its bracket did not bracket anything.
//
// And, as with `close_detection` and the confinement pair, an upstream field
// sent ONE LEVEL UP is refused rather than ignored — `componentPreimage()`
// reads them out of `capture`, so a copy at the top level is outside the MAC
// while looking exactly like a signed measurement.

import {
  isConfinementSource,
  isStorageConfinement,
  type ConfinementSource,
  type StorageConfinement,
} from '@/lib/capture/storageConfinement';
// ---------------------------------------------------------------------------
// RULE 7 — THE HOST HOOK'S LEVEL IS DECLARED, AND LEVEL 2 CANNOT BE CLAIMED
//          BY A DEPLOYMENT THAT REGISTERED NOBODY
// ---------------------------------------------------------------------------
//
// WO-D6. `lib/capture/hostRegistry.ts` splits every host integration in two.
// LEVEL 1 is a host pointing its ComfyUI address at the gate: no code from us,
// full byte coverage, and a record that is honestly SEMANTICALLY BLIND. LEVEL 2
// is a registered adapter supplying the meaning a wire cannot carry — that
// these pixels were the viewport of scene X at frame Y through camera Z.
//
// The design's whole claim is that the difference is VISIBLE ON THE LEAF, and
// visible in the strong direction: a Level-1 leaf declares its blindness
// rather than being merely thinner than a Level-2 one. Five refusals, and each
// is a way that declaration could be present and worth nothing:
//
//   a. a capture-bearing leaf with NO `host_semantics`. Rule 2's argument
//      exactly. A component emitting under this design must say which level it
//      ran at, and 'blind' is available and free — `buildLeaf` defaults to it,
//      so absent here means something rewrote the field out on the way.
//   b. 'supplied' or 'declined' with NO `host_adapter`. Both are Level-2
//      statements and Level 2 means an adapter was registered. A leaf claiming
//      a host supplied its meaning while naming no adapter is a coverage claim
//      with nobody behind it.
//   c. 'blind' carrying ANY host field. Blind means nobody was asked; a host
//      id, an adapter, an evidence type or an evidence hash beside it is two
//      statements that cannot both be true.
//   d. 'supplied' with no `host_evidence_hash`, or 'declined' WITH one. These
//      are the two halves of the same collapse: the first supplies nothing and
//      calls it supplied, the second declines and ships a document anyway. If
//      an adapter had nothing to say, the value for that is 'declined' and it
//      carries no manifest.
//   e. a host field sent ONE LEVEL UP. `componentPreimage()` reads these out
//      of `capture` and would silently skip a top-level copy — a field outside
//      the MAC that looks exactly like a signed one. `host_evidence` is the
//      exception and is REQUIRED to be top level, for the reason
//      `model_fingerprints` is: it is the host's document, not the component's
//      observation, and only its hash is signed.
//
// ⚑ WHAT IS *NOT* REFUSED: 'declined'. An adapter that was registered and had
// nothing to say about this observation is telling the truth, and it is a
// DIFFERENT truth from 'blind' — one is an integration that is not working,
// the other is an integration that was never done. Refusing 'declined' would
// force a Level-2 host to choose between two lies. Same shape as WO-C5's
// deliberate non-refusal of `upstream_continuity: 'unknown'`.

// ---------------------------------------------------------------------------
// RULE 8 — AN ABSENCE SET CARRIES THE SCOPE IT ENUMERATED OVER, AND A CLOSURE
//          IS REFUSED TO A LEAF THAT ALSO SAYS IT COULD NOT ENUMERATE
// ---------------------------------------------------------------------------
//
// WO-E2, and the settled rule is `docs/canon/DECLARED_UNCAPTURED.md`. Round 5
// §3 put the question to Coder as a question rather than a ruling:
//
//   "must `declared_uncaptured` carry the scope it enumerated over — which root
//   types were configured, and whether any were `unspecified` — or does it
//   assert a closure it does not have? That is your own measured-or-unknown
//   invariant applied one level up: THE COMPLETENESS OF THE ABSENCE SET IS
//   ITSELF A FACT, and it needs a source like every other fact."
//
// Six refusals, and each is a way the scope could be present and worth nothing:
//
//   a. ABSENT or malformed on a capture-bearing leaf. Rules 2, 5, 6 and 7's
//      argument exactly. `none`/`not_enumerated`/`unknown` is available and
//      free for a placement that enumerates nothing, so absent means something
//      rewrote the fields out on the way.
//   b. `not_enumerated` CARRYING A COUNT OR A HASH, or a method other than
//      `none`. Nothing was enumerated, so there is no set, no digest of one,
//      and no method that produced it.
//   c. AN ENUMERATED SCOPE WITH A NULL COUNT OR A NULL HASH. ⚑ THIS IS THE
//      "EMPTY SET THAT IS PRESENT" RULE, at the wire. 0 is a count; null is the
//      absence of one. A component that enumerated and found nothing must say
//      0, because "looked and found nothing" and "did not look" are different
//      operational conditions with different owners — the distinction
//      `blind`/`declined` holds open one rule up and `not_queried` holds open
//      one rule down.
//   d. `uncaptured_scope_source: "measured"` WHILE THE INDEPENDENT-OBSERVER
//      BLOCKER STANDS. Rule 4's shape. Coder's answer on round 5 fact (b) is
//      that completeness is `source: unknown` unless an INDEPENDENT observer
//      establishes the history window and continuity; the only party reading
//      /history today is the component that emits the leaf, which is not
//      independent of its own claim.
//   e. `uncaptured_scope: "complete"` ON A LEAF WHOSE
//      `upstream_uncaptured_reason` IS NOT `enumerated`, or whose
//      `upstream_source` is not `measured`. THE CROSS-RULE, and the one that
//      matters most: a leaf claiming a closure over a window it says in the
//      next field it could not enumerate is internally contradictory, and it
//      is exactly the shape round 5 §3 warned about — "the ambiguity you just
//      killed reappears one level up, now WEARING A COMPLETENESS CLAIM, which
//      is worse than the bare hole because it reads as coverage."
//   f. A COUNT THAT IS NOT A SAFE NON-NEGATIVE INTEGER; and any of the five
//      keys sent ONE LEVEL UP, where `componentPreimage()` would not read them
//      and the field would sit outside the MAC looking exactly like a signed
//      one. `declared_uncaptured` — the document — is the exception and MUST be
//      top level, for `model_fingerprints`'s and `host_evidence`'s reason.
//
// ⚑ WHAT IS *NOT* REFUSED: `complete` beside `uncaptured_scope_source:
// "unknown"`. Those are two facts, not a contradiction — the first says every
// condition closure requires holds as the component measured them, the second
// says nobody outside the box confirmed the window. WO-C5 settled the identical
// shape when it accepted `upstream_continuity: "unknown"` beside
// `upstream_source: "measured"`, and collapsing them would force a component
// to lie in one direction or the other.

import {
  UNCAPTURED_INDEPENDENT_OBSERVER,
  UNCAPTURED_OBSERVER_BLOCKER_REASON,
  isUncapturedEnumerationMethod,
  isUncapturedScope,
  isUncapturedScopeSource,
  type UncapturedEnumerationMethod,
  type UncapturedScope,
  type UncapturedScopeSource,
} from '@/lib/capture/declaredUncaptured';
import {
  isUncapturedReason,
  isUpstreamContinuity,
  isUpstreamSource,
  type UncapturedReason,
  type UpstreamContinuity,
  type UpstreamSource,
} from '@/lib/capture/upstreamEpoch';
import {
  HOST_SEMANTICS_STATES,
  hostCaptureLevel,
  isHostSemanticsState,
  type HostCaptureLevel,
  type HostSemanticsState,
} from '@/lib/capture/hostRegistry';
import {
  CHECKPOINT_BLOCKER_REASON,
  CHECKPOINT_VECTORS_SETTLED,
  isAttestationBasis,
  isCaptureProfile,
  type AttestationBasis,
  type CaptureProfile,
} from '@/lib/leaf/attestationBasis';

export type CaptureClaimCode =
  | 'close_detection_rejected'
  | 'attestation_basis_required'
  | 'attestation_basis_refused'
  | 'storage_confinement_required'
  | 'storage_confinement_refused'
  | 'upstream_epoch_required'
  | 'upstream_epoch_refused'
  | 'host_semantics_required'
  | 'host_semantics_refused'
  | 'declared_uncaptured_required'
  | 'declared_uncaptured_refused';

export interface CaptureClaimRefusal {
  ok: false;
  code: CaptureClaimCode;
  message: string;
  detail: Record<string, unknown>;
}

export interface CaptureClaimAccepted {
  ok: true;
  /** null when the submission carries no capture block: a legacy leaf. */
  basis: AttestationBasis | null;
  profile: CaptureProfile | null;
  /** WO-C4. null on a legacy leaf, for the reason `basis` is null there. */
  confinement: StorageConfinement | null;
  confinementSource: ConfinementSource | null;
  /** WO-C5. null on a legacy leaf, same reason again. */
  upstream: UpstreamClaims | null;
  /** WO-D6. null on a legacy leaf; never null on a leaf carrying a capture
   *  block, because the level is not a question a component may leave open. */
  host: HostClaims | null;
  /** WO-E2. null on a legacy leaf; never null on a leaf carrying a capture
   *  block, because the scope of an absence set is not a question a component
   *  may leave open. */
  uncaptured: UncapturedClaims | null;
}

/** WO-E2. What the component enumerated, and what its enumeration is worth. */
export interface UncapturedClaims {
  method: UncapturedEnumerationMethod;
  scope: UncapturedScope;
  scopeSource: UncapturedScopeSource;
  /** 0 is a count. null exactly when `scope` is `not_enumerated`. */
  count: number | null;
  hash: string | null;
}

/** WO-D6. Which level the host hook ran at, and who said so. */
export interface HostClaims {
  semantics: HostSemanticsState;
  /** DERIVED from `semantics`, never read off the wire. */
  level: HostCaptureLevel;
  host: string | null;
  adapter: string | null;
  evidenceType: string | null;
  evidenceHash: string | null;
}

/** WO-C5. What the component said about the process it is watching. */
export interface UpstreamClaims {
  identity: string | null;
  epoch: string | null;
  continuity: UpstreamContinuity;
  lowWatermarkOpen: number | null;
  lowWatermarkClose: number | null;
  uncapturedReason: UncapturedReason;
  source: UpstreamSource;
}

export type CaptureClaimResult = CaptureClaimAccepted | CaptureClaimRefusal;

/** Every place a `close_detection` could be smuggled in as provenance. */
function closeDetectionSites(
  body: Record<string, unknown>,
  capture: Record<string, unknown> | null,
): Array<{ at: string; value: unknown }> {
  const sites: Array<{ at: string; value: unknown }> = [];
  if ('close_detection' in body) sites.push({ at: 'close_detection', value: body.close_detection });
  if (capture && 'close_detection' in capture) {
    sites.push({ at: 'capture.close_detection', value: capture.close_detection });
  }
  return sites.filter((s) => s.value !== null && s.value !== undefined);
}

export function validateCaptureClaims(
  body: Record<string, unknown>,
  opts: { vectorsSettled?: boolean; independentObserver?: boolean } = {},
): CaptureClaimResult {
  const settled = opts.vectorsSettled ?? CHECKPOINT_VECTORS_SETTLED;
  const capture =
    body.capture && typeof body.capture === 'object' && !Array.isArray(body.capture)
      ? (body.capture as Record<string, unknown>)
      : null;

  // ---- Rule 1 -------------------------------------------------------
  // Checked FIRST, and against a submission with no capture block too: a
  // caller that moved the field up a level has made exactly the claim the
  // rule refuses.
  const smuggled = closeDetectionSites(body, capture);
  if (smuggled.length > 0) {
    return {
      ok: false,
      code: 'close_detection_rejected',
      message:
        '`close_detection` is rejected as a provenance or completion field. A filesystem ' +
        'observation — IN_CLOSE_WRITE, quiescence, or anything fs-watch derives — must not ' +
        'create, complete or authenticate an artifact leaf: the authoritative artifact set is ' +
        'the byte stream of artifact-bearing HTTP and WebSocket responses, and the list of ' +
        'artifacts for which an on-disk copy is authoritative while the wire copy is not is ' +
        'EMPTY. Send the observation as `capture.fs_diagnostic` instead, where it is ' +
        'diagnostic corroboration and is not covered by the MAC. The `close_detection` key ' +
        'itself stays in the preimage pinned at null so a proxy cannot add one in flight.',
      detail: { rejected: smuggled },
    };
  }

  if (!capture) {
    // A legacy leaf: canvas, the plugins, a host with no component. No basis
    // is recorded and `basisForTrust()` will read it as 'unknown'.
    return {
      ok: true,
      basis: null,
      profile: null,
      confinement: null,
      confinementSource: null,
      upstream: null,
      host: null,
      uncaptured: null,
    };
  }

  // ---- Rule 2 -------------------------------------------------------
  const raw = capture.attestation_status;
  if (!isAttestationBasis(raw)) {
    return {
      ok: false,
      code: 'attestation_basis_required',
      message:
        'A leaf carrying a `capture` block must declare `capture.attestation_status` as one of ' +
        '"verified" | "stale" | "passthrough". It was ' +
        (raw === undefined ? 'absent' : JSON.stringify(raw)) +
        '. Absent, null or malformed is NEVER read as verified — it resolves to `unknown` for ' +
        'trust decisions, and a leaf emitted under this design is not entitled to be unknown ' +
        'about its own basis. One basis per leaf; every field-level `source: measured` on it ' +
        'is conditional on this value.',
      detail: { received: raw ?? null, accepted: ['verified', 'stale', 'passthrough'] },
    };
  }
  const basis: AttestationBasis = raw;

  const declaredProfile = capture.profile;
  if (declaredProfile !== undefined && declaredProfile !== null && !isCaptureProfile(declaredProfile)) {
    return {
      ok: false,
      code: 'attestation_basis_refused',
      message:
        '`capture.profile` must be one of "server-managed" | "isolated-sidecar" | "desktop" ' +
        'when present. The basis is conditional on the profile, so an unrecognised profile ' +
        'makes the basis unreadable rather than merely odd.',
      detail: { received: declaredProfile },
    };
  }
  const profile: CaptureProfile | null = isCaptureProfile(declaredProfile) ? declaredProfile : null;

  // ---- Rule 3 -------------------------------------------------------
  if (basis === 'verified' && profile === null) {
    return {
      ok: false,
      code: 'attestation_basis_refused',
      message:
        'A leaf declaring `verified` must declare the profile that makes it representable. ' +
        'An undeclared profile is not a claim of a strong one — absent is never verified, on ' +
        'the write side for the same reason it is on the read side.',
      detail: { basis, profile: null },
    };
  }
  if (basis === 'verified' && profile === 'desktop') {
    return {
      ok: false,
      code: 'attestation_basis_refused',
      message:
        '`verified` is unreachable on the desktop profile BY CONSTRUCTION, and this is a ' +
        'refusal rather than a downgrade. PCRs attest boot state; the threat is runtime root, ' +
        'which can LD_PRELOAD or eBPF-synthesize the entire coverage story after the quote was ' +
        'taken, and an interval bound cannot exclude a compromise inside its own interval. ' +
        '`verified` is reserved for a placement that can enforce the capture boundary against ' +
        'the tenant — a server-managed library, a genuinely isolated sidecar, or a CVM. ' +
        'Emit `stale` or `passthrough`.',
      detail: { basis, profile },
    };
  }

  // ---- Rule 4 -------------------------------------------------------
  if (!settled && basis !== 'stale') {
    return {
      ok: false,
      code: 'attestation_basis_refused',
      message:
        `A leaf emitted today must state \`stale\`; this one said \`${basis}\`. Because ` +
        CHECKPOINT_BLOCKER_REASON,
      detail: { basis, required: 'stale', checkpoint_vectors_settled: settled },
    };
  }

  // ---- Rule 5 -------------------------------------------------------
  const conf = validateConfinement(body, capture);
  if (!conf.ok) return conf;

  // ---- Rule 6 -------------------------------------------------------
  const up = validateUpstream(body, capture);
  if (!up.ok) return up;

  // ---- Rule 7 -------------------------------------------------------
  const host = validateHost(body, capture);
  if (!host.ok) return host;

  // ---- Rule 8 -------------------------------------------------------
  // AFTER rule 6, and the order is load-bearing: refusal (e) reads the
  // upstream reason that rule 6 has just established is one of the five, so a
  // malformed reason is a rule-6 refusal rather than an unreadable cross-check
  // here.
  const unc = validateUncaptured(body, capture, up.upstream, opts);
  if (!unc.ok) return unc;

  return {
    ok: true,
    basis,
    profile,
    confinement: conf.confinement,
    confinementSource: conf.confinementSource,
    upstream: up.upstream,
    host: host.host,
    uncaptured: unc.uncaptured,
  };
}

/** Rule 7, split out for the reason Rules 5 and 6 are: five refusals and one
 *  accept do not read as a rule when they are inline. */
function validateHost(
  body: Record<string, unknown>,
  capture: Record<string, unknown>,
): CaptureClaimAccepted | CaptureClaimRefusal {
  // (e) sent one level up, where the preimage does not read it.
  //
  // `host_evidence` is deliberately absent from this list: it MUST be top
  // level. `componentPreimage()` never reads it — only its hash is signed —
  // and putting the document inside `capture` would smuggle a host-shaped
  // blob full of floats into a MAC preimage, which §10 C-1 refuses.
  const misplaced = [
    'host',
    'host_adapter',
    'host_evidence_type',
    'host_semantics',
    'host_evidence_hash',
  ].filter((k) => k in body);
  if (misplaced.length > 0) {
    return {
      ok: false,
      code: 'host_semantics_refused',
      message:
        `${misplaced.join(' and ')} sent at the top level. The host-hook fields are CAPTURE ` +
        'fields — `componentPreimage()` reads them out of `capture`, so a copy one level up ' +
        'is outside the MAC while looking exactly like a signed declaration. Send them inside ' +
        '`capture`. The one exception is `host_evidence`, which is the host\'s DOCUMENT rather ' +
        'than the component\'s observation and belongs at the top level beside ' +
        '`model_fingerprints`, with only its hash signed.',
      detail: { misplaced },
    };
  }

  const raw = capture.host_semantics;

  // (a) absent.
  if (!isHostSemanticsState(raw)) {
    return {
      ok: false,
      code: 'host_semantics_required',
      message:
        'A leaf carrying a `capture` block must declare `capture.host_semantics` as one of ' +
        '"blind" | "declined" | "supplied". It was ' +
        (raw === undefined ? 'absent' : JSON.stringify(raw)) +
        '. "blind" is available and costs nothing — the leaf builder DEFAULTS to it — so a ' +
        'component running at Level 1 has a true value to send. Absent is not Level 1; absent ' +
        'is a leaf that will not say whether anybody named what it captured, and a record that ' +
        'is merely thinner than an enriched one is the failure this field exists to refuse.',
      detail: { received: raw ?? null, accepted: [...HOST_SEMANTICS_STATES] },
    };
  }
  const semantics: HostSemanticsState = raw;

  const str = (k: string): string | null => {
    const v = capture[k];
    return typeof v === 'string' && v !== '' ? v : null;
  };
  const host = str('host');
  const adapter = str('host_adapter');
  const evidenceType = str('host_evidence_type');
  const evidenceHash = str('host_evidence_hash');

  // (b) Level 2 with nobody registered.
  if (semantics !== 'blind' && adapter === null) {
    return {
      ok: false,
      code: 'host_semantics_refused',
      message:
        `\`host_semantics: "${semantics}"\` with no \`capture.host_adapter\` is refused. Both ` +
        'non-blind values are LEVEL-2 statements, and Level 2 means an adapter was registered ' +
        'through `registerHost()`. A leaf asserting that a host supplied — or was asked for — ' +
        'its meaning while naming nobody is a coverage claim with nothing behind it.',
      detail: { semantics, host, adapter, evidence_type: evidenceType },
    };
  }

  // (c) blind, and yet somebody is named.
  if (semantics === 'blind') {
    const present = Object.entries({
      host,
      host_adapter: adapter,
      host_evidence_type: evidenceType,
      host_evidence_hash: evidenceHash,
    })
      .filter(([, v]) => v !== null)
      .map(([k]) => k);
    if (present.length > 0 || body.host_evidence !== undefined) {
      return {
        ok: false,
        code: 'host_semantics_refused',
        message:
          '`host_semantics: "blind"` with ' +
          (present.length ? present.join(', ') : 'a `host_evidence` document') +
          ' beside it is refused. Blind means nobody was registered and nothing named these ' +
          'bytes. A host id, an adapter, an evidence type, a hash or a document alongside it ' +
          'are two statements that cannot both be true, and the wrong one of the two would be ' +
          'the one a reader believes.',
        detail: { semantics, present, has_evidence: body.host_evidence !== undefined },
      };
    }
  }

  // (d) the two halves of the same collapse.
  if (semantics === 'supplied' && evidenceHash === null) {
    return {
      ok: false,
      code: 'host_semantics_refused',
      message:
        '`host_semantics: "supplied"` with no `capture.host_evidence_hash` is refused. It ' +
        'supplies nothing and calls it supplied. An adapter that was reached and had nothing ' +
        'to say has a value of its own — "declined" — and that value carries no manifest.',
      detail: { semantics, evidence_hash: null },
    };
  }
  if (semantics === 'declined' && (evidenceHash !== null || body.host_evidence !== undefined)) {
    return {
      ok: false,
      code: 'host_semantics_refused',
      message:
        '`host_semantics: "declined"` with an evidence hash or an evidence document is ' +
        'refused. Declined means the adapter had nothing to say about THIS observation; a ' +
        'document beside it says it had something.',
      detail: {
        semantics,
        evidence_hash: evidenceHash,
        has_evidence: body.host_evidence !== undefined,
      },
    };
  }

  return {
    ok: true,
    basis: null,
    profile: null,
    confinement: null,
    confinementSource: null,
    upstream: null,
    host: {
      semantics,
      level: hostCaptureLevel(semantics),
      host,
      adapter,
      evidenceType,
      evidenceHash,
    },
    uncaptured: null,
  };
}

/** Rule 5, split out because it has four refusals and one accept. */
function validateConfinement(
  body: Record<string, unknown>,
  capture: Record<string, unknown>,
): CaptureClaimAccepted | CaptureClaimRefusal {
  // (d) sent one level up, where the preimage does not read it.
  const misplaced = ['confinement', 'confinement_source'].filter((k) => k in body);
  if (misplaced.length > 0) {
    return {
      ok: false,
      code: 'storage_confinement_refused',
      message:
        `${misplaced.join(' and ')} sent at the top level. The storage confinement fields are ` +
        'CAPTURE fields — `componentPreimage()` reads them out of `capture`, so a copy one ' +
        'level up is outside the MAC while looking exactly like a signed measurement. Send ' +
        'them inside `capture` or not at all.',
      detail: { misplaced },
    };
  }

  const rawConf = capture.confinement;
  const rawSource = capture.confinement_source;

  // (a) absent.
  if (!isStorageConfinement(rawConf) || !isConfinementSource(rawSource)) {
    return {
      ok: false,
      code: 'storage_confinement_required',
      message:
        'A leaf carrying a `capture` block must declare `capture.confinement` as one of ' +
        '"confined" | "degraded_shared_storage" | "degraded_no_reservation" | "unknown", and ' +
        '`capture.confinement_source` as "measured" or "unknown". Received ' +
        `${JSON.stringify(rawConf ?? null)} / ${JSON.stringify(rawSource ?? null)}. The device ` +
        'identity behind the ratchet state and the watched volumes is re-read AT EMISSION and ' +
        'carried on the leaf: a startup-only check is a config-inherited fact by the time the ' +
        'leaf is emitted, because volumes can be remounted or bind-mounted after boot. A ' +
        'placement with nothing to measure declares "unknown"/"unknown" — which is a ' +
        'different thing from a component that was never asked.',
      detail: {
        confinement: rawConf ?? null,
        confinement_source: rawSource ?? null,
        accepted_confinement: [
          'confined',
          'degraded_shared_storage',
          'degraded_no_reservation',
          'unknown',
        ],
        accepted_source: ['measured', 'unknown'],
      },
    };
  }

  // (b) a substantive value with no measurement behind it.
  if (rawConf !== 'unknown' && rawSource !== 'measured') {
    return {
      ok: false,
      code: 'storage_confinement_refused',
      message:
        `\`confinement: "${rawConf}"\` with \`confinement_source: "${rawSource}"\` is refused. ` +
        'A confinement value is a FACT about a filesystem and may be populated only by a ' +
        'measurement — configuration, inheritance, prior certification and defaults cannot. ' +
        'That cuts both ways: `confined` unmeasured claims a boundary nobody observed, and a ' +
        'degraded value unmeasured cannot discharge the visibility condition the council ' +
        'attached to degraded operation, which is a tag with `source: measured` behind it. ' +
        'Declare "unknown"/"unknown" if nothing was measured.',
      detail: { confinement: rawConf, confinement_source: rawSource },
    };
  }

  // (c) unknown, measured.
  if (rawConf === 'unknown' && rawSource === 'measured') {
    return {
      ok: false,
      code: 'storage_confinement_refused',
      message:
        '`confinement: "unknown"` with `confinement_source: "measured"` is refused: there is ' +
        'no measurement whose conclusion is that nothing was measured. If a stat failed, the ' +
        'source is "unknown" — that is what the pair is for.',
      detail: { confinement: rawConf, confinement_source: rawSource },
    };
  }

  return {
    ok: true,
    basis: null,
    profile: null,
    confinement: rawConf,
    confinementSource: rawSource,
    upstream: null,
    host: null,
    uncaptured: null,
  };
}

/** Rule 6, split out for the reason rule 5 is: five refusals and one accept. */
function validateUpstream(
  body: Record<string, unknown>,
  capture: Record<string, unknown>,
): CaptureClaimAccepted | CaptureClaimRefusal {
  const KEYS = [
    'upstream_identity',
    'upstream_epoch',
    'upstream_continuity',
    'upstream_low_watermark_open',
    'upstream_low_watermark_close',
    'upstream_uncaptured_reason',
    'upstream_source',
  ] as const;

  // (f) sent one level up, where the preimage does not read it.
  const misplaced = KEYS.filter((k) => k in body);
  if (misplaced.length > 0) {
    return {
      ok: false,
      code: 'upstream_epoch_refused',
      message:
        `${misplaced.join(', ')} sent at the top level. The upstream epoch fields are CAPTURE ` +
        'fields — `componentPreimage()` reads them out of `capture`, so a copy one level up ' +
        'is outside the MAC while looking exactly like a signed measurement. Send them inside ' +
        '`capture` or not at all.',
      detail: { misplaced },
    };
  }

  const continuity = capture.upstream_continuity;
  const reason = capture.upstream_uncaptured_reason;
  const source = capture.upstream_source;

  // (a) absent, or malformed.
  if (!isUpstreamContinuity(continuity) || !isUncapturedReason(reason) || !isUpstreamSource(source)) {
    return {
      ok: false,
      code: 'upstream_epoch_required',
      message:
        'A leaf carrying a `capture` block must declare `capture.upstream_continuity` as one ' +
        'of "continuous" | "restarted" | "unknown", `capture.upstream_uncaptured_reason` as ' +
        'one of "enumerated" | "evicted_or_restarted" | "interval_not_covered" | ' +
        '"history_unavailable" | "not_queried", and `capture.upstream_source` as "measured" ' +
        `or "unknown". Received ${JSON.stringify(continuity ?? null)} / ` +
        `${JSON.stringify(reason ?? null)} / ${JSON.stringify(source ?? null)}. A silent ` +
        'ComfyUI restart resets an in-memory history ring that does not survive it, and ' +
        'currently masquerades as a normal short history; a placement with no upstream to ask ' +
        'declares "unknown"/"not_queried"/"unknown", which is a different thing from a ' +
        'component that was never asked.',
      detail: {
        upstream_continuity: continuity ?? null,
        upstream_uncaptured_reason: reason ?? null,
        upstream_source: source ?? null,
      },
    };
  }

  const identity = typeof capture.upstream_identity === 'string' ? capture.upstream_identity : null;
  const epoch = typeof capture.upstream_epoch === 'string' ? capture.upstream_epoch : null;
  const open = watermark(capture.upstream_low_watermark_open);
  const close = watermark(capture.upstream_low_watermark_close);
  if (open === false || close === false) {
    return {
      ok: false,
      code: 'upstream_epoch_refused',
      message:
        'A low watermark must be a safe integer or null. A float in the MAC preimage is a MAC ' +
        'that fails unreproducibly and only sometimes (§10 C-1), and ComfyUI takes the prompt ' +
        "`number` FROM THE CLIENT (server.py:920: `number = float(json_data['number'])`) — so " +
        'the component drops a non-integer from the watermark rather than carrying it here.',
      detail: {
        upstream_low_watermark_open: capture.upstream_low_watermark_open ?? null,
        upstream_low_watermark_close: capture.upstream_low_watermark_close ?? null,
      },
    };
  }

  // (b) a substantive continuity with no measurement behind it.
  if (continuity !== 'unknown' && source !== 'measured') {
    return {
      ok: false,
      code: 'upstream_epoch_refused',
      message:
        `\`upstream_continuity: "${continuity}"\` with \`upstream_source: "${source}"\` is ` +
        'refused. Both directions matter: `continuous` on an unmeasured source claims a ' +
        'continuity nobody established, and `restarted` on one is an alarm nobody rang. ' +
        'Declare "unknown" if nothing was measured.',
      detail: { upstream_continuity: continuity, upstream_source: source },
    };
  }

  // (d) an unmeasured source may only carry a reason that describes not
  //     having a measurement. This is Architect's condition, enforced: the
  //     recoverable case must not be able to wear the unmeasured case's
  //     clothes, or the operator loses the signal to shorten the interval.
  if (source === 'unknown' && reason !== 'not_queried' && reason !== 'history_unavailable') {
    return {
      ok: false,
      code: 'upstream_epoch_refused',
      message:
        `\`upstream_source: "unknown"\` with \`upstream_uncaptured_reason: "${reason}"\` is ` +
        'refused. Only "not_queried" and "history_unavailable" describe not having a ' +
        'measurement. "enumerated" on an unmeasured source is an enumeration nobody ' +
        'performed, and "evicted_or_restarted" on one collapses the recoverable, bounded, ' +
        'detectable case into the unmeasured one — which is precisely the collapse the ' +
        'council refused, because it is the only signal telling an operator to shorten their ' +
        'query interval.',
      detail: { upstream_source: source, upstream_uncaptured_reason: reason },
    };
  }

  // (e) internally contradictory pairs.
  if (reason === 'not_queried' && (epoch !== null || open !== null || close !== null)) {
    return {
      ok: false,
      code: 'upstream_epoch_refused',
      message:
        '`upstream_uncaptured_reason: "not_queried"` with an epoch or a watermark is refused. ' +
        '"not queried" means nobody asked; an epoch is pinned from a retained prompt and a ' +
        'watermark is read off a `/history` response, so either one is evidence that somebody ' +
        'did. Say what was actually measured.',
      detail: {
        upstream_epoch: epoch,
        upstream_low_watermark_open: open,
        upstream_low_watermark_close: close,
      },
    };
  }
  // ⚑ WHAT IS DELIBERATELY *NOT* REFUSED HERE, because a first draft of this
  // rule did refuse it and the live gate run caught it:
  // `upstream_uncaptured_reason: "enumerated"` WITH BOTH WATERMARKS NULL.
  // That reads like "claims an enumeration, bracketed nothing" — but an EMPTY
  // history ring legitimately has no watermark at either end, and the bracket
  // immediately after a ComfyUI restart finds exactly that. Enumerating an
  // empty ring is a real enumeration with a real (empty) result. The shape the
  // draft was reaching for is "claims an enumeration without having measured",
  // and (d) already refuses it: a component that never bracketed carries
  // `upstream_source: "unknown"`, which may only pair with `not_queried` or
  // `history_unavailable`.

  return {
    ok: true,
    basis: null,
    profile: null,
    confinement: null,
    confinementSource: null,
    upstream: {
      identity,
      epoch,
      continuity,
      lowWatermarkOpen: open,
      lowWatermarkClose: close,
      uncapturedReason: reason,
      source,
    },
    host: null,
    uncaptured: null,
  };
}

/** Rule 8, split out for the reason rules 5, 6 and 7 are: six refusals and one
 *  accept do not read as a rule when they are inline. */
function validateUncaptured(
  body: Record<string, unknown>,
  capture: Record<string, unknown>,
  upstream: UpstreamClaims | null,
  opts: { independentObserver?: boolean },
): CaptureClaimAccepted | CaptureClaimRefusal {
  const KEYS = [
    'uncaptured_enumeration_method',
    'uncaptured_scope',
    'uncaptured_scope_source',
    'declared_uncaptured_count',
    'declared_uncaptured_hash',
  ] as const;

  const refuse = (message: string, detail: Record<string, unknown>): CaptureClaimRefusal => ({
    ok: false,
    code: 'declared_uncaptured_refused',
    message,
    detail,
  });

  // (f-ii) the five scalars sent one level up, where the preimage does not
  //        read them.
  const misplaced = KEYS.filter((k) => k in body);
  if (misplaced.length > 0) {
    return refuse(
      `${misplaced.join(', ')} sent at the top level. The absence set's SCOPE fields are ` +
        'CAPTURE fields — `componentPreimage()` reads them out of `capture`, so a copy one ' +
        'level up is outside the MAC while looking exactly like a signed closure claim. The ' +
        'DOCUMENT `declared_uncaptured` is the one that belongs at the top level, beside ' +
        '`model_fingerprints` and `host_evidence`, because only its hash is signed.',
      { misplaced },
    );
  }

  // (f-iii) …and the document sent one level DOWN, inside `capture`, where the
  //         route would not hash it and the leaf would carry a digest of
  //         nothing.
  if ('declared_uncaptured' in capture) {
    return refuse(
      '`declared_uncaptured` sent inside `capture`. The document is top-level, like ' +
        '`model_fingerprints` and `host_evidence`: `capture` is what the component OBSERVED, ' +
        'and the route recomputes `capture.declared_uncaptured_hash` from the top-level ' +
        'document. A copy inside `capture` would never be hashed and the signed digest would ' +
        'cover nothing.',
      { at: 'capture.declared_uncaptured' },
    );
  }

  const method = capture.uncaptured_enumeration_method;
  const scope = capture.uncaptured_scope;
  const scopeSource = capture.uncaptured_scope_source;

  // (a) absent, or malformed.
  if (
    !isUncapturedEnumerationMethod(method) ||
    !isUncapturedScope(scope) ||
    !isUncapturedScopeSource(scopeSource)
  ) {
    return {
      ok: false,
      code: 'declared_uncaptured_required',
      message:
        'A leaf carrying a `capture` block must declare ' +
        '`capture.uncaptured_enumeration_method` as "live_history" or "none", ' +
        '`capture.uncaptured_scope` as one of "complete" | "partial" | "not_enumerated", and ' +
        '`capture.uncaptured_scope_source` as "measured" or "unknown". Received ' +
        `${JSON.stringify(method ?? null)} / ${JSON.stringify(scope ?? null)} / ` +
        `${JSON.stringify(scopeSource ?? null)}. An absence set that does not say what it ` +
        'enumerated over asserts a closure it does not have, which is worse than the bare ' +
        'hole because it reads as coverage; a placement with nothing to enumerate declares ' +
        '"none"/"not_enumerated"/"unknown", which is a different thing from a component that ' +
        'never said.',
      detail: {
        uncaptured_enumeration_method: method ?? null,
        uncaptured_scope: scope ?? null,
        uncaptured_scope_source: scopeSource ?? null,
      },
    };
  }

  const rawCount = capture.declared_uncaptured_count;
  const count =
    rawCount === undefined || rawCount === null
      ? null
      : Number.isSafeInteger(rawCount) && (rawCount as number) >= 0
        ? (rawCount as number)
        : false;
  const hash =
    typeof capture.declared_uncaptured_hash === 'string' ? capture.declared_uncaptured_hash : null;

  // (f-i) a count that is not a safe non-negative integer.
  if (count === false) {
    return refuse(
      '`declared_uncaptured_count` must be a non-negative safe integer or null. A float in ' +
        'the MAC preimage is a MAC that fails unreproducibly and only sometimes (§10 C-1), ' +
        'and a negative cardinality is not a set.',
      { declared_uncaptured_count: rawCount ?? null },
    );
  }

  // (b) nothing was enumerated, so there is nothing to have counted or hashed.
  if (scope === 'not_enumerated') {
    if (count !== null || hash !== null || method !== 'none') {
      return refuse(
        '`uncaptured_scope: "not_enumerated"` with a count, a hash or an enumeration method ' +
          'is refused. "Not enumerated" means no enumeration was performed: there is no set ' +
          'to count, no digest of one, and no method that produced it. If the component ' +
          'enumerated and found nothing uncaptured, the value for that is a count of 0 with ' +
          'a scope of "complete" or "partial" — an empty set that is PRESENT, which is a ' +
          'different fact from an absent one.',
        {
          uncaptured_scope: scope,
          uncaptured_enumeration_method: method,
          declared_uncaptured_count: count,
          declared_uncaptured_hash: hash,
        },
      );
    }
  } else {
    // (c) ⚑ THE EMPTY-SET-IS-PRESENT RULE. An enumerated scope always has a
    //     count and a digest, and 0 is a count.
    if (count === null || hash === null || method === 'none') {
      return refuse(
        `\`uncaptured_scope: "${scope}"\` with ` +
          `${count === null ? 'no count' : 'a count'}, ` +
          `${hash === null ? 'no hash' : 'a hash'} and method "${method}" is refused. An ` +
          'enumerated set always carries its cardinality and the digest of its document — ' +
          'and 0 IS A CARDINALITY. Null is the absence of one, which is "the component did ' +
          'not look", and that state is spelled "not_enumerated". Collapsing the two would ' +
          'make "looked and found nothing" unreadable, which is the distinction this field ' +
          'exists to hold open.',
        {
          uncaptured_scope: scope,
          uncaptured_enumeration_method: method,
          declared_uncaptured_count: count,
          declared_uncaptured_hash: hash,
        },
      );
    }
  }

  // (d) the independent-observer blocker. Rule 4's shape: computed against the
  //     flag rather than hardcoded, so the day an independent observer exists
  //     this refusal lifts without a schema change.
  const independent = opts.independentObserver ?? UNCAPTURED_INDEPENDENT_OBSERVER;
  if (scopeSource === 'measured' && !independent) {
    return refuse(
      '`uncaptured_scope_source: "measured"` is refused today, and this is a refusal rather ' +
        `than a downgrade. Because ${UNCAPTURED_OBSERVER_BLOCKER_REASON} Emit "unknown". ` +
        'Note that "unknown" here is about the COMPLETENESS of the absence set, not about ' +
        'the enumeration: the artifacts listed were really reported by the upstream and ' +
        'really not captured, and `upstream_source` carries that half.',
      { uncaptured_scope_source: scopeSource, independent_observer: independent },
    );
  }

  // (e) THE CROSS-RULE. A closure claimed over a window the same leaf says it
  //     could not enumerate.
  if (
    scope === 'complete' &&
    (upstream === null ||
      upstream.uncapturedReason !== 'enumerated' ||
      upstream.source !== 'measured')
  ) {
    return refuse(
      '`uncaptured_scope: "complete"` on a leaf whose `upstream_uncaptured_reason` is ' +
        `"${upstream?.uncapturedReason ?? '(absent)'}" with \`upstream_source\` ` +
        `"${upstream?.source ?? '(absent)'}" is refused. A closure over the upstream's ` +
        'output enumeration requires that the enumeration covered this leaf\'s interval and ' +
        'that the history ring held across both ends of the bracket — which is exactly what ' +
        'WO-C5\'s reason field says, and this leaf says it did not. The ambiguity round 5 §3 ' +
        'closed must not reappear one level up wearing a completeness claim, which is worse ' +
        'than the bare hole because it reads as coverage. Declare "partial".',
      {
        uncaptured_scope: scope,
        upstream_uncaptured_reason: upstream?.uncapturedReason ?? null,
        upstream_source: upstream?.source ?? null,
      },
    );
  }

  return {
    ok: true,
    basis: null,
    profile: null,
    confinement: null,
    confinementSource: null,
    upstream: null,
    host: null,
    uncaptured: {
      method,
      scope,
      scopeSource,
      count,
      hash,
    },
  };
}

/** A safe integer, null, or `false` for "present and not a number we may
 *  put in a MAC preimage". */
function watermark(v: unknown): number | null | false {
  if (v === undefined || v === null) return null;
  return Number.isSafeInteger(v) ? (v as number) : false;
}
