// WO-2 — the statement / predicate / envelope split.
//
// Four layers, versioned independently, so the compliance vocabulary
// (P1-P8) stops being fused into the signing machinery:
//
//   pae.ts        DSSE Pre-Authentication Encoding. Bytes.
//   dsse.ts       The envelope: payloadType, payload, signatures[].
//   statement.ts  The subject binding. A leaf, verbatim, plus a
//                 predicateType URI it does not interpret.
//   predicate.ts  `scruple-vendor-baseline` — placement, enforcement,
//                 attestation, surfaces, component identity, P1-P8.
//   attest.ts     The only file that knows both halves.
//
// Docs: docs/canon/PREDICATE_scruple-vendor-baseline.md
// Rationale: docs/canon/oss-study/in-toto.md §3.1, §6.

export * from './pae';
export * from './dsse';
export * from './statement';
export * from './predicate';
export * from './attest';
