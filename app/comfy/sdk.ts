// The comfy surface's declaration of what it takes from the server repo.
//
// A SIBLING OF app/vault/sdk.ts, NOT A REPLACEMENT FOR IT, and the split is
// deliberate. `buildMeasurement()` measures the directory of the surface that
// is doing the measuring, so each surface's list of SDK imports has to sit
// inside that surface's own tamper surface: a shared shim one directory up
// would be covered by neither baseline, and the file that names every path
// into the server repo is exactly the file a baseline should cover.
//
// Everything below is imported, never reimplemented — WO-D3's rule, and it
// binds here harder, because `hashModelFingerprints` is a PREIMAGE. A second
// implementation of a preimage is a second preimage, and this one is checked
// on the far side: /api/v2/witness recomputes the hash from the manifest and
// REFUSES the submission if the two disagree. Nothing here could ship a
// hand-rolled version and stay green, which is the correct arrangement.
//
//   CaptureComponent    the gate itself — HTTP + WS reverse proxy, the output
//                       volume watcher, and the Submitter that owns §5's
//                       ordering. Deployed, not authored (H-4 §2).
//   hashModelFingerprints
//                       model_fingerprints_hash, including the correction
//                       that strips `mtime` out of the preimage.
//   ObservationSink     the contract a host adapter implements. Our model
//                       store enrichment is one, which is why it is a
//                       decorator rather than a patch.

export { CaptureComponent, type ComponentDeps } from '../../vendor/scruple-web/services/scruple-capture/src/component';
export { type CaptureConfig, type WatchedVolume } from '../../vendor/scruple-web/services/scruple-capture/src/config';
export { Identity } from '../../vendor/scruple-web/services/scruple-capture/src/identity';
export { buildMeasurement } from '../../vendor/scruple-web/services/scruple-capture/src/build-measurement';
export {
  assuranceForHost,
  type CaptureObservation,
  type HostCaptureProfile,
  type ObservationSink,
} from '../../vendor/scruple-web/lib/capture/surface';
export { profileFor } from '../../vendor/scruple-web/lib/leaf/attestationBasis';
export {
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
} from '../../vendor/scruple-web/lib/leaf/retentionPolicy';
export {
  hashModelFingerprints,
  type ModelFingerprintsResult,
} from '../../vendor/scruple-web/lib/leaf/hashes';
export {
  DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
} from '../../vendor/scruple-web/lib/capture/upstreamEpoch';
