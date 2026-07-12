// Reproduces Direction 2 of the interop test: independent verification
// of the Scruple-signed asset using the c2pa-node distribution.
//
// Usage:
//   cd /data/scruple-web/docs/c2pa-interop
//   npm install c2pa-node
//   node reproduce-verify.mjs
import { createC2pa } from 'c2pa-node';

const c2pa = createC2pa();
const result = await c2pa.read({
  mimeType: 'image/png',
  path: './scruple-test-signed.png',
});

const am = result.active_manifest;
console.log('title:               ', am.title);
console.log('claim_generator_info:', JSON.stringify(am.claim_generator_info));
console.log('signature_info:      ', JSON.stringify(am.signature_info));
console.log('assertions:          ', am.assertions?.map(a => a.label));
console.log('validation_status:   ', JSON.stringify(result.validation_status));
console.log();
console.log(result.validation_status?.length === 0
  ? '✅ INTEROP PASSED — empty validation_status'
  : '❌ INTEROP FAILED');
