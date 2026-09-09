// The named clock, and why a deadline needs one.
//
// WO-C3. SETTLED BY THE BLENDER×COMFYUI COUNCIL (artifact `1a978a6`, §1, §2
// Architect's ruling, hand round 7 §2 and round 8 §2, Appendix C).
// `docs/wo/2026-09-09-council-implementation.md` is the work order.
//
// ---------------------------------------------------------------------------
// THE RULE, VERBATIM
// ---------------------------------------------------------------------------
//
// Architect, hand round 7, ruling on the unbounded settlement window:
//
//   "`expired` must itself be `source: measured` against a NAMED CLOCK, since
//    a deadline derived from a locally-set timestamp is exactly the
//    config-inherited field class we already refused."
//
// Coder accepted it as written, and recorded that the engineers singled it
// out: *"the correct application of the config-inherited-field rule, and I
// would not have thought to apply it to a deadline."*
//
// The field class in question is `pinned_build` and the defect is always the
// same shape: a value that was true when somebody configured it, read later as
// though it had been observed. A component that says "this leaf expires at
// 14:00" and is asked what time it is by nobody has stated a preference, not
// measured an expiry — and a component whose clock is two hours fast states
// that preference in perfect good faith.
//
// ---------------------------------------------------------------------------
// WHAT A NAMED CLOCK IS HERE, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
//
// A named clock is a time source with an IDENTIFIED READER: a name, an
// authority that answers for the reading, and a recorded instant. The property
// the council asked for is attribution — that a terminal `expired` be traceable
// to a party who read a clock, rather than inherited from the emitter's own
// configuration. That is what this module provides.
//
// ⚑ IT IS NOT A TIMESTAMP AUTHORITY. `scruple-witness-v2` is this server's own
// wall clock, read at ingest and at query time, and nothing signs the reading.
// An operator who can set this host's clock can move every deadline it
// evaluates. Saying so here is the point: the honest upgrade is an RFC 3161
// TSA or a roughtime authority enrolled as a second entry in NAMED_CLOCKS, and
// the shape of this module is built to take one — a clock is a name, an
// authority and a reader, and `readNamedClock()` is the only door.
//
// What it DOES buy, today, is the whole of the council's requirement: the
// component cannot name its own clock, cannot supply the reading, and cannot
// produce a terminal `expired` at all. A leaf whose deadline does not sit in
// the window this clock computes is refused at ingest, which is how a
// two-hour-fast local clock is caught rather than believed.

/** How far a component's clock may sit from ours before its deadline is not
 *  a statement about the named clock at all. Five minutes is the NTP-sane
 *  band; beyond it, the deadline was derived from a clock nobody named. */
export const MAX_CLOCK_SKEW_S = 300;

export interface NamedClockEntry {
  /** Who answers for the reading. */
  authority: string;
  /** What kind of time this is, stated so a reader does not over-read it. */
  kind: 'server-wall-clock' | 'timestamp-authority';
  /** The honest limit of this clock, carried on every reading. */
  caveat: string;
}

/** The canonical name of the clock this deployment reads. */
export const SCRUPLE_CLOCK = 'scruple-witness-v2';

/**
 * Every clock this server is an AUTHORITY FOR — meaning it can read it
 * directly and answer for the reading. A clock that is merely named
 * somewhere is not in here, and `readNamedClock()` returns null for it: we
 * do not manufacture a reading of somebody else's clock.
 */
export const NAMED_CLOCKS: Record<string, NamedClockEntry> = {
  [SCRUPLE_CLOCK]: {
    authority: process.env.SCRUPLE_CLOCK_AUTHORITY ?? 'scruple-web:v2-ingest',
    kind: 'server-wall-clock',
    caveat:
      'this server\'s own wall clock, read at ingest and at query time and signed by nothing. ' +
      'It is NAMED and ATTRIBUTABLE, which is what a terminal `expired` requires; it is not a ' +
      'timestamp authority, and an operator who can set this host\'s clock can move it.',
  },
};

/**
 * Names a leaf may never give as its clock. Each of them is the emitter
 * saying "mine" in a word that sounds like an institution — which is the
 * config-inherited field wearing the clothes of a measurement.
 */
export const REFUSED_CLOCK_NAMES = [
  '',
  'local',
  'localhost',
  'system',
  'host',
  'component',
  'client',
  'wall',
  'none',
  'default',
];

export function isRefusedClockName(name: string): boolean {
  return REFUSED_CLOCK_NAMES.includes(name.trim().toLowerCase());
}

/** A reading. `source` is always 'measured' — an unread clock returns null. */
export interface NamedClockReading {
  name: string;
  authority: string;
  kind: NamedClockEntry['kind'];
  caveat: string;
  /** The instant this clock reported, RFC 3339 UTC. */
  read_at: string;
  /** Milliseconds since the epoch, for arithmetic. */
  read_at_ms: number;
  source: 'measured';
}

/**
 * Read a named clock, or return null when this server is not an authority
 * for it.
 *
 * NULL IS NOT AN ERROR AND IT IS NOT ZERO. It is the honest answer to "what
 * time does somebody else's clock say", and every caller must turn it into
 * `source: unknown` rather than into a reading of its own — which is the same
 * discipline `basisForTrust()` runs on one file over: absent is never
 * upgraded, it is named.
 */
export function readNamedClock(name: string, atMs: number = Date.now()): NamedClockReading | null {
  const entry = NAMED_CLOCKS[name];
  if (!entry) return null;
  return {
    name,
    authority: entry.authority,
    kind: entry.kind,
    caveat: entry.caveat,
    read_at: new Date(atMs).toISOString(),
    read_at_ms: atMs,
    source: 'measured',
  };
}

/** Strict RFC 3339 UTC instant. A local offset is a clock nobody named. */
export const INSTANT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export function parseInstant(s: string): number | null {
  if (!INSTANT_UTC.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
