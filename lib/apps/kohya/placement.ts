// Where Studio's Kohya runs, DERIVED — WO-19.
//
// ---------------------------------------------------------------------------
// THE POINT OF THIS FILE
// ---------------------------------------------------------------------------
//
// `PLACEMENT_AND_SURFACES.md` §4.2: a placement is a CLAIM about enforcement,
// and a claim without its enforcement resolves to `unattested-client` — never
// to an intermediate tier. profile.ts made a vendor DECLARE the four sidecar
// obligations because nothing in this process can see a vendor's topology.
//
// Studio is different, and the difference is the whole of WO-19. Studio's
// Kohya configuration is not a vendor's topology we have to take on trust; it
// is a table in this repository. So most of the enforcement is not declared
// here — it is COMPUTED from job-spec.ts's whitelist and arguments.ts's
// classification, and a change to either moves the tier without anybody
// remembering to update a boolean.
//
// Concretely: if someone adds a parameter to PARAMETER_WHITELIST that emits a
// code-bearing flag with a tenant-chosen value — the "advanced: paste your own
// args" box, in whatever costume it arrives wearing — `deriveEnforcement()`
// returns `none`, `resolvePlacement()` degrades Studio to
// `unattested-client`, and `test/v2/kohya-jobapi.test.ts` goes red. That is
// the property this file exists to have. It is not a lint rule; it is the
// tier.
//
// WHAT IS STILL DECLARED, SAID PLAINLY. Two obligations cannot be derived from
// source in this process and are marked `declaration` in every finding they
// produce: that the container exposes no code-executing surface, and that the
// component is PID 1 with the trainer as its child. Both are properties of the
// image and the pod spec, and both are H-4 §7 probe territory. A declaration
// that is wrong is the vendor's accountable act (H-4 §1) — and here the vendor
// is us, which is why the report says which items still need a probe run.

import {
  assuranceFor,
  resolvePlacement,
  type Assurance,
  type Placement,
  type PlacementEnforcement,
  type PlacementResolution,
} from '../../capture/surface';
import { KOHYA_ARGUMENT_CLASS, classifyKohyaFlag, type KohyaArgumentClass } from './arguments';
import { PARAMETER_WHITELIST, VETTED_SLUG_PATTERNS, type ParameterSpec } from './job-spec';

/* ────────────────────────────────────────────────────────────────────────
 * What the container exposes to the tenant.
 * ──────────────────────────────────────────────────────────────────────── */

export const TENANT_SURFACES = [
  'training-job-api',
  'dataset-upload',
  'artifact-download',
  'progress-stream',
  'kohya-gui',
  'jupyter',
  'web-terminal',
  'ssh',
  'file-manager',
] as const;

export type TenantSurface = (typeof TENANT_SURFACES)[number];

/**
 * Which surfaces hand the tenant code execution inside the container.
 *
 * `kohya-gui` is the entry that matters and it is the finding
 * docs/canon/KOHYA_REPLACEMENT.md §3 turns on: Gradio is not a form, it is a
 * training-command launcher whose entire function is to take a form and run a
 * process with those arguments. Exposing it is granting a shell with extra
 * steps, and it is a grant WE made — RunPod hands the customer no console, no
 * SSH and no exec, because the pod runs under our API key.
 *
 * `file-manager` is `false` and the false is deliberate rather than casual:
 * writing bytes into a volume is not code execution ON ITS OWN. It becomes
 * code execution the moment anything in the container imports from a path the
 * tenant can write — which is why `--network_module`, `--dataset_class` and
 * PYTHONPATH are denied in job-spec.ts and why the trainer's environment is
 * scrubbed in argv.ts. The two facts have to hold together; either alone is
 * not enough.
 */
export const SURFACE_GRANTS_CODE_EXECUTION: Readonly<Record<TenantSurface, boolean>> =
  Object.freeze({
    'training-job-api': false,
    'dataset-upload': false,
    'artifact-download': false,
    'progress-stream': false,
    'kohya-gui': true,
    jupyter: true,
    'web-terminal': true,
    ssh: true,
    'file-manager': false,
  });

/* ────────────────────────────────────────────────────────────────────────
 * The configuration.
 * ──────────────────────────────────────────────────────────────────────── */

export interface StudioKohyaConfiguration {
  readonly label: string;
  /** Every surface reachable by the tenant. DECLARED — a property of the image. */
  readonly tenantSurfaces: readonly TenantSurface[];
  /** The accepted parameter set. DERIVED from — and checked against — arguments.ts. */
  readonly whitelist: readonly ParameterSpec[];
  /** DECLARED — a property of the image's CMD. */
  readonly componentIsPid1: boolean;
  /** DECLARED — a property of how the component starts the trainer. */
  readonly trainerIsChildOfComponent: boolean;
}

export type FindingBasis = 'derived' | 'declaration';

export interface EnforcementFinding {
  obligation: string;
  holds: boolean;
  /**
   * `derived` — this process computed it from the tables in this directory,
   * so it cannot silently drift from what the code does.
   * `declaration` — a property of the image or the pod spec that no code in
   * this process can see. H-4 §7 probes are what turn one of these into
   * evidence; until then it is a claim, and the report says so.
   */
  basis: FindingBasis;
  reason: string;
}

/** Classes a parameter may emit with a TENANT-chosen value with no further
 *  argument. Everything else must be component-supplied from a closed map, or
 *  must qualify for the one narrow exception below. */
const TENANT_SAFE_CLASSES: ReadonlySet<KohyaArgumentClass> = new Set<KohyaArgumentClass>([
  'safe-scalar',
]);

/**
 * THE ONE EXCEPTION, and it is narrow on purpose.
 *
 * `--output_name` is `path-bearing` — a filename stem with no upstream
 * sanitization — and the tenant chooses it, because a tenant who cannot name
 * their own model is being handed a worse product to buy a property they
 * already have. What makes that safe is not the intention; it is the anchored
 * pattern. So the exception is granted to the PATTERN, not to the parameter:
 * the slug's regex must be in VETTED_SLUG_PATTERNS, and membership there is
 * earned by surviving job-spec.ts's HOSTILE_SLUGS corpus at module load.
 *
 * Nothing else qualifies. A second path-bearing tenant field would have to
 * bring its own vetted pattern through the same corpus, and a code-, kwargs-,
 * config-expansion-, unpickle-, egress- or launcher-bearing flag can never
 * qualify however it is spelled.
 */
function tenantValuePermitted(p: ParameterSpec, cls: KohyaArgumentClass | 'unclassified'): boolean {
  if (TENANT_SAFE_CLASSES.has(cls as KohyaArgumentClass)) return true;
  if (cls !== 'path-bearing') return false;
  if (p.kind !== 'slug' || !p.pattern) return false;
  return VETTED_SLUG_PATTERNS.has(String(p.pattern));
}

/**
 * THE DERIVATION.
 *
 * `no-tenant-code` is returned only when every obligation below holds. The
 * whitelist obligations are computed; the topology obligations are declared.
 * Both must hold, so a true declaration cannot rescue a leaky whitelist and a
 * tight whitelist cannot rescue an exposed Gradio port.
 */
export function deriveEnforcement(cfg: StudioKohyaConfiguration): {
  enforcement: PlacementEnforcement;
  findings: EnforcementFinding[];
} {
  const findings: EnforcementFinding[] = [];

  /* --- 1. No exposed surface grants code execution. DECLARED. ---------- */
  const executing = cfg.tenantSurfaces.filter((s) => SURFACE_GRANTS_CODE_EXECUTION[s]);
  findings.push({
    obligation: 'no exposed tenant surface grants code execution in the container',
    holds: executing.length === 0,
    basis: 'declaration',
    reason: executing.length
      ? `exposed: ${executing.join(', ')}. Kohya's GUI is a training-command launcher; a gate ` +
        'in front of it is a gate in front of a remote shell (KOHYA_REPLACEMENT.md §2).'
      : `exposed surfaces are ${cfg.tenantSurfaces.join(', ') || '(none)'} — none of which ` +
        'runs tenant-supplied code. Establish by H-4 §7 probe 1 (the tenant cannot reach ' +
        'the workload except through the component); this process cannot see a port map.',
  });

  /* --- 2. No parameter is a free string. DERIVED. ---------------------- */
  // There is no 'string' kind in ParameterKind, so this is a type-level
  // property already — but a type is erased at runtime and a cast is one line,
  // so it is also checked here over the actual array.
  const freeForm = cfg.whitelist.filter(
    (p) => !['enum', 'integer', 'number', 'boolean', 'slug', 'catalog-id'].includes(p.kind),
  );
  findings.push({
    obligation: 'every accepted parameter has a closed domain — no free-form string field',
    holds: freeForm.length === 0,
    basis: 'derived',
    reason: freeForm.length
      ? `free-form: ${freeForm.map((p) => p.name).join(', ')}`
      : `${cfg.whitelist.length} parameters, every one an enum, a bounded number, a boolean ` +
        'or a pattern-matched slug. A tenant cannot express a command because there is ' +
        'nowhere to write one.',
  });

  /* --- 3. Dangerous flags are never tenant-valued. DERIVED. ------------ */
  const leaks: string[] = [];
  for (const p of cfg.whitelist) {
    for (const flag of p.emits) {
      const cls = classifyKohyaFlag(flag) ?? 'unclassified';
      if (p.valueSource === 'component') continue;
      if (tenantValuePermitted(p, cls)) continue;
      leaks.push(`${p.name} → ${flag} (${cls}, tenant-valued)`);
    }
  }
  findings.push({
    obligation:
      'every flag classified anything other than `safe-scalar` is emitted with a ' +
      'component-supplied value, or with tenant text constrained by a vetted pattern',
    holds: leaks.length === 0,
    basis: 'derived',
    reason: leaks.length
      ? leaks.join('; ')
      : 'the code-, unpickle- and path-bearing flags Studio must still emit ' +
        '(--network_module, --optimizer_type, --pretrained_model_name_or_path, ' +
        '--train_data_dir, --output_dir, --logging_dir) all take their value from a frozen ' +
        'map or from a component-owned root: the tenant supplies an index, never a string. ' +
        'The single exception is --output_name, whose pattern is in VETTED_SLUG_PATTERNS and ' +
        'is therefore asserted against a hostile corpus at load.',
  });

  /* --- 4. Nothing is emitted that nobody classified. DERIVED. ---------- */
  const unclassified = [
    ...new Set(
      cfg.whitelist.flatMap((p) => p.emits).filter((f) => !Object.hasOwn(KOHYA_ARGUMENT_CLASS, f)),
    ),
  ];
  findings.push({
    obligation: 'every emitted flag appears in the classification table',
    holds: unclassified.length === 0,
    basis: 'derived',
    reason: unclassified.length
      ? `unclassified and therefore denied: ${unclassified.join(', ')}`
      : 'an argument that cannot be classified is denied, so an emitted flag missing from ' +
        'arguments.ts is a refusal rather than an omission.',
  });

  /* --- 5. Component is PID 1, trainer is its child. DECLARED. ---------- */
  findings.push({
    obligation: 'the component is PID 1 and the trainer runs as its child',
    holds: cfg.componentIsPid1 && cfg.trainerIsChildOfComponent,
    basis: 'declaration',
    reason:
      cfg.componentIsPid1 && cfg.trainerIsChildOfComponent
        ? 'the component owns process 1, so it starts before any trainer exists and killing ' +
          'it ends the container rather than leaving a trainer running unobserved. This is a ' +
          "property of the image's CMD (research/scruple-kohya-image/) and of the spawn in " +
          'services/scruple-capture/kohya/job-runner.ts — H-4 §7 probe territory, not ' +
          'something this process can read.'
        : 'the component does not own process 1, or the trainer is not its child. A trainer ' +
          'that outlives or precedes the component writes checkpoints nobody watched.',
  });

  const holds = findings.every((f) => f.holds);
  return { enforcement: holds ? 'no-tenant-code' : 'none', findings };
}

/* ────────────────────────────────────────────────────────────────────────
 * The two configurations. Certification is per configuration, not per
 * vendor (PLACEMENT_AND_SURFACES.md §4.2), and Studio has two.
 * ──────────────────────────────────────────────────────────────────────── */

/** WO-19's shape. The GUI is not exposed; the job API is. */
export const STUDIO_JOB_API_CONFIGURATION: StudioKohyaConfiguration = Object.freeze({
  label: 'Studio Kohya, job-submission API (WO-19)',
  tenantSurfaces: Object.freeze([
    'training-job-api',
    'dataset-upload',
    'artifact-download',
    'progress-stream',
  ] as TenantSurface[]),
  whitelist: PARAMETER_WHITELIST,
  componentIsPid1: true,
  trainerIsChildOfComponent: true,
});

/** What Studio ships today, kept so the two sit side by side and so the test
 *  suite asserts the difference rather than asserting the improvement alone. */
export const STUDIO_GUI_CONFIGURATION: StudioKohyaConfiguration = Object.freeze({
  label: 'Studio Kohya, Gradio GUI (as shipped before WO-19)',
  tenantSurfaces: Object.freeze(['kohya-gui'] as TenantSurface[]),
  whitelist: Object.freeze([] as ParameterSpec[]),
  componentIsPid1: false,
  trainerIsChildOfComponent: false,
});

export interface StudioKohyaAssurance extends Assurance {
  configuration: string;
  declaredPlacement: Placement;
  resolution: PlacementResolution;
  findings: EnforcementFinding[];
  /** True only when a leaf may be issued for a checkpoint from this shape. */
  mayIssueLeaf: boolean;
  /** The findings a probe must establish before the tier is evidence. */
  needsProbe: string[];
}

/**
 * DECLARED `server-library`, and it survives only if `deriveEnforcement`
 * returns `no-tenant-code`. Attestation is `none`: RunPod's fleets are not
 * attestable and H-5 root chaining is implemented nowhere in the estate, so
 * the strongest leaf reachable is `passthrough` — the top-right cell of
 * PLACEMENT_AND_SURFACES.md §5.2, where P1 and P3 both HOLD and the leaf is
 * still `passthrough`. That is the honest ceiling and this WO does not raise it.
 */
export function resolveStudioKohyaPlacement(
  cfg: StudioKohyaConfiguration,
): StudioKohyaAssurance {
  const { enforcement, findings } = deriveEnforcement(cfg);
  const resolution = resolvePlacement('server-library', enforcement);
  const base = assuranceFor(resolution.effective, 'none');
  return {
    ...base,
    configuration: cfg.label,
    declaredPlacement: 'server-library',
    resolution,
    findings,
    mayIssueLeaf: base.canClaim && base.leaf !== null,
    needsProbe: findings.filter((f) => f.basis === 'declaration').map((f) => f.obligation),
  };
}

/** The shipped answer, computed once. */
export function studioJobApiAssurance(): StudioKohyaAssurance {
  return resolveStudioKohyaPlacement(STUDIO_JOB_API_CONFIGURATION);
}
