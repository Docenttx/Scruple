// The two axes CANON_SKELETON.md §4 was missing.
//
// §4's host hook contract says WHEN capture fires. It does not say HOW the
// bytes are observed (surface) or WHERE the observing code runs (placement),
// and those two are what decide whether P1 and P3 can hold at all.
//
// Full rationale, the six-host mapping and the named abstraction defects:
//   docs/canon/PLACEMENT_AND_SURFACES.md
//
// Vocabulary note: `AttestationStatus` ('verified' | 'passthrough') is H-5's,
// defined in packages/scruple-attestation-verifiers/src/verifier.ts. It is
// re-declared structurally here rather than imported so that this module has
// no dependency on the verifier package (which pulls in crypto backends), but
// the two MUST stay identical. There is no third value and no default.

/* ────────────────────────────────────────────────────────────────────────
 * Axis 1 — Hook. When capture fires. (CANON_SKELETON.md §4, unchanged.)
 * ──────────────────────────────────────────────────────────────────────── */

export const CAPTURE_HOOKS = [
  'attach',
  'detach',
  'document.open',
  'document.close',
  'document.save',
  'artifact.produced',
  'graph.execute',
  'model.write',
  'idle.tick',
] as const;

export type CaptureHook = (typeof CAPTURE_HOOKS)[number];

/* ────────────────────────────────────────────────────────────────────────
 * Axis 2 — Surface. How the bytes are observed.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A surface is a *mechanism of observation*, not a location. The same value
 * appears at wildly different assurance levels: Kohya's `safetensors.save_file`
 * monkey-patch and a Hugging-Face-shaped vendor calling the SDK from its own
 * inference handler are BOTH `in-process-callback`. What separates them is
 * placement, never surface.
 *
 *   'network-gate'        bytes are observed in transit through a proxy the
 *                         witnessed party cannot route around. ComfyUI's
 *                         POST /prompt, GET /view, and WS binary frames.
 *   'filesystem-watch'    bytes are observed as a completed file. Hash on
 *                         IN_CLOSE_WRITE — tamper-EVIDENT, not tamper-proof
 *                         (H-4 §6): a later edit is a new close and a new hash.
 *   'in-process-callback' capture code runs inside the producing process,
 *                         reached by a hook, patch, or direct SDK call.
 *   'host-api-callback'   the host application hands the event to the capture
 *                         code across a published, host-enforced API boundary
 *                         (bpy handlers, Fusion add-in events, UXP).
 *
 * SURFACE DOES NOT AFFECT ASSURANCE. It affects COVERAGE. A surface that
 * misses an egress path does not produce a weaker leaf — it produces no leaf,
 * for events that happened. That is the ComfyUI two-path finding (H-4 §2)
 * stated as a general property, and it is why `assuranceFor()` below does not
 * take a surface argument.
 */
export const CAPTURE_SURFACES = [
  'network-gate',
  'filesystem-watch',
  'in-process-callback',
  'host-api-callback',
] as const;

export type CaptureSurfaceKind = (typeof CAPTURE_SURFACES)[number];

/* ────────────────────────────────────────────────────────────────────────
 * Axis 3 — Placement. Where the observing code runs.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Placement is NOT topology. It is the answer to one question:
 *
 *     Can the party whose behaviour is being measured modify the code that
 *     measures it, or reach the key that seals the measurement?
 *
 * Kohya's in-pod hook is server-side, runs on a machine the tenant does not
 * own, and is nonetheless `unattested-client`, because the tenant has root in
 * that container. Read the values by that question and only that question.
 *
 *   'server-library'     the vendor's own backend calls the SDK. The measured
 *                        party has no code execution in that process at all.
 *                        P1 is free. P3 is ordinary secret management.
 *   'sidecar-gate'       a separate container/namespace the measured party has
 *                        no exec, debug or filesystem access to, sitting on the
 *                        only route between them and the workload. P1 holds by
 *                        topology and is checkable only by probe (H-4 §7).
 *   'attested-client'    capture runs inside a host application that enforces
 *                        code integrity at load. See PlacementEnforcement —
 *                        this placement must be EARNED, never self-declared.
 *   'unattested-client'  capture code the measured party can read and edit.
 *                        Browser JS, an unsigned add-on, a monkey-patch in a
 *                        container the tenant has root in.
 *
 * The fourth value exists so the model can refuse a shape. A placement that
 * cannot pass is better named than excluded.
 */
export const PLACEMENTS = [
  'server-library',
  'sidecar-gate',
  'attested-client',
  'unattested-client',
] as const;

export type Placement = (typeof PLACEMENTS)[number];

/* ────────────────────────────────────────────────────────────────────────
 * Placement resolution — declared vs. effective.
 *
 * DEFECT-1 in PLACEMENT_AND_SURFACES.md: as three bare axes, a host assigns
 * itself its own assurance tier by naming its placement. Blender and Fusion
 * are the same shape (host plugin, user attests own work) and neither can
 * earn `attested-client` on the strength of being a plugin.
 *
 * Closed by splitting the axis in two: a host DECLARES a placement and an
 * enforcement mechanism; `resolvePlacement()` reduces that pair to an
 * EFFECTIVE placement; `assuranceFor()` consumes only the effective value and
 * stays a pure function of (placement, attestation).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * What actually keeps the measured party out of the capture code. Exactly one
 * of these must be true for the declared placement, or it degrades.
 *
 *   'host-enforced-signature'  the host application verifies a signature at
 *                              load and refuses unsigned code. Earns
 *                              `attested-client`.
 *   'isolated-namespace'       separate container/namespace, no exec, no
 *                              debug, no shared filesystem into the capture
 *                              process; the measured party's only route out
 *                              runs through it. Earns `sidecar-gate`, subject
 *                              to H-4 §7 probes.
 *   'no-tenant-code'           the measured party cannot execute code in the
 *                              capture process at all. Earns `server-library`.
 *   'none'                     nothing enforces it. Everything degrades to
 *                              `unattested-client`.
 *
 * `no-tenant-code` is a property of a CONFIGURATION, not of a vendor. A vendor
 * offering bring-your-own-container or trust_remote_code alongside their
 * managed path has two configurations with two different placements, and
 * certification is per configuration (H-4 §7, EMV L3-style).
 */
export const PLACEMENT_ENFORCEMENTS = [
  'host-enforced-signature',
  'isolated-namespace',
  'no-tenant-code',
  'none',
] as const;

export type PlacementEnforcement = (typeof PLACEMENT_ENFORCEMENTS)[number];

/** Which enforcement each declared placement requires to survive resolution. */
const REQUIRED_ENFORCEMENT: Record<Placement, PlacementEnforcement> = {
  'server-library': 'no-tenant-code',
  'sidecar-gate': 'isolated-namespace',
  'attested-client': 'host-enforced-signature',
  'unattested-client': 'none',
};

export interface PlacementResolution {
  declared: Placement;
  enforcement: PlacementEnforcement;
  effective: Placement;
  /** True when the declared placement survived. */
  honoured: boolean;
  reason: string;
}

/**
 * Reduce a declared placement + its enforcement mechanism to the placement the
 * assurance function is allowed to see. Total over all 4 x 4 combinations.
 *
 * A declared placement is honoured only when its required enforcement is
 * present. Anything else lands on `unattested-client` — never on an
 * intermediate tier, because "some enforcement, but not the one this tier
 * needs" is not a partial claim, it is a different claim that was not made.
 */
export function resolvePlacement(
  declared: Placement,
  enforcement: PlacementEnforcement,
): PlacementResolution {
  const required = REQUIRED_ENFORCEMENT[declared];
  if (enforcement === required) {
    return {
      declared,
      enforcement,
      effective: declared,
      honoured: true,
      reason:
        declared === 'unattested-client'
          ? 'declared unattested; nothing to enforce'
          : `enforcement '${enforcement}' satisfies '${declared}'`,
    };
  }
  return {
    declared,
    enforcement,
    effective: 'unattested-client',
    honoured: false,
    reason:
      `'${declared}' requires enforcement '${required}'; got '${enforcement}'. ` +
      'Degraded to unattested-client — an unenforced placement is a declaration, not a boundary.',
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * The assurance function.
 * ──────────────────────────────────────────────────────────────────────── */

/** H-5's two receipt-visible states. Must equal AttestationStatus in
 *  packages/scruple-attestation-verifiers/src/verifier.ts. */
export type AttestationStatus = 'verified' | 'passthrough';

/**
 * What H-5's `dispatch()` produced for this configuration, reduced to the
 * only three outcomes the assurance function distinguishes.
 *
 *   'verified'    — dispatch returned {ok:true, status:'verified'}: chained to
 *                   the vendor root, nonce matched, inside the freshness
 *                   window. All three, per verifier.ts.
 *   'passthrough' — dispatch returned {ok:true, status:'passthrough'}: stored
 *                   and anchored opaquely. Every built-in plugin in the
 *                   verifiers package is in this position today.
 *   'none'        — no attestation envelope. Note that H-5's dispatch REJECTS
 *                   attestation_type:'none' on a leaf envelope; 'none' here
 *                   means the leaf carries no envelope, not that it carries a
 *                   null one.
 *
 * A hard verification failure (dispatch ok:false) is not an input to this
 * function — the leaf is rejected before assurance is computed.
 */
export const ATTESTATION_OUTCOMES = ['verified', 'passthrough', 'none'] as const;
export type AttestationOutcome = (typeof ATTESTATION_OUTCOMES)[number];

/**
 * Reduce an H-5 VerifyResult to an AttestationOutcome. Structural, so this
 * module need not import the verifiers package.
 */
export function attestationOutcomeOf(
  result: { ok: boolean; status?: AttestationStatus } | null | undefined,
): AttestationOutcome {
  if (!result || !result.ok) return 'none';
  return result.status === 'verified' ? 'verified' : 'passthrough';
}

/**
 * 'holds'       — true by construction of the placement.
 * 'conditional' — true if and only if the named conditions are evidenced.
 *                 Compliance is still binary (Standard §5): 'conditional' is
 *                 a statement about what makes the claim CHECKABLE, not a
 *                 third compliance state.
 * 'fails'       — cannot be true at this placement, by any amount of evidence.
 */
export type PropertyDisposition = 'holds' | 'conditional' | 'fails';

export interface Assurance {
  placement: Placement;
  attestation: AttestationOutcome;
  /** Runtime boundary integrity — capture code not modifiable by the measured party. */
  p1: PropertyDisposition;
  /** Signing/API key custody — key unreachable by the measured party. */
  p3: PropertyDisposition;
  /**
   * The leaf's attestation status, or null when NO LEAF MAY BE ISSUED.
   * null is not an AttestationStatus and never reaches H-5's dispatch; it
   * means the configuration is refused before a leaf exists.
   */
  leaf: AttestationStatus | null;
  /**
   * Can this configuration claim the Standard at all? False only at
   * `unattested-client`, where it is false regardless of attestation.
   */
  canClaim: boolean;
  /** What must be evidenced for every 'conditional' above to be true. */
  conditions: string[];
  reason: string;
}

const PROBE_CONDITIONS = [
  'H-4 §7 probe 1: the measured party cannot reach the workload bypassing the gate',
  'H-4 §7 probe 2: the measured party cannot reach the component admin/provisioning surface',
  'H-4 §7 probe 4: a file written into the output volume produces a leaf within the drain window',
  'H-4 §7 probe 5: output retrieved over the non-file path produces a leaf',
];

/**
 * ASSURANCE IS A PURE FUNCTION OF PLACEMENT AND ATTESTATION, AND NOTHING ELSE.
 *
 * Not of surface, not of hook, not of host, not of modality. That is the
 * property that makes the skeleton general: a new host is onboarded by naming
 * its hooks, its surfaces and its placement, and never by writing new evidence
 * logic.
 *
 * Total over all 4 placements x 3 attestation outcomes.
 */
export function assuranceFor(
  placement: Placement,
  attestation: AttestationOutcome,
): Assurance {
  // Rule 1 — the refusal, and it is unconditional.
  //
  // Attestation is deliberately IGNORED here. A page or a patched hook can
  // relay a genuine root-verified SEV-SNP quote it obtained from somewhere
  // else; that quote proves something about a machine, and nothing about the
  // capture. Letting attestation lift this tier would make the standard
  // claimable by anyone who can make one HTTP request.
  if (placement === 'unattested-client') {
    return {
      placement,
      attestation,
      p1: 'fails',
      p3: 'fails',
      leaf: null,
      canClaim: false,
      conditions: [],
      reason:
        'unattested-client: the measured party can modify the capture code and reach its key. ' +
        'Cannot claim the standard. Events may be RECORDED as declared, never as witnessed (D-8). ' +
        'Attestation is ignored at this placement by design.',
    };
  }

  let p1: PropertyDisposition;
  let conditions: string[] = [];

  switch (placement) {
    case 'server-library':
      // The measured party has no code execution in the capture process.
      // P1 is structural — there is nothing to probe.
      p1 = 'holds';
      break;
    case 'sidecar-gate':
      // P1 holds by topology, and topology is the vendor's to get right.
      // Checkable, not provable (H-4 §6).
      p1 = 'conditional';
      conditions = [...PROBE_CONDITIONS];
      break;
    case 'attested-client':
      // The host application enforces the boundary. We have verified the
      // enforcement mechanism exists (resolvePlacement); we have not verified
      // that this install is running the signed build.
      p1 = 'conditional';
      conditions = [
        'the host verifies the plugin signature at load and refuses unsigned code',
        'the running build measurement matches a build we published',
        'the host does not expose a scripting console that can call the plugin with forged arguments',
      ];
      break;
  }

  // P3 — key custody. This is where attestation buys something concrete:
  // sealing the initial key to the build measurement (H-4 §4.4) turns
  // "software-protected, and the tenant is not that user" into
  // "a modified build cannot unseal it".
  let p3: PropertyDisposition;
  if (placement === 'server-library') {
    p3 = 'holds';
  } else if (attestation === 'verified') {
    p3 = 'holds';
  } else {
    p3 = 'conditional';
    conditions = [
      ...conditions,
      'the sealed key is 0600 and owned by a principal the measured party is not (H-4 §4.4)',
    ];
  }

  // The leaf. H-5's vocabulary, unchanged: 'verified' requires a root-chained
  // attestation. Everything else is 'passthrough' and says so on the receipt
  // (Standard §12.4 — "Stored" MUST NOT read as "verified").
  const leaf: AttestationStatus = attestation === 'verified' ? 'verified' : 'passthrough';

  return {
    placement,
    attestation,
    p1,
    p3,
    leaf,
    canClaim: true,
    conditions,
    reason:
      `${placement} + attestation:${attestation} → P1 ${p1}, P3 ${p3}, leaf ${leaf}. ` +
      (leaf === 'passthrough'
        ? 'No root-chained attestation, so the leaf is passthrough and the receipt must read as such.'
        : 'Root-chained attestation present; the key is sealed to the build measurement.'),
  };
}

/** Every (placement, attestation) pair, for exhaustiveness testing. */
export function allAssuranceCells(): Assurance[] {
  const out: Assurance[] = [];
  for (const p of PLACEMENTS) {
    for (const a of ATTESTATION_OUTCOMES) out.push(assuranceFor(p, a));
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * The CaptureSurface interface.
 *
 * Shape follows TestifySec witness's Attestor (Name / Type / RunType /
 * Attest / Schema) as translated in docs/canon/oss-study/witness.md §6.1.
 * That study's `CapturePlugin` is the EVIDENCE contract — what gets captured,
 * in which phase. `CaptureSurface` is the TRANSPORT contract — how the bytes
 * are seen at all. A surface hosts capture plugins; it does not replace them.
 *
 * CAVEAT CARRIED FROM THAT STUDY, VERBATIM IN SPIRIT: witness's attestors are
 * compiled in via Go `init()` and are not hot-pluggable. Neither are these.
 * Registration is an explicit call made at build/startup time by code we
 * publish and measure. There is no dynamic plugin loading, and there will not
 * be one — a capture surface loaded at runtime from a path the measured party
 * can write to is `unattested-client` by definition, whatever its placement
 * claims.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * DEFECT-3, closed here. The surface axis as given conflates two things that
 * produce very different evidence:
 *
 *   'as-delivered' the surface saw the exact bytes the consumer received.
 *                  A network gate on GET /view. Strongest: a third party
 *                  holding the artifact can re-hash it and match the leaf.
 *   'as-written'   the surface saw the exact bytes the host wrote to disk.
 *                  IN_CLOSE_WRITE; Blender reading back scene.render.filepath.
 *                  Equally checkable, but tamper-EVIDENT only — a later edit
 *                  is a new close and a new hash (H-4 §6).
 *   'induced'      the surface CAUSED a serialization to exist and hashed
 *                  that. Fusion's add-in drives ExportManager into a tempfile,
 *                  hashes it, and unlinks it. The hashed artifact is not the
 *                  artifact the user keeps, and unless the host's exporter is
 *                  byte-deterministic NOBODY CAN EVER RE-DERIVE THE HASH.
 *
 * Fidelity does NOT enter the assurance function — it is not a statement about
 * who could tamper with the capture code. It is a statement about whether the
 * resulting leaf is checkable by a third party holding the artifact, which is
 * precisely the adversary model the desktop plugins exist for. A leaf at
 * 'induced' fidelity with no retained artifact is evidence only Scruple can
 * read, which is the opposite of the plugin claim.
 *
 * It is a property of the observation and not a fifth surface value because it
 * cross-cuts: a network-gate is normally 'as-delivered', a filesystem-watch
 * 'as-written', and a host-api-callback can be any of the three.
 */
export const OBSERVATION_FIDELITIES = ['as-delivered', 'as-written', 'induced'] as const;
export type ObservationFidelity = (typeof OBSERVATION_FIDELITIES)[number];

/** Hash + declared metadata for one observed artifact. */
export interface ObservedBytes {
  /** See ObservationFidelity. Required — there is no safe default. */
  fidelity: ObservationFidelity;
  /**
   * Required when fidelity is 'induced': where the hashed serialization can be
   * obtained again. A surface that induces bytes, hashes them and deletes them
   * without retaining or addressing them emits a leaf nobody can check.
   */
  inducedArtifactRef?: string;
  /** SHA-256, streamed. Hex, no prefix. */
  contentHash: string;
  /**
   * DECLARED, NEVER GUESSED (CANON_SKELETON.md §5 property 1). The surface
   * takes this from the producing node's type, the host API, or the gate's
   * declared content type — never from an extension, never from
   * mimetypes.guess_type(). A surface that cannot determine a MIME must emit
   * the observation without one and let the SDK refuse, rather than supply a
   * placeholder.
   */
  mime?: string;
  sizeBytes?: number;
}

/** One thing the surface saw. Emitted to the sink; never sent by the surface. */
export interface CaptureObservation {
  hook: CaptureHook;
  surface: CaptureSurfaceKind;
  /** Correlates observations belonging to one logical event (ComfyUI prompt_id). */
  correlationId?: string;
  bytes?: ObservedBytes;
  /**
   * Hook-shaped evidence: the workflow graph for `graph.execute`, the training
   * config for `model.write`, the document context for `document.save`.
   * Opaque here; its schema is the capture plugin's, per witness §6.1.
   */
  evidence?: Record<string, unknown>;
  observedAt: string;
}

/**
 * Where observations go. The surface calls this and nothing else.
 *
 * Implemented by the SDK. NOT implemented by the surface, and this is the
 * whole point of the seam: CANON_SKELETON.md §5's rule for adapters binds
 * surfaces identically. A surface MAY NOT construct an HTTP request, handle
 * payment, decide MIME, decide applicability, or write its own retry. It also
 * may not compute a MAC, touch the ratchet counter, or decide whether a leaf
 * is verified or passthrough. If a surface needs one of those, the SDK is
 * missing something and the SDK is where it gets added.
 */
export interface ObservationSink {
  emit(o: CaptureObservation): Promise<void>;
}

export interface CaptureSurfaceContext {
  sink: ObservationSink;
  /** Effective placement, already resolved. Informational to the surface. */
  placement: Placement;
  /** Free-form vendor topology config (bind address, watched path, …). */
  config: Record<string, unknown>;
}

/**
 * Lifecycle: open → observe(*) → close.
 *
 *   open()    acquire the observation position — bind the gate, start the
 *             inotify watch, install the host callback. MUST throw if the
 *             position cannot be acquired: a surface that silently fails to
 *             open is the ComfyUI WS gap by another name.
 *   observe() the surface drives this itself from its own event source and
 *             emits to the sink. It is on the interface so a host that has no
 *             event source of its own (idle.tick) can be pumped.
 *   close()   release, and flush anything the sink has not taken. Does not
 *             drain the SDK queue; that is the SDK's.
 */
export interface CaptureSurface {
  /** Stable identifier, e.g. "comfyui-http-gate". */
  name(): string;
  /** Versioned predicate URI, e.g. "scruple.dev/evidence/comfyui-workflow/v1". */
  evidenceType(): string;
  /** Which of the four mechanisms this is. */
  surface(): CaptureSurfaceKind;
  /** What the bytes this surface hashes actually are. See ObservationFidelity. */
  fidelity(): ObservationFidelity;
  /** Which §4 hooks this surface can serve. Declared, checked at registration. */
  hooks(): readonly CaptureHook[];
  /** Where this surface's code runs, as DECLARED. Resolved before it is trusted. */
  placement(): Placement;
  /** What enforces that placement. */
  enforcement(): PlacementEnforcement;
  /** JSON Schema of this surface's own evidence shape (witness Attestor.Schema). */
  schema(): Record<string, unknown>;

  open(ctx: CaptureSurfaceContext): Promise<void>;
  observe(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A host's declared capture configuration: which surfaces, covering which
 * hooks, at what effective placement.
 *
 * DEFECT-2, NOT CLOSED: nothing in this type — or in the three axes — can say
 * that a set of surfaces COVERS every egress path of a host. ComfyUI needs two
 * surfaces and a config naming one is expressible and wrong. Completeness is
 * established outside the model, by H-4 §7 probes 4 and 5 and by ratchet gap
 * accounting (H-4 §4.2). See PLACEMENT_AND_SURFACES.md.
 */
export interface HostCaptureProfile {
  host: string;
  hooks: readonly CaptureHook[];
  surfaces: readonly CaptureSurfaceKind[];
  fidelity: ObservationFidelity;
  declaredPlacement: Placement;
  enforcement: PlacementEnforcement;
  attestation: AttestationOutcome;
}

export interface HostAssurance extends Assurance {
  host: string;
  resolution: PlacementResolution;
}

/** Resolve a host profile all the way to its assurance. */
export function assuranceForHost(profile: HostCaptureProfile): HostAssurance {
  const resolution = resolvePlacement(profile.declaredPlacement, profile.enforcement);
  return {
    host: profile.host,
    resolution,
    ...assuranceFor(resolution.effective, profile.attestation),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Registration. Explicit, static, build-time. See the caveat above.
 * ──────────────────────────────────────────────────────────────────────── */

const surfaceRegistry = new Map<string, CaptureSurface>();

export function registerCaptureSurface(s: CaptureSurface): void {
  if (surfaceRegistry.has(s.name())) {
    throw new Error(`capture surface '${s.name()}' already registered`);
  }
  if (s.hooks().length === 0) {
    throw new Error(`capture surface '${s.name()}' declares no hooks`);
  }
  surfaceRegistry.set(s.name(), s);
}

export function registeredSurfaces(): string[] {
  return Array.from(surfaceRegistry.keys()).sort();
}

/** Test hook. Do not call from production code. */
export function _resetSurfaceRegistryForTests(): void {
  surfaceRegistry.clear();
}

/* ────────────────────────────────────────────────────────────────────────
 * The six mapped hosts. This is the WO's acceptance test made executable:
 * the table in PLACEMENT_AND_SURFACES.md and this constant must agree, and
 * test/v2/placement.test.ts is what holds them together.
 *
 * `declaredPlacement` is what the host or the WO series CLAIMS.
 * `enforcement` is what is actually true TODAY, on evidence.
 * The gap between them is the finding, not an oversight.
 * ──────────────────────────────────────────────────────────────────────── */

export const CANON_HOST_PROFILES: Record<string, HostCaptureProfile> = {
  // Two surfaces, neither sufficient alone (H-4 §2). Modal has no attestable
  // compute today, so the strongest leaf this reference path can demonstrate
  // is passthrough — the open question in H-4 §9.
  comfyui: {
    host: 'comfyui',
    hooks: ['attach', 'detach', 'graph.execute', 'artifact.produced'],
    surfaces: ['network-gate', 'filesystem-watch'],
    fidelity: 'as-delivered',
    declaredPlacement: 'sidecar-gate',
    enforcement: 'isolated-namespace',
    attestation: 'none',
  },

  // As shipped. The pod-side monkey-patch is server code the tenant has root
  // over, and SCRUPLE_APPS_WITNESS_SECRET is readable from inside it.
  kohya_today: {
    host: 'kohya (as shipped)',
    hooks: ['model.write'],
    surfaces: ['in-process-callback'],
    fidelity: 'as-written',
    declaredPlacement: 'sidecar-gate',
    enforcement: 'none',
    attestation: 'none',
  },

  // WO-11's second half: the pod stops being where measurement happens.
  kohya_target: {
    host: 'kohya (re-placed)',
    hooks: ['model.write', 'artifact.produced'],
    surfaces: ['filesystem-watch', 'network-gate'],
    fidelity: 'as-written',
    declaredPlacement: 'sidecar-gate',
    enforcement: 'isolated-namespace',
    attestation: 'none',
  },

  // The vendor's managed inference path. No tenant code in the process.
  vendor_managed: {
    host: 'server-library vendor (HF-shaped, managed path)',
    hooks: ['attach', 'graph.execute', 'artifact.produced'],
    surfaces: ['in-process-callback'],
    fidelity: 'as-delivered',
    declaredPlacement: 'server-library',
    enforcement: 'no-tenant-code',
    attestation: 'verified',
  },

  // The SAME vendor's custom-handler / BYO-container / trust_remote_code path.
  // Same SDK call, same surface, different configuration, different placement.
  vendor_custom_handler: {
    host: 'server-library vendor (custom handler / BYO container)',
    hooks: ['attach', 'graph.execute', 'artifact.produced'],
    surfaces: ['in-process-callback'],
    fidelity: 'as-delivered',
    declaredPlacement: 'server-library',
    enforcement: 'none',
    attestation: 'verified',
  },

  // Declared attested-client throughout the WO series. Manifest carries
  // editEnabled:true, install is a robocopy of readable .py, the API key sits
  // in plaintext at %APPDATA%\ScrupleFusion.key. Nothing enforces the boundary.
  fusion_today: {
    host: 'Fusion 360 add-in (as shipped)',
    hooks: ['attach', 'detach', 'document.open', 'document.save', 'idle.tick'],
    surfaces: ['host-api-callback'],
    fidelity: 'induced',
    declaredPlacement: 'attested-client',
    enforcement: 'none',
    attestation: 'none',
  },

  // The same add-in once the host verifies a signature at load. Expressed now,
  // implemented later — this is the WO's "design for a host we have not met".
  fusion_attested: {
    host: 'Fusion 360 add-in (signed, host-verified)',
    hooks: ['attach', 'detach', 'document.open', 'document.save', 'idle.tick'],
    surfaces: ['host-api-callback'],
    fidelity: 'as-written',
    declaredPlacement: 'attested-client',
    enforcement: 'host-enforced-signature',
    attestation: 'none',
  },

  // Extension zip built with plain `zip -qr`; no signing step exists.
  blender: {
    host: 'Blender add-on',
    hooks: ['attach', 'detach', 'document.save', 'artifact.produced'],
    surfaces: ['host-api-callback', 'filesystem-watch'],
    fidelity: 'as-written',
    declaredPlacement: 'attested-client',
    enforcement: 'none',
    attestation: 'none',
  },

  // The hostile case. Refused, and refused even holding a genuine quote.
  browser_js: {
    host: 'browser JS',
    hooks: ['document.save', 'artifact.produced'],
    surfaces: ['in-process-callback'],
    fidelity: 'as-delivered',
    declaredPlacement: 'unattested-client',
    enforcement: 'none',
    attestation: 'verified',
  },
};
