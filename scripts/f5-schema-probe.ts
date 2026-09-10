// WO-F5 — `schemaState()` asked directly, on the four answers it can give.
//
// The HTTP stages of the gate prove the refusal reaches the wire. This one
// proves the two DON'T-KNOW answers are refusals rather than passes, which no
// HTTP probe can show without a server whose migrations directory is broken —
// and a broken directory is exactly the thing you cannot arrange by accident on
// a server that is already running.
//
//   bash scripts/tsx.sh scripts/f5-schema-probe.ts --db PATH --tree PATH
//
// Prints one JSON object per case on stdout. Every case names the ROOT it was
// asked under, because "which tree did it read" is the question a wrong answer
// here would turn on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const DB = arg('--db')!;
const TREE = arg('--tree')!;

// The module reads SCRUPLE_DB_PATH at import time (lib/db/sqlite.ts), so the
// import happens after the environment is set, once, and every case below runs
// against the same connection — which is also how a server sees it.
process.env.SCRUPLE_DB_PATH = DB;

async function main() {
  const out: unknown[] = [];
  const run = async (label: string, root: string) => {
    process.env.SCRUPLE_REPO_ROOT = root;
    const { schemaState } = await import('@/lib/db/schemaGuard');
    const s = schemaState();
    out.push({
      case: label,
      root,
      current: s.current,
      reason: s.reason,
      pending_count: s.pending.length,
      pending: s.pending,
      on_disk: s.onDisk,
      dir: s.dir,
    });
  };

  await run('tree-matches-database', TREE);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-empty-'));
  fs.mkdirSync(path.join(empty, 'lib', 'db', 'migrations'), { recursive: true });
  await run('migrations-directory-is-empty', empty);

  await run('migrations-directory-does-not-exist', path.join(empty, 'no-such-tree'));

  // And the pending case, so the four answers are all measured by one probe:
  // a tree with one more file in it than the database has ever seen.
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-extra-'));
  const dir = path.join(extra, 'lib', 'db', 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(path.join(TREE, 'lib', 'db', 'migrations'))) {
    fs.copyFileSync(path.join(TREE, 'lib', 'db', 'migrations', f), path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, '999_f5_probe.sql'), '-- a file the database has never seen\n');
  await run('tree-has-a-file-the-database-has-not', extra);

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

void main();
