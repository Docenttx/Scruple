// The three measurement-honesty states, as a type the vault cannot avoid
// filling in.
//
// WO-62 in docs/canon/RUNTIME-INTEGRITY-WORK-ORDERS.md settled the rule and
// named the defect: `machine_manifest_hash` held three different documents
// indistinguishably, and the fix is "an evidence-source recorded beside the
// hash, and three honest states — measured / genuinely absent /
// could-not-determine. COLLAPSING THE LAST TWO IS THE ORIGINAL DEFECT."
//
// The legacy vault collapsed all three. `lock-local-lock.js` opened
// `fileHash = null; hashMethod = null`, filled them in for three extensions,
// and then wrote `if (fileHash) { ...push... }`. A `.png` in the vault folder
// and a `.toml` that could not be read produced the SAME record: no row. There
// was no state in which the vault said "this file is here and I did not
// measure it", so the vault's file count was the count of files it happened to
// understand, and nobody downstream could tell that from the count of files
// that were there.
//
// Hence: every fact this surface reports about a file arrives wrapped, and the
// wrapper has no default. `absent` and `indeterminate` are different answers
// and stay different all the way to the manifest.

export const MEASUREMENT_STATES = ['measured', 'absent', 'indeterminate'] as const;
export type MeasurementState = (typeof MEASUREMENT_STATES)[number];

export interface Measurement<T> {
  /**
   * measured        we looked and this is what we found.
   * absent          we asked an entitled party and the answer is genuinely
   *                 "there is none". A declaration that says `mime: null` is
   *                 this: the producer was asked and declined to type the bytes.
   * indeterminate   we could not determine it. Nobody was entitled to answer,
   *                 or the answer could not be obtained. NOT the same as
   *                 `absent`, and never folded into it.
   */
  state: MeasurementState;
  /** Non-null if and only if `state` is 'measured'. */
  value: T | null;
  /** WHO said so, or what did the looking. Never a guess about who might have. */
  source: string;
  /** Required for 'absent' and 'indeterminate'; null for 'measured'. */
  reason: string | null;
}

export function measured<T>(value: T, source: string): Measurement<T> {
  return { state: 'measured', value, source, reason: null };
}

export function absent<T>(source: string, reason: string): Measurement<T> {
  return { state: 'absent', value: null, source, reason };
}

export function indeterminate<T>(source: string, reason: string): Measurement<T> {
  return { state: 'indeterminate', value: null, source, reason };
}

/** True only for 'measured'. Written once so no call site can widen it. */
export function isMeasured<T>(m: Measurement<T>): m is Measurement<T> & { value: T } {
  return m.state === 'measured' && m.value !== null;
}
