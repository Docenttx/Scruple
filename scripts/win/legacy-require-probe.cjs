// Can `app-legacy/main-modular.js` be loaded at all?
//
// WO-G1 is written on the hypothesis that the legacy app needs "wire it back up
// and fix what the console says", and `docs/G-SERIES-REPORT.md` §2 says
// `app-legacy/` "contains the product". This probe tests the load step that
// happens BEFORE any of that — the module-level `require`s at the top of
// `main-modular.js`, which run before `app.whenReady()` and before a window
// exists.
//
//   electron scripts/win/legacy-require-probe.cjs
//
// VERIFY BY SIDE EFFECT, AND NAME THE CONTROL. Each of `main-modular.js`'s own
// module-level requires is resolved individually and reported. The CONTROL is
// the set of requires that MUST resolve — `./database`, `./context`,
// `./config/config-testnet`, `./lock/merkle`, `./ipc/ipc-barrel`. If those fail
// too, then something about this probe or this checkout is broken and the
// failures below say nothing about `capture/` specifically. A finding here is
// only a finding if the control requires resolve.
//
// Resolution only — nothing is executed. `require.resolve` answers "is this
// module findable", which is the question, and avoids running a wallet or
// opening a database as a side effect of asking it.

const path = require('node:path');
const Module = require('node:module');

const LEGACY = path.join(__dirname, '..', '..', 'app-legacy');
const ENTRY = path.join(LEGACY, 'main-modular.js');

// Exactly the module-level requires in main-modular.js, in source order.
// `electron` and the node builtins are omitted: they are not the question.
const REQUIRES = [
  { spec: './capture/comfyui/session', line: 23, control: false },
  { spec: './capture/comfyui/watcher', line: 24, control: false },
  { spec: './capture/comfyui/server', line: 25, control: false },
  { spec: './config/config-testnet', line: 26, control: true },
  { spec: './database', line: 27, control: true },
  { spec: './lock/merkle', line: 28, control: true },
  { spec: './wallet/ravencoin/wallets-integration-native-testnet', line: 31, control: true },
  { spec: './capture/training/training-hasher', line: 45, control: false },
  { spec: './server/witness-index', line: 55, control: true },
  { spec: './context', line: 58, control: true },
  { spec: './lock/lock-barrel', line: 66, control: true },
  { spec: './capture/training/training-barrel', line: 72, control: false },
  { spec: './ipc/ipc-barrel', line: 75, control: true },
];

// Resolve each specifier the way `main-modular.js` itself would: relative to
// that file, with that file's own resolution paths.
function resolveAsEntry(spec) {
  const paths = Module._nodeModulePaths(LEGACY);
  return Module._resolveFilename(spec, {
    id: ENTRY,
    filename: ENTRY,
    paths,
  });
}

const rows = REQUIRES.map((r) => {
  let resolved = null;
  let code = null;
  try {
    resolved = resolveAsEntry(r.spec);
  } catch (e) {
    code = e && e.code ? e.code : String(e && e.message);
  }
  return { ...r, resolved, code, ok: resolved !== null };
});

const width = Math.max(...REQUIRES.map((r) => r.spec.length));
for (const r of rows) {
  const tag = r.ok
    ? (r.control ? 'CONTROL ok' : 'resolves')
    : (r.control ? 'CONTROL MISFIRED' : `⚑ ${r.code}`);
  console.log(
    `main-modular.js:${String(r.line).padStart(2)}  ${r.spec.padEnd(width)}  ` +
    `${r.ok ? 'FOUND  ' : 'MISSING'}  ${tag}`,
  );
}

const controlsOk = rows.filter((r) => r.control).every((r) => r.ok);
const missing = rows.filter((r) => !r.ok);

console.log('');
if (!controlsOk) {
  console.log(
    'INCONCLUSIVE — a control require also failed to resolve, so nothing here\n' +
    'can be attributed to `capture/`. Fix the checkout and re-run.',
  );
  process.exit(2);
}

if (missing.length === 0) {
  console.log('Every module-level require resolves. main-modular.js can be loaded.');
  process.exit(0);
}

console.log(
  `⚑ FINDING. ${missing.length} of ${rows.length} module-level requires do not resolve,\n` +
  `  and every one of them is under app-legacy/capture/. The ${rows.length - missing.length}\n` +
  '  control requires all resolved, so this is that directory and not the checkout.\n' +
  '\n' +
  `  Consequence: main-modular.js throws MODULE_NOT_FOUND at line ${missing[0].line},\n` +
  '  during module load — before app.whenReady(), before createWindow(), before any\n' +
  '  Electron API is touched. The legacy app cannot start on ANY Electron version,\n' +
  '  so "does it run on Electron 38" is not yet a question that can be asked.',
);

// Prove the consequence rather than predicting it: actually load the entry
// point and report what really comes out.
console.log('\n--- loading app-legacy/main-modular.js for real ---');
try {
  require(ENTRY);
  console.log('loaded without throwing (unexpected given the above)');
} catch (e) {
  console.log(`threw ${e.code || 'Error'}: ${String(e.message).split('\n')[0]}`);
  const req = /Cannot find module '([^']+)'/.exec(String(e.message));
  if (req) console.log(`the module it could not find: ${req[1]}`);
}

process.exit(0);
