// Kohya's argument surface, classified by what the VALUE can do — WO-19.
//
// ---------------------------------------------------------------------------
// WHY A CLASSIFICATION AND NOT JUST A WHITELIST
// ---------------------------------------------------------------------------
//
// job-spec.ts is the whitelist and it denies by default, so strictly speaking
// this table is not needed to keep anything out. It exists because the
// whitelist alone cannot answer the question that decides the tier:
//
//     Is a flag Studio DOES emit safe to emit with a tenant-chosen value?
//
// Studio has to pass `--network_module`; a LoRA trainer that cannot name its
// network module does not train. The safety property is therefore not "no
// dangerous flag appears in argv" — six of them do — but "no dangerous flag
// appears in argv with a value the tenant influenced." That is a statement
// about flags, so it needs a table of flags, and placement.ts derives the
// tier from the join of this table with the whitelist.
//
// Two consequences, both easy to get backwards:
//
//   * CLASSIFICATION IS NOT PERMISSION. A flag classified `safe-scalar` is not
//     thereby accepted. `--training_comment` is an inert string and is still
//     not in the whitelist, because Studio has no use for it. The whitelist is
//     a strict subset of what this table would allow.
//
//   * AN UNCLASSIFIED FLAG IS DENIED, and `classifyKohyaFlag` returning
//     `undefined` is how that is spelled. `validateJobSpec` refuses unknown
//     fields; `deriveEnforcement` degrades the tier if the whitelist emits a
//     flag missing from here. Both directions are closed.
//
// ---------------------------------------------------------------------------
// HOW THIS TABLE WAS BUILT — read this before trusting it
// ---------------------------------------------------------------------------
//
// From kohya's OWN ARGUMENT PARSER, walked as an AST, not from memory and not
// from what the GUI renders. The GUI is a client of the parser and shows a
// subset of it.
//
//   Source:  kohya-ss/sd-scripts @ 37a1cbbc5725ed2a3575506e7bd2001c9908ac92
//   Cross-checked against bmaltais/kohya_ss @ 45088f04, whose sd-scripts
//   submodule pins 6721028c. The two revisions differ by exactly one flag on
//   this surface (`--show_timesteps_offset`, DiT-only), so the pin and
//   upstream are interchangeable for classification purposes.
//
// `library/train_util.py` is now a 218-line re-export shim; every training
// `add_argument` lives in `library/args.py`. A table built from the old
// location would silently be a table of nothing.
//
// THE SURFACE IS `train_network.py::setup_parser()` and exactly the builders
// it composes — add_logging_arguments, add_sd_models_arguments,
// add_model_spec_arguments, add_dataset_arguments, add_training_arguments,
// add_masked_loss_arguments, add_deepspeed_arguments, add_optimizer_arguments,
// add_config_arguments, add_custom_train_arguments — plus
// `add_sdxl_training_arguments` for the SDXL entry point. 198 distinct flags.
// Args belonging to other entry points (FLUX, SD3, Lumina, Hunyuan, Anima,
// train_db, textual inversion) are off-surface and are not listed; running one
// of those scripts is a different configuration and needs its own pass.
//
// THE DEFAULT RULE, applied mechanically to all 198:
//
//     store_true / store_false        → safe-scalar
//     has `choices=`                  → safe-scalar
//     type is int / float / int_or_float → safe-scalar
//     ANYTHING ELSE (a free-form str) → UNCLASSIFIED, therefore DENIED
//
// 181 of 198 were classified. The 17 that were not are all free-form strings —
// the eleven `--metadata_*` fields, five caption separator/affix fields, and
// the preserved typo alias `--caption_extention`. None is needed and none is
// listed, so all seventeen are denied by absence. That is the rule working,
// not a gap in it.
//
// The overrides below are the flags where the mechanical rule is WRONG in
// either direction, and every one names the file and line that decides it.
// Four free-form strings are promoted to safe (`--resolution`,
// `--caption_extension`, `--lr_scheduler`, `--training_comment`); the rest of
// the overrides move a flag the rule called safe into a denied class.
//
// A CLASSIFICATION IS A STATEMENT ABOUT A REVISION. sd-scripts adds arguments
// between releases, and an argument added after this table was written is
// unclassified — which is why unclassified means denied and why the image must
// pin a ref. Bumping that pin is a review of this table, not a version bump.
// If that stops being true, Studio's tier is a claim about last quarter.

/**
 * What the VALUE of this flag can cause.
 *
 *   'safe-scalar'      a bounded number, a closed enum, or a bare switch.
 *                      Nothing is imported, unpickled, opened or fetched.
 *   'code-bearing'     the value is resolved as a Python module or attribute
 *                      and imported. `--network_module` is the canonical one.
 *   'kwargs-bearing'   free `key=value` pairs splatted into code the same
 *                      request selected. A constructor argument is not a
 *                      scalar when the constructor is chosen by the caller.
 *   'config-expansion' a file whose CONTENTS become arguments after the
 *                      argument parser has finished. One field that reopens
 *                      the whole surface.
 *   'unpickle-bearing' the value names bytes that reach `torch.load`. A
 *                      pickle is code; several call sites here pass
 *                      `weights_only=False` explicitly.
 *   'path-bearing'     an arbitrary filesystem path, read or written.
 *   'egress-bearing'   network upload, download, or a credential.
 *   'launcher'         changes how the process is started, or replaces
 *                      training with something that is not training.
 */
export const KOHYA_ARGUMENT_CLASSES = [
  'safe-scalar',
  'code-bearing',
  'kwargs-bearing',
  'config-expansion',
  'unpickle-bearing',
  'path-bearing',
  'egress-bearing',
  'launcher',
] as const;

export type KohyaArgumentClass = (typeof KOHYA_ARGUMENT_CLASSES)[number];

export interface KohyaArgumentEntry {
  readonly cls: KohyaArgumentClass;
  /** Why, naming the sink. Absent for the bulk safe scalars, where the
   *  mechanical rule is the whole reason and repeating it 140 times would
   *  bury the 40 entries that matter. */
  readonly why?: string;
}

const safe = (): KohyaArgumentEntry => Object.freeze({ cls: 'safe-scalar' as const });
const of_ = (cls: KohyaArgumentClass, why: string): KohyaArgumentEntry =>
  Object.freeze({ cls, why });

/**
 * The table. 181 classified flags; the other 17 on the surface are free-form
 * strings left out deliberately, which denies them.
 */
export const KOHYA_ARGUMENT_CLASS: Readonly<Record<string, KohyaArgumentEntry>> = Object.freeze({

  /* ---- safe-scalar ----------------------------------------------------- */
  '--adaptive_noise_scale': safe(),
  '--alpha_mask': safe(),
  '--base_weights_multiplier': safe(),
  '--bucket_no_upscale': safe(),
  '--bucket_reso_steps': safe(),
  '--cache_latents': safe(),
  '--cache_latents_to_disk': safe(),
  '--cache_text_encoder_outputs': safe(),
  '--cache_text_encoder_outputs_to_disk': safe(),
  '--caption_dropout_every_n_epochs': safe(),
  '--caption_dropout_rate': safe(),
  '--caption_extension': of_('safe-scalar',
    'Free-form str upstream, used as a filename SUFFIX when globbing the dataset dir. Studio constrains it to a closed enum anyway. Note the preserved typo alias --caption_extention, which is left unclassified and therefore denied.'),
  '--caption_tag_dropout_rate': safe(),
  '--clip_skip': safe(),
  '--color_aug': safe(),
  '--console_log_level': safe(),
  '--console_log_simple': safe(),
  '--cpu_offload_checkpointing': safe(),
  '--dataset_repeats': safe(),
  '--ddp_gradient_as_bucket_view': safe(),
  '--ddp_static_graph': safe(),
  '--ddp_timeout': safe(),
  '--debiased_estimation_loss': safe(),
  '--dim_from_weights': safe(),
  '--disable_mmap_load_safetensors': safe(),
  '--enable_bucket': safe(),
  '--enable_wildcard': safe(),
  '--flip_aug': safe(),
  '--fp8_base': safe(),
  '--fp8_base_unet': safe(),
  '--full_bf16': safe(),
  '--full_fp16': safe(),
  '--fused_backward_pass': safe(),
  '--gradient_accumulation_steps': safe(),
  '--gradient_checkpointing': safe(),
  '--highvram': safe(),
  '--huber_c': safe(),
  '--huber_scale': safe(),
  '--huber_schedule': safe(),
  '--initial_epoch': safe(),
  '--initial_step': safe(),
  '--ip_noise_gamma': safe(),
  '--ip_noise_gamma_random_strength': safe(),
  '--keep_tokens': safe(),
  '--learning_rate': safe(),
  '--loss_type': safe(),
  '--lowram': safe(),
  '--lr_decay_steps': safe(),
  '--lr_scheduler': of_('safe-scalar',
    'Free-form str upstream but resolved by enum lookup (SchedulerType / DiffusersSchedulerType), with one special case: a name starting with "adafactor" is split on ":" and the tail is float()ed. No import. Studio still component-supplies it, because --lr_scheduler_type IS an import path and the two are one keystroke apart in every UI that has ever rendered them.'),
  '--lr_scheduler_min_lr_ratio': safe(),
  '--lr_scheduler_num_cycles': safe(),
  '--lr_scheduler_power': safe(),
  '--lr_scheduler_timescale': safe(),
  '--lr_warmup_steps': safe(),
  '--masked_loss': safe(),
  '--max_bucket_reso': safe(),
  '--max_data_loader_n_workers': safe(),
  '--max_grad_norm': safe(),
  '--max_timestep': safe(),
  '--max_token_length': safe(),
  '--max_train_epochs': safe(),
  '--max_train_steps': safe(),
  '--max_validation_steps': safe(),
  '--mem_eff_attn': safe(),
  '--min_bucket_reso': safe(),
  '--min_snr_gamma': safe(),
  '--min_timestep': safe(),
  '--mixed_precision': safe(),
  '--multires_noise_discount': safe(),
  '--multires_noise_iterations': safe(),
  '--network_alpha': safe(),
  '--network_dim': safe(),
  '--network_dropout': safe(),
  '--network_train_text_encoder_only': safe(),
  '--network_train_unet_only': safe(),
  '--no_half_vae': safe(),
  '--no_metadata': safe(),
  '--noise_offset': safe(),
  '--noise_offset_random_strength': safe(),
  '--persistent_data_loader_workers': safe(),
  '--prior_loss_weight': safe(),
  '--random_crop': safe(),
  '--resize_interpolation': safe(),
  '--resolution': of_('safe-scalar',
    'Free-form str upstream ("size" or "width,height") parsed with int(). No path, no import. Studio constrains it to a closed enum anyway.'),
  '--save_every_n_epochs': safe(),
  '--save_every_n_steps': safe(),
  '--save_last_n_epochs': safe(),
  '--save_last_n_epochs_state': safe(),
  '--save_last_n_steps': safe(),
  '--save_last_n_steps_state': safe(),
  '--save_model_as': safe(),
  '--save_n_epoch_ratio': safe(),
  '--save_precision': safe(),
  '--save_state': safe(),
  '--save_state_on_train_end': safe(),
  '--scale_v_pred_loss_like_noise_pred': safe(),
  '--scale_weight_norms': safe(),
  '--sdpa': safe(),
  '--seed': safe(),
  '--shuffle_caption': safe(),
  '--skip_cache_check': safe(),
  '--skip_until_initial_step': safe(),
  '--text_encoder_lr': safe(),
  '--token_warmup_min': safe(),
  '--token_warmup_step': safe(),
  '--train_batch_size': safe(),
  '--train_inpainting': safe(),
  '--training_comment': of_('safe-scalar',
    'A free string written into the safetensors metadata. Harmless, and NOT whitelisted — classification is not permission.'),
  '--unet_lr': safe(),
  '--use_8bit_adam': safe(),
  '--use_lion_optimizer': safe(),
  '--v2': safe(),
  '--v_parameterization': safe(),
  '--v_pred_like_loss': safe(),
  '--vae_batch_size': safe(),
  '--validate_every_n_epochs': safe(),
  '--validate_every_n_steps': safe(),
  '--validation_seed': safe(),
  '--validation_split': safe(),
  '--weighted_captions': safe(),
  '--xformers': safe(),
  '--zero_terminal_snr': safe(),

  /* ---- code-bearing ---------------------------------------------------- */
  '--dataset_class': of_('code-bearing',
    'library/dataset.py:1544-1549 — importlib.import_module on everything before the last dot, getattr for the last, then the class is INSTANTIATED with the dataset in hand.'),
  '--dynamo_backend': of_('code-bearing',
    'choices=-constrained to 12 names, so it cannot name an arbitrary module — but it is handed to Accelerator(dynamo_backend=...) and what accelerate does with ipex/tvm/onnxrt beyond that was not traced. Denied as unresolved rather than assumed benign.'),
  '--lr_scheduler_type': of_('code-bearing',
    'library/optimizer.py:513-519 — identical import-and-call pattern. One keystroke from the inert --lr_scheduler.'),
  '--network_module': of_('code-bearing',
    'train_network.py:1049-1051 — importlib.import_module(args.network_module), then network_module.create_network(...). The value IS code, and sys.path is appended with the script dir first, so a bare name resolves against a directory the dataset upload path can reach.'),
  '--optimizer_type': of_('code-bearing',
    'library/optimizer.py:333-344 — a value containing a dot is an import path (module = everything before the last segment, getattr for the last), then called. A second --network_module wearing a different name.'),
  '--torch_compile': of_('code-bearing',
    'Enables the backend named by --dynamo_backend. Denied with it rather than after it.'),

  /* ---- kwargs-bearing -------------------------------------------------- */
  '--lr_scheduler_args': of_('kwargs-bearing',
    'library/optimizer.py:498-502 — same shape, splatted into the scheduler constructor.'),
  '--network_args': of_('kwargs-bearing',
    'train_network.py ~1070 — split("=",1) per token, values kept as RAW STRINGS with no literal_eval, then splatted: create_network(..., **net_kwargs). Arbitrary keyword names reach whatever --network_module imported.'),
  '--optimizer_args': of_('kwargs-bearing',
    'library/optimizer.py:67-85 — split("=") then ast.literal_eval, splatted into optimizer_class(...). literal_eval is the safe parser; the arbitrary KEYS are the problem, not the values.'),

  /* ---- config-expansion ------------------------------------------------ */
  '--config_file': of_('config-expansion',
    'library/args.py:1133-1197 read_config_from_file() — toml.load, every section FLATTENED into one namespace, then parser.parse_args(namespace=config_args). It can set any attribute name, INCLUDING ONES THAT ARE NOT DECLARED ARGUMENTS, which then reach getattr(args, ...) call sites. Accepting this field would make the whitelist decorative.'),
  '--dataset_config': of_('config-expansion',
    'library/config_util.py — the full [[datasets.subsets]] schema, with per-subset image_dir, metadata_file, conditioning_data_dir and custom_attributes. A second, larger arbitrary-path surface reached through one flag.'),
  '--log_tracker_config': of_('config-expansion',
    'library/logging_util.py:38-40 — toml.load REPLACES the whole init_kwargs dict passed to accelerator.init_trackers, i.e. arbitrary per-tracker constructor kwargs.'),
  '--sample_at_first': of_('config-expansion',
    'Turns the --sample_prompts path on. Denied with it.'),
  '--sample_every_n_epochs': of_('config-expansion',
    'Turns the --sample_prompts path on. Denied with it.'),
  '--sample_every_n_steps': of_('config-expansion',
    'Turns the --sample_prompts path on. Denied with it.'),
  '--sample_prompts': of_('config-expansion',
    'CORRECTION TO THE WO BRIEF, AND IT IS WORTH THE PARAGRAPH. At sd-scripts 37a1cbb this does NOT shell out: library/sampling.py generates samples in-process with the training script own pipeline. It is denied on two other grounds, both read out of the code. (1) It is a DIRECTIVE FILE: line_to_prompt_dict (sampling.py:128-216) re-parses each line on " --" with a hand-rolled matcher, so the file contents become arguments after the argument parser has finished. (2) Three of those fragments — cn, mk and i — are FILESYSTEM PATHS read at sample time, so one accepted path yields an unbounded set of further reads. Dispatch is by extension only (.txt/.toml/.json); anything else raises UnboundLocalError.'),
  '--sample_sampler': of_('config-expansion',
    'choices=-constrained, and inert on its own — denied because it is only meaningful on the sampling path. Note the prompt file ss fragment sets the sampler too and is NOT constrained by those choices.'),

  /* ---- unpickle-bearing ------------------------------------------------ */
  '--base_weights': of_('unpickle-bearing',
    'Same load path, nargs=* so it is a list of them.'),
  '--network_weights': of_('unpickle-bearing',
    'Loaded through torch.load. networks/lora.py:815,1077 and network_base.py:304 leave weights_only UNSET, so the behaviour depends on the installed torch; networks/lora_lumina.py:421 sets weights_only=False explicitly. A pickle is code.'),
  '--pretrained_model_name_or_path': of_('unpickle-bearing',
    'Three hazards in one field: an arbitrary local path, an HF repo id (a download initiated from inside the boundary), and library/model_util.py:980 torch.load(..., weights_only=False) with the guard EXPLICITLY DISABLED. Component-supplied from the base-model catalog.'),
  '--resume': of_('unpickle-bearing',
    'Restores accelerate state — optimizer state and pickled objects read back into the process — from a directory the tenant names. With --resume_from_huggingface the same flag becomes a remote fetch spec.'),
  '--vae': of_('unpickle-bearing',
    'A path or an HF repo id; library/model_util.py:1292,1295 loads it with weights_only unset.'),

  /* ---- path-bearing ---------------------------------------------------- */
  '--cache_info': of_('path-bearing',
    'Writes cache metadata alongside the dataset.'),
  '--conditioning_data_dir': of_('path-bearing',
    'Arbitrary read root.'),
  '--console_log_file': of_('path-bearing',
    'logging.FileHandler(path, mode="w") — opens the named file for TRUNCATION.'),
  '--in_json': of_('path-bearing',
    'Arbitrary read path.'),
  '--log_prefix': of_('path-bearing',
    'library/accelerator_setup.py:90 concatenates logging_dir + "/" + log_prefix + time.strftime(...) RAW. A ../ in this field walks out of the log root.'),
  '--logging_dir': of_('path-bearing',
    'Arbitrary write root. Component-supplied.'),
  '--metadata_thumbnail': of_('path-bearing',
    'sai_model_spec file_to_data_url reads the named file and base64s it INTO THE SAFETENSORS HEADER — an arbitrary read whose result is exfiltrated in the artifact we hash.'),
  '--offload_optimizer_nvme_path': of_('path-bearing',
    'DeepSpeed NVMe offload write dir.'),
  '--offload_param_nvme_path': of_('path-bearing',
    'DeepSpeed NVMe offload write dir.'),
  '--output_config': of_('path-bearing',
    'Writes toml.dump(vars(args)) to the --config_file path and exits.'),
  '--output_dir': of_('path-bearing',
    'Arbitrary write root, and library/sampling.py:326 also writes output_dir + "/sample" under it. Component-supplied.'),
  '--output_name': of_('path-bearing',
    'A filename stem with no sanitization observed upstream, joined into the output dir. Studio accepts it from the tenant, which is the one exception in the whole table, and pays for it with an anchored pattern that is itself asserted against a hostile corpus (job-spec.ts VETTED_SLUG_PATTERNS).'),
  '--reg_data_dir': of_('path-bearing',
    'Arbitrary read root.'),
  '--skip_image_resolution': of_('path-bearing',
    'Free-form string consumed by the dataset loader; not traced to a sink. Unresolved, therefore denied.'),
  '--tokenizer_cache_dir': of_('path-bearing',
    'Read/write cache dir, and a from_pretrained miss against it is a download.'),
  '--train_data_dir': of_('path-bearing',
    'Arbitrary read root. Component-supplied from dataset_id.'),

  /* ---- egress-bearing -------------------------------------------------- */
  '--async_upload': of_('egress-bearing',
    'Runs the upload on a detached thread (fire_in_thread); failures are only logged.'),
  '--huggingface_path_in_repo': of_('egress-bearing',
    'Part of the upload path.'),
  '--huggingface_repo_id': of_('egress-bearing',
    'library/huggingface_util.py upload() — HfApi create_repo / upload_file / upload_folder. Uploading the checkpoint from inside the trainer is exactly the artifact path the component exists to observe, routed around it.'),
  '--huggingface_repo_type': of_('egress-bearing',
    'Part of the upload path.'),
  '--huggingface_repo_visibility': of_('egress-bearing',
    'Part of the upload path, and note the inverted default: private unless the value is exactly "public".'),
  '--huggingface_token': of_('egress-bearing',
    'A credential in a job body. Scrubbed from the tracker config, which tells you it is one.'),
  '--log_config': of_('egress-bearing',
    'Logs the training configuration to the tracker. Inert with no tracker; denied with the rest of the tracker surface.'),
  '--log_tracker_name': of_('egress-bearing',
    'Only meaningful on the tracker path, which is off.'),
  '--log_with': of_('egress-bearing',
    'tensorboard | wandb | all. The wandb values open egress and upload the sanitized config — which scrubs only wandb_api_key and huggingface_token, so every local path in the run goes with it.'),
  '--resume_from_huggingface': of_('egress-bearing',
    'Turns --resume into hf_hub_download of a remote spec.'),
  '--save_state_to_huggingface': of_('egress-bearing',
    'Uploads the whole accelerate state directory.'),
  '--wandb_api_key': of_('egress-bearing',
    'library/accelerator_setup.py:112 wandb.login(key=...). A credential in a job body.'),
  '--wandb_run_name': of_('egress-bearing',
    'Only meaningful on the wandb path, which is off.'),

  /* ---- launcher -------------------------------------------------------- */
  '--debug_dataset': of_('launcher',
    'Turns the run into an interactive cv2.imshow session (library/dataset.py:1419) that never trains. Not a code-execution sink; refused because a job that does not train is not a job.'),
  '--deepspeed': of_('launcher',
    'Changes how the process is started and how many of it there are.'),
  '--fp16_master_weights_and_gradients': of_('launcher',
    'DeepSpeed configuration.'),
  '--offload_optimizer_device': of_('launcher',
    'DeepSpeed configuration.'),
  '--offload_param_device': of_('launcher',
    'DeepSpeed configuration.'),
  '--zero3_init_flag': of_('launcher',
    'DeepSpeed configuration.'),
  '--zero3_save_16bit_model': of_('launcher',
    'DeepSpeed configuration.'),
  '--zero_stage': of_('launcher',
    'DeepSpeed configuration.'),});

/**
 * Classify a flag. Accepts `--flag` and bare `flag` so a refusal message can
 * name the class for a field the caller wrote without dashes.
 *
 * Returns `undefined` for anything not in the table, and every caller treats
 * `undefined` as denied. That is the whole default-deny posture in one return
 * value: an argument you cannot classify is denied.
 */
export function classifyKohyaFlag(name: string): KohyaArgumentClass | undefined {
  const key = name.startsWith('--') ? name : `--${name}`;
  // Object.hasOwn, because a caller can pass `constructor` or `__proto__` —
  // JSON.parse makes the latter an own property of a request body — and a
  // bare index would answer with something off Object.prototype.
  return Object.hasOwn(KOHYA_ARGUMENT_CLASS, key) ? KOHYA_ARGUMENT_CLASS[key].cls : undefined;
}

export function whyKohyaFlagIsDenied(name: string): string | undefined {
  const key = name.startsWith('--') ? name : `--${name}`;
  return Object.hasOwn(KOHYA_ARGUMENT_CLASS, key) ? KOHYA_ARGUMENT_CLASS[key].why : undefined;
}

/** Every flag classified as anything other than a safe scalar. The test suite
 *  iterates this and asserts each one is refused by the job API — which is
 *  what "prove the denied set by test" means here. */
export function dangerousKohyaFlags(): readonly string[] {
  return Object.entries(KOHYA_ARGUMENT_CLASS)
    .filter(([, e]) => e.cls !== 'safe-scalar')
    .map(([f]) => f)
    .sort();
}

/**
 * The seventeen free-form strings on the `train_network.py` surface that the
 * mechanical rule left unclassified.
 *
 * They are enumerated HERE, outside KOHYA_ARGUMENT_CLASS, precisely so they
 * stay denied: adding one to the table would be a classification, and the
 * point of this constant is to record that none was made. The test suite
 * asserts each is refused by the job API and that none has quietly acquired
 * an entry. Reporting an argument you could not classify, rather than
 * silently allowing it, is the obligation this list discharges.
 */
export const UNCLASSIFIED_SURFACE_FLAGS: readonly string[] = Object.freeze([
  '--caption_extention',
  '--caption_prefix',
  '--caption_separator',
  '--caption_suffix',
  '--face_crop_aug_range',
  '--keep_tokens_separator',
  '--metadata_author',
  '--metadata_description',
  '--metadata_is_negative_embedding',
  '--metadata_license',
  '--metadata_merged_from',
  '--metadata_preprocessor',
  '--metadata_tags',
  '--metadata_title',
  '--metadata_trigger_phrase',
  '--metadata_usage_hint',
  '--secondary_separator',
]);

/**
 * Not a kohya flag at all, and the most important name in this file after
 * `--network_module`.
 *
 * `additional_parameters` is a FREE-TEXT BOX IN THE KOHYA GUI Studio ships
 * today. `kohya_gui/common_gui.py::run_cmd_advanced_training` takes it,
 * strips double quotes, splits on whitespace and appends each token to the
 * training argv (`shlex.quote`d, which does nothing useful for an argv list).
 * The GUI then runs that argv through `subprocess.Popen`
 * (`class_command_executor.py:156`).
 *
 * So the "paste your own args" trap this WO warns about is not hypothetical
 * and it is not something a future contributor might add. IT IS IN THE
 * PRODUCT, TODAY, and it is a general injection point for
 * `--network_module`, `--dataset_class` and `--optimizer_type` — the three
 * import paths above — reachable by any tenant with the GUI in front of them.
 *
 * It is the single most concrete piece of evidence for
 * docs/canon/KOHYA_REPLACEMENT.md §2's claim that a gate in front of Kohya's
 * GUI is a gate in front of a remote shell, and it is why WO-19 removes the
 * GUI rather than filtering it.
 */
export const GUI_ARBITRARY_ARGUMENT_FIELD = 'additional_parameters';
