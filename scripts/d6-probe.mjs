// WO-D6's control, asked of ONE tree — run twice, against the tree before this
// work order and the tree after it. scripts/d6-gate.sh is what runs both.
//
// The work order's control is: "the same generation with no adapter must
// produce a Level-1 leaf that says so — declared blind, not silently thinner."
// A control has to be shown RED BEFORE the change, and the only honest way to
// show that is to ask the pre-change code the same question and watch it be
// unable to answer.
//
// Two questions, and they are the two halves of the claim:
//
//   Q1  a leaf built with NO host adapter — what does it say about its level?
//       BEFORE: nothing. The field does not exist, so a Level-1 leaf is a
//               Level-2 leaf minus some fields, which is exactly the
//               "silently thinner" record the WO refuses.
//       AFTER:  'blind', in the submission and in the MAC preimage.
//
//   Q2  a capture block CLAIMING a registered host supplied its meaning, with
//       nothing behind it — is it refused?
//       BEFORE: accepted. There is no rule about it, so a leaf can assert a
//               Level-2 integration nobody registered.
//       AFTER:  422 host_semantics_refused.
//
// Nothing here reads a log line. Both answers are returned values.

import { argv } from 'node:process';

const root = argv[2];
if (!root) {
  console.error('usage: d6-probe.mjs <scruple-web-root>');
  process.exit(2);
}

const out = { root, q1: null, q2: null, errors: [] };

const OBSERVATION = {
  hook: 'artifact.produced',
  surface: 'network-gate',
  correlationId: 'probe-1',
  bytes: { fidelity: 'as-delivered', contentHash: 'c'.repeat(64), mime: 'image/png', sizeBytes: 9 },
  evidence: { egress: '/view', kind: 'artifact' },
  observedAt: '2026-09-09T00:00:00.000Z',
};

try {
  const { buildLeaf } = await import(`${root}/services/scruple-capture/src/leaf.ts`);
  const { DEFAULT_RETENTION_POLICY, DEFAULT_RETENTION_POLICY_DIGEST } = await import(
    `${root}/lib/leaf/retentionPolicy.ts`
  );
  const built = buildLeaf(
    OBSERVATION,
    {
      baselineRef: '6'.repeat(64),
      componentId: 'probe',
      buildMeasurement: 'sha256:' + '00'.repeat(32),
      profile: 'desktop',
      enforcement: 'none',
      witnessEndpoint: 'https://witness.example.vendor/api',
      witnessAuthority: null,
      settlementWindowSeconds: DEFAULT_RETENTION_POLICY.settlement_window_s,
      retentionPolicyDigest: DEFAULT_RETENTION_POLICY_DIGEST,
    },
    0,
  );
  out.q1 = {
    inSubmission: 'host_semantics' in built.submission.capture
      ? built.submission.capture.host_semantics
      : '(the field does not exist)',
    inPreimage: 'host_semantics' in built.preimage
      ? built.preimage.host_semantics
      : '(the field does not exist)',
    declaresItsLevel:
      'host_semantics' in built.submission.capture &&
      built.submission.capture.host_semantics !== undefined &&
      built.submission.capture.host_semantics !== null,
  };
} catch (e) {
  out.errors.push(`Q1: ${String(e.message ?? e)}`);
}

try {
  const { validateCaptureClaims } = await import(`${root}/lib/leaf/captureClaims.ts`);
  // A capture block that CLAIMS Level 2 with nothing behind it: it says a host
  // supplied the meaning, and names no adapter and carries no document.
  const forged = {
    surface: 'network-gate',
    hook: 'artifact.produced',
    fidelity: 'as-delivered',
    size_bytes: 17,
    mime_source: 'caller-declared',
    correlation_id: null,
    correlation_method: null,
    egress: 'http:/view',
    close_detection: null,
    workflow_hash: null,
    observed_at: '2026-09-09T00:00:00.000Z',
    profile: 'isolated-sidecar',
    attestation_status: 'stale',
    confinement: 'confined',
    confinement_source: 'measured',
    upstream_identity: 'sha256:' + 'ef'.repeat(32),
    upstream_epoch: 'epoch:' + '9a'.repeat(16),
    upstream_continuity: 'continuous',
    upstream_low_watermark_open: 0,
    upstream_low_watermark_close: 0,
    upstream_uncaptured_reason: 'enumerated',
    upstream_source: 'measured',
    host_semantics: 'supplied',
    host: null,
    host_adapter: null,
    host_evidence_type: null,
    host_evidence_hash: null,
  };
  const r = validateCaptureClaims({ capture: forged });
  out.q2 = { accepted: r.ok === true, code: r.ok ? null : r.code };
} catch (e) {
  out.errors.push(`Q2: ${String(e.message ?? e)}`);
}

console.log(JSON.stringify(out, null, 2));
