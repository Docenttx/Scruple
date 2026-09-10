// `imported_datablocks` — what entered this document from outside, and that
// nobody here watched it arrive.
//
// WO-F3, closing WO-E7 finding E7-1 (`docs/STATE.md` §4.7), which is the
// finding the E series ends on. Two Blender scenes built around two DIFFERENT
// AI images produced two leaves that were identical in every field capable of
// describing how the artifact came to exist. Nothing on those leaves was
// FALSE; the claim was ABSENT, and absence and "there was nothing" read the
// same. `lib/db/migrations/060_imported_datablocks.sql` carries the product
// decision and why the other two candidates were refused.
//
// WHAT THIS FIELD ASSERTS, IN ONE SENTENCE
//
//   These datablocks entered this document from outside it, here are the
//   digests of their bytes, and the party that produced this leaf did not
//   observe how they came to exist.
//
// WHAT IT DOES NOT ASSERT, AND THE DISTINCTION IS THE WHOLE VALUE:
//
//   * NOT that an AI made them. Nothing here knows that, and a field that
//     implied it would be the false claim E7-1 was careful to say this defect
//     is not.
//   * NOT that the list is a closure over everything foreign in the document.
//     It is a closure over THE DATABLOCK TYPES IT ENUMERATED, which is why
//     `datablock_types` rides in the document and is covered by the digest.
//     WO-E2's rule, one field over: the completeness of a set is itself a fact
//     and needs a scope.
//   * NOT byte coverage of the step that produced them. That is
//     `host_semantics` (058), it means "a gate saw every byte and could not
//     read them", and asserting it from a product with no gate would be a
//     capture claim for a capture path that does not exist.
//
// ⚑ WHY THE SCALARS ARE TOP-LEVEL AND NOT `capture` FIELDS.
//
// `capture` is what a CAPTURE COMPONENT observed, and `captureClaims.ts`
// rightly requires any capture-bearing leaf to declare an attestation basis, a
// profile, a storage confinement, an upstream epoch and a host level. The
// product this field exists for — the standalone Blender add-on — is a plugin
// with no component and no gate anywhere in its path: it has none of those
// five to declare, and putting this field inside `capture` would force it to
// invent all five in order to say one true thing. So these sit at the
// submission root beside `machine_manifest_hash`, and `componentPreimage()`
// reads them from there. They are in the MAC either way; what changes is
// whether a plugin has to pretend to be a gate to reach it.
//
// The mirror-image mistakes are both refused below: the scalars sent DOWN into
// `capture` (where the preimage does not read them, and the leaf would carry
// no declaration at all) and the document sent down there too (where nothing
// would hash it).

import { canonicalize } from '@/lib/leaf/canonicalJson';
import { sha256Hex } from '@/lib/scruple/hash';

/** `imported_datablocks_source`. How the set was obtained. */
export const HOST_DATABLOCKS = 'host_datablocks';
export const SOURCE_NONE = 'none';
export const IMPORTED_SOURCES = [HOST_DATABLOCKS, SOURCE_NONE] as const;
export type ImportedDatablocksSource = (typeof IMPORTED_SOURCES)[number];

export function isImportedDatablocksSource(v: unknown): v is ImportedDatablocksSource {
  return typeof v === 'string' && (IMPORTED_SOURCES as readonly string[]).includes(v);
}

/**
 * ⚑ WHETHER ANY DOOR IN THIS ESTATE CAN CLAIM IT WATCHED AN IMPORT ARRIVE.
 *
 * `false`, and the affirmative is REFUSED rather than downgraded — the shape
 * WO-C1 uses for `verified` and WO-E2 for `uncaptured_scope_source: measured`.
 * The reason is not that observing an import is impossible in principle; it is
 * that no door here does it. The add-on sees `bpy.data` after the fact, the
 * component sees files appearing in a volume, and neither watched the bytes
 * being made. A leaf that could carry `imported_origin_observed: 1` on that
 * evidence would be asserting exactly the coverage this field exists to deny.
 *
 * It is POLICY and it lives here, not in migration 060's CHECK, so the day a
 * door genuinely observes an import — a bridge that hashes what it hands to
 * Blender, say — the value moves without a schema change. 060 admits both
 * values because the column has to be able to hold the answer.
 */
export const IMPORTED_ORIGIN_OBSERVER = false;
export const IMPORTED_ORIGIN_BLOCKER_REASON =
  'no door in this estate observes an import: the add-on enumerates `bpy.data` after the ' +
  'fact and the capture component sees a file appear in a volume, so neither watched the ' +
  'bytes being produced. Declare 0 — which is the assertion this field exists to make.';

/**
 * The `kind` under which the declaration's digest enters the run's input
 * manifest, and therefore `input_hash`, and therefore the witness's leaf.
 *
 * ⚑ THIS IS HOW A DIGEST MOVES THE LEAF HASH. The five scalars are in the
 * ratchet MAC, which binds them for a submission that carries a component — and
 * the product this field was built for carries none. What binds it there is the
 * leaf itself: the witness's canonical record hashes `input_hash` (v2 and v2.2
 * alike), so folding the declaration's digest into the input manifest makes a
 * changed digest a changed leaf hash, and the leaf hash is what the witness
 * signs. The alternative — a new field in the witness's record — is a change to
 * a process this series may not touch, and it would leave every leaf written
 * before it unable to express the same fact.
 *
 * Reserved: a caller may not send an input ref under this kind itself
 * (`imported_datablocks_refused`), because a hand-supplied one would be
 * indistinguishable in the preimage from the fold the route performs.
 */
export const IMPORTED_DATABLOCKS_INPUT_KIND = 'imported_datablocks';

/** One datablock that entered the document from outside it. */
export interface ImportedDatablock {
  /** The host's own name for it. Blender: the datablock name in `bpy.data`. */
  datablock: string;
  /** Which datablock table it came out of — `image`, `library`, `sound`. */
  type: string;
  /** The host's own word for where it came from. Blender: `Image.source`. */
  origin: string;
  packed: boolean;
  /** BASENAME ONLY. A leaf is not the place for a user's directory layout. */
  filename: string | null;
  bytes: number | null;
  /** sha256 of the bytes. Null exactly when `unreadable` is set. */
  digest: string | null;
  /** WHICH bytes were hashed, so a verifier knows what to re-hash. */
  digest_of: string | null;
  /** Why there is no digest. Null exactly when `digest` is set. */
  unreadable: string | null;
}

/** The document. Top-level in the submission; only its digest is signed. */
export interface ImportedDatablocksDocument {
  source: ImportedDatablocksSource;
  origin_observed: boolean;
  /** THE SCOPE THE ENUMERATION RANGED OVER. Never empty on an enumerated set. */
  datablock_types: string[];
  datablocks: ImportedDatablock[];
}

/** The signed half, as the route stores it. */
export interface ImportedDatablocksClaims {
  source: ImportedDatablocksSource;
  /** null exactly when `source` is 'none'. */
  originObserved: boolean | null;
  /** 0 is a count. null exactly when `source` is 'none'. */
  count: number | null;
  unreadableCount: number | null;
  hash: string | null;
  /** The canonical bytes that were hashed. null when there is no document. */
  json: string | null;
}

export type ImportedDatablocksCode =
  | 'imported_datablocks_required'
  | 'imported_datablocks_refused';

export interface ImportedDatablocksRefusal {
  ok: false;
  code: ImportedDatablocksCode;
  message: string;
  detail: Record<string, unknown>;
}

export interface ImportedDatablocksAccepted {
  ok: true;
  /** null when the submission said nothing: the question was never asked. */
  declaration: ImportedDatablocksClaims | null;
}

export type ImportedDatablocksResult = ImportedDatablocksAccepted | ImportedDatablocksRefusal;

/** The five signed scalars, by their wire names. Named once. */
export const IMPORTED_SCALAR_KEYS = [
  'imported_datablocks_source',
  'imported_origin_observed',
  'imported_datablocks_count',
  'imported_datablocks_unreadable_count',
  'imported_datablocks_hash',
] as const;

const HEX64 = /^[0-9a-f]{64}$/;

/** The canonical bytes and the digest, from one function so nobody has two. */
export function hashImportedDatablocks(doc: Record<string, unknown>): {
  json: string;
  hash: string;
} {
  const json = canonicalize(doc);
  return { json, hash: sha256Hex(json) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function nonNegInt(v: unknown): number | null | false {
  if (v === undefined || v === null) return null;
  return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : false;
}

/**
 * VALIDATE THE DECLARATION, from the RAW json.
 *
 * Raw and not the parsed body, for the reason `validateResolutionHandles` and
 * `validateCaptureClaims` both read raw: zod strips undeclared top-level keys,
 * so a rule about a field sent where the preimage does not read it cannot see
 * the very key it is about.
 *
 * Refuses content and writes nothing, so it belongs above every write in the
 * route — a refused declaration must leave no row, which is the difference
 * between a validator and a comment.
 */
export function validateImportedDatablocks(
  body: Record<string, unknown>,
  opts: { originObserver?: boolean } = {},
): ImportedDatablocksResult {
  const capture = isPlainObject(body.capture) ? body.capture : null;

  const refuse = (
    message: string,
    detail: Record<string, unknown>,
    code: ImportedDatablocksCode = 'imported_datablocks_refused',
  ): ImportedDatablocksRefusal => ({ ok: false, code, message, detail });

  // ---- the two misplacements, both of which look like a signed declaration
  // ---- and are not ---------------------------------------------------------
  if (capture) {
    const misplaced = IMPORTED_SCALAR_KEYS.filter((k) => k in capture);
    if (misplaced.length > 0) {
      return refuse(
        `${misplaced.join(', ')} sent inside \`capture\`. These are SUBMISSION fields, not ` +
          'capture fields: `componentPreimage()` reads them from the submission root beside ' +
          '`machine_manifest_hash`, so a copy one level down is outside the MAC while looking ' +
          'exactly like a signed declaration. They are top-level on purpose — the product ' +
          'this field exists for is a plugin with no capture block at all, and a `capture` ' +
          'block obliges it to declare an attestation basis, a profile, a confinement, an ' +
          'upstream epoch and a host level it has no way to observe.',
        { misplaced: misplaced.map((k) => `capture.${k}`) },
      );
    }
    if ('imported_datablocks' in capture) {
      return refuse(
        '`imported_datablocks` sent inside `capture`. The document is top-level, like ' +
          '`model_fingerprints`, `host_evidence` and `declared_uncaptured`: the route ' +
          'recomputes `imported_datablocks_hash` from the top-level document, so a copy ' +
          'inside `capture` would never be hashed and the signed digest would cover nothing.',
        { at: 'capture.imported_datablocks' },
      );
    }
  }

  const source = body.imported_datablocks_source;
  const originRaw = body.imported_origin_observed;
  const hashRaw = body.imported_datablocks_hash;
  const doc = body.imported_datablocks;

  const anyPresent =
    IMPORTED_SCALAR_KEYS.some((k) => body[k] !== undefined) || doc !== undefined;

  // Nothing said. The question was never asked of this leaf, which is NULL
  // across all five columns and is a different fact from `source: 'none'`.
  if (!anyPresent) return { ok: true, declaration: null };

  if (!isImportedDatablocksSource(source)) {
    return refuse(
      'A submission that declares anything about imported datablocks must declare ' +
        '`imported_datablocks_source` as "host_datablocks" or "none". Received ' +
        `${JSON.stringify(source ?? null)}. A list of digests with no statement of how it ` +
        'was obtained is a coverage claim nobody made — and a submission that says nothing ' +
        'at all is fine, and is what every leaf written before this field says.',
      { imported_datablocks_source: source ?? null },
      'imported_datablocks_required',
    );
  }

  const count = nonNegInt(body.imported_datablocks_count);
  const unreadable = nonNegInt(body.imported_datablocks_unreadable_count);
  if (count === false || unreadable === false) {
    return refuse(
      '`imported_datablocks_count` and `imported_datablocks_unreadable_count` must each be a ' +
        'non-negative safe integer or absent. A float in the MAC preimage is a MAC that ' +
        'fails unreproducibly and only sometimes (§10 C-1), and a negative cardinality is ' +
        'not a set.',
      {
        imported_datablocks_count: body.imported_datablocks_count ?? null,
        imported_datablocks_unreadable_count: body.imported_datablocks_unreadable_count ?? null,
      },
    );
  }
  const hash = typeof hashRaw === 'string' ? hashRaw : null;
  if (hashRaw !== undefined && (hash === null || !HEX64.test(hash))) {
    return refuse('`imported_datablocks_hash` must be 64 lowercase hex characters.', {
      imported_datablocks_hash: hashRaw ?? null,
    });
  }
  const originObserved =
    originRaw === undefined || originRaw === null ? null : originRaw === true ? true
    : originRaw === false ? false : 'bad';
  if (originObserved === 'bad') {
    return refuse(
      '`imported_origin_observed` must be a boolean or absent. It is the answer to "did the ' +
        'party that produced this leaf watch these assets arrive", and a string or a number ' +
        'there is not an answer.',
      { imported_origin_observed: originRaw ?? null },
    );
  }

  // ---- `none`: nothing was enumerated, so there is nothing to have counted,
  // ---- hashed, listed or observed -----------------------------------------
  if (source === SOURCE_NONE) {
    if (count !== null || unreadable !== null || hash !== null || doc !== undefined || originObserved !== null) {
      return refuse(
        '`imported_datablocks_source: "none"` with a count, a digest, a document or an ' +
          'origin answer is refused. "None" means no enumeration was performed: there is no ' +
          'set to count, no digest of one, and nothing to say about where its members came ' +
          'from. If the host enumerated its datablocks and nothing had come from outside, ' +
          'the value for that is a count of 0 with `source: "host_datablocks"` — AN EMPTY ' +
          'DECLARATION THAT IS PRESENT, which is a different fact from an absent one.',
        {
          imported_datablocks_source: source,
          imported_datablocks_count: count,
          imported_datablocks_unreadable_count: unreadable,
          imported_datablocks_hash: hash,
          imported_origin_observed: originObserved,
          document: doc === undefined ? 'absent' : 'present',
        },
      );
    }
    return {
      ok: true,
      declaration: {
        source,
        originObserved: null,
        count: null,
        unreadableCount: null,
        hash: null,
        json: null,
      },
    };
  }

  // ---- `host_datablocks`: ⚑ THE EMPTY-DECLARATION-IS-PRESENT RULE ---------
  if (count === null || unreadable === null || hash === null || originObserved === null) {
    return refuse(
      `\`imported_datablocks_source: "${source}"\` with ` +
        `${count === null ? 'no count' : 'a count'}, ` +
        `${unreadable === null ? 'no unreadable count' : 'an unreadable count'}, ` +
        `${hash === null ? 'no digest' : 'a digest'} and ` +
        `${originObserved === null ? 'no origin answer' : 'an origin answer'} is refused. An ` +
        'enumerated set always carries its cardinality, the cardinality of the part it could ' +
        'not read, the digest of its document, and the answer to whether anybody watched its ' +
        'members arrive — AND 0 IS A CARDINALITY. Null is the absence of one, which is ' +
        '"nothing enumerated", and that state is spelled `source: "none"`. Collapsing the two ' +
        'would make "looked, and nothing came from outside" unreadable, which is the ' +
        'distinction this field exists to hold open.',
      {
        imported_datablocks_source: source,
        imported_datablocks_count: count,
        imported_datablocks_unreadable_count: unreadable,
        imported_datablocks_hash: hash,
        imported_origin_observed: originObserved,
      },
      'imported_datablocks_required',
    );
  }
  if (unreadable > count) {
    return refuse(
      '`imported_datablocks_unreadable_count` is greater than ' +
        '`imported_datablocks_count`. The unreadable members are a SUBSET of the declared ' +
        'ones; a leaf that could not read more datablocks than it declared has counted ' +
        'something other than what it listed.',
      { imported_datablocks_count: count, imported_datablocks_unreadable_count: unreadable },
    );
  }

  // ⚑ THE NAMED BLOCKER. Refused rather than downgraded, and derived from a
  // flag rather than hardcoded, so it lifts without a schema change.
  const observer = opts.originObserver ?? IMPORTED_ORIGIN_OBSERVER;
  if (originObserved && !observer) {
    return refuse(
      '`imported_origin_observed: true` is refused today, and this is a refusal rather than a ' +
        `downgrade. Because ${IMPORTED_ORIGIN_BLOCKER_REASON}`,
      { imported_origin_observed: true, origin_observer: observer },
    );
  }

  // ---- the document, and its agreement with the signed half ---------------
  if (doc === undefined) {
    return refuse(
      '`imported_datablocks_source: "host_datablocks"` was sent with no `imported_datablocks` ' +
        'document. The digest is signed and the document is not, so a leaf carrying the ' +
        'digest alone commits to a set no verifier can ever read — the bare hole this field ' +
        'exists to close, wearing a signature.',
      { imported_datablocks_hash: hash },
    );
  }
  if (!isPlainObject(doc)) {
    return refuse('`imported_datablocks` must be an object.', { got: typeof doc });
  }

  const list = doc.datablocks;
  const types = doc.datablock_types;
  if (!Array.isArray(list) || !Array.isArray(types) || types.length === 0 ||
      types.some((t) => typeof t !== 'string' || t.length === 0)) {
    return refuse(
      '`imported_datablocks` must carry `datablocks` (an array) and `datablock_types` (a ' +
        'non-empty array of the datablock tables that were enumerated). The types are THE ' +
        'SCOPE THE SET RANGED OVER: without them "no imports" cannot be told apart from "no ' +
        'imports of the one kind anybody looked at", which is WO-E2\'s rule applied to a ' +
        'document instead of to a history ring.',
      { datablocks: Array.isArray(list) ? list.length : null, datablock_types: types ?? null },
    );
  }

  // The document repeats the two claims the scalars carry, and they must agree:
  // the scalars are signed and the document is not, so a disagreement is a
  // party in the middle having rewritten one of the two halves.
  if (doc.source !== source || doc.origin_observed !== originObserved) {
    return refuse(
      'The `imported_datablocks` document disagrees with the signed scalars about its own ' +
        'source or about whether anybody observed the import. The scalars are inside the MAC ' +
        'and the document is not; accepting a pair that disagrees would sign one claim and ' +
        'store another.',
      {
        document: { source: doc.source ?? null, origin_observed: doc.origin_observed ?? null },
        signed: { imported_datablocks_source: source, imported_origin_observed: originObserved },
      },
    );
  }

  let unreadableSeen = 0;
  for (const [i, e] of list.entries()) {
    if (!isPlainObject(e)) {
      return refuse('every member of `datablocks` must be an object.', { at: i });
    }
    const named = typeof e.datablock === 'string' && e.datablock.length > 0;
    const typed = typeof e.type === 'string' && e.type.length > 0;
    if (!named || !typed) {
      return refuse(
        'every declared datablock must carry a non-empty `datablock` name and a `type`. A ' +
          'digest with nothing to attribute it to is not a declaration.',
        { at: i, datablock: e.datablock ?? null, type: e.type ?? null },
      );
    }
    const d = typeof e.digest === 'string' ? e.digest : null;
    const u = typeof e.unreadable === 'string' && e.unreadable.length > 0 ? e.unreadable : null;
    if (d !== null && !HEX64.test(d)) {
      return refuse('a datablock digest must be 64 lowercase hex characters.', {
        at: i,
        datablock: e.datablock,
        digest: e.digest ?? null,
      });
    }
    // ⚑ EXACTLY ONE OF THE TWO, and this is control (b) of the work order in
    // one line. A datablock whose bytes cannot be read is RECORDED AS
    // UNREADABLE, never omitted and never given a digest of something else: an
    // omitted member would make an unreadable import look like no import, and
    // WO-D3's rule is that the refusal keeps the member and refuses only the
    // claim.
    if ((d === null) === (u === null)) {
      return refuse(
        `datablock "${String(e.datablock)}" declares ` +
          `${d === null ? 'neither a digest nor a reason it has none' : 'both a digest and a reason it has none'}` +
          '. Exactly one: a digest is what the bytes were, an `unreadable` reason is why ' +
          'there are none to hash, and both together is a claim about bytes nobody read.',
        { at: i, datablock: e.datablock, digest: d, unreadable: e.unreadable ?? null },
      );
    }
    if (d !== null && (typeof e.digest_of !== 'string' || e.digest_of.length === 0)) {
      return refuse(
        `datablock "${String(e.datablock)}" carries a digest with no \`digest_of\`. A ` +
          'verifier re-hashing this needs to know WHICH bytes were hashed — the packed copy ' +
          'inside the document, or the file the datablock points at.',
        { at: i, datablock: e.datablock },
      );
    }
    const b = nonNegInt(e.bytes);
    if (b === false) {
      return refuse('`bytes` must be a non-negative safe integer or null.', {
        at: i,
        datablock: e.datablock,
        bytes: e.bytes ?? null,
      });
    }
    if (u !== null) unreadableSeen += 1;
  }

  if (list.length !== count || unreadableSeen !== unreadable) {
    return refuse(
      'The `imported_datablocks` document does not match the signed counts: it names ' +
        `${list.length} datablocks (${unreadableSeen} unreadable) beside a signed count of ` +
        `${count} (${unreadable} unreadable). The counts are inside the MAC and the list is ` +
        'not, so accepting a disagreement would let a party in the middle add or remove ' +
        'members while the signature vouched for a cardinality that no longer described them.',
      {
        document: { datablocks: list.length, unreadable: unreadableSeen },
        signed: {
          imported_datablocks_count: count,
          imported_datablocks_unreadable_count: unreadable,
        },
      },
    );
  }

  const hashed = hashImportedDatablocks(doc);
  if (hashed.hash !== hash) {
    return refuse(
      '`imported_datablocks` and `imported_datablocks_hash` disagree. The digest is inside ' +
        'the MAC and the document is not, so accepting a pair that does not match would sign ' +
        'a claim about a document nobody can reproduce — and this digest is also folded into ' +
        '`input_hash`, so it is what a changed datablock moves on the leaf itself.',
      { computed: hashed.hash, supplied: hash },
    );
  }

  return {
    ok: true,
    declaration: {
      source,
      originObserved,
      count,
      unreadableCount: unreadable,
      hash,
      json: hashed.json,
    },
  };
}
