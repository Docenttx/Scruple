#!/usr/bin/env node
/**
 * desktop-run.mjs — the headless driver for Scruple Desktop Studio.
 *
 * The desktop mirror of scruple-web/scripts/scruple-run.ts, which "runs a
 * workflow through the real /api/runs endpoint — the same path a user hits —
 * without the canvas". Web Studio's user path is an HTTP route, so its driver
 * is a fetch. Desktop Studio's user path is a click in a window that reaches
 * the main process over IPC, so this driver launches the REAL app under xvfb
 * and drives a named scenario through the REAL IPC handlers:
 *
 *     driver → xvfb-run electron . --scenario=spec.json
 *              → renderer → window.scruple.<call> → ipcMain.handle → main
 *
 * WHAT IT ASSERTS ON, AND WHAT IT REFUSES TO ASSERT ON.
 *
 * The app writes a result file saying what it did. That file is a CLAIM. Every
 * assertion is evaluated here, in this process, against the world the app left
 * behind — bytes on disk re-hashed here, an exit code, a nonce this script
 * minted. Nothing is asserted from a log line, and nothing from a pixel
 * (docs/DESIGN.md: llvmpipe returns a blank frame; never gate on it).
 *
 * ⚑ THE AUDIT PASS IS THE POINT. A green run against an app nobody has broken
 * is likelier to mean the assertions are weak than that the app is right — the
 * principle scripts/probe-harness/run.sh already applies on the server side. So
 * `--audit` breaks the run once per mutation and requires that EXACTLY the
 * assertions that mutation targets go red, and that the others stay green. A
 * driver that always exits 0 is not a driver.
 *
 * Usage
 *   node scripts/desktop-run.mjs <scenario>            run it; non-zero if it fails
 *   node scripts/desktop-run.mjs <scenario> --audit    + the mutation sweep
 *   node scripts/desktop-run.mjs <scenario> --break <mutation>   one break
 *   node scripts/desktop-run.mjs <scenario> --expect-fail        invert the verdict
 *   node scripts/desktop-run.mjs --list
 *
 * <scenario> is a name under scenarios/ or a path to a spec JSON.
 *
 * Env
 *   SCRUPLE_APP_URL   default http://127.0.0.1:3902  (the served Next UI)
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, createHmac } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync,
  statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
// One implementation of ${...}, shared with the main-process runner.
const { interpolate } = require_(join(REPO, 'app', 'interpolate.js'));

// ── mutations ──────────────────────────────────────────────────────────────
// A mutation only knows how to break something. WHAT THAT MUST DO is declared
// by the scenario, in its `audit` block, because the answer depends on which
// assertions the scenario makes: `no-bridge` reddens seven things in
// capture-file and six in ping, and neither number is a property of the
// mutation.
//
// The sweep requires the declared set EXACTLY. More red than declared means an
// assertion is coupled to something it should not care about; less means the
// assertion does not actually test what it claims to. Both are findings.
const MUTATIONS = {
  'store-truncate': {
    when: 'after',
    describe: 'chop the last 4 KiB off the copy the app stored',
    apply(ctx) {
      const p = ctx.resolve('${steps.cap.value.storePath}');
      truncateSync(p, Math.max(0, statSync(p).size - 4096));
      return `truncated ${p}`;
    },
  },
  'store-delete': {
    when: 'after',
    describe: 'delete the copy the app stored',
    apply(ctx) {
      const p = ctx.resolve('${steps.cap.value.storePath}');
      rmSync(p, { force: true });
      return `deleted ${p}`;
    },
  },
  'source-swap': {
    when: 'before',
    describe: 'rewrite the source file AFTER the driver hashed it, before the app reads it',
    apply(ctx) {
      const f = ctx.fixtures.src;
      writeFileSync(f.path, deterministicBytes('swapped-under-the-app', f.bytes));
      return `rewrote ${f.path} with different bytes of the same length`;
    },
  },
  'fake-bridge': {
    when: 'app-dir',
    describe: 'a preload that answers in the renderer and never reaches main',
    apply(ctx) {
      writeFileSync(join(ctx.appDir, 'app', 'preload.js'), FAKE_PRELOAD);
      return `replaced preload.js in ${ctx.appDir}`;
    },
  },
  'no-bridge': {
    when: 'app-dir',
    describe: 'no preload at all — window.scruple is undefined',
    apply(ctx) {
      rmSync(join(ctx.appDir, 'app', 'preload.js'), { force: true });
      return `removed preload.js from ${ctx.appDir}`;
    },
  },
  // ── WO-D3's mutations. Two of them are INVERSE controls: they do not
  // corrupt anything, they REMOVE the reason a file was refused, and the
  // refusal assertions must go red. A refusal that survives its own cause
  // being deleted was never caused by what the scenario claims.
  'declare-the-undeclared': {
    when: 'before',
    describe: 'add undeclared.png to the vault declaration — the refusal must stop',
    apply(ctx) {
      const v = ctx.fixtures.vault;
      const decl = JSON.parse(readFileSync(v.declarationPath, 'utf8'));
      decl.files['undeclared.png'] = { mime: 'image/png' };
      writeFileSync(v.declarationPath, JSON.stringify(decl, null, 2));
      return 'undeclared.png is now declared image/png';
    },
  },
  'raise-the-ceiling': {
    when: 'env',
    describe: 'raise the ceiling above oversize.bin — the refusal must stop',
    apply(ctx) {
      ctx.env.SCRUPLE_VAULT_CEILING_BYTES = String(64 * 1024 * 1024);
      return 'ceiling raised to 64 MiB';
    },
  },
  'vault-file-swap': {
    when: 'before',
    describe: 'rewrite an accepted vault file AFTER the driver hashed it',
    apply(ctx) {
      const f = ctx.fixtures.vault.files.accepted;
      writeFileSync(f.path, deterministicBytes('swapped-in-the-vault', f.bytes));
      return `rewrote ${f.path} with different bytes of the same length`;
    },
  },
  'manifest-tamper': {
    when: 'after',
    describe: "rewrite one refusal in the manifest to 'captured', keeping it valid JSON",
    // A TRUNCATION WOULD PROVE LESS. Chopping the file makes every assertion
    // that reads it fail, including the ones about parsing, and "the record is
    // gone" is not the interesting claim. This edits one field and leaves the
    // document readable — so what goes red is the DIGEST, which is on a leaf,
    // and the one fact that was edited. That is what witnessing the manifest
    // buys: the record is tamper-evident, not tamper-proof.
    apply(ctx) {
      const p = ctx.resolve('${steps.vault.value.manifest.path}');
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      const e = (doc.entries || []).find((x) => x.outcome === 'refused_over_ceiling');
      if (!e) throw new Error('no over-ceiling refusal in the manifest to tamper with');
      e.outcome = 'captured';
      writeFileSync(p, JSON.stringify(doc));
      return `${e.path}: refused_over_ceiling → captured, in ${p}`;
    },
  },
  // ── WO-D4's mutations. THE FIRST ONE IS THE PRODUCT CLAIM. The rest ask
  // whether the leaf's fingerprints came from where this WO says they did:
  // from the files, through an adapter, with the gate in the path.
  'model-swap': {
    when: 'before',
    describe: "rewrite the model file's WEIGHTS, keeping its filename, its length and its safetensors header",
    // ⚑ THE ENTIRE PRODUCT CLAIM, EXPRESSED AS A DIFFERENCE. docs/DESIGN.md:
    // fingerprints from the store are "the only way to answer *was a
    // proprietary LoRA used* rather than *a file with that name was
    // referenced*". Two seeds of the same architecture give identical tensor
    // names and shapes, so:
    //
    //     filename          unchanged   → every name-derived fact stays green
    //     byte length       unchanged   → a size check would not notice
    //     safetensors header hash  unchanged → the STRUCTURE is the same model
    //     content hash      MOVES       → the WEIGHTS are not the same weights
    //
    // A record built from the workflow's names cannot tell these two runs
    // apart. That is the difference this mutation must make visible.
    apply(ctx) {
      const f = ctx.fixtures.models.files.upscaler;
      const before = f.sha256;
      const after = makeModelFile(f.path, f.swapSeed);
      if (after.sha256 === before) throw new Error('the swap produced identical bytes');
      if (after.bytes !== f.bytes) throw new Error('the swap changed the file length; it must not');
      if (after.header_hash !== f.header_hash) throw new Error('the swap changed the header; it must not');
      return `${f.name}: content ${before.slice(0, 12)} → ${after.sha256.slice(0, 12)}, ` +
        `header ${after.header_hash.slice(0, 12)} and length ${after.bytes} unchanged`;
    },
  },
  'no-adapter': {
    when: 'env',
    describe: 'run the identical gate with NO host adapter in the sink path',
    // The control for "the fingerprints came from the desktop". Same gate,
    // same generation, same leaf — and `model_fingerprints` NULL, because
    // nothing in the server or in the SDK invents them. See app/comfy/gate.ts.
    apply(ctx) {
      ctx.env.SCRUPLE_COMFY_FINGERPRINTS = 'off';
      return 'CaptureComponent started without deps.sinkWrap';
    },
  },
  'bypass-the-gate': {
    when: 'env',
    describe: 'send the generation straight at ComfyUI instead of through the gate',
    // The control for "the gate is in the path". The generation still
    // succeeds and the bytes still land on disk — an artifact with no leaf,
    // which is the exact failure the gate exists to make impossible.
    apply(ctx) {
      ctx.env.SCRUPLE_COMFY_BYPASS_GATE = '1';
      return 'the tenant path points at the upstream';
    },
  },
  'upstream-listens-wide': {
    when: 'env',
    describe: 'launch ComfyUI on 0.0.0.0 — a second route to the tenant',
    // The control for the ledger. If `allLoopback` were a constant rather
    // than a reading of /proc/net/tcp, this would not move it.
    apply(ctx) {
      ctx.env.SCRUPLE_COMFY_LISTEN = '0.0.0.0';
      return 'ComfyUI --listen 0.0.0.0';
    },
  },
  // ── WO-D5's mutations. The dashboard's shape comes from what the deployment
  // announced; these are the two ways that can go wrong, and both must be
  // visible in the DOM rather than only in a log.
  'profile-lie': {
    when: 'env',
    describe: 'the desktop app announces itself as the web deployment',
    // The control for "the shape follows the announcement". If the desktop
    // regions survived this, they were coming from somewhere else — a
    // hard-coded branch, a user agent sniff, a component that always draws.
    apply(ctx) {
      ctx.env.SCRUPLE_PROFILE = 'web';
      return 'x-scruple-profile: web, from a desktop app';
    },
  },
  'no-profile-header': {
    when: 'env',
    describe: 'the desktop app announces nothing at all',
    // A served app with no announcement IS the web deployment, so this must
    // produce the web shape rather than a blank page or a desktop one. The
    // difference from `profile-lie` is that nothing lied; the header is simply
    // not there, which is what every ordinary browser looks like.
    apply(ctx) {
      ctx.env.SCRUPLE_PROFILE = '';
      return 'no x-scruple-profile header on any request';
    },
  },
  'assert-expectation': {
    when: 'spec',
    describe: "rewrite one assertion's expected value to a wrong constant",
    // The WO's own control: "deliberately break the assertion". The scenario
    // says which one, by listing exactly one id under audit.assert-expectation.
    apply(ctx) {
      const id = (ctx.spec.audit || {})['assert-expectation'];
      if (!id || id.length !== 1) throw new Error('audit.assert-expectation must name exactly one assertion id');
      const a = ctx.spec.assert.find((x) => x.id === id[0]);
      if (!a) throw new Error(`no assertion "${id[0]}" in this scenario`);
      a.expected = '<<a value the app will never report>>';
      return `${id[0]} now expects a value nothing can satisfy`;
    },
  },
};

const FAKE_PRELOAD = `// MUTATION ONLY: answers in the renderer; never reaches the main process.
const { contextBridge } = require('electron');
const reply = (nonce) => ({
  ok: true, pong: true, outcome: 'captured', echo: nonce,
  serverNonce: 'deadbeefdeadbeefdeadbeefdeadbeef', mainPid: 1, senderWindowId: 1,
  versions: { electron: 'x', chrome: 'x', node: 'x', v8: 'x' },
});
contextBridge.exposeInMainWorld('scruple', {
  host: 'electron',
  ping: async (nonce) => reply(nonce),
  // The most flattering lie about a host: every app installed, a gate running,
  // a model store full. It cannot know the main pid and it cannot know the
  // per-run model root the driver made, which is what the dashboard assertions
  // look at.
  profile: async () => ({
    ...reply(null), host: 'electron', profile: 'desktop',
    apps: [{ id: 'comfyui', name: 'ComfyUI', available: true, detail: '99.9.9 · /nonexistent/main.py' }],
    gate: { url: 'http://127.0.0.1:2', upstream: 'http://127.0.0.1:1', adapter: 'model-store', running: true },
    vault: { dir: '/nonexistent/vault', state: null, ceilingBytes: 1, configured: true },
    modelStore: { root: '/nonexistent/models', files: 99 },
  }),
  captureFile: async (req) => ({ ...reply(null), sourcePath: req.path, storePath: req.path, sha256: 'f'.repeat(64), bytes: 0 }),
  // The most flattering lie a renderer-side stub can tell about a vault: it
  // says everything was captured and nothing was refused. Nothing here can
  // know the main pid, cannot make a manifest exist, and cannot put a row in
  // the witness — which is exactly what the vault assertions look at.
  vaultCapture: async (req) => ({
    ...reply(null), outcome: 'vaulted', vaultDir: req.vaultDir, vaultId: req.vaultId,
    counts: { files: 5, captured: 5, refused_mime_undeclared: 0, refused_mime_declared_absent: 0,
              refused_over_ceiling: 0, refused_unreadable: 0 },
    entries: [], emitted: [], queueDepth: 0,
    manifest: { path: '/nonexistent/manifest.json', digest: 'f'.repeat(64), bytes: 0 },
  }),
  // The most flattering lie about a ComfyUI session: everything launched,
  // everything is on loopback, nobody else is listening, and a generation
  // happened. A stub in the page can say all of that. What it cannot do is
  // start a process, hold a socket, put a PNG on disk or a row in a witness.
  comfyLaunch: async () => ({
    ...reply(null), outcome: 'launched',
    comfy: { version: '0.18.1', pid: 1, upstreamUrl: 'http://127.0.0.1:1' },
    modelRoot: '/nonexistent/models', modelFiles: [],
    gate: { pid: 1, url: 'http://127.0.0.1:2', adapter: 'model-store' },
    ledger: { gate: { count: 1, allOwnedByExpected: true, allLoopback: true },
              upstream: { count: 1, allOwnedByExpected: true, allLoopback: true } },
  }),
  comfyGenerate: async () => ({
    ...reply(null), outcome: 'generated', viaGate: true, promptId: 'stub',
    images: [{ filename: 'stub.png', sha256: 'f'.repeat(64), bytes: 0, storePath: '/nonexistent/stub.png' }],
    ledger: { gate: { count: 1, allOwnedByExpected: true, allLoopback: true },
              upstream: { count: 1, allOwnedByExpected: true, allLoopback: true } },
  }),
  comfyStop: async () => ({ ...reply(null), outcome: 'stopped', gateResult: { queueDepth: 0, enrichments: [] } }),
});
`;

// ── assertion kinds ────────────────────────────────────────────────────────
// Every one of these looks at the filesystem or at a value the app could not
// have chosen. None looks at stdout.
const KINDS = {
  'app-completed': (a, ctx) => ({
    pass: ctx.exitCode === 0 && ctx.result !== null && ctx.result.error === null,
    detail: { exitCode: ctx.exitCode, appError: ctx.result ? ctx.result.error : 'no result file' },
  }),
  equals: (a, ctx) => {
    const actual = ctx.resolve(a.actual);
    const expected = ctx.resolve(a.expected);
    return { pass: Object.is(actual, expected), detail: { actual, expected } };
  },
  'at-least': (a, ctx) => {
    const actual = ctx.resolve(a.actual);
    return { pass: typeof actual === 'number' && actual >= a.min, detail: { actual, min: a.min } };
  },
  'non-empty': (a, ctx) => {
    const actual = ctx.resolve(a.actual);
    return { pass: actual !== null && actual !== undefined && actual !== '', detail: { actual } };
  },
  'ends-with': (a, ctx) => {
    const actual = String(ctx.resolve(a.actual));
    const suffix = String(ctx.resolve(a.suffix));
    return { pass: actual.endsWith(suffix), detail: { actual, suffix } };
  },
  'step-succeeded': (a, ctx) => {
    const step = ctx.result && ctx.result.steps ? ctx.result.steps[a.step] : null;
    if (!step) return { pass: false, detail: `step "${a.step}" never ran` };
    const v = step.value;
    return {
      pass: step.error === null && step.reachedBridge === true && !!v && v.ok !== false,
      detail: { error: step.error, reachedBridge: step.reachedBridge, ok: v ? v.ok : null, reason: v ? v.reason : null },
    };
  },
  // The reply carries the pid of the process that wrote the result file. A
  // renderer-local stub would have to guess it, and the fake-bridge mutation
  // shows that it cannot.
  'reached-main': (a, ctx) => {
    const step = ctx.result && ctx.result.steps ? ctx.result.steps[a.step] : null;
    if (!step || !step.value) return { pass: false, detail: `step "${a.step}" returned nothing` };
    const v = step.value;
    const pidOk = Number.isInteger(v.mainPid) && v.mainPid === ctx.result.mainPid;
    const nonceOk = v.serverNonce === undefined || v.serverNonce === ctx.result.serverNonce;
    return { pass: pidOk && nonceOk, detail: { replyPid: v.mainPid, mainPid: ctx.result.mainPid, nonceOk } };
  },
  'file-exists': (a, ctx) => {
    const p = ctx.resolve(a.path);
    return { pass: typeof p === 'string' && existsSync(p) && statSync(p).isFile(), detail: p };
  },
  'file-absent': (a, ctx) => {
    const p = ctx.resolve(a.path);
    return { pass: !existsSync(p), detail: p };
  },
  // The one docs/DESIGN.md names. Read the bytes HERE and hash them HERE.
  'file-rehashes': (a, ctx) => {
    const p = ctx.resolve(a.path);
    const want = ctx.resolve(a.sha256);
    if (typeof p !== 'string' || !existsSync(p)) return { pass: false, detail: { path: p, why: 'no such file' } };
    const got = createHash('sha256').update(readFileSync(p)).digest('hex');
    return { pass: got === want, detail: { path: p, onDisk: got, recorded: want } };
  },
  // ── WO-D3. Rows in the scratch witness, read from the witness server's own
  // sqlite file by this process. Not from the app's reply, not from the app's
  // database, and certainly not from a log line: the WO's observable is "leaves
  // in the scratch witness", and the witness is a different process with a
  // different file.
  'witness-row': (a, ctx) => {
    const hash = ctx.resolve(a.contentHash);
    const rows = witnessRows(hash);
    return { pass: rows.length > 0, detail: { contentHash: hash, rows } };
  },
  // The other half, and the one that makes a refusal mean something: a refused
  // file must have NO leaf. A surface that refused in its own record and
  // witnessed the bytes anyway would pass every assertion above.
  'witness-row-absent': (a, ctx) => {
    const hash = ctx.resolve(a.contentHash);
    const rows = witnessRows(hash);
    return { pass: rows.length === 0, detail: { contentHash: hash, rows } };
  },
  // What the app SAID happened to one file. Weak on its own — it reads the
  // reply — and paired below with `manifest-entry`, which reads the bytes.
  'entry-outcome': (a, ctx) => {
    const entries = ctx.resolve(a.entries);
    if (!Array.isArray(entries)) return { pass: false, detail: 'no entries array' };
    const e = entries.find((x) => x && x.path === a.path);
    return { pass: !!e && e.outcome === a.expected, detail: { path: a.path, got: e ? e.outcome : null, expected: a.expected } };
  },
  // THE ONE THAT MAKES A REFUSAL "A RECORDED OUTCOME". The manifest is read
  // off disk HERE and parsed HERE; the app's reply is not consulted. A refusal
  // that exists only in the reply is a refusal that was silently skipped.
  'manifest-entry': (a, ctx) => {
    const p = ctx.resolve(a.path);
    if (typeof p !== 'string' || !existsSync(p)) return { pass: false, detail: { path: p, why: 'no manifest on disk' } };
    let doc;
    try { doc = JSON.parse(readFileSync(p, 'utf8')); }
    catch (err) { return { pass: false, detail: `manifest is not JSON: ${String(err.message || err)}` }; }
    const e = (doc.entries || []).find((x) => x && x.path === a.entry);
    if (!e) return { pass: false, detail: { entry: a.entry, why: 'not in the manifest at all' } };
    const checks = { outcome: e.outcome === a.expected };
    if (a.mimeState) checks.mimeState = e.mime && e.mime.state === a.mimeState;
    if (a.contentHashState) checks.contentHashState = e.content_hash && e.content_hash.state === a.contentHashState;
    if (a.bytesCountedState) checks.bytesCountedState = e.bytes_counted && e.bytes_counted.state === a.bytesCountedState;
    if (a.bytesCountedAtLeast !== undefined) {
      checks.bytesCountedAtLeast =
        e.bytes_counted && typeof e.bytes_counted.value === 'number' && e.bytes_counted.value >= a.bytesCountedAtLeast;
    }
    const pass = Object.values(checks).every(Boolean);
    return { pass, detail: { entry: a.entry, outcome: e.outcome, expected: a.expected, checks } };
  },
  'manifest-count': (a, ctx) => {
    const p = ctx.resolve(a.path);
    if (typeof p !== 'string' || !existsSync(p)) return { pass: false, detail: { path: p, why: 'no manifest on disk' } };
    let doc;
    try { doc = JSON.parse(readFileSync(p, 'utf8')); }
    catch (err) { return { pass: false, detail: `manifest is not JSON: ${String(err.message || err)}` }; }
    const got = (doc.counts || {})[a.key];
    return { pass: got === a.expected, detail: { key: a.key, got, expected: a.expected } };
  },
  // ── WO-D4. Rows in the scratch APP database, which is where a leaf's
  // evidence package lands — a different file from the witness, written by a
  // different service. `witness-row` above proves a leaf exists; these read
  // what it CARRIES.
  //
  // The NEWEST row for the content hash, never `SELECT *`: the scratch
  // database is persistent, and a mutation run that produced the same bytes
  // an hour ago must not answer for this one. Every run's workflow carries a
  // per-run integer, so in practice the hash is unique to the run; the ORDER
  // BY is there so that stops being something to rely on.
  'iteration-field': (a, ctx) => {
    const hash = ctx.resolve(a.contentHash);
    const row = iterationRow(hash, [a.field]);
    if (!row) return { pass: false, detail: { contentHash: hash, why: 'no iteration row for these bytes' } };
    const got = row[a.field];
    if (a.nonNull) return { pass: got !== null && got !== '', detail: { field: a.field, got } };
    if (a.isNull) return { pass: got === null || got === '', detail: { field: a.field, got } };
    const want = ctx.resolve(a.expected);
    return { pass: String(got) === String(want), detail: { field: a.field, got, expected: want } };
  },
  // THE ONE WO-D4 EXISTS FOR. The leaf's `model_fingerprints` manifest, read
  // out of the database HERE, for one model key, compared against a digest
  // THIS PROCESS took of the file on disk. Two claims are separable and both
  // are asserted, because the whole point is that they can disagree:
  //
  //   `key`               what the WORKFLOW called it — a name
  //   `contentHash`       what the BYTES were — a measurement
  //
  // A record derived from names satisfies the first and cannot satisfy the
  // second, which is what `model-swap` demonstrates.
  'model-fingerprint': (a, ctx) => {
    const hash = ctx.resolve(a.contentHash);
    const row = iterationRow(hash, ['model_fingerprints', 'model_fingerprints_hash']);
    if (!row) return { pass: false, detail: { contentHash: hash, why: 'no iteration row for these bytes' } };
    if (!row.model_fingerprints) {
      return { pass: false, detail: { contentHash: hash, why: 'the leaf carries no model_fingerprints' } };
    }
    let manifest;
    try { manifest = JSON.parse(row.model_fingerprints); }
    catch (err) { return { pass: false, detail: `model_fingerprints is not JSON: ${String(err.message || err)}` }; }
    const key = ctx.resolve(a.key);
    const fp = manifest[key];
    if (!fp) {
      return { pass: false, detail: { key, why: 'not in the manifest', keys: Object.keys(manifest) } };
    }
    const checks = {};
    if (a.state) checks.state = fp.state === a.state;
    if (a.resolution) checks.resolution = fp.resolution === a.resolution;
    if (a.declaredName !== undefined) checks.declaredName = fp.declared_name === ctx.resolve(a.declaredName);
    if (a.sha256 !== undefined) checks.contentHash = fp.content_hash === ctx.resolve(a.sha256);
    if (a.headerHash !== undefined) checks.headerHash = fp.header_hash === ctx.resolve(a.headerHash);
    if (a.bytes !== undefined) checks.bytes = fp.bytes === ctx.resolve(a.bytes);
    const pass = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
    return { pass, detail: { key, checks, fingerprint: fp, leafHash: row.model_fingerprints_hash } };
  },
  // The manifest and the hash on the leaf agree. Weak-looking and not weak:
  // /api/v2/witness recomputes this itself and REFUSES a submission whose two
  // halves disagree, so a green here is the server's arithmetic as well as
  // ours — and it is recomputed with the SDK's own canonicalization, never a
  // second implementation of the preimage.
  'model-fingerprints-hash-agrees': (a, ctx) => {
    const hash = ctx.resolve(a.contentHash);
    const row = iterationRow(hash, ['model_fingerprints', 'model_fingerprints_hash']);
    if (!row) return { pass: false, detail: { contentHash: hash, why: 'no iteration row' } };
    if (!row.model_fingerprints || !row.model_fingerprints_hash) {
      return { pass: false, detail: { why: 'one half is missing', row } };
    }
    const recomputed = createHash('sha256').update(row.model_fingerprints, 'utf8').digest('hex');
    return {
      pass: recomputed === row.model_fingerprints_hash,
      detail: { stored: row.model_fingerprints_hash, recomputed },
    };
  },
  // ── WO-D5. The dashboard's shape, asked two ways.
  //
  // `dom-*` reads what the REAL Electron window laid out — the app under test,
  // showing the served route, with its own profile header on the request.
  // `route-*` makes THIS PROCESS fetch the same route with a profile it chooses,
  // which is how one run can check both shapes come off one route without
  // launching two apps. Neither looks at a pixel (docs/DESIGN.md: the frame is
  // blank here and nothing may gate on it).
  'dom-present': (a, ctx) => {
    const sel = ctx.result.steps[a.step];
    if (!sel || !sel.value || !sel.value.selectors) return { pass: false, detail: `step "${a.step}" read no DOM` };
    const hit = sel.value.selectors[a.selector];
    if (!hit) return { pass: false, detail: { selector: a.selector, why: 'the scenario never read this selector' } };
    const min = a.min === undefined ? 1 : a.min;
    return { pass: hit.count >= min, detail: { selector: a.selector, count: hit.count, min } };
  },
  // ⚑ THE CONTROL THE WO NAMES. `count: 0` is what "absent" means, and it is
  // asserted alongside `mentions: 0` below — a region rendered empty, hidden or
  // commented out has a count of 0 too, and only the substring check tells them
  // apart.
  'dom-absent': (a, ctx) => {
    const sel = ctx.result.steps[a.step];
    if (!sel || !sel.value || !sel.value.selectors) return { pass: false, detail: `step "${a.step}" read no DOM` };
    const hit = sel.value.selectors[a.selector];
    if (!hit) return { pass: false, detail: { selector: a.selector, why: 'the scenario never read this selector' } };
    return { pass: hit.count === 0, detail: { selector: a.selector, count: hit.count } };
  },
  // Not merely empty: the string does not occur ANYWHERE in the serialised
  // document. A dashboard that drew every region and hid the inapplicable ones
  // would pass `dom-absent` and fail this.
  'dom-unmentioned': (a, ctx) => {
    const sel = ctx.result.steps[a.step];
    if (!sel || !sel.value || !sel.value.mentions) return { pass: false, detail: `step "${a.step}" read no mentions` };
    const n = sel.value.mentions[a.needle];
    if (n === undefined) return { pass: false, detail: { needle: a.needle, why: 'the scenario never looked for this string' } };
    return { pass: n === 0, detail: { needle: a.needle, occurrences: n } };
  },
  // The region contains a value only THIS MACHINE could have supplied — the
  // model root this run created, minutes ago, under a per-run directory. A
  // server rendering the web shape cannot produce it and neither can a static
  // mock.
  'dom-contains': (a, ctx) => {
    const sel = ctx.result.steps[a.step];
    if (!sel || !sel.value || !sel.value.selectors) return { pass: false, detail: `step "${a.step}" read no DOM` };
    const hit = sel.value.selectors[a.selector];
    if (!hit) return { pass: false, detail: { selector: a.selector, why: 'the scenario never read this selector' } };
    const want = String(ctx.resolve(a.text));
    return {
      pass: hit.text.includes(want),
      detail: { selector: a.selector, want, got: hit.text.slice(0, 300) },
    };
  },
  // What the LAYOUT ENGINE computed for a canon class, in the real window.
  // The canon design is 21 tokens and two layouts; this asks the browser what
  // one of them resolved to rather than asking a stylesheet what it says.
  'dom-computed': (a, ctx) => {
    const sel = ctx.result.steps[a.step];
    if (!sel || !sel.value || !sel.value.computed) return { pass: false, detail: `step "${a.step}" computed nothing` };
    const got = sel.value.computed[`${a.selector}|${a.prop}`];
    if (got === undefined) return { pass: false, detail: { selector: a.selector, prop: a.prop, why: 'the scenario never asked for this property' } };
    const want = ctx.resolve(a.expected);
    return { pass: got === want, detail: { selector: a.selector, prop: a.prop, got, expected: want } };
  },
  // THE SAME ROUTE, THE OTHER SHAPE. Fetched here, by this process, with the
  // profile named by the assertion — so "one route renders both" is established
  // without trusting anything the app said.
  'route-shape': (a, ctx) => {
    const html = fetchRoute(ctx.appURL, a.route || '/studio', a.profile);
    const present = (a.present || []).map((sel) => [sel, countMarkers(html, sel)]);
    const absent = (a.absent || []).map((sel) => [sel, countMarkers(html, sel)]);
    const pass =
      present.every(([, n]) => n > 0) && absent.every(([, n]) => n === 0);
    return {
      pass,
      detail: {
        profile: a.profile, bytes: html.length,
        present: Object.fromEntries(present), absent: Object.fromEntries(absent),
      },
    };
  },
  'file-bytes': (a, ctx) => {
    const p = ctx.resolve(a.path);
    const want = ctx.resolve(a.bytes);
    if (typeof p !== 'string' || !existsSync(p)) return { pass: false, detail: { path: p, why: 'no such file' } };
    const got = statSync(p).size;
    return { pass: got === want, detail: { path: p, onDisk: got, expected: want } };
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch the served route with a declared deployment profile.
 *
 * Synchronous on purpose: the assertion table is synchronous, and curl through
 * execFileSync keeps this repo at one dependency. A failure THROWS — a route
 * that could not be fetched is not a route that rendered nothing.
 */
function fetchRoute(appURL, route, profile) {
  const args = ['-sS', '--fail-with-body', '-m', '60'];
  if (profile) args.push('-H', `x-scruple-profile: ${profile}`);
  args.push(new URL(route, appURL).toString());
  try {
    return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`GET ${route} (profile=${profile}) failed: ${String(err.message || err)}`);
  }
}

/** How many nodes carry this marker, counted in the SERVED HTML. */
function countMarkers(html, marker) {
  return html.split(marker).length - 1;
}


/** Fixture bytes that are the same on every run, so a digest can be compared across runs. */
function deterministicBytes(seed, n) {
  const out = Buffer.alloc(n);
  let filled = 0, counter = 0;
  while (filled < n) {
    const block = createHmac('sha256', seed).update(String(counter++)).digest();
    block.copy(out, filled, 0, Math.min(block.length, n - filled));
    filled += block.length;
  }
  return out;
}


/**
 * Rows in the SCRATCH WITNESS for one content hash.
 *
 * Read with the sqlite3 CLI in read-only mode rather than through a driver,
 * because this repo has one dependency (electron) and the point of the query is
 * that it is made from OUTSIDE both the app and the sidecar. The URI form is
 * `mode=ro` so nothing here can write to a database this process does not own.
 *
 * 🔴 The path comes from SCRUPLE_WITNESS_DB and defaults to the scratch file.
 * The production witness at :5799 has its own database and is never opened.
 */
function witnessRows(contentHash) {
  if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) return [];
  const db = process.env.SCRUPLE_WITNESS_DB
    || '/mnt/corpus/scruple-council-impl/witness-scratch.db';
  const sql = `SELECT id || '|' || leaf_hash FROM witnesses WHERE content_hash = '${contentHash}';`;
  try {
    const out = execFileSync('sqlite3', [`file:${db}?mode=ro`, '-batch', sql], { encoding: 'utf8' });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    // A query that could not run is NOT an absent row. Returning [] here would
    // make `witness-row-absent` pass on a broken sqlite3 and turn a harness
    // fault into a green control.
    throw new Error(`witness query failed against ${db}: ${String(err.message || err)}`);
  }
}


/**
 * The newest `iterations` row for one content hash, from the SCRATCH APP
 * database — the file the Next app writes, which is not the witness's file.
 *
 * Read with the sqlite3 CLI in `mode=ro` for the same reasons `witnessRows`
 * is: one dependency in this repo, and the query has to be made from outside
 * the app, the gate and the sidecar. A query that could not run THROWS rather
 * than returning null, so a broken sqlite3 cannot turn into a green control.
 *
 * 🔴 SCRUPLE_DB_PATH defaults to the scratch database. Production is never
 * opened from here.
 */
function iterationRow(contentHash, fields) {
  if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) return null;
  const db = process.env.SCRUPLE_DB_PATH || '/mnt/corpus/scruple-council-impl/scruple-scratch.db';
  const sql =
    `SELECT ${fields.map((f) => `"${f}"`).join(', ')} FROM iterations ` +
    `WHERE output_hash = '${contentHash}' ORDER BY rowid DESC LIMIT 1;`;
  let out;
  try {
    out = execFileSync('sqlite3', [`file:${db}?mode=ro`, '-batch', '-json', sql], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`iterations query failed against ${db}: ${String(err.message || err)}`);
  }
  const rows = out.trim() ? JSON.parse(out) : [];
  return rows.length ? rows[0] : null;
}

/**
 * A REAL model file, built by scripts/d4-make-model.py.
 *
 * ⚑ NOT `deterministicBytes`. Every other fixture in this driver is an
 * arbitrary blob, because for a vault or a captured file the bytes are the
 * only thing that matters. A model is different: ComfyUI has to LOAD it, and
 * a blob with a .safetensors extension makes `UpscaleModelLoader` throw, which
 * means no generation, which means no leaf to carry a fingerprint. The
 * fixture is therefore a genuine 1,700-parameter RealESRGAN Compact state
 * dict, and the generation that produces the leaf is a real one.
 */
function makeModelFile(destPath, seed) {
  const out = execFileSync('python3', [join(REPO, 'scripts', 'd4-make-model.py'), destPath, String(seed)], {
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

/**
 * A MODEL STORE FIXTURE: a ComfyUI base directory this run owns, with weights
 * in it that the driver hashed before ComfyUI ever saw them.
 *
 * The base directory is per-run and never the reference checkout at
 * /data/reference/ui-inspire/ComfyUI, which stays read-only: `--base-directory`
 * moves models, input, output, temp, user and custom_nodes together, so one
 * flag decides all of them and there is no path left over to disagree.
 */
function materialiseModelStore(sourceDir, id, spec) {
  const baseDir = join(sourceDir, spec.name || id);
  for (const d of ['models/upscale_models', 'models/loras', 'models/checkpoints', 'input', 'output', 'temp', 'user', 'custom_nodes']) {
    mkdirSync(join(baseDir, d), { recursive: true });
  }
  const modelRoot = join(baseDir, 'models');
  const files = {};
  for (const [fid, f] of Object.entries(spec.files || {})) {
    const p = join(modelRoot, f.subdir, f.name);
    const built = makeModelFile(p, f.seed);
    files[fid] = {
      ...f, path: p, key: `${f.subdir}/${f.name}`,
      bytes: built.bytes, sha256: built.sha256,
      header_hash: built.header_hash, header_size: built.header_size,
    };
  }
  return { ...spec, path: baseDir, baseDir, modelRoot, files };
}

/** The scratch app credentials the GATE needs, under its own baseline. The
 *  baseline_ref is the tamper surface of app/comfy/ — the code doing the
 *  measuring — so a change in the vault surface cannot show up as drift here
 *  and vice versa. */
function surfaceSandbox(surfaceRel) {
  const run = (args) =>
    execFileSync('bash', [join(REPO, 'scripts', 'tsx.sh'), join(REPO, 'scripts', 'd3-sandbox.ts'), '--surface', surfaceRel, ...args], {
      cwd: REPO, encoding: 'utf8',
      env: {
        ...process.env,
        SCRUPLE_DB_PATH: process.env.SCRUPLE_DB_PATH || '/mnt/corpus/scruple-council-impl/scruple-scratch.db',
        SCRUPLE_BDK_ALLOW_DEV: process.env.SCRUPLE_BDK_ALLOW_DEV || '1',
      },
    }).trim().split('\n').pop().trim();
  const sandbox = JSON.parse(run(['--json']));
  return { ...sandbox, token: run(['--mint-token']) };
}

/**
 * A VAULT FIXTURE: a directory, its files, and the declaration that types them.
 *
 * Written and hashed HERE, before the app exists, for the same reason the flat
 * fixtures are: the digest the app reports has to be compared against one it
 * did not produce.
 *
 * ⚑ THE CONTROLS LIVE IN THE SHAPE OF THIS DIRECTORY. `accepted.png` is
 * declared and `undeclared.png` is not, and THEY HAVE THE SAME EXTENSION. Any
 * extension table, `mimetypes` import or "sensible default" in the surface
 * makes the second one pass, and the second one passing is the failure. A
 * fixture pair that differed in extension as well would not be able to tell
 * the difference.
 */
function materialiseVault(sourceDir, id, spec, salt) {
  const dir = join(sourceDir, spec.name || id);
  mkdirSync(dir, { recursive: true });
  const declaration = { vault_declaration: 'v1', declared_by: spec.declaredBy || 'desktop-run fixture', files: {} };
  // KEYED BY A DOT-FREE ID, not by the filename. `${fixtures.vault.files.accepted.sha256}`
  // has to resolve, and app/interpolate.js splits a reference on '.', so a key
  // of "accepted.png" would be looked up as two path segments and throw.
  const files = {};
  for (const [fid, f] of Object.entries(spec.files || {})) {
    const name = f.name || fid;
    // SALTED WITH THE RUN NONCE, unlike the flat fixtures. The witness is a
    // persistent scratch database: a vault file with the same bytes every run
    // would be witnessed once and then found by every later run's
    // `witness-row-absent` — an assertion that goes permanently red because an
    // EARLIER mutation did its job. The driver hashes these itself, so it needs
    // no cross-run determinism to compare against.
    const bytes = deterministicBytes(`${f.seed || `${id}/${name}`}:${salt}`, f.bytes);
    const p = join(dir, name);
    writeFileSync(p, bytes);
    files[fid] = { name, path: p, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    // `declare: false` means the declaration does not name it at all —
    // `indeterminate`. `mime: null` means it names it and declares no type —
    // `absent`. Two different facts, and the fixture can express both.
    if (f.declare === false) continue;
    declaration.files[name] = { mime: f.mime === undefined ? null : f.mime, ...(f.reason ? { reason: f.reason } : {}) };
  }
  const declarationPath = join(dir, 'scruple-vault.json');
  const declarationBytes = Buffer.from(JSON.stringify(declaration, null, 2), 'utf8');
  writeFileSync(declarationPath, declarationBytes);
  return {
    ...spec, path: dir, files, declarationPath,
    declarationSha256: createHash('sha256').update(declarationBytes).digest('hex'),
  };
}

/**
 * The scratch app credentials a vault run needs, and a FRESH provisioning
 * token for it.
 *
 * Read from scripts/d3-sandbox.ts rather than reimplemented, because minting a
 * key and a baseline by hand here would be this script testing its own INSERT.
 * The token is single-use and short-TTL by design, so it is minted per run.
 */
function vaultSandbox() {
  return surfaceSandbox('app/vault');
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function resolveScenario(nameOrPath) {
  if (nameOrPath.endsWith('.json')) return resolve(nameOrPath);
  const p = join(REPO, 'scenarios', `${nameOrPath}.json`);
  if (!existsSync(p)) {
    const have = readdirSync(join(REPO, 'scenarios')).map((f) => basename(f, '.json'));
    throw new Error(`no scenario "${nameOrPath}"; have: ${have.join(', ')}`);
  }
  return p;
}

// ── one run ────────────────────────────────────────────────────────────────

async function runOnce({ specPath, label, appURL, breaks, timeoutMs, quiet }) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const runDir = join(REPO, '.run', 'd2', `${label}-${Date.now()}`);
  const sourceDir = join(runDir, 'source');
  const storeDir = join(runDir, 'store');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  const nonce = randomBytes(12).toString('hex');
  const resultPath = join(runDir, 'result.json');
  const reportPath = join(runDir, 'report.json');
  const applied = [];

  // Fixtures: written and hashed HERE, before the app has seen them, so the
  // digest the app reports is being compared against one it did not produce.
  const fixtures = {};
  for (const [id, f] of Object.entries(spec.fixtures || {})) {
    if (f.kind === 'vault') { fixtures[id] = materialiseVault(sourceDir, id, f, nonce); continue; }
    if (f.kind === 'model-store') { fixtures[id] = materialiseModelStore(sourceDir, id, f); continue; }
    const bytes = deterministicBytes(f.seed || id, f.bytes);
    const path_ = join(sourceDir, f.name || id);
    writeFileSync(path_, bytes);
    fixtures[id] = {
      ...f, path: path_, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  // An app directory of our own only when a mutation needs to change the app.
  const dirMutations = breaks.filter((b) => MUTATIONS[b].when === 'app-dir');
  let appDir = REPO;
  if (dirMutations.length) {
    appDir = join(runDir, 'app-under-test');
    mkdirSync(appDir, { recursive: true });
    cpSync(join(REPO, 'app'), join(appDir, 'app'), { recursive: true });
    cpSync(join(REPO, 'package.json'), join(appDir, 'package.json'));
  }

  // The child's environment, assembled BEFORE the mutations run so an `env`
  // mutation has something to change. Everything a page may not choose lives
  // here: the store, the ceiling, the key, the baseline, the token.
  const env = {
    ...process.env,
    SCRUPLE_APP_URL: appURL,
    SCRUPLE_RUN_STORE: storeDir,
    SCRUPLE_SCENARIO_RESULT: resultPath,
    // So a copied app/ (the app-dir mutations) still finds scripts/ and
    // vendor/. Without it `fake-bridge` would fail because the sidecar was
    // missing, which has nothing to do with the preload it is testing.
    SCRUPLE_DESKTOP_ROOT: REPO,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };

  if (spec.needs === 'vault') {
    const sandbox = vaultSandbox();
    env.SCRUPLE_VAULT_API_KEY = sandbox.apiKey;
    env.SCRUPLE_VAULT_BASELINE_REF = sandbox.baselineRef;
    env.SCRUPLE_VAULT_PROVISIONING_TOKEN = sandbox.token;
    env.SCRUPLE_VAULT_STATE = join(runDir, 'vault-state');
    // THE CEILING IS CONFIGURATION AND IT COMES FROM HERE, never from the
    // scenario's steps — a renderer that could raise the ceiling could make an
    // over-ceiling refusal disappear.
    if (spec.vaultCeilingBytes) env.SCRUPLE_VAULT_CEILING_BYTES = String(spec.vaultCeilingBytes);
    mkdirSync(env.SCRUPLE_VAULT_STATE, { recursive: true, mode: 0o700 });
  }

  if (spec.needs === 'comfy') {
    const sandbox = surfaceSandbox('app/comfy');
    env.SCRUPLE_COMFY_API_KEY = sandbox.apiKey;
    env.SCRUPLE_COMFY_BASELINE_REF = sandbox.baselineRef;
    env.SCRUPLE_COMFY_PROVISIONING_TOKEN = sandbox.token;
    env.SCRUPLE_COMFY_STATE = join(runDir, 'comfy-state');
    // THE MODEL ROOT AND THE COMFYUI CHECKOUT ARE CONFIGURATION, and they come
    // from here for the same reason the vault's ceiling does: a renderer that
    // could name the model root could point the fingerprinter at a directory
    // it had filled itself.
    const store = Object.values(fixtures).find((f) => f && f.kind === 'model-store');
    if (!store) throw new Error('a scenario that needs comfy must declare a model-store fixture');
    env.SCRUPLE_COMFY_BASE = store.baseDir;
    env.SCRUPLE_COMFY_MAIN = process.env.SCRUPLE_COMFY_MAIN
      || '/data/reference/ui-inspire/ComfyUI/main.py';
    env.SCRUPLE_COMFY_PYTHON = process.env.SCRUPLE_COMFY_PYTHON || 'python3';
    mkdirSync(env.SCRUPLE_COMFY_STATE, { recursive: true, mode: 0o700 });
  }

  const ctxEarly = { fixtures, appDir, spec, runDir, env };
  for (const b of breaks) {
    const m = MUTATIONS[b];
    if (m.when === 'after') continue;
    applied.push({ mutation: b, what: m.apply(ctxEarly) });
  }

  // The spec the app actually reads: fixtures materialised, driver block filled.
  const materialised = {
    ...spec,
    fixtures,
    driver: {
      nonce, appURL, expectedOrigin: new URL(appURL).origin, runDir, storeDir,
      // An integer derived from the run nonce, so a scenario can make its
      // workflow unique to THIS run. The scratch app database is persistent
      // and a generation with an identical graph produces identical bytes;
      // without this, a `witness-row` assertion could be satisfied by a leaf
      // an earlier run wrote. 24 bits, because it is used as an RGB colour.
      nonceInt: parseInt(nonce.slice(0, 6), 16),
    },
  };
  const materialisedPath = join(runDir, 'spec.json');
  writeFileSync(materialisedPath, JSON.stringify(materialised, null, 2));

  const electron = join(REPO, 'node_modules', '.bin', 'electron');
  const child = spawn(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1280x900x24', electron, appDir, `--scenario=${materialisedPath}`],
    {
      cwd: appDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let appLog = '';
  child.stdout.on('data', (d) => { appLog += d; if (!quiet) process.stdout.write(`   | ${d}`); });
  child.stderr.on('data', (d) => { appLog += d; });

  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const exitCode = await new Promise((res) => {
    child.on('close', (code, signal) => { clearTimeout(killer); res(signal ? `signal:${signal}` : code); });
  });
  writeFileSync(join(runDir, 'app.log'), appLog);

  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;

  const ctx = {
    exitCode, timedOut, result, fixtures, appDir, runDir, storeDir, appURL,
    // Deliberately allowed to THROW. The assertion loop turns that into a
    // failed check. An earlier version caught it and returned a placeholder
    // string, and the audit sweep found the hole: under `no-bridge` there is no
    // reply to read a version out of, and `non-empty` was happily passing on
    // "<<unresolved: …>>". A reference that does not resolve is a failed
    // assertion, never a satisfied one.
    resolve: (v) => interpolate(v, { ...(result || {}), fixtures, driver: materialised.driver }),
  };

  for (const b of breaks) {
    const m = MUTATIONS[b];
    if (m.when !== 'after') continue;
    applied.push({ mutation: b, what: m.apply(ctx) });
  }

  // ── the verdict ──────────────────────────────────────────────────────────
  const checks = [];
  const add = (id, pass, detail, note) => checks.push({ id, pass: !!pass, detail: detail ?? null, note: note ?? null });

  // Two the driver always makes, whatever the scenario says.
  add('process-did-not-hang', !timedOut, { timeoutMs });
  add('result-written', result !== null, resultPath);

  for (const a of materialised.assert || []) {
    const kind = KINDS[a.kind];
    if (!kind) { add(a.id || a.kind, false, `unknown assertion kind "${a.kind}"`); continue; }
    if (result === null && a.kind !== 'app-completed') { add(a.id || a.kind, false, 'no result file', a.note); continue; }
    let outcome;
    try { outcome = kind(a, ctx); } catch (err) { outcome = { pass: false, detail: String(err.message || err) }; }
    add(a.id || a.kind, outcome.pass, outcome.detail, a.note);
  }

  const failed = checks.filter((c) => !c.pass).map((c) => c.id);
  const report = {
    spec: materialised,
    scenario: materialised.scenario, label, appURL, runDir, specPath, exitCode, timedOut,
    breaks: applied, passed: failed.length === 0, failed,
    checks,
    versions: result ? result.versions : null,
    page: result && result.renderer ? { href: result.renderer.href, bodyChars: result.renderer.bodyChars, bridgeMethods: result.renderer.bridgeMethods } : null,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  report.reportPath = reportPath;
  return report;
}

function printReport(r) {
  for (const c of r.checks) {
    console.log(`   ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}${c.pass ? '' : `  ${JSON.stringify(c.detail)}`}`);
  }
  if (r.versions) {
    console.log(`   electron ${r.versions.electron} · chromium ${r.versions.chrome} · node ${r.versions.node}`);
  }
  if (r.page) console.log(`   page ${r.page.href} (${r.page.bodyChars} chars) · bridge [${(r.page.bridgeMethods || []).join(', ')}]`);
  console.log(`   run  ${r.runDir}`);
  console.log(`   ${r.passed ? 'PASSED' : `FAILED — ${r.failed.join(', ')}`}`);
}

// ── main ───────────────────────────────────────────────────────────────────

if (process.argv.includes('--list')) {
  console.log('scenarios:');
  for (const f of readdirSync(join(REPO, 'scenarios'))) {
    const s = JSON.parse(readFileSync(join(REPO, 'scenarios', f), 'utf8'));
    console.log(`  ${basename(f, '.json').padEnd(16)} ${s.description}`);
  }
  console.log('\nmutations:');
  for (const [k, m] of Object.entries(MUTATIONS)) console.log(`  ${k.padEnd(20)} ${m.describe}`);
  process.exit(0);
}

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.error('usage: desktop-run.mjs <scenario> [--audit] [--break <mutation>] [--expect-fail]');
  console.error('       desktop-run.mjs --list');
  process.exit(2);
}

const specPath = resolveScenario(target);
const appURL = argValue('--url', process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902');
const timeoutMs = Number(argValue('--timeout', '180000'));
const expectFail = process.argv.includes('--expect-fail');
const audit = process.argv.includes('--audit');
const oneBreak = argValue('--break', null);
if (oneBreak && !MUTATIONS[oneBreak]) {
  console.error(`unknown mutation "${oneBreak}"; have: ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

console.log(`── desktop-run · ${basename(specPath)} ──`);
console.log(`   app url : ${appURL}`);

const clean = await runOnce({
  specPath, label: oneBreak ? `break-${oneBreak}` : 'clean', appURL,
  breaks: oneBreak ? [oneBreak] : [], timeoutMs, quiet: false,
});
printReport(clean);

if (!audit) {
  if (expectFail) {
    console.log(`\n   expected FAIL${oneBreak ? ` (mutation ${oneBreak})` : ''}`);
    console.log(clean.passed ? '── THE BREAK DID NOT FIRE — that is the problem ──' : '── the break fired as required ──');
    process.exit(clean.passed ? 1 : 0);
  }
  process.exit(clean.passed ? 0 : 1);
}

// ── the audit sweep ────────────────────────────────────────────────────────
// Break it once per mutation. Each must redden exactly what it targets.
if (!clean.passed) {
  console.log('\n── the clean run failed; the sweep would be meaningless. Stopping. ──');
  process.exit(1);
}
const declared = clean.spec.audit || {};
const unknown = Object.keys(declared).filter((k) => !MUTATIONS[k]);
if (unknown.length) {
  console.log(`\n── ${basename(specPath)} declares mutations that do not exist: ${unknown.join(', ')} ──`);
  process.exit(2);
}
if (!Object.keys(declared).length) {
  console.log('\n── this scenario declares no audit block; there is nothing to sweep ──');
  process.exit(2);
}
let rc = 0;
const rows = [];

for (const [name, targets] of Object.entries(declared)) {
  const m = MUTATIONS[name];
  process.stdout.write(`\n── mutation ${name} — ${m.describe}\n`);
  let r;
  try {
    r = await runOnce({ specPath, label: `audit-${name}`, appURL, breaks: [name], timeoutMs, quiet: true });
  } catch (err) {
    rows.push([name, 'ERROR', String(err.message || err)]); rc = 1; continue;
  }
  const red = new Set(r.failed);
  const missing = targets.filter((id) => !red.has(id));
  const extra = [...red].filter((id) => !targets.includes(id));
  let verdict, detail;
  if (r.passed) { verdict = 'NOT CAUGHT'; detail = 'the run still passed'; rc = 1; }
  else if (missing.length) { verdict = 'MISSED'; detail = `declared red, stayed green: ${missing.join(', ')}`; rc = 1; }
  else if (extra.length) { verdict = 'OVERREACH'; detail = `red but not declared: ${extra.join(', ')}`; rc = 1; }
  else { verdict = 'caught'; detail = `${targets.length} red exactly: ${targets.join(', ')}`; }
  rows.push([name, verdict, detail]);
  console.log(`   ${verdict}: ${detail}`);
}

console.log('\n════ audit sweep ════');
for (const [name, verdict, detail] of rows) {
  console.log(`  ${name.padEnd(20)} ${verdict.padEnd(11)} ${detail}`);
}
console.log(rc === 0
  ? '\n════ scenario PASSES and every mutation was caught by exactly what it targets ════'
  : '\n════ SWEEP NOT CLEAN — see above ════');
process.exit(rc);
