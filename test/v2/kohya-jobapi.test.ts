// WO-19 — Studio's Kohya, to L2.
//
// ---------------------------------------------------------------------------
// WHAT THIS SUITE IS PROVING, AND WHY IT IS SHAPED LIKE THIS
// ---------------------------------------------------------------------------
//
// Studio's Kohya can be `server-library` only while the tenant has no code
// execution in the container. Everything else — the PID-1 component, the
// image with no Gradio port, the watcher that survived two moves — is
// downstream of one property:
//
//     THE TENANT CANNOT EXPRESS A COMMAND.
//
// A property like that is not proved by a happy-path test. It is proved by
// establishing that the DENIED SET is denied, and by making the tier itself
// fall over when it is not. So the suite has three unusual shapes:
//
//   1. It iterates the classification table rather than a hand-written list of
//      bad inputs. Every flag arguments.ts classifies as anything but a safe
//      scalar — 59 of them — is fed to the validator and asserted refused, in
//      both `--flag` and bare spellings. A hand-written list would drift from
//      the table; this cannot.
//
//   2. It POISONS the whitelist and asserts the tier drops. If adding an
//      "advanced: paste your own args" parameter did not move
//      `resolveStudioKohyaPlacement` off `server-library`, the derivation
//      would be decoration and the tier would be a declaration wearing a
//      function's clothes. That test is the load-bearing one in the file.
//
//   3. It asserts an ABSENCE by scanning source: no second construction site
//      for a kohya command line, no `shell: true`, no `witnessed: true`. The
//      drift-guard style used by kohya-honesty.test.ts and
//      packages/scruple-attestation-verifiers/src/status.test.ts.
//
// It also re-asserts `header_hash` on the new path. WO-11b carried the
// structural fingerprint out of the pod; this WO moves the capture again, and
// losing it here would make the second move a net evidence regression — worse
// than doing nothing.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path first. Use `npm run test:v2`.');
}

// Its own private sqlite file, for the reason kohya-honesty.test.ts documents:
// node's runner executes test files concurrently and concurrent
// runMigrations() against one file races. Modules that read SCRUPLE_DB_PATH at
// import time must therefore be imported AFTER this line, via dynamic import.
const PRIVATE_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kohya-jobapi-'));
process.env.SCRUPLE_DB_PATH = path.join(PRIVATE_DB_DIR, 'kohya-jobapi.db');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

import {
  KOHYA_ARGUMENT_CLASS,
  UNCLASSIFIED_SURFACE_FLAGS,
  classifyKohyaFlag,
  dangerousKohyaFlags,
} from '../../lib/apps/kohya/arguments';
import {
  HOSTILE_SLUGS,
  PARAMETER_WHITELIST,
  REFUSED_ESCAPE_HATCHES,
  canonicalJobJson,
  jobSpecHash,
  validateJobSpec,
  type ParameterSpec,
  type ValidatedJobSpec,
} from '../../lib/apps/kohya/job-spec';
import {
  STUDIO_GUI_CONFIGURATION,
  STUDIO_JOB_API_CONFIGURATION,
  resolveStudioKohyaPlacement,
  studioJobApiAssurance,
} from '../../lib/apps/kohya/placement';
import {
  buildTrainerArgv,
  componentSuppliedValues,
  dangerousFlagsWithTenantValues,
  type ComponentRoots,
} from '../../lib/apps/kohya/argv';
import { StudioJobRunner, JobPlacementRefusal } from '../../services/scruple-capture/kohya/job-runner';
import { CheckpointWatchSurface } from '../../services/scruple-capture/kohya/checkpoint-watch';
import type { CaptureObservation, ObservationSink } from '../../lib/capture/surface';
import type { CloseWriteSource } from '../../services/scruple-capture/src/surfaces/fs-watch';

/* ────────────────────────────────────────────────────────────────────────
 * Fixtures
 * ──────────────────────────────────────────────────────────────────────── */

const GOOD_JOB: Record<string, unknown> = {
  dataset_id: 'ds-01hzxyab',
  base_model_id: 'sdxl-base-1.0',
  training_type: 'lora',
  output_name: 'my-lora_v2.1',
  network_dim: 32,
  network_alpha: 16,
  network_dropout: 0.05,
  learning_rate: 0.0001,
  unet_lr: 0.0001,
  text_encoder_lr: 0.00005,
  optimizer: 'adamw8bit',
  lr_scheduler: 'cosine',
  lr_warmup_steps: 100,
  max_train_epochs: 10,
  train_batch_size: 2,
  gradient_accumulation_steps: 1,
  save_every_n_epochs: 1,
  seed: 42,
  mixed_precision: 'bf16',
  save_precision: 'fp16',
  gradient_checkpointing: true,
  cache_latents: true,
  attention: 'sdpa',
  resolution: '1024,1024',
  enable_bucket: true,
  min_bucket_reso: 256,
  max_bucket_reso: 1024,
  bucket_reso_steps: 64,
  caption_extension: '.txt',
  shuffle_caption: true,
  keep_tokens: 1,
  max_token_length: 225,
  clip_skip: 2,
  noise_offset: 0.05,
  min_snr_gamma: 5,
};

const ROOTS: ComponentRoots = {
  modelsRoot: '/srv/scruple/models',
  datasetsRoot: '/srv/scruple/datasets',
  outputRoot: '/srv/scruple/out',
  loggingRoot: '/srv/scruple/logs',
};

function validGood(): ValidatedJobSpec {
  const r = validateJobSpec(GOOD_JOB);
  assert.equal(r.ok, true, 'the reference job must validate');
  return (r as { ok: true; spec: ValidatedJobSpec }).spec;
}

class ManualSource implements CloseWriteSource {
  readonly method = 'inotify-close-write' as const;
  private cb: ((p: string) => void) | null = null;
  start(_dir: string, onCloseWrite: (p: string) => void): void {
    this.cb = onCloseWrite;
  }
  stop(): void {
    this.cb = null;
  }
  fire(p: string): void {
    this.cb?.(p);
  }
}

class CollectingSink implements ObservationSink {
  readonly seen: CaptureObservation[] = [];
  async emit(o: CaptureObservation): Promise<void> {
    this.seen.push(o);
  }
}

function writeSafetensors(dir: string, name: string): { abs: string; headerHash: string } {
  const header = {
    'lora_unet_down.lora_down.weight': { dtype: 'F16', shape: [8, 320], data_offsets: [0, 8] },
    __metadata__: { ss_network_dim: '32' },
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(headerBytes.length));
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, Buffer.concat([len, headerBytes, Buffer.alloc(16, 3)]));
  return { abs, headerHash: crypto.createHash('sha256').update(headerBytes).digest('hex') };
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. THE DENIED SET, PROVEN — the deliverable, not a detail
 * ══════════════════════════════════════════════════════════════════════ */

describe('the denied argument set is proven, not asserted', () => {
  test('the two the WO names by hand are denied, and for the right reason', () => {
    for (const flag of ['--network_module', '--sample_prompts']) {
      const cls = classifyKohyaFlag(flag);
      assert.ok(cls && cls !== 'safe-scalar', `${flag} must not be classified safe`);
      for (const spelling of [flag, flag.replace(/^--/, '')]) {
        const r = validateJobSpec({ ...GOOD_JOB, [spelling]: 'anything' });
        assert.equal(r.ok, false, `${spelling} must be refused`);
        assert.ok(
          (r as { ok: false; refusals: { field: string }[] }).refusals.some(
            (x) => x.field === spelling,
          ),
          `the refusal must name ${spelling}`,
        );
      }
    }
    assert.equal(classifyKohyaFlag('--network_module'), 'code-bearing');
  });

  test('EVERY dangerous flag in the classification table is refused', () => {
    const flags = dangerousKohyaFlags();
    assert.ok(flags.length >= 50, `expected the denied set to be substantial; got ${flags.length}`);
    const accepted: string[] = [];
    for (const flag of flags) {
      for (const spelling of [flag, flag.replace(/^--/, '')]) {
        // `--output_name` is the one path-bearing flag Studio accepts from the
        // tenant, under a vetted pattern — so its BARE spelling is a
        // whitelisted parameter and is expected to validate. Its dashed
        // spelling must still be refused.
        if (spelling === 'output_name') continue;
        const r = validateJobSpec({ ...GOOD_JOB, [spelling]: 'x' });
        if (r.ok) accepted.push(spelling);
      }
    }
    assert.deepEqual(
      accepted,
      [],
      'these dangerous arguments were ACCEPTED by the job API. Each one is a path from a ' +
        'tenant request to code execution, an arbitrary file, or egress, and any one of them ' +
        'puts Studio back at `unattested-client`.',
    );
  });

  test('every escape hatch is refused, and says which trap it was', () => {
    for (const [field, why] of Object.entries(REFUSED_ESCAPE_HATCHES)) {
      const r = validateJobSpec({ ...GOOD_JOB, [field]: 'x' });
      assert.equal(r.ok, false, `${field} must be refused`);
      const ref = (r as { ok: false; refusals: { field: string; code: string; message: string }[] })
        .refusals.find((x) => x.field === field);
      assert.ok(ref, `the refusal must name ${field}`);
      assert.equal(ref.code, 'escape-hatch');
      assert.equal(ref.message, why, 'the caller is told WHICH trap, not just "unknown field"');
    }
  });

  test('the seventeen unclassifiable arguments are denied by absence', () => {
    assert.equal(UNCLASSIFIED_SURFACE_FLAGS.length, 17);
    for (const flag of UNCLASSIFIED_SURFACE_FLAGS) {
      assert.equal(
        KOHYA_ARGUMENT_CLASS[flag],
        undefined,
        `${flag} has acquired a classification. It is on the list of arguments nobody could ` +
          'classify; classifying it is a decision that belongs in a review, and until then an ' +
          'argument you cannot classify is denied.',
      );
      assert.equal(classifyKohyaFlag(flag), undefined);
      const r = validateJobSpec({ ...GOOD_JOB, [flag.replace(/^--/, '')]: 'x' });
      assert.equal(r.ok, false, `${flag} must be refused`);
    }
  });

  test('prototype keys are refused as data, not answered off Object.prototype', () => {
    // JSON.parse makes `__proto__` an OWN property, so a request body can
    // carry any of these. A bare object index would have returned Object's
    // constructor for `constructor` — truthy — and put a function where a
    // refusal message belongs.
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const body = JSON.parse(JSON.stringify({ ...GOOD_JOB, [key]: 'x' }));
      const r = validateJobSpec(body);
      assert.equal(r.ok, false, `${key} must be refused`);
      for (const ref of (r as { ok: false; refusals: { message: unknown }[] }).refusals) {
        assert.equal(typeof ref.message, 'string', 'a refusal message is a string');
      }
      assert.equal(classifyKohyaFlag(key), undefined);
    }
  });

  test('an argument that exists in no list at all is still refused', () => {
    const r = validateJobSpec({ ...GOOD_JOB, some_future_kohya_flag: 'x' });
    assert.equal(r.ok, false, 'default deny is the whole posture');
    assert.match(
      (r as { ok: false; refusals: { message: string }[] }).refusals[0].message,
      /denies by default/,
    );
  });

  test('a whitelisted parameter still refuses a value outside its domain', () => {
    const cases: [string, unknown][] = [
      ['network_dim', 100000],
      ['network_dim', 2.5],
      ['network_dim', '32'],
      ['learning_rate', 1],
      ['mixed_precision', 'fp8'],
      ['optimizer', 'evil.module.Optimizer'],
      ['training_type', 'networks.evil'],
      ['base_model_id', '../../etc/passwd'],
      ['attention', 'flash'],
      ['resolution', '1,1'],
      ['max_token_length', 75],
      ['cache_latents', 'true'],
    ];
    for (const [field, value] of cases) {
      const r = validateJobSpec({ ...GOOD_JOB, [field]: value });
      assert.equal(r.ok, false, `${field}=${String(value)} must be refused`);
    }
  });

  test('output_name refuses every hostile slug, and dataset_id refuses traversal', () => {
    assert.ok(HOSTILE_SLUGS.length >= 15, 'the hostile corpus must be worth passing');
    for (const bad of HOSTILE_SLUGS) {
      const r = validateJobSpec({ ...GOOD_JOB, output_name: bad });
      assert.equal(r.ok, false, `output_name=${JSON.stringify(bad)} must be refused`);
    }
    for (const bad of ['../other', 'a/b', 'DS-UPPER', 'short', '.hidden', '-lead']) {
      const r = validateJobSpec({ ...GOOD_JOB, dataset_id: bad });
      assert.equal(r.ok, false, `dataset_id=${JSON.stringify(bad)} must be refused`);
    }
  });

  test('every refusal is collected, not just the first', () => {
    const r = validateJobSpec({ ...GOOD_JOB, network_module: 'a', sample_prompts: 'b', args: 'c' });
    assert.equal(r.ok, false);
    assert.equal((r as { ok: false; refusals: unknown[] }).refusals.length, 3);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 2. THE TIER IS DERIVED — the load-bearing tests
 * ══════════════════════════════════════════════════════════════════════ */

describe('placement is computed from the whitelist, not declared beside it', () => {
  test('the shipped job-API configuration resolves to server-library', () => {
    const a = studioJobApiAssurance();
    assert.equal(a.declaredPlacement, 'server-library');
    assert.equal(a.resolution.enforcement, 'no-tenant-code');
    assert.equal(a.resolution.effective, 'server-library');
    assert.equal(a.resolution.honoured, true);
    assert.equal(a.p1, 'holds', 'at server-library P1 is structural, not conditional');
    assert.equal(a.p3, 'holds');
    assert.equal(
      a.leaf,
      'passthrough',
      'and it is STILL passthrough: P1 being free does not buy a verified attestation, ' +
        'nothing does except chaining to a vendor root (PLACEMENT_AND_SURFACES.md §5.2)',
    );
    assert.equal(a.mayIssueLeaf, true);
    assert.ok(a.findings.every((f) => f.holds));
  });

  test("today's GUI configuration resolves to unattested-client and may issue no leaf", () => {
    const a = resolveStudioKohyaPlacement(STUDIO_GUI_CONFIGURATION);
    assert.equal(a.resolution.effective, 'unattested-client');
    assert.equal(a.leaf, null);
    assert.equal(a.mayIssueLeaf, false);
    assert.equal(a.canClaim, false);
    const exec = a.findings.find((f) => f.obligation.includes('code execution'));
    assert.equal(exec?.holds, false);
    assert.match(exec!.reason, /kohya-gui/);
  });

  test('ONE free-form argument field drops Studio to unattested-client', () => {
    // The trap PLACEMENT_AND_SURFACES.md §7.3 records for a vendor's
    // custom-handler path, reproduced against ourselves. If this test ever
    // goes green with `server-library`, the derivation has become decoration.
    const pasteYourOwnArgs = {
      name: 'advanced_args',
      kind: 'slug' as const,
      valueSource: 'tenant' as const,
      pattern: /^.*$/,
      emits: ['--network_module'],
      why: 'the box a product manager asks for',
    } as unknown as ParameterSpec;

    const poisoned = resolveStudioKohyaPlacement({
      ...STUDIO_JOB_API_CONFIGURATION,
      whitelist: [...PARAMETER_WHITELIST, pasteYourOwnArgs],
    });
    assert.equal(poisoned.resolution.effective, 'unattested-client');
    assert.equal(poisoned.mayIssueLeaf, false);
    const f = poisoned.findings.find((x) => x.obligation.includes('component-supplied'));
    assert.equal(f?.holds, false);
    assert.match(f!.reason, /advanced_args → --network_module/);
    assert.equal(f!.basis, 'derived', 'and it was derived, so nobody had to remember it');
  });

  test('emitting a flag nobody classified also drops the tier', () => {
    const unknownEmitter = {
      name: 'mystery',
      kind: 'boolean' as const,
      valueSource: 'tenant' as const,
      emits: ['--a_flag_added_upstream_last_tuesday'],
      why: 'an upstream release',
    } as unknown as ParameterSpec;
    const a = resolveStudioKohyaPlacement({
      ...STUDIO_JOB_API_CONFIGURATION,
      whitelist: [...PARAMETER_WHITELIST, unknownEmitter],
    });
    assert.equal(a.resolution.effective, 'unattested-client');
    const f = a.findings.find((x) => x.obligation.includes('classification table'));
    assert.equal(f?.holds, false);
  });

  test('a declared obligation that is false also drops the tier', () => {
    for (const patch of [
      { componentIsPid1: false },
      { trainerIsChildOfComponent: false },
      { tenantSurfaces: ['training-job-api', 'jupyter'] as never },
    ]) {
      const a = resolveStudioKohyaPlacement({ ...STUDIO_JOB_API_CONFIGURATION, ...patch });
      assert.equal(a.resolution.effective, 'unattested-client', JSON.stringify(patch));
    }
  });

  test('the two declared obligations are reported as needing a probe', () => {
    const a = studioJobApiAssurance();
    assert.equal(a.needsProbe.length, 2);
    assert.ok(a.needsProbe.some((n) => n.includes('code execution')));
    assert.ok(a.needsProbe.some((n) => n.includes('PID 1')));
    assert.equal(
      a.findings.filter((f) => f.basis === 'derived').length,
      3,
      'three of the five obligations are computed from source; the report must not claim more',
    );
  });

  test('every whitelisted parameter emits only classified flags', () => {
    for (const p of PARAMETER_WHITELIST) {
      for (const flag of p.emits) {
        assert.ok(
          classifyKohyaFlag(flag),
          `${p.name} emits ${flag}, which is not in the classification table`,
        );
      }
      if (p.valueSource === 'tenant') {
        for (const flag of p.emits) {
          const cls = classifyKohyaFlag(flag);
          const vetted = cls === 'path-bearing' && p.kind === 'slug';
          assert.ok(
            cls === 'safe-scalar' || vetted,
            `${p.name} is tenant-valued and emits ${flag} (${cls})`,
          );
        }
      }
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 3. THE COMMAND LINE
 * ══════════════════════════════════════════════════════════════════════ */

describe('the built command line carries no tenant-chosen dangerous value', () => {
  test('a valid job builds an argv with only component-supplied dangerous values', () => {
    const plan = buildTrainerArgv(validGood(), ROOTS, 'kj_test');
    const bad = dangerousFlagsWithTenantValues(plan.argv, componentSuppliedValues(plan));
    assert.deepEqual(bad, []);
    assert.ok(plan.argv.includes('--network_module'));
    assert.equal(plan.argv[plan.argv.indexOf('--network_module') + 1], 'networks.lora');
    assert.equal(plan.argv[plan.argv.indexOf('--optimizer_type') + 1], 'AdamW8bit');
    assert.equal(
      plan.argv[0],
      'sd-scripts/sdxl_train_network.py',
      'the base model selects the SCRIPT — there is no --sdxl argument in sd-scripts, and a ' +
        'table built from what the GUI renders would have invented one',
    );
  });

  test('argv contains none of the denied flags', () => {
    const plan = buildTrainerArgv(validGood(), ROOTS, 'kj_test');
    const emitted = new Set(plan.argv.filter((t) => t.startsWith('--')));
    for (const flag of dangerousKohyaFlags()) {
      const componentEmits = [
        '--network_module',
        '--optimizer_type',
        '--pretrained_model_name_or_path',
        '--train_data_dir',
        '--output_dir',
        '--logging_dir',
        '--output_name',
      ];
      if (componentEmits.includes(flag)) continue;
      assert.equal(emitted.has(flag), false, `${flag} must never be emitted`);
    }
  });

  test('every path in argv is inside a component-owned root', () => {
    const plan = buildTrainerArgv(validGood(), ROOTS, 'kj_test');
    assert.ok(plan.paths.dataset.startsWith(ROOTS.datasetsRoot + '/'));
    assert.ok(plan.paths.baseModel.startsWith(ROOTS.modelsRoot + '/'));
    assert.ok(plan.paths.outputDir.startsWith(ROOTS.outputRoot + '/'));
    assert.ok(plan.paths.loggingDir.startsWith(ROOTS.loggingRoot + '/'));
  });

  test('buildTrainerArgv re-refuses a hostile output_name even if validation was skipped', () => {
    const spec = { ...validGood(), output_name: '../../etc/cron.d/x' } as ValidatedJobSpec;
    assert.throws(() => buildTrainerArgv(spec, ROOTS, 'kj_test'), /output_name/);
  });

  test('a field with no emission rule cannot reach argv', () => {
    const spec = { ...validGood(), network_module: 'evil' } as unknown as ValidatedJobSpec;
    assert.throws(() => buildTrainerArgv(spec, ROOTS, 'kj_test'), /no emission rule/);
  });

  test("the trainer's environment is a replacement, not the tenant's", () => {
    const plan = buildTrainerArgv(validGood(), ROOTS, 'kj_test');
    for (const forbidden of ['PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH']) {
      assert.equal(plan.env[forbidden], undefined, `${forbidden} is code execution as configuration`);
    }
    assert.equal(
      plan.env.PYTHONNOUSERSITE,
      '1',
      'sitecustomize.py on the user site path is exactly how the shipped in-pod hook installed ' +
        'itself, so it is a demonstrated injection point, not a theoretical one',
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. THE RUNNER, AND header_hash
 * ══════════════════════════════════════════════════════════════════════ */

describe('the component runs the trainer and keeps the structural fingerprint', () => {
  test('a checkpoint close still produces model_write with header_hash and a run commitment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kohya-job-vol-'));
    const { abs, headerHash } = writeSafetensors(dir, 'my-lora_v2.1.safetensors');
    const sink = new CollectingSink();
    const source = new ManualSource();
    const spec = validGood();

    const spawned: { bin: string; argv: readonly string[]; env: Record<string, string> }[] = [];
    const runner = await StudioJobRunner.start(
      {
        roots: { ...ROOTS, outputRoot: dir },
        source,
        log: () => undefined,
        spawnFn: (bin, argv, o) => {
          spawned.push({ bin, argv, env: o.env });
          return { pid: 1234 } as never;
        },
      },
      sink,
    );

    assert.equal(runner.assurance.placement, 'server-library');
    await runner.startJob('kj_1', spec);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].bin, '/usr/bin/python3');

    source.fire(abs);
    await runner.settled();

    assert.equal(sink.seen.length, 1);
    const o = sink.seen[0];
    assert.equal(o.hook, 'model.write');
    assert.equal(o.evidence?.kind, 'model_write');
    assert.equal(
      o.evidence?.header_hash,
      headerHash,
      'the safetensors structural fingerprint must survive the SECOND re-placement too. The ' +
        'in-pod hook computed it, WO-11b carried it out of the pod, and losing it here would ' +
        'make this WO a net evidence regression — worse than doing nothing.',
    );
    assert.equal(o.bytes?.fidelity, 'as-written');
    assert.equal(
      (o.evidence?.structural_summary as Record<string, unknown>).layer_count,
      1,
      '__metadata__ is not a tensor',
    );

    // The run commitment: the leaf binds to the hyperparameters, not a filename.
    const graph = o.evidence?.graph as Record<string, unknown>;
    assert.ok(graph, 'a checkpoint with no run commitment is an image leaf with a longer name');
    assert.equal(o.evidence?.correlation_method, 'training-run');
    assert.equal(JSON.stringify(graph), canonicalJobJson(spec));
    assert.equal(graph.network_dim, 32);
    assert.equal(
      graph.network_module,
      undefined,
      'the commitment is the tenant-facing job, which contains no import path at all',
    );

    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the runner refuses to start where the configuration does not survive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kohya-job-refuse-'));
    await assert.rejects(
      () =>
        StudioJobRunner.start(
          {
            roots: { ...ROOTS, outputRoot: dir },
            configuration: STUDIO_GUI_CONFIGURATION,
            source: new ManualSource(),
            log: () => undefined,
          },
          new CollectingSink(),
        ),
      (e: unknown) => {
        assert.ok(e instanceof JobPlacementRefusal);
        assert.equal(e.assurance.resolution.effective, 'unattested-client');
        assert.match(e.message, /NO LEAF MAY BE ISSUED/);
        return true;
      },
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a job spec hashes canonically, so the row and the leaf agree by construction', () => {
    const a = validateJobSpec(GOOD_JOB);
    const reordered = Object.fromEntries(Object.entries(GOOD_JOB).reverse());
    const b = validateJobSpec(reordered);
    assert.ok(a.ok && b.ok);
    assert.equal(jobSpecHash(a.spec), jobSpecHash(b.spec));
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 5. THE ROUTE
 * ══════════════════════════════════════════════════════════════════════ */

let POST: typeof import('../../app/api/apps/kohya/jobs/route').POST;
let conn: typeof import('../../lib/db/sqlite').conn;
let sessionId: string;
let otherSessionId: string;
const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

function signedRequest(body: unknown, token = TOKEN): Request {
  const raw = JSON.stringify(body);
  return new Request('https://scruple.ai/api/apps/kohya/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-scruple-signature': crypto.createHmac('sha256', token).update(raw).digest('hex'),
    },
    body: raw,
  });
}

before(async () => {
  const { runMigrations } = await import('../../lib/db/migrate');
  ({ conn } = await import('../../lib/db/sqlite'));
  ({ POST } = await import('../../app/api/apps/kohya/jobs/route'));
  runMigrations(false);

  const now = new Date().toISOString();
  const project = conn()
    .prepare(
      `INSERT INTO projects
         (user_id, name, type, status, created_at, iteration_count, is_active, witnessed_count, is_archived)
       VALUES ('u-jobapi', 'kohya-jobapi', 'training', 'unlocked', ?, 0, 1, 0, 0)`,
    )
    .run(now);
  const projectId = project.lastInsertRowid as number;

  sessionId = crypto.randomUUID();
  otherSessionId = crypto.randomUUID();
  const insert = conn().prepare(
    `INSERT INTO app_sessions
       (id, user_id, app_id, backend, machine_id, endpoint_id, endpoint_url,
        signed_token, expires_at, status)
     VALUES (?, ?, 'kohya', 'runpod', 'm', ?, 'https://pod.example', ?,
             datetime('now', '+1 hour'), 'active')`,
  );
  insert.run(sessionId, 'u-jobapi', String(projectId), TOKEN);
  insert.run(otherSessionId, 'u-other', String(projectId), OTHER_TOKEN);
});

after(() => {
  try {
    fs.rmSync(PRIVATE_DB_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('POST /api/apps/kohya/jobs', () => {
  test('accepts a valid job and reports the derived tier', async () => {
    const res = await POST(signedRequest({ session_id: sessionId, spec: GOOD_JOB }) as never);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.placement, 'server-library');
    assert.equal(body.leaf, 'passthrough');
    assert.equal(body.p1, 'holds');
    assert.equal(body.p3, 'holds');
    assert.equal(body.spec_hash, jobSpecHash(validGood()));
    assert.ok(body.run_id, 'the job is the row, so a failed insert must not answer ok');
    assert.equal(body.needs_probe.length, 2);
  });

  test('the accepted job is never reported as witnessed', async () => {
    const res = await POST(signedRequest({ session_id: sessionId, spec: GOOD_JOB }) as never);
    const body = await res.json();
    assert.equal(
      body.witnessed,
      false,
      'accepting a job is not observing an artifact. No path may report a checkpoint as ' +
        'witnessed unless a leaf exists (D-8).',
    );
    assert.ok(body.reason.length > 20);
  });

  test('refuses a command, an escape hatch, and a parameter beside the spec', async () => {
    for (const spec of [
      { ...GOOD_JOB, args: '--network_module evil' },
      { ...GOOD_JOB, command: 'bash -c id' },
      { ...GOOD_JOB, config_file: '/tmp/x.toml' },
      { ...GOOD_JOB, sample_prompts: '/etc/passwd' },
    ]) {
      const res = await POST(signedRequest({ session_id: sessionId, spec }) as never);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'job refused');
      assert.ok(body.refusals.length >= 1);
    }
    const beside = await POST(
      signedRequest({ session_id: sessionId, spec: GOOD_JOB, extra_args: '--x' }) as never,
    );
    assert.equal(beside.status, 400);
    assert.equal((await beside.json()).error, 'unexpected fields');
  });

  test('another session token cannot submit, and an unknown session answers 401', async () => {
    const wrong = await POST(
      signedRequest({ session_id: sessionId, spec: GOOD_JOB }, OTHER_TOKEN) as never,
    );
    assert.equal(wrong.status, 401);
    const unknown = await POST(signedRequest({ session_id: 'nope', spec: GOOD_JOB }) as never);
    assert.equal(unknown.status, 401, 'not 404 — that would be a session-enumeration oracle');
  });

  test('a revoked session is refused', async () => {
    const id = crypto.randomUUID();
    conn()
      .prepare(
        `INSERT INTO app_sessions
           (id, user_id, app_id, backend, machine_id, endpoint_id, endpoint_url,
            signed_token, expires_at, status)
         VALUES (?, 'u-jobapi', 'kohya', 'runpod', 'm', '0', 'https://pod.example', ?,
                 datetime('now', '+1 hour'), 'revoked')`,
      )
      .run(id, TOKEN);
    const res = await POST(signedRequest({ session_id: id, spec: GOOD_JOB }) as never);
    assert.equal(res.status, 403);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 6. DRIFT GUARDS — properties asserted as absences
 * ══════════════════════════════════════════════════════════════════════ */

describe('source does not contradict the placement (drift guard)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  test('the jobs route never hardcodes witnessed: true', () => {
    const src = read('app/api/apps/kohya/jobs/route.ts');
    assert.ok(
      !/witnessed:\s*true/.test(src),
      'this route accepts jobs; it observes nothing and signs nothing. If a leaf is ever ' +
        'issued from here, delete this assertion in the same commit and say so.',
    );
    assert.match(src, /witnessed:\s*false/);
  });

  test('nothing in the owned tree spawns through a shell', () => {
    for (const rel of [
      'services/scruple-capture/kohya/job-runner.ts',
      'lib/apps/kohya/argv.ts',
      'lib/apps/kohya/job-spec.ts',
      'app/api/apps/kohya/jobs/route.ts',
    ]) {
      const src = read(rel);
      assert.ok(!/shell:\s*true/.test(src), `${rel} must never spawn through a shell`);
      assert.ok(
        !/\bexecSync\b|\bexec\(|child_process'\s*\)\.exec/.test(src),
        `${rel} must not use exec — with a shell there is no such thing as a safe string`,
      );
    }
  });

  test('there is exactly one place a kohya command line is constructed', () => {
    // A second construction site is how the whitelist gets bypassed later:
    // some helper that "just needs one more flag" and does not go through
    // buildTrainerArgv. The property is worth an assertion because it is
    // invisible in review.
    const sites = ['lib/apps/kohya/argv.ts', 'services/scruple-capture/kohya/job-runner.ts'];
    const constructors = sites.filter((rel) => /--network_module'/.test(read(rel)));
    assert.deepEqual(
      constructors,
      ['lib/apps/kohya/argv.ts'],
      'only argv.ts may emit --network_module',
    );
  });

  test('the image backs the two obligations the code can only declare', () => {
    // placement.ts marks these `basis: 'declaration'` and reports them in
    // needsProbe, because no code in this process can see a running container.
    // A source guard is not a probe and is not offered as one — H-4 §7 is what
    // converts a declaration into evidence. What it does buy is that the
    // declaration cannot silently stop matching the image it describes.
    // Comments stripped first. Both files EXPLAIN what they leave out — the
    // GUI, port 7860, sitecustomize — because a reader needs to know that the
    // absences are decisions rather than oversights. A scan that cannot tell a
    // rationale from an instruction would force that reasoning out of the
    // files, which is the wrong trade. Same technique
    // kohya-replacement.test.ts uses on runpod-session.ts.
    const strip = (src: string) =>
      src
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
    const df = strip(read('research/scruple-kohya-image/Dockerfile.jobapi'));
    const sh = strip(read('research/scruple-kohya-image/start-jobapi.sh'));

    assert.ok(!/kohya_ss/.test(df), 'the GUI must not be installed, not merely unexposed');
    assert.ok(!/7860|EXPOSE\s+3001/.test(df), 'no Gradio port');
    assert.match(df, /EXPOSE 8899/, 'the only exposed port is the job API');
    assert.ok(
      !/sitecustomize/.test(df),
      'no in-pod hook: a hash of a file computed by the party that can rewrite it proves ' +
        'nothing, which is why P2 called the old path unfixable in place',
    );
    assert.match(df, /ENTRYPOINT \[\]/, 'clear whatever the base image declared');
    assert.match(df, /ARG SD_SCRIPTS_REF=[0-9a-f]{40}/, 'the pin is part of the security argument');
    assert.match(
      sh,
      /^exec /m,
      '`exec` is what makes the component PID 1 rather than a child of a shell that could be ' +
        'killed while the trainer keeps writing to a volume nobody is watching',
    );
  });

  test('the GUI is not in the job-API configuration', () => {
    assert.equal(
      STUDIO_JOB_API_CONFIGURATION.tenantSurfaces.includes('kohya-gui'),
      false,
      "Studio's answer is available to us because we own the surface. Exposing the GUI " +
        'alongside the job API is a second configuration with a worse tier hiding inside the ' +
        'first (PLACEMENT_AND_SURFACES.md §4.2).',
    );
  });
});
