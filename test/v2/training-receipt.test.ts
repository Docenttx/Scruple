// WO-30 · A TRAINING RECEIPT, PRODUCED WITHOUT A GPU.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS FOR
// ---------------------------------------------------------------------------
//
// `docs/canon/demo-readiness/training.md` states the position plainly: no
// Kohya checkpoint has ever carried a witness leaf, `app_kohya_progress` /
// `checkpoints` / `app_sessions` are all zero rows, and the legacy route has
// never in its history returned `witnessed: true`. So this is not a regression
// test — there is no working state to return to. It is the first end-to-end
// proof that the path CAN produce one.
//
// And the whole of it runs on a CPU in a temp directory. The survey's step 4
// ("run one small job, ~$0.05") is the step that has never been taken, and this
// file is the argument that everything except the GPU can be taken without it:
// a synthetic safetensors file, a synthetic dataset, a stub witness server, and
// the REAL component, the REAL /api/v2/witness route, the REAL server-side
// ratchet and the REAL preimage functions.
//
// What the receipt must carry, from §4's table:
//
//   input_hash                dataset root hash        WAS: not available
//   workflow_hash             the training recipe      WAS: not available
//   model_fingerprints_hash   base-model fingerprint   WAS: not available
//   content_hash              the checkpoint's bytes   was: the one thing sent
//
// ---------------------------------------------------------------------------
// SAFETY, BOTH RULES, AND THE SECOND ONE HAS BEEN VIOLATED IN THIS REPO BEFORE
// ---------------------------------------------------------------------------
//
//  1. Its own throwaway SCRUPLE_DB_PATH. The v2 suite runs its files
//     concurrently against one shared sqlite file, so a file that writes rows
//     must not share it.
//  2. WITNESS_SERVER_URL is repointed at a local stub before anything imports
//     `lib/scruple/witness`. 127.0.0.1:5799 is the PRODUCTION witness; a test
//     that reaches it writes into a real audit log, which has happened once.
//
// tsx compiles this to CJS, so top-level await is unavailable and every module
// under test is imported inside `before()` — which is also what makes the env
// assignments take effect, since `lib/db/sqlite` and `lib/scruple/witness` both
// read their variable at module scope.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** Every .ts/.sh file under a directory. Used by the env-list guard. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') stack.push(full); }
      else if (/\.(ts|tsx|sh)$/.test(e.name)) out.push(full);
    }
  }
  return out;
}


const PROD_WITNESS = /127\.0\.0\.1:5799|localhost:5799/;
if (PROD_WITNESS.test(process.env.WITNESS_SERVER_URL ?? '')) {
  throw new Error('Refusing to run against the production witness server.');
}

// The base derivation key every capture component's IK is derived from. Set
// before `lib/ratchet/*` is imported, and set to a value of this file's own so
// two suites cannot provision against each other's key schedule.
process.env.SCRUPLE_BDK_HEX = 'e9'.repeat(32);

const TENANT = 'tenant-wo30';
const BASELINE = crypto.createHash('sha256').update('wo30 tamper surface').digest('hex');
const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/* ────────────────────────────────────────────────────────────────────────
 * Fixtures — a training run's worth of bytes, none of them a model.
 * ──────────────────────────────────────────────────────────────────────── */

/** A well-formed safetensors file with a tiny tensor. Real format, real
 *  header, sixteen bytes of "weights" — everything the structural fingerprint
 *  needs and nothing a GPU had to produce. */
function writeSafetensors(
  abs: string,
  header: Record<string, unknown>,
): { headerHash: string; contentHash: string; bytes: number } {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(headerBytes.length));
  const file = Buffer.concat([len, headerBytes, Buffer.alloc(16, 7)]);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, file);
  return { headerHash: sha256(headerBytes), contentHash: sha256(file), bytes: file.length };
}

const CHECKPOINT_HEADER = {
  'lora_unet_down_blocks_0.lora_down.weight': {
    dtype: 'F16',
    shape: [4, 320],
    data_offsets: [0, 8],
  },
  'lora_unet_down_blocks_0.lora_up.weight': { dtype: 'F16', shape: [320, 4], data_offsets: [8, 16] },
  __metadata__: { ss_network_dim: '4', ss_network_alpha: '4' },
};

const BASE_MODEL_HEADER = {
  'model.diffusion_model.weight': { dtype: 'F16', shape: [2, 2], data_offsets: [0, 8] },
  __metadata__: { format: 'pt' },
};

/** The job. Deliberately the smallest thing the whitelist will accept plus the
 *  three floats that made this hard — `learning_rate` 1e-4, `text_encoder_lr`
 *  5e-5 and `noise_offset` 0.05. See the RFC 8785 test below. */
const JOB = {
  dataset_id: 'ds-wo30test',
  base_model_id: 'sdxl-base-1.0',
  training_type: 'lora',
  output_name: 'wo30-receipt',
  network_dim: 4,
  network_alpha: 4,
  learning_rate: 0.0001,
  text_encoder_lr: 0.00005,
  noise_offset: 0.05,
  optimizer: 'adamw8bit',
  lr_scheduler: 'cosine',
  max_train_epochs: 1,
  train_batch_size: 1,
  mixed_precision: 'bf16',
  resolution: '1024,1024',
};

const BASE_MODEL_RELPATH = 'sdxl/sd_xl_base_1.0.safetensors';

/* ────────────────────────────────────────────────────────────────────────
 * Wiring
 * ──────────────────────────────────────────────────────────────────────── */

class ManualSource {
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

let dir: string;
let stub: http.Server;
/** Every record the witness server was handed. */
let witnessRecords: Record<string, unknown>[] = [];
/** Every body that reached POST /api/v2/witness, as the route parsed it. */
let submissions: Record<string, unknown>[] = [];
let apiKey: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let M: any;

/** Roots and the resolved paths under them, built fresh per run. */
interface Rig {
  roots: {
    modelsRoot: string;
    datasetsRoot: string;
    outputRoot: string;
    loggingRoot: string;
  };
  datasetDir: string;
  baseModelAbs: string;
}

function makeRig(name: string, opts: { withDataset?: boolean } = {}): Rig {
  const root = fs.mkdtempSync(path.join(dir, `${name}-`));
  const roots = {
    modelsRoot: path.join(root, 'models'),
    datasetsRoot: path.join(root, 'datasets'),
    outputRoot: path.join(root, 'out'),
    loggingRoot: path.join(root, 'logs'),
  };
  for (const d of Object.values(roots)) fs.mkdirSync(d, { recursive: true });

  const datasetDir = path.join(roots.datasetsRoot, JOB.dataset_id);
  if (opts.withDataset !== false) {
    fs.mkdirSync(path.join(datasetDir, '10_subject'), { recursive: true });
    fs.writeFileSync(path.join(datasetDir, '10_subject', 'a.png'), Buffer.from('image-a'));
    fs.writeFileSync(path.join(datasetDir, '10_subject', 'a.txt'), 'a caption');
    fs.writeFileSync(path.join(datasetDir, '10_subject', 'b.png'), Buffer.from('image-b'));
    fs.writeFileSync(path.join(datasetDir, '10_subject', 'b.txt'), 'b caption');
  }

  const baseModelAbs = path.join(roots.modelsRoot, BASE_MODEL_RELPATH);
  writeSafetensors(baseModelAbs, BASE_MODEL_HEADER);

  return { roots, datasetDir, baseModelAbs };
}

/** A component with a real provisioned identity against the real server-side
 *  ratchet, submitting into the REAL route handler. */
function makeSubmitter(stateDir: string) {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'wo30' });
  const measurement = M.buildMeasurement();
  const r = M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: measurement });
  assert.ok(r.ok, 'provisioning must succeed');
  const identity = M.Identity.fromSealed(stateDir, {
    component_id: componentId,
    chain_key_hex: r.ikHex,
    counter: 0,
    build_measurement: measurement,
    attestation_status: null,
    provisioned_at: r.provisionedAt,
  });

  const submitter = new M.Submitter({
    identity,
    queue: new M.QueueStore(path.join(stateDir, 'queue.jsonl')),
    apiBaseUrl: 'https://scruple.test',
    apiKey,
    baselineRef: BASELINE,
    log: () => undefined,
    // The route handler IS the network. No server to start, no port to race.
    fetchImpl: async (url: string, init: RequestInit) => {
      const req = new Request(String(url), init);
      submissions.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return M.WITNESS_POST(req);
    },
  });
  return { submitter, identity, componentId };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-wo30-'));
  process.env.SCRUPLE_DB_PATH = path.join(dir, 'wo30-test.db');

  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      witnessRecords.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          witness_id: `wit_${witnessRecords.length}`,
          server_timestamp: new Date().toISOString(),
          signature: 'hmac-transport-seal',
          leaf_hash: sha256(`wo30-leaf-${witnessRecords.length}`),
          prev_record_hash: '',
          leaf_scheme: 'v2',
          leaf_signature: null,
          leaf_signer_key_id: null,
          leaf_signature_alg: null,
          signer_surrogate: false,
          independently_verifiable: false,
        }),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  process.env.WITNESS_SERVER_URL = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;

  const [migrate, sqlite, prov, ident, bm, sub, q, runner, jobSpec, hashes, canon, commitments] =
    await Promise.all([
      import('../../lib/db/migrate'),
      import('../../lib/db/sqlite'),
      import('../../lib/ratchet/provisioning'),
      import('../../services/scruple-capture/src/identity'),
      import('../../services/scruple-capture/src/build-measurement'),
      import('../../services/scruple-capture/src/submitter'),
      import('../../services/scruple-capture/src/queue'),
      import('../../services/scruple-capture/kohya/job-runner'),
      import('../../lib/apps/kohya/job-spec'),
      import('../../lib/leaf/hashes'),
      import('../../lib/leaf/canonicalJson'),
      import('../../services/scruple-capture/kohya/commitments'),
    ]);
  const witnessRoute = await import('../../app/api/v2/witness/route');

  M = {
    conn: sqlite.conn,
    issueProvisioningToken: prov.issueProvisioningToken,
    redeemProvisioningToken: prov.redeemProvisioningToken,
    Identity: ident.Identity,
    buildMeasurement: bm.buildMeasurement,
    Submitter: sub.Submitter,
    QueueStore: q.QueueStore,
    StudioJobRunner: runner.StudioJobRunner,
    validateJobSpec: jobSpec.validateJobSpec,
    canonicalJobJson: jobSpec.canonicalJobJson,
    hashRunInputs: hashes.hashRunInputs,
    hashModelFingerprints: hashes.hashModelFingerprints,
    hashWorkflow: canon.hashWorkflow,
    datasetRootHash: commitments.datasetRootHash,
    fingerprintModelFile: commitments.fingerprintModelFile,
    WITNESS_POST: witnessRoute.POST as unknown as (req: Request) => Promise<Response>,
  };

  migrate.runMigrations(false);
  const conn = sqlite.conn;
  conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'wo30@example.com');
  apiKey = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
  conn()
    .prepare(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label)
       VALUES (?, ?, ?, ?, ?, 'wo30')`,
    )
    .run(
      crypto.randomUUID(),
      TENANT,
      sha256(apiKey),
      apiKey.slice(0, 12),
      JSON.stringify(['witness:write']),
    );
  const now = new Date().toISOString();
  conn()
    .prepare(
      `INSERT INTO baselines
         (tenant_id, baseline_hash, manifest_json, attestation_provider,
          signer_pubkey_spki_sha256_hex, submitted_at, activated_at)
       VALUES (?, ?, '{}', 'none', ?, ?, ?)`,
    )
    .run(TENANT, BASELINE, sha256('wo30-pubkey'), now, now);
});

after(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** One full run: submit a job, close a checkpoint, let the leaf land. */
async function runToLeaf(opts: { withDataset?: boolean } = {}) {
  const rig = makeRig('rig', opts);
  // A DIFFERENT CHECKPOINT PER RUN. `iterations` is queried by `output_hash`
  // below, and two runs that wrote byte-identical files would let one test
  // read the other's row and pass on it — the kind of green that proves
  // nothing. The nonce lives in `__metadata__`, where a real run's
  // `ss_session_id` would.
  const nonce = crypto.randomBytes(8).toString('hex');
  const stateDir = fs.mkdtempSync(path.join(dir, 'state-'));
  const { submitter, componentId } = makeSubmitter(stateDir);
  const source = new ManualSource();

  const validated = M.validateJobSpec(JOB);
  assert.equal(validated.ok, true, 'the reference job must validate');

  const runner = await M.StudioJobRunner.start(
    {
      roots: rig.roots,
      source,
      log: () => undefined,
      // NO TRAINER IS SPAWNED. The GPU is the only part of this that costs
      // money and the only part that is stubbed; every hash below is computed
      // by the shipping code over real bytes on a real disk.
      spawnFn: () => ({ pid: 4242 }) as never,
    },
    submitter,
  );

  const jobId = 'kj_wo30';
  await runner.startJob(jobId, validated.spec);

  const outDir = path.join(rig.roots.outputRoot, jobId);
  const ckptAbs = path.join(outDir, `${JOB.output_name}.safetensors`);
  const ckpt = writeSafetensors(ckptAbs, {
    ...CHECKPOINT_HEADER,
    __metadata__: { ...CHECKPOINT_HEADER.__metadata__, ss_run_nonce: nonce },
  });

  source.fire(ckptAbs);
  await runner.settled();
  await submitter.drain();
  await runner.stop();

  return { rig, ckpt, ckptAbs, componentId, spec: validated.spec };
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. THE RECEIPT
 * ══════════════════════════════════════════════════════════════════════ */

describe('a synthetic checkpoint produces a witnessed leaf with training fields', () => {
  test('end to end, no GPU: the four commitments reach the leaf and the witness', async () => {
    submissions = [];
    witnessRecords = [];
    const { rig, ckpt, spec } = await runToLeaf();

    // ---- what the component sent -------------------------------------
    assert.equal(submissions.length, 1, 'exactly one submission for one checkpoint');
    const s = submissions[0];
    assert.equal(s.kind, 'model_write', 'a checkpoint is a model.write, not an artifact');
    assert.equal(s.content_hash, ckpt.contentHash);
    assert.equal(s.baseline_ref, BASELINE);

    // ---- input_hash: the dataset, recomputed independently ------------
    //
    // The point of recomputing rather than echoing: the assertion fails if the
    // component's formula and the published preimage ever come apart, which is
    // the only failure mode that matters for a field an auditor re-derives.
    const dsc = M.datasetRootHash(rig.datasetDir);
    assert.equal(dsc.fileCount, 4, 'two images and two captions');
    assert.deepEqual(dsc.skipped, [], 'nothing was skipped, and the field says so');
    const expectedInputHash = M.hashRunInputs({
      provider: null,
      prompt: null,
      spec: null,
      inputs: [{ kind: 'dataset', hash: dsc.rootHash }],
    });
    assert.equal(
      s.input_hash,
      expectedInputHash,
      'input_hash is THE field the regulatory interest is about — "what data was this trained ' +
        'on, and how do you know". docs/canon/demo-readiness/training.md §4 records it as not ' +
        'available on any shipping path.',
    );

    // ---- model_fingerprints: the base model, manifest AND hash --------
    const fpManifest = s.model_fingerprints as Record<string, Record<string, unknown>>;
    assert.ok(fpManifest, 'the manifest travels, not only its hash');
    assert.deepEqual(Object.keys(fpManifest), [BASE_MODEL_RELPATH]);
    const expectedFp = M.fingerprintModelFile(rig.baseModelAbs);
    assert.deepEqual(fpManifest[BASE_MODEL_RELPATH], expectedFp);
    assert.equal(
      s.model_fingerprints_hash,
      M.hashModelFingerprints({ [BASE_MODEL_RELPATH]: expectedFp }).hash,
    );
    assert.ok(
      typeof fpManifest[BASE_MODEL_RELPATH].header_hash === 'string',
      "the base model's structural fingerprint has a home INSIDE this manifest — the only " +
        'place a header hash currently has one (MODEL_WRITE_HOOK.md §4.2)',
    );

    // ---- workflow_hash: the recipe ------------------------------------
    const graph = s.graph as Record<string, unknown>;
    assert.ok(graph, 'a checkpoint with no run commitment is an image leaf with a longer name');
    assert.equal(JSON.stringify(graph), M.canonicalJobJson(spec));
    assert.equal(
      graph.network_module,
      undefined,
      'the commitment is the tenant-facing job, which contains no import path at all',
    );

    // ---- the checkpoint's OWN header hash, uncovered but present ------
    const capture = s.capture as Record<string, unknown>;
    assert.equal(
      capture.header_hash,
      ckpt.headerHash,
      'the written checkpoint has no leaf field for its structural fingerprint, so it rides ' +
        'in the capture block, uncovered by the MAC. Carried rather than dropped: a field on ' +
        'the wire can be covered later; one never sent cannot be recovered.',
    );

    // ---- what the WITNESS was told ------------------------------------
    assert.equal(witnessRecords.length, 1, 'the leaf reached the witness server');
    const w = witnessRecords[0];
    assert.equal(w.content_hash, ckpt.contentHash);
    assert.equal(w.input_hash, expectedInputHash);
    assert.equal(w.workflow_hash, M.hashWorkflow(graph));
    assert.equal(w.model_fingerprints_hash, s.model_fingerprints_hash);

    // ---- and what was STORED ------------------------------------------
    const row = M.conn()
      .prepare(
        `SELECT witnessed, output_kind, leaf_kind, leaf_scheme, output_hash, leaf_hash,
                input_hash, workflow_hash, model_fingerprints, model_fingerprints_hash,
                component_verified, component_id, mime_declared, seal_state
           FROM iterations WHERE output_hash = ?`,
      )
      .get(ckpt.contentHash) as Record<string, unknown>;
    assert.ok(row, 'a leaf row exists');
    assert.equal(
      row.witnessed,
      1,
      'THE claim of this WO. No Kohya checkpoint has ever carried a witness leaf ' +
        '(docs/canon/demo-readiness/training.md §1).',
    );
    assert.equal(row.output_kind, 'checkpoint');
    assert.equal(row.leaf_kind, 'training');
    assert.equal(row.input_hash, expectedInputHash);
    assert.equal(row.workflow_hash, M.hashWorkflow(graph));
    assert.equal(row.model_fingerprints_hash, s.model_fingerprints_hash);
    assert.deepEqual(
      JSON.parse(String(row.model_fingerprints)),
      { [BASE_MODEL_RELPATH]: expectedFp },
      'the manifest is stored, so a receipt can say WHICH weights rather than that some were ' +
        'enumerated',
    );
    assert.equal(
      row.component_verified,
      1,
      'the ratchet MAC verified — a leaf whose producer could not be identified is weaker ' +
        'evidence and the row would say so',
    );
    assert.equal(
      row.mime_declared,
      0,
      'nothing was entitled to declare a type for a checkpoint written into an output volume, ' +
        'and an absent type is a different fact from application/octet-stream',
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 2. THE MUST-NOT-FIRE HALF
 *
 * A green test with no control proves only that it cannot fail. Each of
 * these is a case where the leaf must come out WEAKER rather than absent or
 * invented.
 * ══════════════════════════════════════════════════════════════════════ */

describe('an absent commitment is null, never guessed, and never a refusal', () => {
  test('no dataset directory: the leaf is still issued, with input_hash null', async () => {
    submissions = [];
    witnessRecords = [];
    const { ckpt } = await runToLeaf({ withDataset: false });

    assert.equal(submissions.length, 1, 'the checkpoint still produced a leaf');
    assert.equal(
      submissions[0].input_hash,
      undefined,
      'ABSENT, not zero and not the hash of an empty manifest. sha256("{}") would assert "we ' +
        'enumerated the training data and there was none", which is a claim, not a gap.',
    );
    const row = M.conn()
      .prepare(`SELECT witnessed, input_hash FROM iterations WHERE output_hash = ?`)
      .get(ckpt.contentHash) as { witnessed: number; input_hash: string | null };
    assert.equal(row.input_hash, null);
    assert.equal(
      row.witnessed,
      1,
      'refusing the leaf would convert a flagged fact into a silence — a checkpoint that ' +
        'exists and has no leaf is the invisible failure PLACEMENT_AND_SURFACES.md §2.2 ' +
        'forbids, and strictly worse than a leaf with one null field',
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 3. THE DATASET PREIMAGE
 *
 * It is not in lib/leaf/registry.yaml — there is no dataset field at all —
 * so its properties are pinned here and stated in prose in
 * MODEL_WRITE_HOOK.md §4. A preimage nobody outside this repo can reproduce
 * is not a commitment.
 * ══════════════════════════════════════════════════════════════════════ */

describe('the dataset root hash is a commitment, not a checksum', () => {
  test('it is the sha256 of the sorted {relpath: sha256} manifest, and nothing else', () => {
    const root = fs.mkdtempSync(path.join(dir, 'ds-preimage-'));
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'z.png'), 'zzz');
    fs.writeFileSync(path.join(root, 'b', 'a.png'), 'aaa');

    const manifest = { 'b/a.png': sha256('aaa'), 'z.png': sha256('zzz') };
    const expected = sha256(JSON.stringify(manifest));
    assert.equal(
      M.datasetRootHash(root).rootHash,
      expected,
      'stated in prose in MODEL_WRITE_HOOK.md §4 so a verifier can reproduce it with sha256sum ' +
        'and jq. Paths are POSIX-relative; keys are sorted ascending; there is no whitespace.',
    );
  });

  test('a symlink is SKIPPED and reported, never followed', () => {
    const root = fs.mkdtempSync(path.join(dir, 'ds-link-'));
    const outside = path.join(dir, 'outside.png');
    fs.writeFileSync(outside, 'outside bytes');
    fs.writeFileSync(path.join(root, 'real.png'), 'real bytes');
    fs.symlinkSync(outside, path.join(root, 'linked.png'));

    const c = M.datasetRootHash(root);
    assert.equal(c.fileCount, 1);
    assert.deepEqual(
      c.skipped,
      ['linked.png'],
      'following it would make the hash depend on something outside the directory being ' +
        'committed to, and a dataset that hashes differently depending on what a link points ' +
        'at today is not a commitment. Reporting it is what stops the exclusion being silent.',
    );
  });

  test('the same bytes in a different creation order hash identically', () => {
    const a = fs.mkdtempSync(path.join(dir, 'ds-ord-a-'));
    const b = fs.mkdtempSync(path.join(dir, 'ds-ord-b-'));
    fs.writeFileSync(path.join(a, '1.png'), 'one');
    fs.writeFileSync(path.join(a, '2.png'), 'two');
    fs.writeFileSync(path.join(b, '2.png'), 'two');
    fs.writeFileSync(path.join(b, '1.png'), 'one');
    assert.equal(M.datasetRootHash(a).rootHash, M.datasetRootHash(b).rootHash);
  });

  test('one changed caption byte changes the root hash', () => {
    const root = fs.mkdtempSync(path.join(dir, 'ds-sens-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'a photo of sks dog');
    const before = M.datasetRootHash(root).rootHash;
    fs.writeFileSync(path.join(root, 'a.txt'), 'a photo of sks cat');
    assert.notEqual(M.datasetRootHash(root).rootHash, before);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. THE RECIPE'S FLOATS
 *
 * The survey (§4) credits `training_recipe()` + `hash_training_recipe()`
 * with "handling the float problem" by quoting every float as a decimal
 * string. WO-21 superseded that: both languages moved onto RFC 8785, whose
 * §3.2.2.3 mandates ECMA-262 Number::toString, so raw floats now
 * canonicalize identically — and `encode_number`'s Python `repr` would
 * REINTRODUCE the divergence inside the quoted string ("0.00001" vs
 * "1e-05"). See packages/scruple-api/scruple_api/canonical.py's docstring.
 *
 * So the recipe is committed RAW, and this is the assertion that says so
 * deliberately rather than by omission.
 * ══════════════════════════════════════════════════════════════════════ */

describe('the training recipe is committed raw, under RFC 8785', () => {
  test('the learning rates are numbers in the commitment, not quoted strings', () => {
    const v = M.validateJobSpec(JOB);
    assert.ok(v.ok);
    const doc = JSON.parse(M.canonicalJobJson(v.spec)) as Record<string, unknown>;
    assert.equal(typeof doc.text_encoder_lr, 'number');
    assert.equal(doc.text_encoder_lr, 0.00005);
    // The value that used to diverge: JS "0.00005", Python json.dumps
    // "5e-05". RFC 8785 pins the JS spelling in both languages.
    assert.match(M.canonicalJobJson(v.spec), /"text_encoder_lr":0\.00005/);
    assert.equal(M.hashWorkflow(doc), M.hashWorkflow(JSON.parse(JSON.stringify(doc))));
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 5. DRIFT GUARDS
 * ══════════════════════════════════════════════════════════════════════ */

describe('source does not contradict the receipt', () => {
  const REPO_ROOT = path.join(__dirname, '..', '..');

  test('the job route reports dispatch and never assumes it', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'app/api/apps/kohya/jobs/route.ts'),
      'utf8',
    );
    assert.ok(!/witnessed:\s*true/.test(src), 'the jobs route must never claim witnessed:true');
    assert.match(
      src,
      /dispatch\.ok && runId !== null/,
      "training_runs.status may only become 'running' on a dispatch that actually returned. A " +
        'status written beside a request that may not have landed is the same lie as ' +
        'witnessed:true beside a leaf that does not exist.',
    );
  });

  test('the documented env list is the env the entrypoint actually requires', () => {
    // WO-35. The COPY set had a closure test; the ENV set had nothing, and it
    // was wrong in both directions at once. Dockerfile.jobapi's RunPod
    // template instructions named SCRUPLE_USER_ID, SCRUPLE_APP_ID,
    // SCRUPLE_SESSION_ID, SCRUPLE_SESSION_TOKEN, SCRUPLE_WITNESS_URL,
    // SCRUPLE_PLACEMENT and SCRUPLE_CAN_WITNESS — seven variables that appear
    // nowhere in the component — while omitting SCRUPLE_API_URL and
    // SCRUPLE_API_KEY, which it refuses to start without.
    //
    // Nothing caught it because the image had never been built and the
    // component had never been run. A pod registered from that template dies
    // at boot, before the port binds and before a placement resolves.
    const server = fs.readFileSync(
      path.join(REPO_ROOT, 'services/scruple-capture/kohya/job-api-server.ts'),
      'utf8',
    );
    // The truth is `need('X')` — the calls that throw when unset.
    const required = new Set<string>();
    for (const m of server.matchAll(/need\(\s*'(SCRUPLE_[A-Z0-9_]+)'\s*\)/g)) {
      required.add(m[1]);
    }
    assert.ok(required.size >= 6, `expected the entrypoint to require several vars, saw ${required.size}`);
    // The two the old list omitted. Named explicitly so that deleting the
    // `need()` calls cannot make this test vacuously pass.
    assert.ok(required.has('SCRUPLE_API_URL'));
    assert.ok(required.has('SCRUPLE_API_KEY'));

    const dockerfile = fs.readFileSync(
      path.join(REPO_ROOT, 'research/scruple-kohya-image/Dockerfile.jobapi'),
      'utf8',
    );
    const launcher = fs.readFileSync(
      path.join(REPO_ROOT, 'research/scruple-kohya-image/start-jobapi.sh'),
      'utf8',
    );

    // The OPERATOR-FACING list, not "appears somewhere in the file". The
    // first version of this guard used a bare substring test and passed while
    // the list was still wrong, because the comment explaining the old bug
    // mentions SCRUPLE_API_URL. A test that a prose mention satisfies is not
    // testing the list.
    const documented = new Set(
      [...dockerfile.matchAll(/REQUIRED-ENV:\s*(SCRUPLE_[A-Z0-9_]+)/g)].map((m) => m[1]),
    );

    // MUST FIRE — every var the entrypoint requires is in that list.
    for (const v of required) {
      assert.ok(
        documented.has(v),
        `${v} is required by job-api-server.ts but is not a REQUIRED-ENV entry in ` +
          'Dockerfile.jobapi. A template registered from that file produces a pod ' +
          'that dies at boot, before the port binds and before a placement resolves.',
      );
    }

    // FIRST-BOOT-ENV is a separate marker on purpose. The provisioning token
    // is not a `need()` call: the component accepts a sealed identity in its
    // state dir instead and refuses only when it has NEITHER. Documenting it
    // as unconditionally required would be its own small lie, and a pod
    // restarting on a warm volume does not want a re-minted token.
    const firstBoot = new Set(
      [...dockerfile.matchAll(/FIRST-BOOT-ENV:\s*(SCRUPLE_[A-Z0-9_]+)/g)].map((m) => m[1]),
    );
    assert.ok(
      firstBoot.has('SCRUPLE_CAPTURE_PROVISIONING_TOKEN'),
      'the provisioning token must stay documented somewhere: without it AND without a ' +
        'sealed identity the component refuses to start, and that is the first thing a ' +
        'fresh pod hits.',
    );
    for (const v of firstBoot) {
      assert.ok(!required.has(v), `${v} is a hard requirement — document it as REQUIRED-ENV`);
    }

    // And the converse: the list must not invent requirements either.
    for (const v of documented) {
      assert.ok(
        required.has(v),
        `Dockerfile.jobapi documents ${v} as REQUIRED-ENV but nothing requires it. ` +
          'That is how the list came to name seven variables no code reads.',
      );
    }

    // MUST *NOT* FIRE — the seven that nothing reads must not come back as
    // though they were operator instructions. They may be NAMED in the
    // comment that explains why they were removed; what must not return is
    // the launcher printing them as if they were configuration.
    const phantom = [
      'SCRUPLE_USER_ID',
      'SCRUPLE_APP_ID',
      'SCRUPLE_SESSION_ID',
      'SCRUPLE_SESSION_TOKEN',
      'SCRUPLE_WITNESS_URL',
      'SCRUPLE_CAN_WITNESS',
    ];
    const componentTrees = ['services/scruple-capture', 'lib/apps/kohya', 'lib/capture'];
    for (const v of phantom) {
      const readAnywhere = componentTrees.some((tree) =>
        walkFiles(path.join(REPO_ROOT, tree)).some((f) => fs.readFileSync(f, 'utf8').includes(v)),
      );
      assert.equal(
        readAnywhere,
        false,
        `${v} is now read by the component — add it to the documented list rather than deleting this line.`,
      );
      assert.ok(
        !new RegExp(`echo .*\\$\\{${v}`).test(launcher),
        `start-jobapi.sh echoes ${v}, which nothing reads. Echoing a variable is not reading it.`,
      );
    }
  });

  test('WO-35 — the HTTP-delivered payload is the same set the image COPYs', () => {
    // Option 2 (public GPU base + dockerStartCmd) delivers the component over
    // HTTP because there is no image to bake it into. Two delivery paths for
    // one component is two chances to ship different code while claiming the
    // same placement — so the set lives in ONE module and this asserts the
    // Dockerfile agrees with it.
    //
    // Without this, `Dockerfile.jobapi` and `/api/apps/kohya/component` drift
    // exactly the way the COPY set drifted from the import closure in the
    // first place: silently, because nothing ran both.
    const mod = fs.readFileSync(
      path.join(process.cwd(), 'lib/apps/kohya/component-files.ts'),
      'utf8',
    );
    const listed = [...mod.matchAll(/'([a-z][^']*\.(?:ts|json)|[a-z][a-z/-]*)'/g)]
      .map((m) => m[1])
      .filter((v) => v.includes('/') || v.endsWith('.json'));
    const dockerfile = fs.readFileSync(
      path.join(process.cwd(), 'research/scruple-kohya-image/Dockerfile.jobapi'),
      'utf8',
    );

    // MUST FIRE — everything the payload ships is also COPYed into the image.
    for (const entry of listed) {
      assert.ok(
        dockerfile.includes(entry),
        `${entry} is in the HTTP payload but Dockerfile.jobapi does not COPY it. ` +
          'The two delivery paths would ship different components.',
      );
    }

    // MUST *NOT* FIRE — the payload must not widen to whole directories whose
    // narrowness is the security argument. lib/ratchet/ holds the SERVER-side
    // ratchet (provisioning.ts, verify.ts, which read the BDK and the
    // components table); shipping the directory would put the party that
    // ISSUES identities inside the container that merely HOLDS one.
    for (const forbidden of ['lib/ratchet', 'lib/leaf', 'lib/scruple']) {
      assert.ok(
        !listed.includes(forbidden),
        `${forbidden} is shipped WHOLE. Named files only — Dockerfile.jobapi ` +
          'carries the argument and it is a security property, not tidiness.',
      );
    }
    for (const named of ['lib/ratchet/ratchet.ts', 'lib/leaf/hashes.ts', 'lib/scruple/hash.ts']) {
      assert.ok(listed.includes(named), `${named} must be shipped by name`);
    }
  });

  test('Dockerfile.jobapi copies every tree the entrypoint imports', () => {
    // WHY A CLOSURE AND NOT A LIST. `Dockerfile.jobapi` copies three trees and
    // says why it copies only three: "an image that carries app/, scripts/ and
    // test/ is an image whose contents are not the thing being measured." That
    // argument is right and it is also how the image came to be missing
    // `lib/leaf`, `lib/scruple` and `lib/ratchet` — the entrypoint acquired
    // them transitively (WO-6 put `hashes.ts` behind `src/leaf.ts`) and nothing
    // re-derived the copy set. The image has never been built, so nothing ever
    // failed. This walks the imports and fails instead.
    const need = new Set<string>();
    const seen = new Set<string>();
    const missing: string[] = [];
    const resolveSpec = (spec: string, from: string): string | null => {
      let base: string;
      if (spec.startsWith('@/')) base = path.join(REPO_ROOT, spec.slice(2));
      else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
      else return null; // a package, installed by `npm ci`
      for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      }
      missing.push(`${spec} from ${path.relative(REPO_ROOT, from)}`);
      return null;
    };
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const rel = path.relative(REPO_ROOT, file);
      if (!rel.startsWith('services/scruple-capture')) need.add(rel);
      const src = fs.readFileSync(file, 'utf8');
      const re =
        /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const r = resolveSpec(m[1] ?? m[2], file);
        if (r) walk(r);
      }
    };
    walk(path.join(REPO_ROOT, 'services/scruple-capture/kohya/job-api-server.ts'));
    assert.deepEqual(missing, [], 'every relative import must resolve in-tree');

    const dockerfile = fs.readFileSync(
      path.join(REPO_ROOT, 'research/scruple-kohya-image/Dockerfile.jobapi'),
      'utf8',
    );
    const copied = dockerfile
      .split('\n')
      .filter((l) => l.startsWith('COPY '))
      .flatMap((l) => l.replace(/^COPY\s+/, '').trim().split(/\s+/).slice(0, -1));

    const uncovered = [...need].filter(
      (rel) => !copied.some((c) => rel === c || rel.startsWith(`${c}/`)),
    );
    assert.deepEqual(
      uncovered,
      [],
      'these files are imported by the container entrypoint and are NOT copied into the ' +
        'image. `node --import tsx` would die on the first import, before the job API binds a ' +
        'port and before any placement is resolved. Add a COPY for each — naming FILES, not ' +
        'the directories they sit in: lib/ratchet/ also holds the server-side ratchet and ' +
        'lib/leaf/ the server-side preimage, and neither belongs in a tenant container.',
    );
  });

  test('the job form is generated from the whitelist, not written beside it', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'lib/apps/kohya/form.ts'), 'utf8');
    assert.match(src, /PARAMETER_WHITELIST/);
    const panel = fs.readFileSync(
      path.join(REPO_ROOT, 'app/apps/kohya/JobSubmitPanel.tsx'),
      'utf8',
    );
    assert.ok(
      !/<textarea/i.test(panel),
      'a free-text control on this surface is one "advanced: paste your own args" box away ' +
        'from dropping Studio back to `unattested-client` (PLACEMENT_AND_SURFACES.md §7.3). ' +
        'ParameterKind has no `string` member; the form must have no control for one.',
    );
  });
});
