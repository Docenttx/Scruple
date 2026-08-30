// From a validated job to a process — WO-19.
//
// ---------------------------------------------------------------------------
// THIS IS THE ONLY PLACE A KOHYA COMMAND LINE IS CONSTRUCTED
// ---------------------------------------------------------------------------
//
// Not "should be". Is — and the test suite asserts it by grepping for a second
// construction site. The whole of Studio's `server-library` claim reduces to
// two sentences, and this file owns the second one:
//
//   1. The tenant cannot express a command          → job-spec.ts
//   2. The command we build from what they CAN say
//      contains no flag they influenced the value of → this file
//
// Four rules, and each closes a different way the second sentence fails.
//
// NO SHELL, EVER. `spawn(bin, argv, { shell: false })`. With a shell there is
// no such thing as a safe string, and `output_name` is tenant text. Without
// one, argv elements are opaque to the OS and a semicolon is a semicolon.
//
// NO PATH CROSSES THE BOUNDARY. Ids in, paths out, and `within()` re-checks
// containment after resolution rather than trusting the pattern that let the
// id through. Two checks over one property is not redundancy here: the
// pattern is a syntactic claim and containment is a filesystem one, and
// symlinks are the reason they are different claims.
//
// THE ENVIRONMENT IS THE COMPONENT'S. `PYTHONPATH`, `PYTHONSTARTUP`,
// `LD_PRELOAD` and `PYTHONHOME` are code execution spelled as configuration —
// exactly how the shipped in-pod hook was installed, via `sitecustomize.py` on
// the default path. That mechanism is the reason the old placement was
// `unattested-client`, so the new one starts the trainer with an explicit,
// enumerated environment and passes nothing through.
//
// THE OUTPUT NAME IS RE-CHECKED. Validation ran; this file does not assume it
// did. `buildTrainerArgv` is exported and could be reached by a future caller
// that skipped `validateJobSpec`, and the cost of the re-check is a regex.

import path from 'node:path';

import { classifyKohyaFlag } from './arguments';
import {
  ATTENTION_FLAG,
  PARAMETER_WHITELIST,
  VETTED_SLUG_PATTERNS,
  LR_SCHEDULER,
  OPTIMIZER_TYPE,
  OUTPUT_NAME_PATTERN,
  TRAINING_TYPE_NETWORK_MODULE,
  WHITELIST_BY_NAME,
  baseModelById,
  type ValidatedJobSpec,
} from './job-spec';

/** Roots the component owns. None of them is ever tenant input. */
export interface ComponentRoots {
  /** Read-only. Base model catalog. */
  modelsRoot: string;
  /** Read-write by the upload path, read-only to the trainer in practice. */
  datasetsRoot: string;
  /** The volume the checkpoint watcher observes. */
  outputRoot: string;
  /** Training logs. Watched too — a run that logs is a run that happened. */
  loggingRoot: string;
}

export interface TrainerPlan {
  /** The interpreter. A constant, not a parameter. */
  bin: string;
  argv: string[];
  cwd: string;
  /** The complete environment. Not a delta — a replacement. */
  env: Record<string, string>;
  /** Resolved, containment-checked paths, echoed for the receipt. */
  paths: { dataset: string; baseModel: string; outputDir: string; loggingDir: string };
}

/** Where the trainer lives. The SCRIPT NAME comes from the base-model
 *  catalog entry, not from a flag — there is no `--sdxl` argument; SDXL is a
 *  different entry point. A tenant choosing a base model is choosing which of
 *  two literal programs runs, which is a stronger property than a switch. */
const SD_SCRIPTS_DIR = 'sd-scripts';

/**
 * Containment. `path.resolve` collapses `..` before this runs, so a traversal
 * that survived the id pattern still fails here, and the separator suffix stops
 * `/data/datasets-evil` passing as inside `/data/datasets`.
 */
function within(root: string, candidate: string, what: string): string {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  if (c !== r && !c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) {
    throw new Error(
      `${what} resolved to '${c}', which is outside the component-owned root '${r}'. ` +
        'Refusing. A path that escapes its root is the failure mode job-spec.ts exists to ' +
        'make unexpressible, so reaching this line means something bypassed validation.',
    );
  }
  return c;
}

/**
 * Build the trainer's command line from a validated job.
 *
 * Emission is driven by WHITELIST_BY_NAME rather than by a switch over field
 * names: a parameter that is not in the whitelist has no emission rule, so an
 * unvalidated field cannot reach argv even if it reached this function.
 */
export function buildTrainerArgv(
  spec: ValidatedJobSpec,
  roots: ComponentRoots,
  jobId: string,
): TrainerPlan {
  const trainingType = String(spec.training_type ?? '');
  const networkModule = TRAINING_TYPE_NETWORK_MODULE[trainingType];
  if (!networkModule) {
    throw new Error(
      `training_type '${trainingType}' has no network module. Refusing to guess one.`,
    );
  }

  const model = baseModelById(String(spec.base_model_id ?? ''));
  if (!model) throw new Error(`base_model_id '${String(spec.base_model_id)}' is not in the catalog.`);
  const script = `${SD_SCRIPTS_DIR}/${model.script}`;

  const outputName = String(spec.output_name ?? '');
  if (!OUTPUT_NAME_PATTERN.test(outputName)) {
    throw new Error(
      `output_name '${outputName}' does not match ${String(OUTPUT_NAME_PATTERN)}. Re-checked ` +
        'here rather than assumed: this function is exported and validation is a different ' +
        'function.',
    );
  }

  const datasetId = String(spec.dataset_id ?? '');
  const dataset = within(roots.datasetsRoot, path.join(roots.datasetsRoot, datasetId), 'dataset_id');
  const baseModel = within(roots.modelsRoot, path.join(roots.modelsRoot, model.relPath), 'base_model_id');
  const outputDir = within(roots.outputRoot, path.join(roots.outputRoot, jobId), 'output dir');
  const loggingDir = within(roots.loggingRoot, path.join(roots.loggingRoot, jobId), 'logging dir');

  const argv: string[] = [
    script,
    // ---- component-supplied, every one of them a denied flag with a value
    // ---- the tenant did not choose.
    '--network_module', networkModule,
    '--pretrained_model_name_or_path', baseModel,
    '--train_data_dir', dataset,
    '--output_dir', outputDir,
    '--logging_dir', loggingDir,
  ];

  // Component-supplied lookups, emitted only when the tenant selected a key.
  if (typeof spec.optimizer === 'string') {
    const v = OPTIMIZER_TYPE[spec.optimizer];
    if (!v) throw new Error(`optimizer '${spec.optimizer}' is not in OPTIMIZER_TYPE.`);
    argv.push('--optimizer_type', v);
  }
  if (typeof spec.lr_scheduler === 'string') {
    const v = LR_SCHEDULER[spec.lr_scheduler];
    if (!v) throw new Error(`lr_scheduler '${spec.lr_scheduler}' is not in LR_SCHEDULER.`);
    argv.push('--lr_scheduler', v);
  }
  if (typeof spec.attention === 'string') {
    const v = ATTENTION_FLAG[spec.attention];
    if (!v) throw new Error(`attention '${spec.attention}' is not in ATTENTION_FLAG.`);
    argv.push(v);
  }

  // Everything else: driven by the whitelist's own `emits`.
  const handled = new Set([
    'training_type',
    'base_model_id',
    'dataset_id',
    'optimizer',
    'lr_scheduler',
    'attention',
  ]);
  for (const [name, value] of Object.entries(spec)) {
    if (handled.has(name)) continue;
    const p = WHITELIST_BY_NAME.get(name);
    if (!p) {
      throw new Error(
        `'${name}' has no emission rule. buildTrainerArgv emits only whitelisted parameters, ` +
          'so a field that reached here without a spec is a validation bypass, not a new ' +
          'feature.',
      );
    }
    const flag = p.emits[0];
    if (p.kind === 'boolean') {
      if (value === true) argv.push(flag);
      continue;
    }
    argv.push(flag, String(value));
  }

  // The trainer never sees the tenant's environment because there is no such
  // thing here: this is the whole of it.
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/trainer',
    LANG: 'C.UTF-8',
    PYTHONUNBUFFERED: '1',
    // Refuse the user site-packages directory outright. `sitecustomize.py` on
    // the default path is exactly how the shipped in-pod hook installed itself
    // (research/scruple-kohya-image/Dockerfile), which makes it a demonstrated
    // code-injection point rather than a theoretical one.
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };

  return {
    bin: '/usr/bin/python3',
    argv,
    cwd: '/opt/kohya',
    env,
    paths: { dataset, baseModel, outputDir, loggingDir },
  };
}

/**
 * The one narrow allowance, derived from the whitelist rather than written
 * down twice.
 *
 * placement.ts permits a tenant value after a dangerous flag only when the
 * parameter is a slug whose pattern is in VETTED_SLUG_PATTERNS. This map is
 * the runtime half of the same rule: flag → the pattern its value must match.
 * It is BUILT FROM PARAMETER_WHITELIST, so the static derivation and the
 * runtime check cannot disagree about which flags qualify — a second literal
 * list here is how they would come apart.
 */
export const VETTED_TENANT_FLAG_PATTERNS: ReadonlyMap<string, RegExp> = (() => {
  const m = new Map<string, RegExp>();
  for (const p of PARAMETER_WHITELIST) {
    if (p.valueSource !== 'tenant') continue;
    if (p.kind !== 'slug' || !p.pattern) continue;
    if (!VETTED_SLUG_PATTERNS.has(String(p.pattern))) continue;
    for (const flag of p.emits) m.set(flag, p.pattern);
  }
  return m;
})();

/**
 * A standing assertion over a built command line: no flag in it may be
 * dangerous unless its value came from a component map, or matches a vetted
 * pattern for that flag.
 *
 * Used by the runner before it spawns, and by the test suite over the valid
 * input domain. It is belt-and-braces over a property placement.ts already
 * derives statically — and it is cheap, so if the static derivation is ever
 * wrong this is where it surfaces as a refusal rather than as a process.
 *
 * Returns the offending entries rather than throwing, so a caller can log all
 * of them; the runner turns a non-empty result into a refusal.
 */
export function dangerousFlagsWithTenantValues(
  argv: readonly string[],
  componentSuppliedValues: ReadonlySet<string>,
): string[] {
  const bad: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const cls = classifyKohyaFlag(tok);
    if (cls === 'safe-scalar') continue;
    const next = argv[i + 1];
    const value = next && !next.startsWith('--') ? next : null;
    if (value === null) continue; // a bare switch carries no value to poison
    if (componentSuppliedValues.has(value)) continue;
    const vetted = VETTED_TENANT_FLAG_PATTERNS.get(tok);
    if (vetted && vetted.test(value)) continue;
    bad.push(`${tok} ${value} (${cls ?? 'unclassified'})`);
  }
  return bad;
}

/** Every value the component itself is allowed to place after a dangerous
 *  flag, for the assertion above. */
export function componentSuppliedValues(plan: TrainerPlan): ReadonlySet<string> {
  return new Set<string>([
    ...Object.values(TRAINING_TYPE_NETWORK_MODULE),
    ...Object.values(OPTIMIZER_TYPE),
    ...Object.values(LR_SCHEDULER),
    plan.paths.dataset,
    plan.paths.baseModel,
    plan.paths.outputDir,
    plan.paths.loggingDir,
  ]);
}
