// Generate test/vectors/component-preimage-vectors.json.
//
//   npm run gen:preimage-vectors
//
// §10 C-1 fixed the ENCODING of `canonical_preimage` — UTF-8 JSON, keys
// sorted by Unicode code point, compact separators, floats refused — and
// left the FIELD SET open. That is the half that is still able to go wrong,
// and it goes wrong quietly: two implementations both honour C-1, produce
// different bytes, and every MAC one of them writes fails to verify against
// the other with a `bad_mac` that looks like tampering.
//
// There are now THREE implementations of the field set:
//
//   lib/leaf/componentPreimage.ts                  the server, at ingest
//   services/scruple-capture/src/leaf.ts           the sidecar component
//   packages/.../scruple_host_sdk/server_library.py the server-library
//                                                  component, in Python
//
// The first two are compared directly in test/v2/component-auth.test.ts,
// because they are the same language. This file is how the third joins
// them: the submissions and their canonical preimage bytes, emitted from
// the TypeScript and checked by the Python suite. Exactly the role
// test/vectors/ratchet-vectors.json plays for the key schedule — that file
// pins the arithmetic, this one pins what the arithmetic is applied to.
//
// The MACs are included too, over a published dev BDK, so the Python side
// checks the whole chain end to end rather than only the preimage.

import fs from 'node:fs';
import path from 'node:path';
import { componentPreimage } from '../lib/leaf/componentPreimage.ts';
import { canonicalPreimage, deriveIk, Ratchet } from '../lib/ratchet/ratchet.ts';
import { DEFAULT_RETENTION_POLICY_DIGEST } from '../lib/leaf/retentionPolicy.ts';

const OUT = path.join(process.cwd(), 'test', 'vectors', 'component-preimage-vectors.json');

// bytes(range(32)) — the same deliberately obvious test key
// test/vectors/ratchet-vectors.json uses. Never a real BDK.
const BDK = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const COMPONENT_ID = '0b0c9f4a-7e21-4b0d-9a3e-2c5d8f1a6b74';
const BUILD = 'sha256:' + 'ab'.repeat(32);

const cases = [
  {
    name: 'server-library, everything declared',
    submission: {
      baseline_ref: 'b'.repeat(64),
      kind: 'artifact',
      content_hash: 'c'.repeat(64),
      mime: 'image/png',
      input_hash: 'd'.repeat(64),
      model_fingerprints_hash: 'e'.repeat(64),
      machine_manifest_hash: 'f'.repeat(64),
      capture: {
        surface: 'in-process-callback',
        hook: 'artifact.produced',
        fidelity: 'as-delivered',
        size_bytes: 17,
        mime_source: 'caller-declared',
        correlation_id: null,
        correlation_method: null,
        egress: null,
        close_detection: null,
        workflow_hash: null,
        observed_at: '2026-08-30T00:00:00.000Z',
        // WO-C1. Three-valued, and `stale` is what every leaf emits until
        // the witness and the verifier pass shared Merkle vectors.
        attestation_status: 'stale',
        profile: 'server-managed',
        // WO-C4. The `server-library` placement declares no watched volume,
        // so there is no device pair to compare and the honest answer is
        // `unknown` with source `unknown`. It is NOT `confined`: a placement
        // that measured nothing has not established a boundary, and the two
        // must not read the same to a verifier.
        confinement: 'unknown',
        confinement_source: 'unknown',
      },
      // WO-C2. The resolution handles, in the signed preimage. This case has
      // an authority enrolled and a preceding checkpoint with its quote time
      // — Architect's interval bound — and `checkpoint_id: null`, because no
      // checkpoint can be claimed settled while the Merkle blocker stands.
      resolution: {
        witness_endpoint: 'https://witness.example.vendor/api',
        witness_authority: 'sha256:' + 'cd'.repeat(32),
        checkpoint_id: null,
        prev_checkpoint_id: 'ckpt-2026-08-29-0001',
        prev_checkpoint_quote_time: '2026-08-29T23:59:00.000Z',
        // WO-C3. Handles six and seven: when this leaf's silence becomes a
        // finding, and the digest of the retention policy that says how long
        // the evidence which would settle it is kept. The digest is over the
        // canonical POLICY OBJECT — durations included — because one over the
        // policy's NAME leaves a legitimate expiry indistinguishable from a
        // forged handle.
        settlement_deadline: '2026-08-31T00:00:00.000Z',
        retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
      },
      component: {
        component_id: COMPONENT_ID,
        build_measurement: BUILD,
        counter: 0,
        attestation: { provider: 'none', quote_ref: null },
      },
    },
  },
  {
    name: 'no mime — H-4 §7 probe 4, an unattributed write',
    note:
      'The absence is IN the preimage as a null, so a proxy cannot add a type in flight ' +
      'without breaking the MAC. That is the property that makes accepting an undeclared ' +
      'MIME safe rather than merely permissive. WO-C1: `close_detection` was ' +
      "'IN_CLOSE_WRITE' in this vector until 2026-09-09 and is now null, which is the " +
      'ONLY value it may ever hold — the council retracted the filesystem trigger from ' +
      'the freeze gate and lib/leaf/captureClaims.ts returns 422 for anything else. A ' +
      'vector carrying the retracted value is the dead schema reference the retraction ' +
      'was meant to prevent; the next contributor copies vectors.',
    submission: {
      baseline_ref: 'b'.repeat(64),
      kind: 'artifact',
      content_hash: '9'.repeat(64),
      capture: {
        surface: 'filesystem-watch',
        hook: 'artifact.produced',
        fidelity: 'as-written',
        size_bytes: 4096,
        mime_source: null,
        correlation_id: null,
        correlation_method: null,
        egress: null,
        close_detection: null,
        workflow_hash: null,
        observed_at: '2026-08-30T00:00:01.000Z',
        attestation_status: 'stale',
        profile: 'isolated-sidecar',
        // WO-C4. A sidecar that DID measure, and found the ratchet's state on
        // the same filesystem as the volume it watches. Degraded operation is
        // permitted and this is what makes it permitted: the tag is on the
        // leaf, inside the MAC, with `measured` behind it. A tag a proxy
        // could rewrite to `confined` would be worth nothing, which is why
        // both keys are in the preimage rather than only the value.
        confinement: 'degraded_shared_storage',
        confinement_source: 'measured',
      },
      // WO-C2. An endpoint with NO authority enrolled. Carried as a null
      // rather than as a plausible-looking string, because inventing the
      // identity is inventing exactly what it exists to prove — and the
      // route then refuses to let this leaf name a `checkpoint_id` at all.
      resolution: {
        witness_endpoint: 'http://127.0.0.1:8080',
        witness_authority: null,
        checkpoint_id: null,
        prev_checkpoint_id: null,
        prev_checkpoint_quote_time: null,
        // WO-C3. A deadline and a policy, on a leaf with no authority — the
        // two are independent: knowing WHEN silence becomes a finding does
        // not require knowing whose signature counts at the endpoint.
        settlement_deadline: '2026-08-31T00:00:01.000Z',
        retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
      },
      component: {
        component_id: COMPONENT_ID,
        build_measurement: BUILD,
        counter: 1,
        attestation: { provider: 'none', quote_ref: null },
      },
    },
  },
  {
    name: 'no capture block and no resolution block — nulls in a stable shape, not a different shape',
    note:
      'A key dropped from the object changes the canonical JSON and therefore the MAC. This ' +
      'case and the ones above must produce the same KEY SET. WO-C2: the five ' +
      '`resolution_*` keys are null here (SEVEN of them since WO-C3), which is what makes ' +
      '"this leaf named no witness and no deadline" ' +
      'a SIGNED statement — a party in the middle can no more add a witness endpoint than ' +
      'rewrite one, because both change the canonical JSON. WO-C4 adds ' +
      '`confinement` and `confinement_source`, null here for the same reason: a ' +
      'submission that carried no measurement must produce the same key SET as one ' +
      'that did, or the absence is not signed.',
    submission: {
      baseline_ref: null,
      kind: 'graph_execute',
      content_hash: '1'.repeat(64),
      mime: 'text/plain',
      component: { component_id: COMPONENT_ID, counter: 2 },
    },
  },
];

const doc = {
  $schema_note:
    'Shared cross-language vectors for the H-4 §4.3 component MAC preimage — the FIELD SET, ' +
    'which §10 C-1 left open. Generated from lib/leaf/componentPreimage.ts and ' +
    'lib/ratchet/ratchet.ts; consumed by packages/scruple-host-sdk/tests/test_server_library.py ' +
    'and by test/v2/component-auth.test.ts. Regenerate with `npm run gen:preimage-vectors`.',
  spec: 'docs/canon/H4-DUKPT-CAPTURE-COMPONENT.md §4.1, §4.3, §10 C-1',
  generated_by: 'scripts/gen-component-preimage-vectors.mjs',
  bdk_hex: BDK.toString('hex'),
  bdk_note:
    'bytes(range(32)), the same obvious test key test/vectors/ratchet-vectors.json uses. ' +
    'Never a real BDK; production custody is the signer HSM.',
  cases: cases.map((c) => {
    const fields = componentPreimage(c.submission);
    const bytes = canonicalPreimage(fields);
    const r = new Ratchet(deriveIk(BDK, COMPONENT_ID), 0);
    r.skip(c.submission.component.counter);
    const { mac } = r.mac(bytes);
    r.destroy();
    return {
      name: c.name,
      ...(c.note ? { note: c.note } : {}),
      submission: c.submission,
      preimage_fields: fields,
      canonical_preimage_utf8: bytes.toString('utf8'),
      mac_hex: mac,
    };
  }),
};

fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`[gen] wrote ${OUT}`);
