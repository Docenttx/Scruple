// Does the shipped better-sqlite3 PREBUILD actually load under Electron 38 on
// this machine, with no C++ toolchain present?
//
// WO-G1's report states the finding G3 cares about: "the travel laptop needs no
// build toolchain", because better-sqlite3@13 ships N-API prebuilds. The
// prebuilds do ship — `prebuilds/win32-x64.node` is in the tarball. What is not
// established by that is whether the binary loads in Electron's runtime, which
// is the only thing the app actually needs. A prebuild that ships and does not
// load would leave the claim technically true and practically false.
//
//   electron sqlite-load-check.cjs      (ELECTRON_RUN_AS_NODE=1)

const path = require('node:path');
const Module = require('node:module');

const req = Module.createRequire(path.join(__dirname, 'app-legacy', 'anything.js'));

const report = { electron: process.versions.electron || null, node: process.versions.node, modules: process.versions.modules };

try {
  const Database = req('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(a INTEGER, b TEXT)');
  db.prepare('INSERT INTO t VALUES (?, ?)').run(42, 'forty-two');
  const row = db.prepare('SELECT a, b FROM t').get();
  report.loaded = true;
  report.roundTrip = row;
  report.sqlite = db.prepare('select sqlite_version() v').get().v;
  // The exact API surface app-legacy/database.js uses.
  report.api = ['prepare', 'get', 'run', 'all', 'exec', 'pragma', 'close']
    .map((m) => `${m}:${typeof (db[m] ?? db.prepare('SELECT 1')[m]) === 'function'}`)
    .join(' ');
  report.bindingPath = req.resolve('better-sqlite3');
  db.close();
} catch (e) {
  report.loaded = false;
  report.error = String(e.message).split('\n')[0];
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.loaded ? 0 : 1);
