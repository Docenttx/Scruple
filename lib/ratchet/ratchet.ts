// The H-4 forward-secure per-event key ratchet — server side.
//
// Specified in docs/canon/H4-DUKPT-CAPTURE-COMPONENT.md §4. This file is
// the exact counterpart of
// packages/scruple-host-sdk/scruple_host_sdk/ratchet.py, and the two are
// held together by test/vectors/ratchet-vectors.json, which the Python
// side generated and both suites consume. Two implementations that each
// pass their own tests and disagree on the wire is the failure mode that
// file exists to prevent; it is also, per CANON_SKELETON, the failure
// mode the six SDK forks actually had.
//
//   IK    = HKDF-SHA256(ikm=BDK, salt=component_id, info="scruple/ik/v1", L=32)
//   K_0   = IK,  n = 0
//   M_n   = HKDF-Expand(K_n, "scruple/mac/v1", 32)
//   K_n+1 = HKDF-Expand(K_n, "scruple/ratchet/v1", 32)
//   mac   = HMAC-SHA256(M_n, canonical_preimage)
//   zeroize(K_n, M_n); n += 1
//
// NOTE THE ASYMMETRY, because it is easy to "fix" by accident and doing so
// silently breaks every component in the field: IK derivation is a FULL
// HKDF (extract then expand — the BDK is input keying material and
// component_id is the salt), while both chain steps are HKDF-Expand ONLY
// (K_n is already a uniformly random 32-byte PRK; re-extracting buys
// nothing and would need a salt the chain does not have).
//
// NAMING. Not DUKPT in customer-facing material — a forward-secure
// per-event key ratchet, with DUKPT as the cited precedent (§4).
//
// ON ZEROIZATION — what JavaScript actually delivers, which is less than
// the word suggests:
//
//   GUARANTEED. Node `Buffer`s allocated here are `.fill(0)`ed before
//   the reference is dropped. That allocation no longer holds the key.
//
//   NOT GUARANTEED, and unreachable from JS:
//     * crypto.createHmac() copies the key into OpenSSL's HMAC_CTX. There
//       is no API to wipe it.
//     * Any key that arrives as a hex STRING (from the DB cache, from
//       JSON) is an immutable, possibly interned V8 string. It cannot be
//       overwritten and it survives until GC feels like it.
//     * V8 copies live objects during compaction; the copy is not wiped.
//     * The OS may have paged any of it to swap or into a core dump.
//
//   So this narrows the window in a buffer we own. Forward secrecy comes
//   from the one-wayness of SHA-256, not from the fill(0). Do not sell
//   the fill(0).

import crypto from 'node:crypto';

export const HASH_LEN = 32;

/** Domain separation labels. These are WIRE FORMAT — changing any one of
 *  them invalidates every component in the field. They are the reason
 *  M_n and K_n+1, both HKDF-Expand of the same K_n, are independent. */
export const INFO_IK = Buffer.from('scruple/ik/v1', 'utf8');
export const INFO_MAC = Buffer.from('scruple/mac/v1', 'utf8');
export const INFO_RATCHET = Buffer.from('scruple/ratchet/v1', 'utf8');

export class RatchetError extends Error {}

// ---------------------------------------------------------------------------
// HKDF (RFC 5869), written out rather than pulled from a library, so this
// file and ratchet.py can be read side by side and seen to agree.
//
// crypto.hkdfSync() is the full extract+expand and IS used for the IK — but
// hkdfSha256() below is also implemented by hand and test/v2/ratchet.test.ts
// asserts the two agree, which makes Node's built-in an independent third
// implementation checking the two we wrote.
// ---------------------------------------------------------------------------

export function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  const s = salt.length === 0 ? Buffer.alloc(HASH_LEN) : salt; // RFC 5869 §2.2
  return crypto.createHmac('sha256', s).update(ikm).digest();
}

/** RFC 5869 §2.3 — expand ONLY, no extract. What the chain steps use. */
export function hkdfExpand(prk: Buffer, info: Buffer, length = HASH_LEN): Buffer {
  if (length < 1 || length > 255 * HASH_LEN) {
    throw new RatchetError(`hkdfExpand: length ${length} out of range`);
  }
  const blocks: Buffer[] = [];
  let t = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    t = crypto
      .createHmac('sha256', prk)
      .update(Buffer.concat([t, info, Buffer.from([i])]))
      .digest();
    blocks.push(t);
  }
  // Buffer.from() rather than a bare .subarray(): subarray's type is
  // Buffer<ArrayBufferLike>, which does not flow into the Buffer<ArrayBuffer>
  // every other signature here uses. Copying also means the returned key
  // does not share memory with a longer block we are about to drop, so
  // zeroize() on it actually clears the bytes it names.
  return Buffer.from(Buffer.concat(blocks).subarray(0, length));
}

/** Full HKDF-SHA256. Used only for IK derivation. */
export function hkdfSha256(ikm: Buffer, salt: Buffer, info: Buffer, length = HASH_LEN): Buffer {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length);
}

/**
 * IK = HKDF-SHA256(ikm=BDK, salt=utf8(component_id), info="scruple/ik/v1", L=32).
 *
 * Only the server ever runs this: the component receives its IK over TLS
 * at provisioning (§4.4) and never holds the BDK, which is what makes one
 * component's compromise non-systemic.
 */
export function deriveIk(bdk: Buffer, componentId: string): Buffer {
  if (bdk.length < 16) throw new RatchetError('BDK must be at least 16 bytes');
  if (!componentId) throw new RatchetError('component_id must not be empty');
  return hkdfSha256(bdk, Buffer.from(componentId, 'utf8'), INFO_IK, HASH_LEN);
}

export function macKey(chainKey: Buffer): Buffer {
  return hkdfExpand(chainKey, INFO_MAC, HASH_LEN);
}

export function nextChainKey(chainKey: Buffer): Buffer {
  return hkdfExpand(chainKey, INFO_RATCHET, HASH_LEN);
}

/** Advance K_from to K_to. `steps` must be non-negative. */
export function ratchetForward(chainKey: Buffer, steps: number): Buffer {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new RatchetError(`ratchetForward: steps must be a non-negative integer, got ${steps}`);
  }
  let k: Buffer = Buffer.from(chainKey);
  for (let i = 0; i < steps; i++) {
    const n = nextChainKey(k);
    zeroize(k);
    k = n;
  }
  return k;
}

export function macFor(chainKey: Buffer, preimage: Buffer): string {
  const m = macKey(chainKey);
  try {
    return crypto.createHmac('sha256', m).update(preimage).digest('hex');
  } finally {
    zeroize(m);
  }
}

/** Constant-time hex MAC comparison. `!==` on hex strings leaks the length
 *  of the matching prefix through timing, and a MAC check is exactly the
 *  place that matters. */
export function macEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** Best-effort. See the zeroization note at the top of this file for what
 *  it does and does not achieve. */
export function zeroize(...bufs: Array<Buffer | Uint8Array | null | undefined>): void {
  for (const b of bufs) {
    if (b && typeof (b as Buffer).fill === 'function') {
      try {
        (b as Buffer).fill(0);
      } catch {
        /* not writable; nothing further is achievable */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Canonical preimage
//
// SPEC GAP, recorded rather than papered over: §4.1 says
// `mac = HMAC-SHA256(M_n, canonical_preimage)` and never defines
// canonical_preimage. Two implementations reading that sentence will not
// agree. This is the definition both halves of H-4 use, and it is in the
// shared vectors so a disagreement is a test failure rather than a field
// incident.
//
//   canonical_preimage(fields) = UTF-8 of JSON, keys sorted by Unicode
//   CODE POINT, no insignificant whitespace, no trailing newline.
//
// Two traps, both handled:
//
//  1. FLOATS ARE REFUSED. Python's repr and JS Number#toString do not
//     agree on every double. A MAC that depends on float formatting fails
//     intermittently and unreproducibly — the worst failure mode there is.
//     Counters and sizes are integers; everything else is a string.
//
//  2. SORT BY CODE POINT, NOT UTF-16 CODE UNIT. JS's default Array#sort
//     compares UTF-16 units, so a key above the BMP sorts before U+E000..
//     U+FFFF, while Python sorts by code point and puts it after. Same
//     input, different JSON, different MAC. codePointCompare() below is
//     that difference.
// ---------------------------------------------------------------------------

export type PreimageValue = string | number | boolean | null;
export type PreimageFields = Record<string, PreimageValue>;

export function codePointCompare(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const x = ai[i].codePointAt(0)!;
    const y = bi[i].codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ai.length === bi.length ? 0 : ai.length < bi.length ? -1 : 1;
}

export function canonicalPreimage(fields: PreimageFields): Buffer {
  const keys = Object.keys(fields).sort(codePointCompare);
  const parts: string[] = [];
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw new RatchetError(`canonicalPreimage: non-finite number for "${k}"`);
      }
      if (!Number.isInteger(v)) {
        throw new RatchetError(
          `canonicalPreimage: float value for "${k}". Floats do not serialise ` +
            'identically across languages; use a string or an integer.',
        );
      }
      if (!Number.isSafeInteger(v)) {
        throw new RatchetError(
          `canonicalPreimage: integer for "${k}" exceeds the exactly-representable range`,
        );
      }
    } else if (!(typeof v === 'string' || typeof v === 'boolean' || v === null)) {
      throw new RatchetError(
        `canonicalPreimage: unsupported value type ${typeof v} for "${k}"`,
      );
    }
    // JSON.stringify of a string, a boolean, null, or a safe integer
    // matches Python's json.dumps byte for byte. Object.is(v, -0) is the
    // one exception and JSON.stringify already renders it as "0".
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  }
  return Buffer.from(`{${parts.join(',')}}`, 'utf8');
}

/**
 * `(K_n, n)` — the same state the component holds. The server uses it to
 * ratchet a cached chain key forward to a received counter.
 */
export class Ratchet {
  private k: Buffer | null;
  private n: number;

  constructor(chainKey: Buffer, counter = 0) {
    if (chainKey.length !== HASH_LEN) {
      throw new RatchetError(`chain key must be ${HASH_LEN} bytes, got ${chainKey.length}`);
    }
    if (!Number.isInteger(counter) || counter < 0) {
      throw new RatchetError('counter must be a non-negative integer');
    }
    this.k = Buffer.from(chainKey);
    this.n = counter;
  }

  /** The counter the NEXT event will carry. */
  get counter(): number {
    return this.n;
  }

  get destroyed(): boolean {
    return this.k === null;
  }

  /** K_n, for persisting cached state. Not for MACing anything. */
  chainKey(): Buffer {
    if (!this.k) throw new RatchetError('ratchet has been destroyed');
    return Buffer.from(this.k);
  }

  /**
   * Consume counter n: derive M_n, MAC, ratchet, zeroize.
   *
   * Ordering is the spec's, §5: derive, MAC, ratchet, then enqueue. The
   * counter is spent when the MAC is computed, not when the submission
   * succeeds.
   */
  mac(preimage: Buffer | PreimageFields): { counter: number; mac: string } {
    if (!this.k) throw new RatchetError('ratchet has been destroyed');
    const blob = Buffer.isBuffer(preimage) ? preimage : canonicalPreimage(preimage);
    const k = this.k;
    const m = macKey(k);
    const next = nextChainKey(k);
    const tag = crypto.createHmac('sha256', m).update(blob).digest('hex');
    const used = this.n;
    this.k = next;
    this.n = used + 1;
    zeroize(k, m);
    return { counter: used, mac: tag };
  }

  /** Advance without producing a MAC — what the server does to reach a
   *  received counter across a gap. */
  skip(steps: number): void {
    if (!this.k) throw new RatchetError('ratchet has been destroyed');
    const advanced = ratchetForward(this.k, steps);
    zeroize(this.k);
    this.k = advanced;
    this.n += steps;
  }

  destroy(): void {
    zeroize(this.k);
    this.k = null;
  }
}
