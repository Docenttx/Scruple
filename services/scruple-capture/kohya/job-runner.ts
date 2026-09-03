// The component as PID 1, the trainer as its child — WO-19.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED, AND WHY IT IS A DIFFERENT FILE FROM index.ts
// ---------------------------------------------------------------------------
//
// index.ts is WO-11b's runner. It hosts the SIDECAR shape: the tenant keeps
// Kohya's GUI, the component watches from a namespace the tenant cannot reach,
// and on a RunPod Pod it refuses to start because RunPod has no second
// container to put it in (docs/canon/KOHYA_REPLACEMENT.md §3). That refusal is
// correct and stays.
//
// This file hosts the OTHER answer to the same question — §4's (b2), the one
// the doc recommends. Instead of moving the component out of the tenant's
// reach, it removes the tenant's reach:
//
//     the component owns PID 1;
//     the trainer is a child it spawns;
//     the tenant-facing surface is a job API that cannot express a command
//     (lib/apps/kohya/job-spec.ts).
//
// One container, no substrate migration, and the placement is
// `server-library` — a STRONGER tier than the sidecar the WO originally
// asked for, because at `server-library` P1 and P3 both hold outright rather
// than conditionally (PLACEMENT_AND_SURFACES.md §5.2).
//
// The two are not alternatives to choose between at runtime. They are two
// CONFIGURATIONS with two tiers, certified separately (§4.2), and each refuses
// where it does not fit. That is why there are two runners and not one runner
// with a flag.
//
// ---------------------------------------------------------------------------
// PID 1 IS NOT A DETAIL
// ---------------------------------------------------------------------------
//
// If the trainer is PID 1 and the component is a child, killing the component
// leaves the container running with an unobserved trainer in it — a checkpoint
// written to a volume nobody is watching, which produces NO LEAF FOR AN EVENT
// THAT HAPPENED, the failure mode PLACEMENT_AND_SURFACES.md §2.2 says must
// never be modelled as a weaker leaf because it is invisible.
//
// With the component as PID 1 the same act ends the container. The tenant can
// still stop being witnessed; they cannot stop being witnessed and keep
// training. That is the same trade H-4 §4.2 makes with the counter in the
// clear, and it is the guarantee payments actually ships.
//
// ---------------------------------------------------------------------------
// AND header_hash SURVIVES THE SECOND MOVE
// ---------------------------------------------------------------------------
//
// The in-pod hook computed it; WO-11b carried it out of the pod; this file
// keeps it, by reusing CheckpointWatchSurface unchanged rather than writing a
// second observer. Losing it here would make the re-placement a net evidence
// regression — worse than doing nothing — which is exactly what
// STUDIO_P1-P8_GRADE.md records /v2/witness doing to the legacy canvas leaf.
// The only thing this file adds to the watcher is a RUN CONTEXT: the validated
// job, so the checkpoint's leaf commits to the hyperparameters that produced
// it instead of to a filename.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import {
  buildTrainerArgv,
  componentSuppliedValues,
  dangerousFlagsWithTenantValues,
  type ComponentRoots,
  type TrainerPlan,
} from '../../../lib/apps/kohya/argv';
import {
  canonicalJobJson,
  jobSpecHash,
  type ValidatedJobSpec,
} from '../../../lib/apps/kohya/job-spec';
import {
  STUDIO_JOB_API_CONFIGURATION,
  resolveStudioKohyaPlacement,
  type StudioKohyaAssurance,
  type StudioKohyaConfiguration,
} from '../../../lib/apps/kohya/placement';
import type { ObservationSink } from '../../../lib/capture/surface';
import { CheckpointWatchSurface, type KohyaRunContext } from './checkpoint-watch';
import {
  baseModelCommitment,
  datasetRootHash,
  trainingInputHash,
  type DatasetCommitment,
} from './commitments';
import type { CloseWriteSource } from '../src/surfaces/fs-watch';

export class JobPlacementRefusal extends Error {
  constructor(
    readonly assurance: StudioKohyaAssurance,
    message: string,
  ) {
    super(message);
    this.name = 'JobPlacementRefusal';
  }
}

/** WO-35 — what an operator can learn about a job without a shell. */
export const JOB_TAIL_LINES = 40;

export interface JobRecord {
  jobId: string;
  specHash: string;
  state: 'running' | 'exited' | 'failed';
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  /** Last JOB_TAIL_LINES lines of the trainer's own stdout/stderr. */
  tail: string[];
}

/** A spawn we can substitute in tests. The signature is deliberately narrower
 *  than child_process.spawn's: there is no `shell` option to pass, because
 *  there is no shell. */
export type SpawnFn = (
  bin: string,
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
) => ChildProcess;

export interface StudioJobRunnerOptions {
  roots: ComponentRoots;
  /** The vendor's declaration for the checkpoint volume, or null. Never guessed. */
  declaredMime?: string | null;
  configuration?: StudioKohyaConfiguration;
  source?: CloseWriteSource;
  spawnFn?: SpawnFn;
  log?: (line: string) => void;
}

export interface StartedJob {
  jobId: string;
  plan: TrainerPlan;
  child: ChildProcess;
  specHash: string;
}

/**
 * The PID-1 component. It resolves its own placement once, refuses if the
 * configuration did not survive, and thereafter accepts validated jobs.
 */
export class StudioJobRunner {
  readonly assurance: StudioKohyaAssurance;
  private readonly log: (line: string) => void;
  /** WO-35 — bounded, in-memory. Lost on restart, which is correct: this is
   *  operational state, not evidence. Evidence is the leaf. */
  private readonly jobs = new Map<string, JobRecord>();
  private readonly spawnFn: SpawnFn;
  private readonly watch: CheckpointWatchSurface;
  private run: KohyaRunContext | null = null;

  private constructor(
    readonly opts: StudioJobRunnerOptions,
    assurance: StudioKohyaAssurance,
  ) {
    this.assurance = assurance;
    this.log = opts.log ?? ((l) => console.log(`[scruple-capture/kohya-jobs] ${l}`));
    this.spawnFn =
      opts.spawnFn ??
      ((bin, argv, o) =>
        // shell: false is the default and is stated anyway, because this is
        // the line that makes `output_name` a string rather than a program.
        nodeSpawn(bin, [...argv], {
          cwd: o.cwd,
          // A REPLACEMENT, not a delta. The cast is to NodeJS.ProcessEnv,
          // which this repo's types declare with required keys; the runtime
          // contract is a plain string map and passing a partial one is the
          // whole point — see argv.ts on PYTHONPATH / sitecustomize.
          env: o.env as unknown as NodeJS.ProcessEnv,
          shell: false,
          // WO-35 — was `'inherit'`, which sent the trainer's output to the
          // container log and nowhere a caller could reach. RunPod's REST v1
          // has no log endpoint and this component deliberately has no shell,
          // so a job that failed had NO diagnosis path at all: the operator
          // saw a 202, then silence, and could not distinguish "still loading
          // a 7.7GB checkpoint" from "died on the first import".
          //
          // "No shell" is the right answer for the TENANT. It was never meant
          // to mean the OPERATOR cannot be told why their training failed.
          // `progress-stream` is already one of the exposed surfaces the
          // placement declares, so reporting job state does not widen the
          // claim — it fills in a surface that was declared and absent.
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
    this.watch = new CheckpointWatchSurface({
      volume: opts.roots.outputRoot,
      declaredMime: opts.declaredMime ?? null,
      source: opts.source,
      // A thunk, because the watcher opens before any job arrives. Absent is
      // an honest state and produces a leaf with no run commitment rather
      // than a fabricated one.
      runContext: () => this.run,
      log: this.log,
    });
  }

  /**
   * Resolve, refuse, then open the watcher. The ORDER matches index.ts's and
   * for the same reason: a configuration that may not issue a leaf must not
   * acquire an identity, burn a provisioning token, or bind a watcher that
   * will observe events it may not report.
   */
  static async start(
    opts: StudioJobRunnerOptions,
    sink: ObservationSink,
  ): Promise<StudioJobRunner> {
    const cfg = opts.configuration ?? STUDIO_JOB_API_CONFIGURATION;
    const assurance = resolveStudioKohyaPlacement(cfg);
    const log = opts.log ?? ((l: string) => console.log(`[scruple-capture/kohya-jobs] ${l}`));

    log(`configuration: ${assurance.configuration}`);
    log(`placement: ${assurance.resolution.reason}`);
    log(`assurance: ${assurance.reason}`);
    for (const f of assurance.findings) {
      log(`  [${f.basis}] ${f.holds ? 'holds' : 'FAILS'} — ${f.obligation}: ${f.reason}`);
    }
    for (const n of assurance.needsProbe) {
      log(`  probe required before this is evidence: ${n}`);
    }

    if (!assurance.mayIssueLeaf) {
      throw new JobPlacementRefusal(
        assurance,
        `Refusing to start. '${cfg.label}' resolves to placement ` +
          `'${assurance.resolution.effective}' (${assurance.resolution.reason}), where P1 and ` +
          'P3 fail and NO LEAF MAY BE ISSUED. The failing obligations are: ' +
          assurance.findings
            .filter((f) => !f.holds)
            .map((f) => `${f.obligation} — ${f.reason}`)
            .join(' | ') +
          '. The remedy is a configuration change, not a flag.',
      );
    }

    const runner = new StudioJobRunner(opts, assurance);
    await runner.watch.open({ sink, placement: assurance.placement, config: {} });
    return runner;
  }

  /**
   * Start a validated job.
   *
   * `spec` MUST have come from `validateJobSpec`. This method does not
   * re-validate — `buildTrainerArgv` refuses any field with no emission rule,
   * which catches a bypass — but it DOES re-check the built command line
   * against the classification table before spawning. That last check is
   * belt-and-braces over a property placement.ts already derives statically,
   * and it is cheap: if the static derivation is ever wrong, this is where it
   * surfaces as a refusal instead of as a process.
   */
  async startJob(jobId: string, spec: ValidatedJobSpec): Promise<StartedJob> {
    const plan = buildTrainerArgv(spec, this.opts.roots, jobId);

    const bad = dangerousFlagsWithTenantValues(plan.argv, componentSuppliedValues(plan));
    if (bad.length) {
      throw new Error(
        'Refusing to spawn: the built command line carries a dangerous flag with a value the ' +
          `component did not supply — ${bad.join('; ')}. lib/apps/kohya/placement.ts derives ` +
          'the tier from the assertion that this cannot happen, so reaching here means the ' +
          'whitelist and the classification table have disagreed and the tier is wrong.',
      );
    }

    // ---- the two commitments that were null until WO-30 -----------------
    //
    // WHAT CHANGED IS THE ARGUMENT, NOT THE HONESTY RULE. The previous
    // comment here said dataset and base-model commitments "are established
    // by the ingest path that minted the ids, not by this process," and left
    // both null. That is right about ATTRIBUTION and wrong about
    // AVAILABILITY: `buildTrainerArgv` has just resolved and
    // containment-checked both paths under roots this component owns, so the
    // bytes are in reach right now, immediately before the trainer reads
    // them. The claim made is therefore the weaker, checkable one — THESE ARE
    // THE BYTES THE TRAINER READ — and not "Studio's upload path vouches for
    // this dataset id", which this process still cannot say.
    //
    // `docs/canon/demo-readiness/training.md` §4/§5 is the reason it matters:
    // `input_hash` is the field that answers "what data was this trained on",
    // and no shipping path populated it. A checkpoint hash with no dataset
    // commitment is a log line.
    //
    // ABSENT ON FAILURE, NEVER FABRICATED. A dataset root that is not there,
    // or a base-model file that is not there, produces null and a log line —
    // the leaf then says less, which is the correct direction. It does not
    // refuse: a checkpoint that exists and gets no leaf is the invisible
    // failure PLACEMENT_AND_SURFACES.md §2.2 forbids, and it would be a
    // strictly worse answer than a leaf with two null fields.
    let dataset: DatasetCommitment | null = null;
    try {
      dataset = datasetRootHash(plan.paths.dataset);
    } catch (e) {
      this.log(
        `job ${jobId}: NO DATASET COMMITMENT — ${String(e)}. The leaf will carry a null ` +
          'input_hash, which is the field a regulator asks about. This is recorded, not ' +
          'papered over.',
      );
    }

    const baseModel = baseModelCommitment(
      plan.paths.baseModel,
      path.relative(this.opts.roots.modelsRoot, plan.paths.baseModel).split(path.sep).join('/'),
    );
    if (!baseModel) {
      this.log(
        `job ${jobId}: NO BASE-MODEL FINGERPRINT — ${plan.paths.baseModel} is not readable. ` +
          'The leaf will carry a null model_fingerprints_hash.',
      );
    }

    this.run = {
      // The COMMITMENT the checkpoint's leaf carries: the canonical job, not a
      // filename. WO-20 will need the same shape for vendors; it is built here
      // first, which is the only sense in which WO-19 gates it.
      //
      // It is the TENANT-FACING job, not the argv — no import paths, no
      // resolved paths, no component-supplied module names. And it is sent
      // through `hashGraphOrTraining` -> RFC 8785 unchanged, NOT through
      // WO-20's `encode_number` quoting: WO-21 moved both languages onto RFC
      // 8785, whose §3.2.2.3 mandates ECMA-262 Number::toString, so the raw
      // floats in a learning rate now canonicalize identically in TypeScript
      // and in Python. Quoting them here would REINTRODUCE a divergence —
      // `encode_number` uses Python `repr`, and a JS component writing
      // "0.00001" where Python writes "1e-05" is the same bug one layer in
      // (packages/scruple-api/scruple_api/canonical.py, module docstring).
      trainingConfig: JSON.parse(canonicalJobJson(spec)) as Record<string, unknown>,
      inputHash: dataset ? trainingInputHash(dataset.rootHash) : null,
      modelFingerprintsHash: baseModel?.hash ?? null,
      modelFingerprints: baseModel?.manifest ?? null,
      datasetSummary: dataset
        ? {
            root_hash: dataset.rootHash,
            file_count: dataset.fileCount,
            total_bytes: dataset.totalBytes,
            skipped: dataset.skipped,
          }
        : null,
    };

    this.log(
      `job ${jobId} spec=${jobSpecHash(spec).slice(0, 12)} → ${plan.bin} ` +
        `${plan.argv.map((a) => path.basename(a)).slice(0, 3).join(' ')}…`,
    );

    const child = this.spawnFn(plan.bin, plan.argv, { cwd: plan.cwd, env: plan.env });

    // WO-35 — job state, so a 202 is not the last thing an operator hears.
    // A bounded tail: enough to name a failure, never a log service.
    const rec: JobRecord = {
      jobId,
      specHash: jobSpecHash(spec),
      state: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      signal: null,
      tail: [],
    };
    this.jobs.set(jobId, rec);
    const keep = (chunk: unknown): void => {
      for (const line of String(chunk).split('\n')) {
        const t = line.trimEnd();
        if (!t) continue;
        rec.tail.push(t.slice(0, 400));
        if (rec.tail.length > JOB_TAIL_LINES) rec.tail.shift();
      }
    };
    // EVERY hook here is optional, because `SpawnFn`'s signature is
    // "deliberately narrower than child_process.spawn's" and a substituted
    // spawn is entitled to return the narrow thing. Assuming a real
    // ChildProcess broke two suites the first time this was written — which
    // is the tests doing exactly what they are for.
    type Streamish = { on?: (e: string, f: (c: unknown) => void) => void } | null | undefined;
    const c = child as unknown as {
      stdout?: Streamish;
      stderr?: Streamish;
      on?: (e: string, f: (...a: never[]) => void) => void;
    };
    c.stdout?.on?.('data', keep);
    c.stderr?.on?.('data', keep);
    c.on?.('exit', ((code: number | null, signal: string | null) => {
      rec.state = code === 0 ? 'exited' : 'failed';
      rec.exitCode = code;
      rec.signal = signal;
      rec.endedAt = new Date().toISOString();
      this.log(`job ${jobId} ${rec.state} code=${code} signal=${signal}`);
    }) as never);

    return { jobId, plan, child, specHash: rec.specHash };
  }

  /**
   * Operator-facing job state. NOT a log service and not a tenant surface for
   * reading the filesystem: a fixed set of fields and a bounded tail of the
   * trainer's own output.
   *
   * `witnessed` is deliberately absent here. Whether a checkpoint became a
   * leaf is the watcher's answer, not the runner's, and conflating "the
   * trainer exited 0" with "a leaf exists" is the exact substitution this
   * estate keeps finding.
   */
  jobStatus(jobId: string): JobRecord | null {
    return this.jobs.get(jobId) ?? null;
  }

  listJobs(): JobRecord[] {
    return [...this.jobs.values()];
  }

  /** Wait for every in-flight capture to settle. */
  async settled(): Promise<void> {
    await this.watch.settled();
  }

  async stop(): Promise<void> {
    await this.watch.close();
  }
}
