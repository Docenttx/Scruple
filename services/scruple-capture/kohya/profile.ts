// Kohya as a host of the capture component — placement, duties, topology.
//
// WO-11b. The companion prose is docs/canon/KOHYA_REPLACEMENT.md; this file is
// the part of it a program can execute, and the two must agree.
//
// ---------------------------------------------------------------------------
// WHAT RE-PLACEMENT ACTUALLY CHANGES, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
//
// PLACEMENT_AND_SURFACES.md §7.2 gives the target row: hooks `model.write` +
// `artifact.produced`, surfaces `filesystem-watch` + `network-gate`, declared
// `sidecar-gate`. Read literally that looks like the ComfyUI component with a
// different `host` string. It is not, and the difference is the WO:
//
//   ComfyUI's artifacts are RETRIEVED THROUGH A SURFACE THE GATE OWNS. That
//   is what lets services/scruple-capture/src/submitter.ts block: the gate
//   awaits emit() before forwarding a byte, so no artifact reaches the tenant
//   that no leaf covers. FAIL-CLOSED IS AVAILABLE THERE.
//
//   A Kohya checkpoint is a file. It is written to a volume the tenant's own
//   process owns, and every ordinary way of collecting it — the pod's file
//   browser, JupyterLab, `scp`, a network volume the tenant remounts — reads
//   the bytes off disk without crossing any gate we could place. THERE IS NO
//   POINT AT WHICH BYTES CAN BE WITHHELD PENDING A LEAF.
//
// So of the component's three duties (H-4 §2, services/scruple-capture/src/
// component.ts):
//
//   GATE    APPLIES ONLY IN PART, and never to the artifact. It can commit the
//           TRAINING CONFIG on the way in — the dataset config, the base model,
//           the hyperparameters — which is Kohya's analogue of `POST /prompt`
//           and is what `hashGraphOrTraining` in lib/leaf/hashes.ts already
//           expects. It cannot gate the checkpoint out, because the checkpoint
//           does not come out that way. Modelling it as ComfyUI's gate would
//           import fail-closed language into a path that cannot fail closed.
//
//   WATCH   APPLIES, AND IS LOAD-BEARING RATHER THAN COMPLEMENTARY. For
//           ComfyUI the watcher covers what the gate structurally cannot; for
//           Kohya the watcher IS the capture. Everything the evidence rests on
//           is hash-on-close, which H-4 §6 is explicit is tamper-EVIDENT and
//           not tamper-proof.
//
//   SUBMIT  APPLIES UNCHANGED. Ratchet, counter in the clear, queue, drain,
//           gap and silence accounting. This is the duty that survives the
//           translation intact, and — see below — it is also the duty that is
//           worth the most here, because a tenant who removes the capture
//           produces SILENCE, and silence under a counter is visible.
//
// ---------------------------------------------------------------------------
// AND ONE THING THE TARGET ROW DOES NOT SAY
// ---------------------------------------------------------------------------
//
// `declaredPlacement: 'sidecar-gate'` is a CLAIM, and §4.2 is explicit that a
// claim without its enforcement resolves to `unattested-client` — not to an
// intermediate tier. Nothing in the repo checks whether the enforcement is
// there. `resolveKohyaPlacement()` below is that check, expressed as the four
// topology obligations of H-4 §2 (as amended by §10 C-8 and C-9), and its
// answer on RunPod's Pods as RunPod offers them is `none`.
//
// That is not a pessimistic default. It is the model refusing, which §4.1 says
// is the reason the fourth placement value exists.

import {
  assuranceFor,
  resolvePlacement,
  type Assurance,
  type HostCaptureProfile,
  type PlacementEnforcement,
  type PlacementResolution,
} from '../../../lib/capture/surface';

/* ────────────────────────────────────────────────────────────────────────
 * The three duties, and which of them Kohya has.
 * ──────────────────────────────────────────────────────────────────────── */

export type Duty = 'gate' | 'watch' | 'submit';
export type DutyDisposition = 'applies' | 'applies-in-part' | 'does-not-apply';

export interface DutyRuling {
  duty: Duty;
  disposition: DutyDisposition;
  /** What it covers here, in one sentence a reader can check against code. */
  covers: string;
  /** The thing a ComfyUI-shaped reading would wrongly assume it covers. */
  doesNotCover: string;
}

export const KOHYA_DUTIES: readonly DutyRuling[] = Object.freeze([
  Object.freeze({
    duty: 'gate' as const,
    disposition: 'applies-in-part' as const,
    covers:
      'the training request on the way IN — dataset config, base model, hyperparameters — ' +
      'committed as the run inputs the leaf carries (lib/leaf/hashes.ts hashGraphOrTraining).',
    doesNotCover:
      'the checkpoint on the way OUT. A checkpoint is a file on a volume; it is collected ' +
      'off disk and traverses no network surface a gate could hold. Fail-closed, which is ' +
      'the whole value of the ComfyUI gate, is not available for Kohya artifacts.',
  }),
  Object.freeze({
    duty: 'watch' as const,
    disposition: 'applies' as const,
    covers:
      'every safetensors write that completes in the checkpoint volume, hashed on close, ' +
      'with the safetensors header hashed separately as a structural fingerprint.',
    doesNotCover:
      'preventing anything. H-4 §6: a later edit is a new close and a new hash. The watcher ' +
      'makes modification produce a second event, and reconciliation — not the watcher — is ' +
      'what turns that into a finding.',
  }),
  Object.freeze({
    duty: 'submit' as const,
    disposition: 'applies' as const,
    covers:
      'the ratchet, the counter in the clear, the durable queue, and the gap and silence ' +
      'accounting that follow from them. This is the duty that translates unchanged, and on ' +
      'a host with no fail-closed point it is the one carrying the most weight: a tenant who ' +
      'removes the capture stops the counter, and a stopped counter is visible (H-4 §4.2).',
    doesNotCover:
      'issuing a leaf at a placement that may not have one. Submission is gated on the ' +
      'assurance resolved below, not on the component having started successfully.',
  }),
]);

/* ────────────────────────────────────────────────────────────────────────
 * Topology — H-4 §2 obligations 1-3 plus §10 C-9's obligation 4.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * What the VENDOR declares about their own deployment. Every field defaults to
 * false and none of them is verifiable from inside this process — H-4 §7 is
 * where they get probed, from inside the tenant container, which is where the
 * adversary sits. Declaring one true and being wrong is the vendor's
 * accountable act (§1); leaving it false costs only a refusal.
 */
export interface KohyaTopology {
  /**
   * Obligation 1. The training workload binds loopback or a private namespace
   * and the component is the only route to it.
   *
   * KOHYA-SPECIFIC TRAP, and it is the sharpest thing on this page: satisfying
   * this obligation does NOT give you what it gives you on ComfyUI. Kohya's GUI
   * is a training-command launcher — its whole function is to take a form and
   * run a process with those arguments. A gate in front of it is a gate in
   * front of a remote shell. C-9 found custom nodes doing this to ComfyUI as an
   * extension; for Kohya it is the product. Obligation 1 therefore buys
   * INGRESS ATTRIBUTION and does not buy containment, and obligation 4 is not
   * optional hardening here — it is what obligation 1 leans on.
   */
  workloadReachableOnlyThroughComponent: boolean;
  /**
   * Obligation 2. The component runs in a container or namespace the tenant has
   * no exec, debug, or filesystem access to. This is the one that decides
   * whether the sealed IK is out of the tenant's reach (H-4 §7 probe 3), and
   * therefore the one that decides P3.
   */
  componentIsolatedFromTenant: boolean;
  /**
   * Obligation 3, as amended by §10 C-8. For ComfyUI that reads `output/`,
   * `temp/` and `input/`; for Kohya it is the checkpoint output directory, the
   * sample/logging directory a training run also writes images into, and the
   * dataset directory. A watcher on the checkpoint directory alone misses the
   * sample images, which are artifacts.
   */
  allArtifactVolumesMountedAndWatched: boolean;
  /**
   * Obligation 4 (§10 C-9). Egress from the workload container is denied except
   * through the component. Without it the correct claim is only "every artifact
   * collected through the sanctioned path is witnessed" — and on Kohya, where
   * the workload is a command launcher, "sanctioned path" is doing more work in
   * that sentence than it can bear.
   */
  workloadEgressDeniedExceptThroughComponent: boolean;
}

export const NO_TOPOLOGY_ENFORCEMENT: KohyaTopology = Object.freeze({
  workloadReachableOnlyThroughComponent: false,
  componentIsolatedFromTenant: false,
  allArtifactVolumesMountedAndWatched: false,
  workloadEgressDeniedExceptThroughComponent: false,
});

/**
 * RunPod Pods as RunPod offers them, stated as a topology rather than as an
 * opinion. Every field is false and docs/canon/KOHYA_REPLACEMENT.md §3 gives
 * the per-field reason. This constant exists so that the finding is something
 * the code asserts, not something a document claims.
 */
export const RUNPOD_POD_TOPOLOGY: KohyaTopology = NO_TOPOLOGY_ENFORCEMENT;

/**
 * ASSURANCE COMES FROM OBLIGATIONS 1 AND 2 ONLY, and that is deliberate.
 *
 * PLACEMENT_AND_SURFACES.md §2.2: surface affects COVERAGE, not assurance.
 * Obligations 3 and 4 are coverage obligations — an unwatched volume and an
 * open egress both produce NO LEAF for events that happened, which §2.2 is
 * explicit must not be modelled as a weaker leaf. So they do not move the
 * tier; they are reported separately by `coverageCaveats()` and they belong in
 * the deployment's claim, not in its assurance.
 *
 * Obligations 1 and 2 are the placement question in §4: can the measured party
 * modify the measuring code or reach the key that seals the measurement.
 */
export function enforcementFor(t: KohyaTopology): PlacementEnforcement {
  return t.workloadReachableOnlyThroughComponent && t.componentIsolatedFromTenant
    ? 'isolated-namespace'
    : 'none';
}

/** Obligations 3 and 4, as the sentences a deployment may not say. */
export function coverageCaveats(t: KohyaTopology): string[] {
  const out: string[] = [];
  if (!t.allArtifactVolumesMountedAndWatched) {
    out.push(
      'Not every artifact volume is watched (H-4 §2 obligation 3, §10 C-8). Sample images ' +
        'and checkpoints written outside the watched path produce no leaf at all — an ' +
        'absence, not a weaker leaf. Coverage is established by H-4 §7 probe 4, not here.',
    );
  }
  if (!t.workloadEgressDeniedExceptThroughComponent) {
    out.push(
      'Workload egress is not denied (§10 C-9 obligation 4). A training process can POST a ' +
        'checkpoint anywhere; on Kohya the GUI exists to run commands, so this is the ' +
        'ordinary case rather than an exotic one. The strongest honest claim is about ' +
        'artifacts collected through the sanctioned path.',
    );
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * The two profiles, and the resolution.
 * ──────────────────────────────────────────────────────────────────────── */

/** As shipped — the in-pod `sitecustomize.py` monkey-patch. Mirrors
 *  CANON_HOST_PROFILES.kohya_today and exists here so the two rows sit
 *  side by side where the re-placement is being read. */
export const KOHYA_AS_SHIPPED: HostCaptureProfile = Object.freeze({
  host: 'kohya (in-pod hook, as shipped)',
  hooks: ['model.write'],
  surfaces: ['in-process-callback'],
  fidelity: 'as-written',
  declaredPlacement: 'sidecar-gate',
  enforcement: 'none',
  attestation: 'none',
} as const);

/**
 * The re-placed profile, with `enforcement` supplied by the deployment rather
 * than asserted by the constant. CANON_HOST_PROFILES.kohya_target hardcodes
 * `isolated-namespace` because it describes the TARGET; a running component
 * must not, because that is precisely the assertion §4.2 says to stop taking
 * on trust.
 */
export function kohyaProfile(t: KohyaTopology): HostCaptureProfile {
  return {
    host: 'kohya (re-placed)',
    // `artifact.produced` covers the sample images a run also writes; the
    // checkpoint itself is `model.write`, which is the hook that did not
    // change when the placement did (PLACEMENT_AND_SURFACES.md §7.2).
    hooks: ['model.write', 'artifact.produced'],
    // Both, for the reason lib/capture/surface.ts calls DEFECT-2: naming one
    // is expressible and wrong. The gate's coverage here is the training
    // request, not the artifact — see KOHYA_DUTIES.
    surfaces: ['filesystem-watch', 'network-gate'],
    fidelity: 'as-written',
    declaredPlacement: 'sidecar-gate',
    enforcement: enforcementFor(t),
    // No attestable compute on the training fleets in scope. H-5 chain-to-root
    // is implemented nowhere in the estate, so `verified` is not reachable and
    // the strongest leaf is `passthrough` (PLACEMENT_AND_SURFACES.md §5.2).
    attestation: 'none',
  };
}

export interface KohyaAssurance extends Assurance {
  host: string;
  resolution: PlacementResolution;
  duties: readonly DutyRuling[];
  coverage: string[];
  /** True only when a leaf may be issued for a Kohya checkpoint. */
  mayIssueLeaf: boolean;
}

export function resolveKohyaPlacement(t: KohyaTopology): KohyaAssurance {
  const profile = kohyaProfile(t);
  const resolution = resolvePlacement(profile.declaredPlacement, profile.enforcement);
  const base = assuranceFor(resolution.effective, profile.attestation);
  return {
    ...base,
    host: profile.host,
    resolution,
    duties: KOHYA_DUTIES,
    coverage: coverageCaveats(t),
    // D-8 and PLACEMENT_AND_SURFACES.md §4.1: at `unattested-client`, events
    // may be RECORDED AS DECLARED and may never be reported as witnessed.
    // `canClaim` is the assurance function's own word for it; this alias
    // exists so a caller cannot read past it.
    mayIssueLeaf: base.canClaim && base.leaf !== null,
  };
}
