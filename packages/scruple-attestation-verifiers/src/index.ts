// Public API for @scruple/attestation-verifiers.
//
// Consumers:
//   - Server API (@/lib/baseline/ingest_check.ts) — imports dispatch()
//   - Reference verifier CLI (packages/scruple-verify) — imports dispatch()
//     for independent re-verification of receipt attestations
//
// Plugin registration happens on module load in each plugin file;
// consumers should import from '@scruple/attestation-verifiers' and the
// plugins side-effect-register themselves when their modules are loaded
// via the './plugins/' subpath imports.

export * from './envelope.js';
export * from './verifier.js';
export { dispatch, registerPlugin, getRegisteredTypes } from './dispatch.js';
