// The resolution handles, and the rule that they are only handles when they
// are SIGNED.
//
// WO-C2. SETTLED BY THE BLENDER×COMFYUI COUNCIL (artifact `1a978a6`, §1, §2
// Architect's ruling, Appendix C). `docs/wo/2026-09-09-council-implementation.md`
// is the work order.
//
// ---------------------------------------------------------------------------
// WHY THE HANDLES EXIST AT ALL
// ---------------------------------------------------------------------------
//
// Round 11 resolved a real conflict rather than splitting it. Architect
// required that a verifier can read the leaf ALONE and know what is asserted
// and when silence becomes a finding. IT Expert required that the leaf NOT
// carry a full Merkle path and a raw TPM quote, because that bloats every
// high-frequency emission. The resolution was to separate what a leaf CLAIMS
// from what it CARRIES AS EVIDENCE:
//
//   "The leaf carries its claims and its resolution handles ... The Merkle
//    path and the raw quote are EVIDENCE, and evidence is resolvable rather
//    than carried."
//
// ---------------------------------------------------------------------------
// AND WHY THAT MAKES THE HANDLES SECURITY-CRITICAL
// ---------------------------------------------------------------------------
//
// Architect settled on exactly two conditions, and this file is the first of
// them, verbatim from §2:
//
//   "the handles (`witness endpoint`, authority identity, `checkpoint_id`,
//    preceding checkpoint id and quote time) must sit inside the signed
//    preimage, or an attacker who can rewrite an unsigned endpoint redirects
//    resolution to a service that will happily confirm anything — THE HANDLE
//    BECOMES THE ATTACK SURFACE THE PROOF USED TO CLOSE."
//
// Moving the proof out of the leaf is only safe if the pointer to the proof
// cannot be moved. So the five handles below are in the MAC preimage of all
// three implementations (`lib/leaf/componentPreimage.ts`,
// `services/scruple-capture/src/leaf.ts`, `server_library.py`), and this
// module holds the rules that stop a handle existing anywhere the preimage
// does not read.
//
// ---------------------------------------------------------------------------
// THE AUTHORITY IS NOT DECORATION ON THE URL
// ---------------------------------------------------------------------------
//
// Hand round 8, IT Expert, and it is the reason `witness_endpoint` alone was
// refused: "an endpoint field in the leaf is self-asserted by the emitter, so
// a compromised gate names its own witness — the field has to carry the
// witness's key/authority identity alongside the URL, or a verifier following
// it just gets A COOPERATING LIAR AT A VALID ADDRESS."
//
// The endpoint says WHERE. The authority says WHOSE SIGNATURE COUNTS when you
// get there. A `checkpoint_id` with no authority is therefore refused below:
// it is a claim that can only be resolved by trusting whoever answers.
//
// ---------------------------------------------------------------------------
// ABSENT IS null, NEVER OMITTED — AND THAT IS WHAT SIGNS THE ABSENCE
// ---------------------------------------------------------------------------
//
// The same discipline `close_detection` runs on. All five keys are always in
// the preimage; a component with no enrolled authority MACs `null` for it. The
// consequence is the one that matters: a party sitting between the component
// and the route cannot ADD a handle either, because adding one changes the
// canonical JSON and breaks the MAC. Stripping the block and adding a block
// are the same failure, and both are caught.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT HERE: THE LEAF INDEX AND THE LEAF HASH
// ---------------------------------------------------------------------------
//
// §1 lists "checkpoint identifier and leaf index/hash" among the handles, and
// neither is in this preimage. A component cannot sign what it does not yet
// know: the index is assigned by the checkpoint that has not been built at the
// time the MAC is computed, and the leaf hash is derived by the witness from
// the submission the MAC is over. Signing a placeholder for either would put a
// forgeable field in the preimage and call it covered.
//
// They belong to the checkpoint record, resolved through `checkpoint_id` — and
// WO-C6 has a bearing on the index specifically: a sorted-pair Merkle cannot
// bind an index at all, so `lib/scruple/merkle.ts` could not honour such a
// field today even if the leaf carried one. Recorded here rather than left as
// an apparent omission.
//
// ---------------------------------------------------------------------------
// WO-C3 — AND THE TWO THE BLOCK WAS BUILT TO TAKE
// ---------------------------------------------------------------------------
//
// WO-C2 reserved room here and this is it: `settlement_deadline` and
// `retention_policy_digest` are handles six and seven, in the same block and
// the same preimage, with no second block beside it.
//
// They are Architect's SECOND settle condition and the other half of the same
// argument. The first (WO-C2) says the pointer to the evidence must be signed
// or an attacker redirects it. The second says the pointer must also say HOW
// LONG THE THING POINTED AT WILL BE THERE:
//
//   "the `retention_policy_digest` must bind evidence RETENTION DURATION, not
//    just policy identity, so a resolution attempt after the evidence is
//    legitimately gone yields a named `evidence_expired` state rather than
//    being INDISTINGUISHABLE FROM A FORGED HANDLE."
//
// and, from hand round 7, the bound that stops silence being free:
//
//   "an unresolved gap that never expires is indistinguishable from a policy
//    of never checking — the verifier defaults to accept by exhaustion. The
//    bound must be CARRIED IN THE LEAF as a declared `settlement_deadline`
//    plus the retention policy digest in force."
//
// Both are in the MAC for the reason all five before them are: a deadline a
// proxy can push out is not a deadline, and a retention digest a proxy can
// swap for a longer-lived policy is not a retention binding. What the digest
// RESOLVES TO, and whether the deadline sits where a NAMED CLOCK puts it, are
// `lib/leaf/settlement.ts`'s — this file is shape and pairing, that file is
// the binding.

import { CHECKPOINT_VECTORS_SETTLED, CHECKPOINT_BLOCKER_REASON } from '@/lib/leaf/attestationBasis';
import { RETENTION_DIGEST_RE } from '@/lib/leaf/retentionPolicy';

/* ────────────────────────────────────────────────────────────────────────
 * The block.
 * ──────────────────────────────────────────────────────────────────────── */

export interface ResolutionHandles {
  /**
   * WHERE the evidence is resolved: the base URL of the checkpoint service
   * this leaf's proof must be fetched from. In this estate that is the same
   * /v2 API the leaf was submitted to, which fronts the witness.
   *
   * SELF-ASSERTED BY THE EMITTER, and the server does NOT overwrite it with
   * its own address. Rewriting it here would destroy the only evidence that a
   * compromised component named somewhere else — the receipt discloses what
   * the component signed, and a reader compares.
   */
  witness_endpoint: string | null;
  /**
   * WHOSE signature counts at that address. A key identity — in this estate
   * the witness's `leaf_signer_key_id`. null when no authority has been
   * enrolled with the component, which is a real state and not a default:
   * the leaf is then resolvable only by trusting whoever answers the URL, and
   * it may not claim a checkpoint (see rule 6).
   */
  witness_authority: string | null;
  /**
   * The checkpoint this leaf settles into. null until there is one — and
   * today it is null on every leaf, because no checkpoint can be claimed
   * settled by anybody (Appendix C item 0, rule 5 below).
   */
  checkpoint_id: string | null;
  /** The PRECEDING checkpoint — Architect's interval bound. */
  prev_checkpoint_id: string | null;
  /** And when that one was quoted. Half an interval is not an interval. */
  prev_checkpoint_quote_time: string | null;
  /**
   * WO-C3. WHEN SILENCE BECOMES A FINDING. An RFC 3339 UTC instant: at it, an
   * unresolved gap flips to a terminal `expired`, which is an assertion about
   * the COMPONENT'S DELIVERY and not about the leaf's validity.
   *
   * The component signs it because the component is what knows its own
   * settlement window — and it is CHECKED at ingest against the window the
   * named clock puts it in (`lib/leaf/settlement.ts`), because a deadline
   * derived from a locally-set timestamp is the config-inherited field class
   * the council refused. Signed claim, measured check.
   */
  settlement_deadline: string | null;
  /**
   * WO-C3. `sha256:<64 hex>` over the CANONICAL RETENTION POLICY OBJECT —
   * which contains the durations, not merely the policy's name. A digest over
   * an identity tells a verifier which document applied and nothing about when
   * the evidence stops existing, which leaves a legitimate expiry
   * indistinguishable from a forged handle. See lib/leaf/retentionPolicy.ts.
   */
  retention_policy_digest: string | null;
}

/** The block's key set, exactly. Anything else inside it is unsigned. */
export const RESOLUTION_HANDLE_KEYS = [
  'witness_endpoint',
  'witness_authority',
  'checkpoint_id',
  'prev_checkpoint_id',
  'prev_checkpoint_quote_time',
  // WO-C3. Appended rather than inserted — the preimage sorts by key anyway,
  // and appending keeps this list readable as a history of what the council
  // required when. Adding them CHANGES EVERY MAC, which is why all three
  // implementations and the shared vectors move in the same commit.
  'settlement_deadline',
  'retention_policy_digest',
] as const;

export type ResolutionHandleKey = (typeof RESOLUTION_HANDLE_KEYS)[number];

/** How each handle is spelled INSIDE the MAC preimage. */
export const resolutionPreimageKey = (k: ResolutionHandleKey): string => `resolution_${k}`;

/**
 * The seven fields, flattened for the preimage. Prefixed rather than merged
 * bare, so a handle can never collide with a capture field and so the
 * canonical JSON says which block a key came from.
 *
 * ALWAYS SEVEN KEYS. `resolution` absent produces seven nulls, which is what
 * makes "this leaf named no witness and no deadline" a signed statement
 * rather than a gap.
 */
export function resolutionPreimageFields(
  r: Partial<ResolutionHandles> | null | undefined,
): Record<string, string | null> {
  const h = r ?? {};
  const out: Record<string, string | null> = {};
  for (const k of RESOLUTION_HANDLE_KEYS) {
    const v = h[k];
    out[resolutionPreimageKey(k)] = v == null ? null : String(v);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * The validator.
 * ──────────────────────────────────────────────────────────────────────── */

export type ResolutionHandleCode =
  | 'resolution_handles_unsigned'
  | 'resolution_handles_required'
  | 'resolution_handles_refused';

export interface ResolutionRefusal {
  ok: false;
  code: ResolutionHandleCode;
  message: string;
  detail: Record<string, unknown>;
}

export interface ResolutionAccepted {
  ok: true;
  /** null when the submission carries no handles: a legacy leaf. */
  handles: ResolutionHandles | null;
}

export type ResolutionResult = ResolutionAccepted | ResolutionRefusal;

/**
 * Every place a handle could be smuggled in where the preimage does not read
 * it. This is the list the control in `test/v2/resolution-handles.test.ts`
 * fires at, and each entry was ACCEPTED with a 201 before this file existed —
 * recorded in `01-controls-RED.txt`.
 *
 * `component` is included because it is the one other object on the
 * submission whose keys the preimage reads selectively: `component_id`,
 * `counter`, `build_measurement` and `attestation.provider` enter the MAC and
 * nothing else does, so a handle parked beside them looks signed and is not.
 */
const UNSIGNED_SITES = ['capture', 'component'] as const;

function handleSitesOutsideTheBlock(body: Record<string, unknown>): Array<{ at: string }> {
  const found: Array<{ at: string }> = [];
  for (const k of RESOLUTION_HANDLE_KEYS) {
    if (k in body) found.push({ at: k });
  }
  for (const site of UNSIGNED_SITES) {
    const o = body[site];
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const rec = o as Record<string, unknown>;
    for (const k of RESOLUTION_HANDLE_KEYS) {
      if (k in rec) found.push({ at: `${site}.${k}` });
    }
    if ('resolution' in rec) found.push({ at: `${site}.resolution` });
  }
  return found;
}

/**
 * An endpoint a verifier is expected to FOLLOW, so the shapes that make
 * following one dangerous are refused rather than stored.
 *
 * Embedded credentials are the sharp one: `http://attacker:pw@host/` reads as
 * `host` to a human and sends the userinfo to whatever the URL parser decides
 * the host is. A fragment or a query on a base URL is the same class of trick
 * one layer down — the handle is a BASE the verifier appends a path to, and a
 * base carrying `?` or `#` silently rewrites what it appends.
 */
function endpointRefusal(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'it is not an absolute URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `its scheme is \`${u.protocol.replace(':', '')}\`, and a verifier resolves evidence over http or https`;
  }
  if (u.username !== '' || u.password !== '') {
    return 'it carries embedded credentials, which read as part of the hostname to a person and are not';
  }
  if (u.search !== '' || u.hash !== '') {
    return 'it carries a query or a fragment, and this handle is a BASE a verifier appends a path to';
  }
  if (u.hostname === '') return 'it names no host';
  return null;
}

/** Strict UTC instant. A local timestamp is a clock nobody named. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export function validateResolutionHandles(
  body: Record<string, unknown>,
  opts: { vectorsSettled?: boolean } = {},
): ResolutionResult {
  const settled = opts.vectorsSettled ?? CHECKPOINT_VECTORS_SETTLED;

  // ---- Rule 1 — a handle outside the signed block is refused, not read.
  //
  // Checked FIRST and against the RAW body, for the reason WO-C1 found the
  // hard way one file over: zod strips undeclared top-level keys, so a rule
  // written against the parsed body cannot see the field it is about.
  //
  // The refusal matters more than it looks. Storing such a handle would give a
  // reader a witness endpoint that nothing signed, in a leaf that otherwise
  // carries signed ones — which is precisely the redirect Architect's
  // condition exists to prevent, dressed as a field that looks the same.
  const stray = handleSitesOutsideTheBlock(body);
  if (stray.length > 0) {
    return {
      ok: false,
      code: 'resolution_handles_unsigned',
      message:
        'A resolution handle was sent outside the signed `resolution` block. The handles are ' +
        'only handles because they are inside the MAC preimage: moving the proof out of the ' +
        'leaf made the pointer to the proof security-critical, and an attacker who can rewrite ' +
        'an unsigned endpoint redirects resolution to a service that will confirm anything. ' +
        'Send them as the top-level `resolution` object, which every implementation of the ' +
        'preimage reads, and nowhere else.',
      detail: { unsigned_sites: stray.map((s) => s.at), signed_block: 'resolution' },
    };
  }

  const rawBlock = body.resolution;
  const hasBlock = rawBlock !== undefined && rawBlock !== null;
  const capture =
    body.capture && typeof body.capture === 'object' && !Array.isArray(body.capture)
      ? (body.capture as Record<string, unknown>)
      : null;

  if (!hasBlock) {
    // ---- Rule 2 — a leaf emitted under this design must say where its
    // evidence resolves. The `capture` block is the boundary, the same one
    // `captureClaims.ts` uses: canvas, the desktop plugins and every
    // component-less caller predate this design and are untouched.
    //
    // The endpoint and the authority are knowable at emission — the component
    // is configured with them — so a capture-bearing leaf that names neither
    // is a leaf whose proof nobody can find, and the checkpoint half stays
    // nullable because there is no checkpoint yet to name.
    if (capture) {
      return {
        ok: false,
        code: 'resolution_handles_required',
        message:
          'A leaf carrying a `capture` block must carry a `resolution` block: the witness ' +
          'endpoint its evidence resolves against, the authority identity whose signature ' +
          'counts there, and — WO-C3 — the settlement deadline at which its silence becomes a ' +
          'finding together with the retention policy digest that says how long the evidence ' +
          'will be there to fetch. The Merkle path and the raw quote are deliberately NOT in ' +
          'the leaf — they are resolved out of band — which is only tenable if the leaf says ' +
          'where to resolve them, and for how long that will work. `checkpoint_id`, ' +
          '`prev_checkpoint_id` and `prev_checkpoint_quote_time` may be null; the other four ' +
          'may not.',
        detail: { required: RESOLUTION_HANDLE_KEYS },
      };
    }
    return { ok: true, handles: null };
  }

  if (typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
    return {
      ok: false,
      code: 'resolution_handles_refused',
      message: '`resolution` must be an object carrying exactly the five handle fields.',
      detail: { received: typeof rawBlock },
    };
  }
  const block = rawBlock as Record<string, unknown>;

  // ---- Rule 3 — the block's key set is EXACTLY the preimage's key set.
  //
  // An unrecognised key inside `resolution` is the same defect as a handle at
  // the top level, one level less obvious: it sits in the block a reader
  // trusts and no implementation of the preimage reads it. Refused rather
  // than ignored, so a sixth handle cannot be introduced by a caller ahead of
  // being introduced into the MAC.
  const unknown = Object.keys(block).filter(
    (k) => !(RESOLUTION_HANDLE_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      code: 'resolution_handles_unsigned',
      message:
        'The `resolution` block carries a key no implementation of the MAC preimage reads, so ' +
        'it would sit inside the block a reader trusts while being covered by nothing. The ' +
        'block is exactly the signed field set: adding a handle means adding it to the ' +
        'preimage in all three implementations and to the shared vectors, not to the wire.',
      detail: { unsigned_keys: unknown, signed_keys: RESOLUTION_HANDLE_KEYS },
    };
  }

  for (const k of RESOLUTION_HANDLE_KEYS) {
    const v = block[k];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      return {
        ok: false,
        code: 'resolution_handles_refused',
        message:
          `\`resolution.${k}\` must be a string or null. Every handle enters the MAC preimage, ` +
          'and the preimage admits strings, safe integers, booleans and null only — a handle ' +
          'that cannot be canonicalised identically in two languages is a handle that ' +
          'authenticates differently in each.',
        detail: { field: k, received: typeof v },
      };
    }
    if (typeof v === 'string' && v.trim() === '') {
      return {
        ok: false,
        code: 'resolution_handles_refused',
        message:
          `\`resolution.${k}\` is an empty string. Send null to say there is none — an empty ` +
          'string is a value that reads as present and resolves to nothing.',
        detail: { field: k },
      };
    }
  }

  const handles: ResolutionHandles = {
    witness_endpoint: (block.witness_endpoint as string | null | undefined) ?? null,
    witness_authority: (block.witness_authority as string | null | undefined) ?? null,
    checkpoint_id: (block.checkpoint_id as string | null | undefined) ?? null,
    prev_checkpoint_id: (block.prev_checkpoint_id as string | null | undefined) ?? null,
    prev_checkpoint_quote_time:
      (block.prev_checkpoint_quote_time as string | null | undefined) ?? null,
    settlement_deadline: (block.settlement_deadline as string | null | undefined) ?? null,
    retention_policy_digest:
      (block.retention_policy_digest as string | null | undefined) ?? null,
  };

  // ---- Rule 4 — the handles are only handles when they are SIGNED.
  //
  // A submission with no component envelope and no MAC has nothing over it.
  // Accepting a `resolution` block there would store an unsigned endpoint in
  // the same column as a signed one, and no reader downstream could tell them
  // apart — which is the whole of Architect's condition, defeated by an
  // omission rather than by an attack.
  const signed = Boolean(body.component) && typeof body.mac === 'string';
  if (!signed) {
    return {
      ok: false,
      code: 'resolution_handles_unsigned',
      message:
        'A `resolution` block was sent on a submission with no component envelope and MAC. ' +
        'The handles are security-critical precisely because the proof is not in the leaf, and ' +
        'their protection is the ratchet MAC that covers them. An unsigned handle is an ' +
        'assertion by whoever sent it, stored in the field a verifier follows.',
      detail: { has_component: Boolean(body.component), has_mac: typeof body.mac === 'string' },
    };
  }

  if (handles.witness_endpoint === null) {
    return {
      ok: false,
      code: 'resolution_handles_required',
      message:
        '`resolution.witness_endpoint` is null. A leaf that names no witness cannot have its ' +
        'evidence resolved by anybody, and the whole claims-versus-evidence split depends on ' +
        'the leaf saying where its proof is obtained.',
      detail: { field: 'witness_endpoint' },
    };
  }
  const badEndpoint = endpointRefusal(handles.witness_endpoint);
  if (badEndpoint) {
    return {
      ok: false,
      code: 'resolution_handles_refused',
      message:
        `\`resolution.witness_endpoint\` is refused because ${badEndpoint}. This handle is a ` +
        'URL a verifier is expected to follow, so the shapes that make following one dangerous ' +
        'are refused at ingest rather than stored and followed later.',
      detail: { witness_endpoint: handles.witness_endpoint, reason: badEndpoint },
    };
  }

  // ---- Rule 5 (WO-C3) — a deadline and a retention policy are ONE FACT.
  //
  // A `settlement_deadline` with no `retention_policy_digest` is a moment
  // stated against no policy: a verifier learns when to start worrying and
  // nothing about whether the evidence will still be there to look at. A
  // digest with no deadline is the mirror — a retention window with no point
  // at which silence becomes a finding, which is Architect's "indistinguishable
  // from a policy of never checking" restated as a missing field.
  const deadline = handles.settlement_deadline;
  const retention = handles.retention_policy_digest;
  if ((deadline === null) !== (retention === null)) {
    return {
      ok: false,
      code: 'resolution_handles_refused',
      message:
        '`settlement_deadline` and `retention_policy_digest` are present together or not at ' +
        'all. The deadline says when this leaf\'s silence becomes a finding; the digest says ' +
        'how long the evidence that would settle it is kept. A deadline without a retention ' +
        'binding is a finding nobody can check, and a retention binding without a deadline is a ' +
        'window with no moment in it.',
      detail: { settlement_deadline: deadline, retention_policy_digest: retention },
    };
  }
  if (deadline !== null && !INSTANT.test(deadline)) {
    return {
      ok: false,
      code: 'resolution_handles_refused',
      message:
        '`settlement_deadline` must be an RFC 3339 UTC instant ending in `Z`. A local-offset ' +
        'timestamp is a deadline against a clock nobody named, which is precisely the ' +
        'config-inherited field class this design refuses — and this field is the one the ' +
        'council applied that rule to by name.',
      detail: { settlement_deadline: deadline },
    };
  }
  if (retention !== null && !RETENTION_DIGEST_RE.test(retention)) {
    return {
      ok: false,
      code: 'resolution_handles_refused',
      message:
        '`retention_policy_digest` must be `sha256:` followed by 64 lowercase hex characters — ' +
        'the digest of the CANONICAL RETENTION POLICY OBJECT, which contains the durations. A ' +
        'policy name, a URL or a version string in this field would bind an identity and no ' +
        'duration, which is the shape the council refused.',
      detail: { retention_policy_digest: retention },
    };
  }

  // ---- Rule 6 (WO-C3) — a capture-bearing leaf must name BOTH.
  //
  // Rule 2 catches a leaf with no block at all. This catches the block that is
  // present and hollow: a leaf that observed something, says where its
  // evidence lives, and never says when its absence becomes a finding. That
  // leaf is the "accept by exhaustion" case — a verifier holding it waits
  // forever, correctly, and learns nothing.
  if (capture && (deadline === null || retention === null)) {
    return {
      ok: false,
      code: 'resolution_handles_required',
      message:
        'A leaf carrying a `capture` block must declare `settlement_deadline` and ' +
        '`retention_policy_digest`. An unresolved gap that never expires is indistinguishable ' +
        'from a policy of never checking, and a handle with no retention duration leaves a ' +
        'legitimate expiry indistinguishable from a forged handle. Both are the council\'s ' +
        'words, and both are about a leaf exactly like this one.',
      detail: {
        settlement_deadline: deadline,
        retention_policy_digest: retention,
        required: ['settlement_deadline', 'retention_policy_digest'],
      },
    };
  }

  // ---- Rule 7 — an interval has two ends.
  const prevId = handles.prev_checkpoint_id;
  const prevAt = handles.prev_checkpoint_quote_time;
  if ((prevId === null) !== (prevAt === null)) {
    return {
      ok: false,
      code: 'resolution_handles_refused',
      message:
        '`prev_checkpoint_id` and `prev_checkpoint_quote_time` are present together or not at ' +
        'all. They are one fact — the preceding checkpoint AND when it was quoted — and it is ' +
        'the interval bound Architect asked be carried on the leaf rather than left to policy. ' +
        'Half of it bounds nothing.',
      detail: { prev_checkpoint_id: prevId, prev_checkpoint_quote_time: prevAt },
    };
  }
  if (prevAt !== null && !INSTANT.test(prevAt)) {
    return {
      ok: false,
      code: 'resolution_handles_refused',
      message:
        '`prev_checkpoint_quote_time` must be an RFC 3339 UTC instant ending in `Z`. A ' +
        'local-offset or partial timestamp is a bound against a clock nobody named, which is ' +
        'the config-inherited field class this design already refuses elsewhere.',
      detail: { prev_checkpoint_quote_time: prevAt },
    };
  }

  // ---- Rule 8 — a checkpoint you cannot resolve against anyone.
  if (handles.checkpoint_id !== null && handles.witness_authority === null) {
    return {
      ok: false,
      code: 'resolution_handles_refused',
      message:
        'A `checkpoint_id` was named with no `witness_authority`. The endpoint is self-asserted ' +
        'by the emitter, so a compromised component names its own witness; the authority ' +
        'identity is what stops a verifier who follows the URL from getting a cooperating liar ' +
        'at a valid address. A checkpoint with no authority is a claim resolvable only by ' +
        'trusting whoever answers.',
      detail: { checkpoint_id: handles.checkpoint_id, witness_authority: null },
    };
  }

  // ---- Rule 9 — and no checkpoint may be named while the blocker stands.
  //
  // The same constant WO-C1's rule 4 reads, applied to the other half of the
  // claim. `attestation_status: stale` says this leaf's checkpoint cannot be
  // claimed settled; a `checkpoint_id` beside it names the checkpoint anyway,
  // and a reader who follows the handle finds a root whose algorithm depends
  // on which caller last spoke to the witness. WO-C6 lifts both together.
  if (!settled && handles.checkpoint_id !== null) {
    return {
      ok: false,
      code: 'resolution_handles_refused',
      message:
        'A leaf emitted today may not name a `checkpoint_id`. Because ' + CHECKPOINT_BLOCKER_REASON,
      detail: {
        checkpoint_id: handles.checkpoint_id,
        required: null,
        checkpoint_vectors_settled: settled,
      },
    };
  }

  return { ok: true, handles };
}
