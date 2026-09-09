// The ONE file in this repo that names a path into the server repo.
//
// docs/DESIGN.md keeps the vault MODEL from app-legacy/lock/lock-local-lock.js
// — enumerate a directory, hash the set, treat it as a unit — and replaces its
// implementation. WO-D3 says what to replace it WITH: "the ObservationSink
// contract, not a hand-rolled client."
//
// So everything below is imported, never reimplemented:
//
//   Submitter        the ObservationSink the ComfyUI capture component emits
//                    into. It owns the §5 ordering — derive, MAC, ratchet,
//                    persist, THEN enqueue — and the queue that makes capture
//                    survive a witness that is slow, saturated or restarting.
//   Identity         §4.4 provisioning and the forward-secure ratchet.
//   QueueStore       store-and-forward. docs/DESIGN.md: "NOT a reason to
//                    delete the queue".
//   assuranceForHost what this configuration may and may not claim, from its
//                    placement and enforcement — not from what it calls itself.
//   profileFor       placement → trust profile. On the desktop the answer is
//                    'desktop', and `verified` is unrepresentable from there.
//
// The vendor/scruple-web link is a SYMLINK, not a copy — vendor/README.md has
// the argument. A copy of the ratchet or of the leaf preimage would be a
// second implementation of a MAC, and two implementations of a preimage are
// two preimages.

export { Submitter, type SubmittedEvent } from '../../vendor/scruple-web/services/scruple-capture/src/submitter';
export { QueueStore } from '../../vendor/scruple-web/services/scruple-capture/src/queue';
export { Identity, type SealedState } from '../../vendor/scruple-web/services/scruple-capture/src/identity';
export { buildMeasurement } from '../../vendor/scruple-web/services/scruple-capture/src/build-measurement';
export {
  assuranceForHost,
  resolvePlacement,
  type CaptureHook,
  type CaptureObservation,
  type CaptureSurface,
  type CaptureSurfaceContext,
  type CaptureSurfaceKind,
  type HostCaptureProfile,
  type ObservationFidelity,
  type ObservationSink,
  type Placement,
  type PlacementEnforcement,
} from '../../vendor/scruple-web/lib/capture/surface';
export { profileFor, type CaptureProfile } from '../../vendor/scruple-web/lib/leaf/attestationBasis';
export {
  measureStorageConfinement,
  type StorageMeasurement,
} from '../../vendor/scruple-web/lib/capture/storageConfinement';
export {
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
} from '../../vendor/scruple-web/lib/leaf/retentionPolicy';
export {
  canonicalize,
  canonicalizeBytes,
  CANONICALIZATION_PROFILE,
} from '../../vendor/scruple-web/lib/leaf/canonicalJson';
