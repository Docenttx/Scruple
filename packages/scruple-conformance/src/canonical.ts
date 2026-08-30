// Canonical JSON, C-1's rules applied to a nested structure.
//
// H-4 §10 C-1 made this normative for the MAC preimage: UTF-8 JSON, keys
// sorted by UNICODE CODE POINT, compact separators, floats refused. That
// definition is implemented for a FLAT field set in
// lib/ratchet/ratchet.ts#canonicalPreimage, and a bundle manifest is not flat.
//
// So this is the same rule, recursively, and test/v2/conformance.test.ts holds
// the two together by asserting they agree byte-for-byte on every flat object.
// If they ever diverge, a signature computed by one and checked by the other
// fails in the field and nowhere else, which is the failure mode C-1 exists to
// prevent.
//
// The two traps C-1 names stay closed here:
//   * FLOATS ARE REFUSED. Python repr and JS Number#toString disagree on some
//     doubles. A format-dependent signature fails unreproducibly and only
//     sometimes, which is worse than failing always.
//   * CODE POINT, NOT UTF-16 CODE UNIT. Array.prototype.sort compares UTF-16
//     code units and disagrees with Python's sort for astral-plane keys.

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [k: string]: CanonicalValue };

export class CanonicalError extends Error {}

/** Sort by Unicode code point. `localeCompare` is locale-dependent and the
 *  default comparator is UTF-16; neither agrees with Python's `sorted()`. */
export function byCodePoint(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const ca = A[i].codePointAt(0)!;
    const cb = B[i].codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return A.length - B.length;
}

export function canonicalJson(value: CanonicalValue, path = '$'): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalError(`non-finite number at ${path}`);
    if (!Number.isInteger(value)) {
      throw new CanonicalError(
        `float at ${path}. Floats do not serialise identically across languages (§10 C-1); ` +
          'carry the value as a string or as an integer in its smallest unit.',
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalError(`integer at ${path} exceeds the exactly-representable range`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as { [k: string]: CanonicalValue };
    const keys = Object.keys(obj).sort(byCodePoint);
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], `${path}.${k}`)}`)
      .join(',')}}`;
  }
  throw new CanonicalError(`unsupported value type ${typeof value} at ${path}`);
}

export function canonicalBytes(value: CanonicalValue): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
