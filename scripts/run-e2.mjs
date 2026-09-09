// WO-E2 — `declared_uncaptured`, demonstrated against the REAL
// `CaptureComponent` and a REAL upstream that reports artifacts the component
// does not capture.
//
//   E2_REPO=/data/scruple-web node --import tsx scripts/run-e2.mjs
//
// THE SAME SCRIPT RUNS BEFORE AND AFTER THE CHANGE. `E2_REPO` selects the tree
// the component is imported from, so stage 1 of `e2-gate.sh` points it at a
// worktree of the parent commit and gets the same three sessions with the same
// stub. Everything printed is read off the leaves the component actually
// submitted, so the difference between the two runs is the code and not the
// script.
//
// ⚑ THE STUB IS IN THIS FILE, not imported from the tree under test. A stub
// that came from the repo would change between the two runs, and the "before"
// run would then be measuring a different upstream. run-c5.mjs made the same
// choice for the same reason.
//
// THREE SESSIONS. Same upstream, same graph, same retrievals. THE ONLY
// DIFFERENCE IS WHICH ROOTS ARE DECLARED:
//
//   A  GATE       roots: output only. The PreviewImage write lands in temp/,
//                 is listed in /history (round 5 §4(a)), and nobody captures
//                 it. A leaf must NAME it, with a scope that says what was
//                 looked at.
//   B  CONTROL 1  roots: output + temp + input. The watcher captures the temp
//                 write too, so nothing is left over — and the leaf must carry
//                 an EMPTY SET THAT IS PRESENT (count 0, document there), never
//                 an absent field.
//   C  CONTROL 2  roots: one untyped root (the pre-C-8 `outputVolume` form).
//                 It must REFUSE TO CLAIM CLOSURE, because it cannot have one.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const REPO = process.env.E2_REPO || '/data/scruple-web';
const ROOT = process.env.E2_ROOT || '/tmp/woe2';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
process.env.SCRUPLE_DB_PATH = path.join(ROOT, 'unused.db');
process.env.SCRUPLE_BDK_HEX = 'e2'.repeat(32);
// 🔴 Never the production witness on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

const { CaptureComponent } = await import(`${REPO}/services/scruple-capture/src/component.ts`);
const { Identity } = await import(`${REPO}/services/scruple-capture/src/identity.ts`);
const { DEFAULT_RETENTION_POLICY, DEFAULT_RETENTION_POLICY_DIGEST } = await import(
  `${REPO}/lib/leaf/retentionPolicy.ts`
);

const say = (s = '') => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ─────────────────────────────────────────────────────────────────────────
// A stub ComfyUI, transcribed from /data/reference/ui-inspire/ComfyUI:
//
//   GET  /system_stats  server.py:646-685
//   GET  /history       server.py:888-900 -> execution.py:1282, with
//                       max_items/offset walking the dict from the front, and
//                       `outputs` merged in by task_done (:1237-1242).
//   POST /prompt        server.py:915-935
//   GET  /view          server.py:501 — output/, temp/ and input/ by `type`.
//
// ⚑ `PreviewImage` IS A `SaveImage` SUBCLASS WHOSE output_dir IS
// folder_paths.get_temp_directory() (nodes.py:1684-1690). It writes a FULL
// IMAGE to temp/ and reports it in /history tagged `type: "temp"`. That is the
// artifact class an output-only deployment cannot see, and the reason round 5
// §4(a) was checked in the source rather than reasoned about.
// ─────────────────────────────────────────────────────────────────────────
async function startUpstream(dirs) {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  let number = 0;
  let history = {};

  const STATS = {
    system: {
      os: 'linux', ram_total: 67e9, ram_free: 41e9, comfyui_version: '0.3.44',
      required_frontend_version: '1.24.4', installed_templates_version: '0.1.41',
      required_templates_version: '0.1.41', python_version: '3.11.9',
      pytorch_version: '2.5.1+cu124', embedded_python: false,
      argv: ['main.py', '--listen', '127.0.0.1'],
    },
    devices: [{ name: 'cuda:0 NVIDIA L4', type: 'cuda', index: 0, vram_total: 23e9, vram_free: 21e9, torch_vram_total: 0, torch_vram_free: 0 }],
  };

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub.invalid');
    const p = url.pathname.replace(/^\/api/, '');
    const json = (b) => {
      const buf = Buffer.from(JSON.stringify(b), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(buf.length) });
      res.end(buf);
    };

    if (req.method === 'GET' && p === '/system_stats') {
      return json({ ...STATS, system: { ...STATS.system, ram_free: STATS.system.ram_free - Math.floor(Math.random() * 1e6) } });
    }

    if (req.method === 'GET' && p === '/history') {
      const maxItems = url.searchParams.has('max_items') ? Number(url.searchParams.get('max_items')) : null;
      let offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : -1;
      const keys = Object.keys(history);
      if (offset < 0 && maxItems !== null) offset = keys.length - maxItems;
      const out = {};
      let i = 0;
      for (const k of keys) {
        if (i >= offset) {
          out[k] = history[k];
          if (maxItems !== null && Object.keys(out).length >= maxItems) break;
        }
        i++;
      }
      return json(out);
    }

    if (req.method === 'POST' && p === '/prompt') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const graph = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const n = number++;
      const promptId = crypto.randomUUID();
      const outputs = {};
      for (const [nodeId, node] of Object.entries(graph)) {
        if (!node || typeof node !== 'object') continue;
        if (node.class_type === 'SaveImage') {
          const prefix = String(node.inputs?.filename_prefix ?? 'ComfyUI').replace(/[^A-Za-z0-9_.-]/g, '_');
          const file = `${prefix}_00001_.png`;
          fs.writeFileSync(path.join(dirs.output, file), PNG_1x1);
          outputs[nodeId] = { images: [{ filename: file, subfolder: '', type: 'output' }] };
        }
        if (node.class_type === 'PreviewImage') {
          const file = `ComfyUI_temp_${promptId.slice(0, 5)}_00001_.png`;
          fs.writeFileSync(path.join(dirs.temp, file), PNG_1x1);
          outputs[nodeId] = { images: [{ filename: file, subfolder: '', type: 'temp' }] };
        }
      }
      history[promptId] = {
        prompt: [n, promptId, graph, {}, []],
        outputs,
        status: { status_str: 'success', completed: true, messages: [] },
      };
      return json({ prompt_id: promptId, number: n, node_errors: {} });
    }

    if (req.method === 'GET' && p === '/view') {
      const filename = url.searchParams.get('filename') ?? '';
      const type = url.searchParams.get('type') ?? 'output';
      const base = type === 'input' ? dirs.input : type === 'temp' ? dirs.temp : dirs.output;
      const abs = path.join(base, filename);
      if (!fs.existsSync(abs)) { res.writeHead(404).end('not found'); return; }
      const buf = fs.readFileSync(abs);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(buf.length) });
      return res.end(buf);
    }

    res.writeHead(404).end('not found');
  };

  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get promptCount() { return Object.keys(history).length; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function startIngest() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { received.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {}
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function identityFor(stateDir, suffix) {
  return Identity.fromSealed(stateDir, {
    component_id: `7e2d1e3a-9b44-4f21-8a6e-1d0c9f2b3a${suffix}`,
    chain_key_hex: '33'.repeat(32),
    counter: 0,
    build_measurement: `sha256:${'e2'.repeat(32)}`,
    attestation_status: null,
    provisioned_at: new Date().toISOString(),
  });
}

function cfgFor({ stateDir, upstreamUrl, apiBaseUrl, volumes }) {
  return {
    upstreamUrl,
    listenHost: '127.0.0.1',
    listenPort: 0,
    ...volumes,
    stateDir,
    allowDegradedStorage: true,
    stateMinReservableBytes: 1,
    apiBaseUrl,
    apiKey: 'sk_woe2',
    provisioningToken: null,
    baselineRef: 'ee'.repeat(32),
    outputVolumeDeclaredMime: 'image/png',
    witnessAuthority: null,
    retentionPolicyDigest: DEFAULT_RETENTION_POLICY_DIGEST,
    settlementWindowSeconds: DEFAULT_RETENTION_POLICY.settlement_window_s,
    settleMs: 30,
    correlationTtlMs: 60_000,
    heartbeatWindowSeconds: 900,
    // Brackets are driven by hand below, so nothing races an interval.
    upstreamPollIntervalMs: 3_600_000,
    upstreamMaxReadingAgeMs: 3_600_000,
    upstreamAnchorWindow: 64,
  };
}

async function generate(gateUrl, graph, fetchNames) {
  const r = await fetch(`${gateUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(graph),
  });
  await r.json();
  await sleep(120);
  for (const f of fetchNames) {
    const v = await fetch(`${gateUrl}/view?filename=${f.filename}&type=${f.type}&subfolder=`);
    await v.arrayBuffer();
  }
}

async function session({ name, roots, suffix }) {
  const base = path.join(ROOT, name);
  const dirs = {
    output: path.join(base, 'output'),
    temp: path.join(base, 'temp'),
    input: path.join(base, 'input'),
  };
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const upstream = await startUpstream(dirs);
  const ingest = await startIngest();

  const volumes =
    roots === 'three'
      ? { watchedVolumes: [
          { type: 'output', path: dirs.output },
          { type: 'temp', path: dirs.temp },
          { type: 'input', path: dirs.input },
        ] }
      : roots === 'output-only'
        ? { watchedVolumes: [{ type: 'output', path: dirs.output }] }
        : { outputVolume: dirs.output };

  const comp = await CaptureComponent.start(
    cfgFor({ stateDir, upstreamUrl: upstream.url, apiBaseUrl: ingest.url, volumes }),
    { identity: identityFor(stateDir, suffix), log: () => {} },
  );
  const gateUrl = `http://127.0.0.1:${comp.port}`;

  // ONE generation that produces TWO artifacts: an output/ save the client
  // retrieves, and a temp/ preview nobody retrieves.
  await generate(
    gateUrl,
    {
      1: { class_type: 'SaveImage', inputs: { filename_prefix: name } },
      2: { class_type: 'PreviewImage', inputs: {} },
    },
    [{ filename: `${name}_00001_.png`, type: 'output' }],
  );
  await comp.fsWatch.settled();
  // ONE bracket, by hand, so the enumeration sees the completed prompt.
  await comp.upstream.poll();
  // …then a second generation, so a leaf is emitted AFTER that bracket. A
  // leaf's absence set describes the newest reading available at ITS emission.
  await generate(
    gateUrl,
    { 1: { class_type: 'SaveImage', inputs: { filename_prefix: `${name}b` } } },
    [{ filename: `${name}b_00001_.png`, type: 'output' }],
  );
  await comp.fsWatch.settled();
  await sleep(120);

  const leaves = ingest.received.slice();
  const prompts = upstream.promptCount;
  await comp.stop();
  await ingest.close();
  await upstream.close();
  return { leaves, prompts };
}

const cap = (l) => l?.capture ?? {};
const A = (v) => (v === undefined ? '(ABSENT)' : v === null ? 'null' : String(v));

/**
 * ⚑ THE LISTING IS DE-DUPLICATED ON (component_id, counter), AND THAT IS NOT
 * HIDING ANYTHING.
 *
 * `Submitter.capture()` enqueues BEFORE it sends and then drains best-effort,
 * so two concurrent surfaces — the HTTP gate's `as-delivered` copy and the
 * watcher's `as-written` one, which H-4 §2 says are two observations of one
 * generation — can both drain the same entry. The submitter's own comment
 * owns this: "a crash the other way costs one duplicate, which the server
 * drops idempotently on (component_id, counter) (§4.2 rule 3)". THE REAL ROUTE
 * DEDUPES; this ingest stub is forty lines and does not, so the raw list shows
 * the same leaf twice.
 *
 * Verified rather than assumed: the duplicates are BYTE-IDENTICAL, same MAC,
 * same counter, same capture block. They are re-deliveries of one leaf, not
 * two leaves. The assertions below run over the RAW list, so nothing is
 * excluded from a verdict — only from the printout.
 */
function report(label, leaves) {
  say(`  leaves emitted by session ${label}:`);
  const shown = new Set();
  for (const [i, l] of leaves.entries()) {
    const key = `${l.component?.component_id}#${l.component?.counter}`;
    if (shown.has(key)) continue;
    shown.add(key);
    const c = cap(l);
    say(`   #${String(i).padStart(2)} n=${l.component?.counter} ${c.egress ?? '-'}`);
    say(
      `        method=${A(c.uncaptured_enumeration_method)}  scope=${A(c.uncaptured_scope)}` +
        `  src=${A(c.uncaptured_scope_source)}  count=${A(c.declared_uncaptured_count)}`,
    );
    const doc = l.declared_uncaptured;
    if (doc) {
      const names = doc.artifacts.map((a) => `${a.type}:${a.filename}`).join(', ') || '(none)';
      say(`        set: ${names}`);
      say(
        `        scope: types=[${doc.scope.volume_types.join(',')}] missing=[${doc.scope.missing_types.join(',')}]` +
          ` unspecified=${doc.scope.unspecified_roots} window=${doc.scope.history_window.entries_enumerated}/${doc.scope.history_window.anchor_window}`,
      );
    } else {
      say('        set: (no document)');
    }
  }
}

const enumeratedLeaves = (ls) => ls.filter((l) => cap(l).uncaptured_enumeration_method === 'live_history');

// ═════════════════════════════════════════════════════════════════════════
say(`E2_REPO = ${REPO}`);
say('');
say('════ SESSION A — THE GATE: output/ watched, a temp/ artifact nobody captured ════');
const a = await session({ name: 'gate', roots: 'output-only', suffix: '01' });
report('A', a.leaves);

say('');
say('════ SESSION B — CONTROL 1: all three roots watched, nothing left over ════');
const b = await session({ name: 'ctl1', roots: 'three', suffix: '02' });
report('B', b.leaves);

say('');
say('════ SESSION C — CONTROL 2: one UNTYPED root; closure must be refused ════');
const c = await session({ name: 'ctl2', roots: 'single', suffix: '03' });
report('C', c.leaves);

// ═════════════════════════════════════════════════════════════════════════
say('');
say('════ THE GATE, AND ITS CONTROLS ════');

const aEnum = enumeratedLeaves(a.leaves);
const aNamed = aEnum.filter((l) => Number(cap(l).declared_uncaptured_count) > 0);
const aTemp = aNamed.some((l) =>
  (l.declared_uncaptured?.artifacts ?? []).some((x) => x.type === 'temp'),
);
const aScoped = aNamed.every((l) => {
  const s = l.declared_uncaptured?.scope;
  return s && s.volume_types.length > 0 && Array.isArray(s.missing_types) && s.history_window?.epoch;
});
const gate = aEnum.length > 0 && aNamed.length > 0 && aTemp && aScoped;

const bEnum = enumeratedLeaves(b.leaves);
const bLast = bEnum[bEnum.length - 1];
const control1 =
  bEnum.length > 0 &&
  cap(bLast).declared_uncaptured_count === 0 &&
  cap(bLast).declared_uncaptured_hash != null &&
  !!bLast.declared_uncaptured &&
  Array.isArray(bLast.declared_uncaptured.artifacts) &&
  bLast.declared_uncaptured.artifacts.length === 0 &&
  cap(bLast).uncaptured_scope !== 'not_enumerated';

const cEnum = enumeratedLeaves(c.leaves);
const control2 =
  cEnum.length > 0 &&
  cEnum.every((l) => cap(l).uncaptured_scope === 'partial') &&
  cEnum.every((l) => l.declared_uncaptured?.completeness?.conditions?.roots_cover_c8 === false) &&
  cEnum.every((l) => l.declared_uncaptured?.scope?.unspecified_roots === 1);

// The control for the controls: `complete` must be REACHABLE, or `partial` is
// a constant and none of the above measures anything.
const reachable = bEnum.some((l) => cap(l).uncaptured_scope === 'complete');

say(`  A  leaves=${a.leaves.length}  enumerating=${aEnum.length}  naming an uncaptured artifact=${aNamed.length}`);
say(`  B  leaves=${b.leaves.length}  enumerating=${bEnum.length}  newest count=${A(cap(bLast).declared_uncaptured_count)}  scope=${A(cap(bLast).uncaptured_scope)}`);
say(`  C  leaves=${c.leaves.length}  enumerating=${cEnum.length}  scopes=${[...new Set(cEnum.map((l) => A(cap(l).uncaptured_scope)))].join(',') || '(none)'}`);
say('');
say(`  GATE      — an uncaptured artifact is NAMED, with a scope   : ${gate ? 'RAISED' : 'NOT RAISED'}`);
say(`  CONTROL 1 — nothing uncaptured is an EMPTY SET THAT IS THERE : ${control1 ? 'present and empty' : 'ABSENT or wrong — control fired'}`);
say(`  CONTROL 2 — untyped roots REFUSE to claim closure            : ${control2 ? 'closure refused' : 'NOT refused — control fired'}`);
say('  REACHABLE — `complete` occurs at least once                  : ' +
  (reachable ? 'yes' : 'NO — `partial` is a constant and nothing above measures anything'));
say('');
const pass = gate && control1 && control2 && reachable;
say(pass
  ? 'RESULT: GATE PASSED — the set names what was missed, an empty set is present, and a deployment that cannot have closure does not claim one.'
  : 'RESULT: GATE FAILED.');
process.exit(pass ? 0 : 1);
