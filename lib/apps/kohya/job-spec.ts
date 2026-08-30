// The tenant-facing training surface for Studio's Kohya — WO-19.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS FOR, IN ONE SENTENCE
// ---------------------------------------------------------------------------
//
// It is the reason Studio's Kohya can be `server-library` instead of
// `unattested-client`, and the only reason. Everything else in WO-19 —
// the PID-1 component, the container that exposes no Gradio port, the
// watcher that survived the move — is downstream of the single property
// this file establishes:
//
//     THE TENANT CANNOT EXPRESS A COMMAND.
//
// docs/canon/KOHYA_REPLACEMENT.md §3 established that RunPod is not what
// hands the tenant root. We are. Pods run under our API key; RunPod gives the
// customer no console, no SSH, no exec. Every bit of code execution inside
// that container was granted by Kohya's GUI, which is a training-command
// launcher we chose to expose. Take the launcher away and put a job-submission
// API in its place and the tenant's code-execution surface is exactly the set
// of parameters enumerated below — no more, by construction rather than by
// policy.
//
// ---------------------------------------------------------------------------
// SO THE WHITELIST IS THE DELIVERABLE, NOT A DETAIL
// ---------------------------------------------------------------------------
//
// A job API that accepts one free-form string reverts Studio to
// `unattested-client` silently. `PLACEMENT_AND_SURFACES.md` §7.3 records this
// for a vendor's custom-handler path and calls it the most commercially
// important line in the document: `no-tenant-code` is a property of a
// CONFIGURATION, and one "advanced: paste your own args" box is a second
// configuration with a different tier hiding inside the first.
//
// Three structural choices follow, and each is load-bearing:
//
//   1. DEFAULT DENY. `validateJobSpec` refuses any key not in
//      PARAMETER_WHITELIST. An argument nobody classified is denied, which is
//      the only safe default when the upstream argument parser grows between
//      releases (see arguments.ts, PINNING).
//
//   2. NO PATHS EVER CROSS THE BOUNDARY. The tenant names a dataset and a base
//      model by CATALOG ID. The component turns ids into paths under roots it
//      owns. There is no field in which a path can be written, so there is no
//      path to traverse.
//
//   3. THE DANGEROUS FLAGS ARE STILL EMITTED — BY US. `--network_module` is an
//      import path and Studio has to pass one. The tenant supplies
//      `training_type: 'lora'`; COMPONENT_SUPPLIED_VALUES turns that into the
//      literal `networks.lora`. The tenant selects from a closed set; the
//      tenant never supplies the string. `deriveEnforcement()` in placement.ts
//      checks that property mechanically rather than trusting this comment.
//
// The companion prose is docs/canon/KOHYA_REPLACEMENT.md §7-§8. The proof is
// test/v2/kohya-jobapi.test.ts, which feeds every argument classified
// dangerous in arguments.ts through this validator and asserts refusal.

import crypto from 'node:crypto';

import { classifyKohyaFlag, type KohyaArgumentClass } from './arguments';

/* ────────────────────────────────────────────────────────────────────────
 * Parameter kinds. Every one is a CLOSED domain — an enum, a bounded
 * number, a boolean, or a slug matched against an anchored pattern.
 *
 * There is deliberately no 'string' kind. A free string is how this file
 * fails, so the type system does not offer one.
 * ──────────────────────────────────────────────────────────────────────── */

export type ParameterKind = 'enum' | 'integer' | 'number' | 'boolean' | 'slug' | 'catalog-id';

/**
 * Who chooses the VALUE that reaches the trainer's argv.
 *
 *   'tenant'    — the validated tenant value is emitted directly. Only ever
 *                 permitted for flags classified `safe-scalar`.
 *   'component' — the tenant picks a KEY from a closed enum and we look the
 *                 value up in COMPONENT_SUPPLIED_VALUES. This is what lets a
 *                 code-bearing flag like `--network_module` be emitted at all
 *                 without the tenant being able to influence what gets
 *                 imported.
 */
export type ValueSource = 'tenant' | 'component';

export interface ParameterSpec {
  /** The key accepted in the job body. Snake case, matching the receipt. */
  readonly name: string;
  readonly kind: ParameterKind;
  readonly valueSource: ValueSource;
  /** enum: the complete set of accepted values. */
  readonly choices?: readonly (string | number)[];
  /** integer / number: inclusive bounds. Both are required for those kinds. */
  readonly min?: number;
  readonly max?: number;
  /** slug: the anchored pattern and a hard length cap. */
  readonly pattern?: RegExp;
  readonly maxLength?: number;
  readonly required?: boolean;
  /**
   * Every kohya flag this parameter can EVER cause to appear in argv.
   * placement.ts reads this to derive the enforcement; if a parameter can
   * emit a dangerous flag with a tenant-chosen value the whole configuration
   * degrades to `unattested-client`. Keeping this field honest is the single
   * maintenance obligation of this file.
   */
  readonly emits: readonly string[];
  readonly why: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Catalogs — the two things a tenant would otherwise supply as a path.
 * ──────────────────────────────────────────────────────────────────────── */

export interface BaseModelEntry {
  readonly id: string;
  readonly label: string;
  /** Relative to the component's read-only model root. Never tenant input. */
  readonly relPath: string;
  readonly family: 'sd15' | 'sdxl';
  /**
   * The sd-scripts entry point for this family.
   *
   * NOT A `--sdxl` FLAG — there is no such argument. SDXL is a different
   * SCRIPT (`sdxl_train_network.py`), which is a stronger property than a
   * switch: the base model the tenant picks selects the program, and the set
   * of programs is two literals in this file.
   */
  readonly script: string;
}

/**
 * A closed catalog, not a directory listing. A base model is a thing we
 * published; `--pretrained_model_name_or_path` also accepts a Hugging Face
 * repo id, which is a download of somebody else's bytes initiated from inside
 * the boundary, so the field never takes tenant text of any shape.
 */
export const BASE_MODEL_CATALOG: readonly BaseModelEntry[] = Object.freeze([
  Object.freeze({
    id: 'sd15-base',
    label: 'Stable Diffusion 1.5',
    relPath: 'sd15/v1-5-pruned.safetensors',
    family: 'sd15' as const,
    script: 'train_network.py',
  }),
  Object.freeze({
    id: 'sdxl-base-1.0',
    label: 'SDXL 1.0 base',
    relPath: 'sdxl/sd_xl_base_1.0.safetensors',
    family: 'sdxl' as const,
    script: 'sdxl_train_network.py',
  }),
]);

export function baseModelById(id: string): BaseModelEntry | null {
  return BASE_MODEL_CATALOG.find((m) => m.id === id) ?? null;
}

/**
 * The dataset id. A dataset reaches the component through Studio's upload
 * path, which names it; the tenant echoes that name back. The pattern is
 * anchored and excludes `.`, so `..` is not expressible and neither is `/`.
 */
export const DATASET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

/**
 * Output names are the ONE piece of tenant free text that reaches the
 * filesystem, and they reach it as a single filename component.
 *
 * The pattern refuses, in order: an empty name, a leading `-` (which argv
 * would read as a flag rather than a value), `/` and `\`, `.` in the leading
 * position (so `..` is not expressible), and anything past 64 characters.
 * `buildTrainerArgv` re-checks it rather than trusting that validation ran.
 */
export const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/* ────────────────────────────────────────────────────────────────────────
 * COMPONENT-SUPPLIED VALUES — the closed maps behind the dangerous flags.
 *
 * Read this next to arguments.ts. `--network_module`, `--optimizer_type` and
 * `--lr_scheduler` are all classified dangerous there, and all three are
 * emitted here, because a LoRA trainer that cannot name its network module
 * does not train. The safety is not that the flag is absent; it is that its
 * value comes from this frozen map and the tenant's contribution is an index
 * into it.
 * ──────────────────────────────────────────────────────────────────────── */

export const TRAINING_TYPE_NETWORK_MODULE: Readonly<Record<string, string>> = Object.freeze({
  // ONE ENTRY, and the shortness is the point.
  //
  // `networks/lora.py` ships inside the pinned sd-scripts tree and was read
  // when arguments.ts was built. LyCORIS (`lycoris.kohya`) is a third-party
  // package that would arrive through a separate pip install, has its own
  // `--network_args` vocabulary, and has not been read — so adding it is a
  // code review with a pin of its own, not a line in a map. An argument you
  // cannot classify is denied, and a module you have not read is the same
  // sentence one level up.
  lora: 'networks.lora',
});

export const OPTIMIZER_TYPE: Readonly<Record<string, string>> = Object.freeze({
  // sd-scripts resolves `--optimizer_type` by IMPORTING when the value
  // contains a dot (`importlib.import_module` on everything before the last
  // segment). Every value below is a bare name sd-scripts handles internally,
  // and none of them contains a dot — which is checked, not assumed, by
  // assertComponentValuesAreInert() below.
  adamw: 'AdamW',
  adamw8bit: 'AdamW8bit',
  adafactor: 'Adafactor',
  lion: 'Lion',
  lion8bit: 'Lion8bit',
  sgdnesterov: 'SGDNesterov',
  sgdnesterov8bit: 'SGDNesterov8bit',
  prodigy: 'Prodigy',
});

export const LR_SCHEDULER: Readonly<Record<string, string>> = Object.freeze({
  constant: 'constant',
  constant_with_warmup: 'constant_with_warmup',
  linear: 'linear',
  cosine: 'cosine',
  cosine_with_restarts: 'cosine_with_restarts',
  polynomial: 'polynomial',
  adafactor: 'adafactor',
});

/** `--xformers` and `--sdpa` are bare switches; the tenant picks which one. */
export const ATTENTION_FLAG: Readonly<Record<string, string>> = Object.freeze({
  xformers: '--xformers',
  sdpa: '--sdpa',
});

export const MIXED_PRECISION = Object.freeze(['no', 'fp16', 'bf16'] as const);
export const SAVE_PRECISION = Object.freeze(['float', 'fp16', 'bf16'] as const);
export const CAPTION_EXTENSION = Object.freeze(['.txt', '.caption'] as const);
export const RESOLUTIONS = Object.freeze([
  '512,512',
  '576,576',
  '640,640',
  '704,704',
  '768,768',
  '832,832',
  '896,896',
  '960,960',
  '1024,1024',
] as const);

/**
 * A frozen map is only inert if its VALUES are. sd-scripts treats a dotted
 * `--optimizer_type` as an import path and `--network_module` as one
 * unconditionally, so a typo that introduced a path separator, a dot in the
 * wrong map, or a leading `-` would be a code-execution primitive smuggled in
 * as a lookup table.
 *
 * This runs at module load. It throws rather than warns: a build that cannot
 * satisfy it must not start.
 */
function assertComponentValuesAreInert(): void {
  const bare = /^[A-Za-z0-9][A-Za-z0-9_]*$/;
  const dotted = /^[A-Za-z0-9][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

  for (const [k, v] of Object.entries(OPTIMIZER_TYPE)) {
    if (!bare.test(v)) {
      throw new Error(
        `OPTIMIZER_TYPE['${k}'] = '${v}' is not a bare identifier. sd-scripts imports any ` +
          '`--optimizer_type` containing a dot; a dotted value here is arbitrary code ' +
          'execution wearing a lookup table (docs/canon/KOHYA_REPLACEMENT.md §8).',
      );
    }
  }
  for (const [k, v] of Object.entries(LR_SCHEDULER)) {
    if (!bare.test(v)) throw new Error(`LR_SCHEDULER['${k}'] = '${v}' is not a bare identifier.`);
  }
  for (const [k, v] of Object.entries(TRAINING_TYPE_NETWORK_MODULE)) {
    if (!dotted.test(v)) {
      throw new Error(
        `TRAINING_TYPE_NETWORK_MODULE['${k}'] = '${v}' is not a dotted module path. ` +
          '`--network_module` is fed to importlib.import_module; a value with a slash, a ' +
          'dash or a leading dot is not a module name and must never be emitted.',
      );
    }
  }
  for (const [k, v] of Object.entries(ATTENTION_FLAG)) {
    if (!/^--[a-z_]+$/.test(v)) throw new Error(`ATTENTION_FLAG['${k}'] = '${v}' is not a switch.`);
  }
}
assertComponentValuesAreInert();

/* ────────────────────────────────────────────────────────────────────────
 * VETTED SLUG PATTERNS — the one place tenant text survives into argv.
 *
 * `--output_name` is classified `path-bearing` in arguments.ts (a filename
 * stem, joined into the output dir, with no sanitization observed upstream),
 * and Studio nonetheless lets the tenant choose it, because a tenant who
 * cannot name their own model is being handed a worse product to buy a
 * property they already have. The safety is the pattern — so the pattern is
 * the thing that has to be checked, not the intention behind it.
 *
 * placement.ts permits a `path-bearing` flag with a tenant value ONLY when
 * the parameter is a slug whose pattern is in this set, and membership is
 * earned by surviving HOSTILE_SLUGS below at module load. A future pattern
 * that let `../` through would throw on import rather than lower the tier
 * quietly, which is the failure direction that matters: a tier that drops is
 * visible, and a traversal that works is not.
 * ──────────────────────────────────────────────────────────────────────── */

/** Every shape that must NOT match a vetted slug pattern. */
export const HOSTILE_SLUGS: readonly string[] = Object.freeze([
  '',
  '.',
  '..',
  '../etc/passwd',
  '..\\windows',
  '/etc/passwd',
  'a/b',
  'a\\b',
  '-rf',
  '--network_module',
  '-',
  '.hidden',
  'a\u0000b',
  'a b',
  'a;b',
  'a$(id)b',
  'a`id`b',
  'a\nb',
  'x'.repeat(65),
]);

export const VETTED_SLUG_PATTERNS: ReadonlySet<string> = (() => {
  const vetted = [OUTPUT_NAME_PATTERN];
  for (const re of vetted) {
    for (const hostile of HOSTILE_SLUGS) {
      if (re.test(hostile)) {
        throw new Error(
          `Slug pattern ${String(re)} accepts the hostile value ${JSON.stringify(hostile)}. ` +
            'A pattern in VETTED_SLUG_PATTERNS is what permits tenant text after a ' +
            'path-bearing flag (lib/apps/kohya/placement.ts). Refusing to load.',
        );
      }
    }
    // Sanity in the other direction: a pattern that rejects everything would
    // pass the hostile corpus trivially and break the product.
    if (!re.test('my-lora_v2.1')) {
      throw new Error(`Slug pattern ${String(re)} rejects an ordinary name. Refusing to load.`);
    }
  }
  return new Set(vetted.map((r) => String(r)));
})();

/* ────────────────────────────────────────────────────────────────────────
 * THE WHITELIST.
 *
 * Every accepted parameter, its type, its permitted range, and every flag it
 * can cause to be emitted. This array IS the tenant's expressive power. If it
 * is not here it cannot be said.
 * ──────────────────────────────────────────────────────────────────────── */

export const PARAMETER_WHITELIST: readonly ParameterSpec[] = Object.freeze([
  /* ---- what to train on, named rather than pathed ---------------------- */
  Object.freeze({
    name: 'dataset_id',
    kind: 'catalog-id' as const,
    valueSource: 'component' as const,
    pattern: DATASET_ID_PATTERN,
    maxLength: 64,
    required: true,
    emits: ['--train_data_dir'],
    why:
      '`--train_data_dir` is an arbitrary read path. The tenant supplies an id minted by ' +
      "Studio's upload path; the component joins it under a root it owns and re-checks " +
      'containment. There is no field here in which a path can be written.',
  }),
  Object.freeze({
    name: 'base_model_id',
    kind: 'enum' as const,
    valueSource: 'component' as const,
    choices: Object.freeze(BASE_MODEL_CATALOG.map((m) => m.id)),
    required: true,
    emits: ['--pretrained_model_name_or_path'],
    why:
      'Three hazards in one upstream field: an arbitrary local path, a Hugging Face repo id ' +
      '(a download initiated from inside the boundary), and library/model_util.py:980 ' +
      'torch.load(..., weights_only=False) with the pickle guard EXPLICITLY DISABLED. Closed ' +
      'catalog only. The catalog entry also selects the trainer SCRIPT, so the family is not ' +
      'a tenant parameter either.',
  }),
  Object.freeze({
    name: 'training_type',
    kind: 'enum' as const,
    valueSource: 'component' as const,
    choices: Object.freeze(Object.keys(TRAINING_TYPE_NETWORK_MODULE)),
    required: true,
    emits: ['--network_module'],
    why:
      'THE flag this WO exists for. `--network_module` is fed straight to ' +
      'importlib.import_module, so its value is code. The tenant picks a key; ' +
      'TRAINING_TYPE_NETWORK_MODULE supplies the module name.',
  }),
  Object.freeze({
    name: 'output_name',
    kind: 'slug' as const,
    valueSource: 'tenant' as const,
    pattern: OUTPUT_NAME_PATTERN,
    maxLength: 64,
    required: true,
    emits: ['--output_name'],
    why:
      'The one piece of tenant free text that reaches the filesystem, and the ONLY parameter ' +
      'in the whole whitelist that emits a non-safe flag with a tenant-chosen value. It is ' +
      'permitted because `--output_name` is a filename stem with no upstream sanitization and ' +
      'the pattern below is what supplies it: no separator, no leading dash (argv would read ' +
      'that as a flag), no leading dot (that is how `..` starts). The pattern is itself ' +
      'asserted against a hostile corpus at module load — see VETTED_SLUG_PATTERNS.',
  }),

  /* ---- network shape --------------------------------------------------- */
  Object.freeze({ name: 'network_dim', kind: 'integer' as const, valueSource: 'tenant' as const, min: 1, max: 320, emits: ['--network_dim'], why: 'LoRA rank. Bounded integer.' }),
  Object.freeze({ name: 'network_alpha', kind: 'number' as const, valueSource: 'tenant' as const, min: 0.1, max: 320, emits: ['--network_alpha'], why: 'LoRA alpha. Bounded number.' }),
  Object.freeze({ name: 'network_dropout', kind: 'number' as const, valueSource: 'tenant' as const, min: 0, max: 1, emits: ['--network_dropout'], why: 'Bounded number.' }),
  Object.freeze({ name: 'network_train_unet_only', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--network_train_unet_only'], why: 'Bare switch.' }),
  Object.freeze({ name: 'network_train_text_encoder_only', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--network_train_text_encoder_only'], why: 'Bare switch.' }),

  /* ---- optimisation ---------------------------------------------------- */
  Object.freeze({
    name: 'optimizer',
    kind: 'enum' as const,
    valueSource: 'component' as const,
    choices: Object.freeze(Object.keys(OPTIMIZER_TYPE)),
    emits: ['--optimizer_type'],
    why:
      'sd-scripts IMPORTS `--optimizer_type` when the value contains a dot, which makes it a ' +
      'second `--network_module`. Closed map; every emitted value is asserted dot-free at ' +
      'module load.',
  }),
  Object.freeze({
    name: 'lr_scheduler',
    kind: 'enum' as const,
    valueSource: 'component' as const,
    choices: Object.freeze(Object.keys(LR_SCHEDULER)),
    emits: ['--lr_scheduler'],
    why:
      'Component-supplied even though the ordinary values are inert, because the sibling flag ' +
      '`--lr_scheduler_type` IS an import path and the two are one keystroke apart in every ' +
      'UI that has ever rendered them.',
  }),
  Object.freeze({ name: 'learning_rate', kind: 'number' as const, valueSource: 'tenant' as const, min: 1e-8, max: 1e-2, emits: ['--learning_rate'], why: 'Bounded number.' }),
  Object.freeze({ name: 'text_encoder_lr', kind: 'number' as const, valueSource: 'tenant' as const, min: 0, max: 1e-2, emits: ['--text_encoder_lr'], why: 'Bounded number.' }),
  Object.freeze({ name: 'unet_lr', kind: 'number' as const, valueSource: 'tenant' as const, min: 0, max: 1e-2, emits: ['--unet_lr'], why: 'Bounded number.' }),
  Object.freeze({ name: 'lr_warmup_steps', kind: 'integer' as const, valueSource: 'tenant' as const, min: 0, max: 100_000, emits: ['--lr_warmup_steps'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'lr_scheduler_num_cycles', kind: 'integer' as const, valueSource: 'tenant' as const, min: 1, max: 100, emits: ['--lr_scheduler_num_cycles'], why: 'Bounded integer.' }),

  /* ---- schedule -------------------------------------------------------- */
  Object.freeze({ name: 'max_train_epochs', kind: 'integer' as const, valueSource: 'tenant' as const, min: 1, max: 500, emits: ['--max_train_epochs'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'max_train_steps', kind: 'integer' as const, valueSource: 'tenant' as const, min: 1, max: 1_000_000, emits: ['--max_train_steps'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'train_batch_size', kind: 'integer' as const, valueSource: 'tenant' as const, min: 1, max: 64, emits: ['--train_batch_size'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'gradient_accumulation_steps', kind: 'integer' as const, valueSource: 'tenant' as const, min: 1, max: 64, emits: ['--gradient_accumulation_steps'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'save_every_n_epochs', kind: 'integer' as const, valueSource: 'tenant' as const, min: 1, max: 500, emits: ['--save_every_n_epochs'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'seed', kind: 'integer' as const, valueSource: 'tenant' as const, min: 0, max: 2_147_483_647, emits: ['--seed'], why: 'Bounded integer.' }),

  /* ---- precision and memory -------------------------------------------- */
  Object.freeze({ name: 'mixed_precision', kind: 'enum' as const, valueSource: 'tenant' as const, choices: MIXED_PRECISION, emits: ['--mixed_precision'], why: 'Closed enum, argparse choices upstream.' }),
  Object.freeze({ name: 'save_precision', kind: 'enum' as const, valueSource: 'tenant' as const, choices: SAVE_PRECISION, emits: ['--save_precision'], why: 'Closed enum, argparse choices upstream.' }),
  Object.freeze({ name: 'gradient_checkpointing', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--gradient_checkpointing'], why: 'Bare switch.' }),
  Object.freeze({ name: 'cache_latents', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--cache_latents'], why: 'Bare switch.' }),
  Object.freeze({ name: 'cache_latents_to_disk', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--cache_latents_to_disk'], why: 'Bare switch; writes inside the component-owned dataset root.' }),
  Object.freeze({
    name: 'attention',
    kind: 'enum' as const,
    valueSource: 'component' as const,
    choices: Object.freeze(Object.keys(ATTENTION_FLAG)),
    emits: ['--xformers', '--sdpa'],
    why: 'Two mutually exclusive bare switches; the tenant picks which one appears.',
  }),

  /* ---- dataset handling ------------------------------------------------ */
  Object.freeze({ name: 'resolution', kind: 'enum' as const, valueSource: 'tenant' as const, choices: RESOLUTIONS, emits: ['--resolution'], why: 'Closed enum rather than a free "W,H" string — the upstream parser accepts free text here.' }),
  Object.freeze({ name: 'enable_bucket', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--enable_bucket'], why: 'Bare switch.' }),
  Object.freeze({ name: 'min_bucket_reso', kind: 'integer' as const, valueSource: 'tenant' as const, min: 64, max: 2048, emits: ['--min_bucket_reso'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'max_bucket_reso', kind: 'integer' as const, valueSource: 'tenant' as const, min: 64, max: 4096, emits: ['--max_bucket_reso'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'bucket_reso_steps', kind: 'integer' as const, valueSource: 'tenant' as const, min: 1, max: 256, emits: ['--bucket_reso_steps'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'caption_extension', kind: 'enum' as const, valueSource: 'tenant' as const, choices: CAPTION_EXTENSION, emits: ['--caption_extension'], why: 'Closed enum. Free text here is a glob over the dataset root.' }),
  Object.freeze({ name: 'shuffle_caption', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--shuffle_caption'], why: 'Bare switch.' }),
  Object.freeze({ name: 'keep_tokens', kind: 'integer' as const, valueSource: 'tenant' as const, min: 0, max: 255, emits: ['--keep_tokens'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'flip_aug', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--flip_aug'], why: 'Bare switch.' }),
  Object.freeze({ name: 'color_aug', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--color_aug'], why: 'Bare switch.' }),
  Object.freeze({ name: 'random_crop', kind: 'boolean' as const, valueSource: 'tenant' as const, emits: ['--random_crop'], why: 'Bare switch.' }),
  Object.freeze({ name: 'max_token_length', kind: 'enum' as const, valueSource: 'tenant' as const, choices: Object.freeze([150, 225]), emits: ['--max_token_length'], why: "Closed enum. Upstream choices are [None, 150, 225] — 75 is the tokenizer default and is expressed by OMITTING the flag, not by passing it, which is why it is not offered." }),

  /* ---- loss ------------------------------------------------------------ */
  Object.freeze({ name: 'clip_skip', kind: 'integer' as const, valueSource: 'tenant' as const, min: 1, max: 12, emits: ['--clip_skip'], why: 'Bounded integer.' }),
  Object.freeze({ name: 'noise_offset', kind: 'number' as const, valueSource: 'tenant' as const, min: 0, max: 1, emits: ['--noise_offset'], why: 'Bounded number.' }),
  Object.freeze({ name: 'min_snr_gamma', kind: 'number' as const, valueSource: 'tenant' as const, min: 0, max: 20, emits: ['--min_snr_gamma'], why: 'Bounded number.' }),
  Object.freeze({ name: 'prior_loss_weight', kind: 'number' as const, valueSource: 'tenant' as const, min: 0, max: 2, emits: ['--prior_loss_weight'], why: 'Bounded number.' }),
]);

export const WHITELIST_BY_NAME: ReadonlyMap<string, ParameterSpec> = new Map(
  PARAMETER_WHITELIST.map((p) => [p.name, p]),
);

/* ────────────────────────────────────────────────────────────────────────
 * The escape hatches, named so the refusal can say WHICH trap was sprung.
 *
 * Default-deny already refuses all of these — they are not in the whitelist.
 * They are enumerated anyway because a 400 that says "unknown field" teaches
 * nobody anything, and because a future contributor reaching for one of these
 * names should meet a sentence explaining why it does not exist rather than
 * an empty slot they might feel entitled to fill.
 * ──────────────────────────────────────────────────────────────────────── */

export const REFUSED_ESCAPE_HATCHES: Readonly<Record<string, string>> = Object.freeze({
  args: 'A free-form argument string is the whole risk. One such field makes the configuration `unattested-client` (PLACEMENT_AND_SURFACES.md §7.3).',
  extra_args: 'See `args`.',
  additional_args: 'See `args`.',
  advanced_args: 'See `args`. The "advanced" label does not create a second tier; it creates a second CONFIGURATION, with a worse one.',
  raw_args: 'See `args`.',
  argv: 'See `args`.',
  command: 'The job API cannot express a command. That is the property Studio\'s placement rests on.',
  cmd: 'See `command`.',
  script: 'See `command`.',
  entrypoint: 'See `command`.',
  env: 'Environment is the component\'s, not the tenant\'s: PYTHONPATH, PYTHONSTARTUP and LD_PRELOAD are all code execution spelled as configuration.',
  environment: 'See `env`.',
  config_file: '`--config_file` is a TOML that can set EVERY other argument, including the denied ones. Accepting it re-opens the entire surface in one field.',
  dataset_config: '`--dataset_config` is a TOML carrying arbitrary dataset paths and per-subset settings. The dataset is named by id; its layout is the component\'s.',
  toml: 'See `config_file`.',
  network_module: 'An import path. `importlib.import_module(args.network_module)`. Use `training_type`.',
  network_args: 'Free key=value pairs forwarded as **kwargs into whatever `--network_module` imported.',
  optimizer_args: 'Free key=value pairs forwarded as **kwargs into the optimizer constructor.',
  lr_scheduler_args: 'See `optimizer_args`.',
  lr_scheduler_type: 'An import path, one keystroke from the inert `--lr_scheduler`.',
  dataset_class: 'An import path for a replacement dataset class.',
  sample_prompts: 'A file the trainer reads and whose lines it parses as generation directives; in the GUI path sample generation shells out. It is also an arbitrary read path. Studio does not offer sampling during training.',
  sample_every_n_steps: 'Sampling is off. See `sample_prompts`.',
  sample_every_n_epochs: 'Sampling is off. See `sample_prompts`.',
  huggingface_repo_id: 'Egress. Uploading a checkpoint straight from the trainer is exactly the artifact path the component exists to observe.',
  huggingface_token: 'A credential in a job body.',
  wandb_api_key: 'A credential in a job body, and egress.',
  log_tracker_config: 'A config file for a tracker, i.e. a second `--config_file`.',
  log_with: 'Selects a tracker that opens its own network egress.',
  train_data_dir: 'A path. Use `dataset_id`.',
  reg_data_dir: 'A path.',
  output_dir: 'A path the component owns.',
  logging_dir: 'A path the component owns.',
  resume: 'A path, and it restores optimizer state from bytes the tenant supplied.',
  network_weights: 'A path to weights loaded into the training graph.',
  base_weights: 'A path to weights loaded into the training graph.',
  vae: 'A path or repo id.',
  pretrained_model_name_or_path: 'A path or a Hugging Face repo id. Use `base_model_id`.',
  torch_compile: 'Enables a backend named by `--dynamo_backend`, which is resolved as a module.',
  dynamo_backend: 'Resolved as a module.',
  deepspeed: 'Changes how the process is launched, which is the one thing the tenant may not do.',
});

/* ────────────────────────────────────────────────────────────────────────
 * Validation.
 * ──────────────────────────────────────────────────────────────────────── */

export interface Refusal {
  field: string;
  code:
    | 'unknown-field'
    | 'escape-hatch'
    | 'wrong-type'
    | 'out-of-range'
    | 'not-a-choice'
    | 'pattern'
    | 'missing'
    | 'not-an-object'
    | 'unknown-catalog-id';
  message: string;
}

export type ValidatedJobSpec = Readonly<Record<string, string | number | boolean>>;

export type ValidationResult =
  | { ok: true; spec: ValidatedJobSpec }
  | { ok: false; refusals: Refusal[] };

/**
 * DEFAULT DENY, and the order of the checks is part of the design: the
 * escape-hatch table is consulted BEFORE the generic unknown-field refusal so
 * that the caller is told which trap they walked into, and unknown fields are
 * collected rather than short-circuited so that a client fixing their request
 * sees all of them at once instead of discovering the whitelist one 400 at a
 * time.
 */
export function validateJobSpec(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      refusals: [{ field: '<body>', code: 'not-an-object', message: 'A job is a JSON object of named parameters.' }],
    };
  }

  const body = input as Record<string, unknown>;
  const refusals: Refusal[] = [];
  const spec: Record<string, string | number | boolean> = {};

  for (const [key, raw] of Object.entries(body)) {
    // Object.hasOwn, not a bare index. `REFUSED_ESCAPE_HATCHES['constructor']`
    // on a plain object literal returns Object's constructor — truthy — and
    // would have put a function where a refusal message belongs. Prototype
    // keys reach this line because JSON.parse makes `__proto__` an OWN
    // property, so a body can contain any of them.
    const hatchKey = key.replace(/^--/, '');
    const hatch = Object.hasOwn(REFUSED_ESCAPE_HATCHES, key)
      ? REFUSED_ESCAPE_HATCHES[key]
      : Object.hasOwn(REFUSED_ESCAPE_HATCHES, hatchKey)
        ? REFUSED_ESCAPE_HATCHES[hatchKey]
        : undefined;
    const p = WHITELIST_BY_NAME.get(key);
    if (!p) {
      // A key that names a known-dangerous kohya flag gets the specific
      // sentence; anything else gets the generic one. Both are refusals.
      if (hatch) {
        refusals.push({ field: key, code: 'escape-hatch', message: hatch });
      } else {
        const cls = classifyKohyaFlag(key);
        refusals.push({
          field: key,
          code: 'unknown-field',
          message:
            `'${key}' is not an accepted parameter` +
            (cls ? ` (kohya classifies it '${cls}')` : '') +
            '. The job API accepts data and hyperparameters only, and denies by default: an ' +
            'argument that cannot be classified is denied (docs/canon/KOHYA_REPLACEMENT.md §8).',
        });
      }
      continue;
    }
    const v = coerce(p, raw, refusals);
    if (v !== undefined) spec[key] = v;
  }

  for (const p of PARAMETER_WHITELIST) {
    if (p.required && spec[p.name] === undefined) {
      refusals.push({ field: p.name, code: 'missing', message: `'${p.name}' is required.` });
    }
  }

  if (refusals.length) return { ok: false, refusals };
  return { ok: true, spec: Object.freeze(spec) };
}

function coerce(
  p: ParameterSpec,
  raw: unknown,
  refusals: Refusal[],
): string | number | boolean | undefined {
  const bad = (code: Refusal['code'], message: string) => {
    refusals.push({ field: p.name, code, message });
    return undefined;
  };

  switch (p.kind) {
    case 'boolean':
      if (typeof raw !== 'boolean') return bad('wrong-type', `'${p.name}' is a boolean.`);
      return raw;

    case 'integer':
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return bad('wrong-type', `'${p.name}' is a finite ${p.kind}. Strings are not coerced.`);
      }
      if (p.kind === 'integer' && !Number.isInteger(raw)) {
        return bad('wrong-type', `'${p.name}' is an integer.`);
      }
      if (p.min !== undefined && raw < p.min) {
        return bad('out-of-range', `'${p.name}' must be >= ${p.min}; got ${raw}.`);
      }
      if (p.max !== undefined && raw > p.max) {
        return bad('out-of-range', `'${p.name}' must be <= ${p.max}; got ${raw}.`);
      }
      return raw;
    }

    case 'enum': {
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        return bad('wrong-type', `'${p.name}' is one of: ${(p.choices ?? []).join(', ')}.`);
      }
      if (!(p.choices ?? []).includes(raw)) {
        return bad('not-a-choice', `'${p.name}' must be one of: ${(p.choices ?? []).join(', ')}.`);
      }
      return raw;
    }

    case 'slug':
    case 'catalog-id': {
      if (typeof raw !== 'string') return bad('wrong-type', `'${p.name}' is a string.`);
      if (p.maxLength !== undefined && raw.length > p.maxLength) {
        return bad('pattern', `'${p.name}' is at most ${p.maxLength} characters.`);
      }
      if (p.pattern && !p.pattern.test(raw)) {
        return bad(
          'pattern',
          `'${p.name}' must match ${String(p.pattern)}. Separators, a leading dash and a ` +
            'leading dot are all refused — the first would be a path, the second would be ' +
            'read as a flag, the third is how `..` starts.',
        );
      }
      return raw;
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * The commitment. What the leaf carries about a run.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Canonical JSON — keys sorted, no whitespace — so two identical jobs hash
 * identically regardless of the order a client happened to serialise them in.
 * This is the value that goes in `training_runs.params_hash` and, when a leaf
 * is issued, in the run commitment the checkpoint's `model.write` carries.
 */
export function canonicalJobJson(spec: ValidatedJobSpec): string {
  const keys = Object.keys(spec).sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, spec[k]])));
}

export function jobSpecHash(spec: ValidatedJobSpec): string {
  return crypto.createHash('sha256').update(canonicalJobJson(spec)).digest('hex');
}

/** Every flag any whitelisted parameter can emit. Used by placement.ts. */
export function emittableFlags(
  whitelist: readonly ParameterSpec[] = PARAMETER_WHITELIST,
): readonly string[] {
  return [...new Set(whitelist.flatMap((p) => p.emits))].sort();
}

/** Re-exported for the placement derivation, which reasons over both. */
export type { KohyaArgumentClass };
