#!/usr/bin/env node
/**
 * Refuse to run a gate against a database whose schema is behind the tree.
 *
 * WHY THIS EXISTS. WO-E2 added 059_declared_uncaptured.sql at 17:43 and nothing
 * applied it to the sandbox database. `next dev` does not migrate on boot, so
 * every leaf submission answered 500 — and WO-D6's gate reported ELEVEN FAILED
 * ASSERTIONS with `no iteration row`, which is the symptom and says nothing
 * about the cause. The gate was silently red for over an hour and the next work
 * order found it by accident (finding E4-0).
 *
 * ⚑ THE POINT IS NOT THAT MIGRATIONS GET APPLIED. It is that a schema failure
 * STOPS LOOKING LIKE A TEST FAILURE. A gate that applies migrations silently
 * would have fixed this morning's symptom and left the next one undiagnosable,
 * so the default here is to REFUSE and name the pending files; `--apply` is the
 * opt-in, and it re-checks afterwards rather than trusting its own write.
 *
 * The migrations directory is resolved from THIS FILE, never from cwd:
 * lib/db/migrate.ts uses `process.cwd()`, so it silently depends on being run
 * from the repo root, and a gate that cd's anywhere else gets a different
 * answer to the same question.
 *
 * Exit codes are distinct on purpose — a caller must be able to tell these
 * apart without parsing prose:
 *   0  schema matches the tree
 *   3  MIGRATIONS PENDING (and --apply was not given)
 *   4  the database could not be opened or read
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.SCRUPLE_REPO_ROOT ?? path.resolve(HERE, '..');
const MIGRATIONS_DIR = path.join(REPO, 'lib', 'db', 'migrations');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dbArg = argv.find((a) => a.startsWith('--db='));
const DB_PATH = dbArg ? dbArg.slice(5) : process.env.SCRUPLE_DB_PATH;

const say = (s) => process.stdout.write(`[preflight] ${s}\n`);

if (!DB_PATH) { say('FAIL no database: pass --db=PATH or set SCRUPLE_DB_PATH'); process.exit(4); }
if (!fs.existsSync(MIGRATIONS_DIR)) { say(`FAIL migrations dir not found: ${MIGRATIONS_DIR}`); process.exit(4); }

const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
if (onDisk.length === 0) { say(`FAIL no .sql files in ${MIGRATIONS_DIR} — a zero count here would read as "nothing pending"`); process.exit(4); }

let db;
try { db = new Database(DB_PATH); } catch (e) { say(`FAIL cannot open ${DB_PATH}: ${e.message}`); process.exit(4); }

function pending() {
  let applied = new Set();
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").get();
    if (t) applied = new Set(db.prepare('SELECT filename FROM _migrations').all().map((r) => r.filename));
  } catch (e) { say(`FAIL cannot read _migrations: ${e.message}`); process.exit(4); }
  return onDisk.filter((f) => !applied.has(f));
}

let missing = pending();
say(`db=${DB_PATH}`);
say(`migrations on disk=${onDisk.length}  pending=${missing.length}`);

if (missing.length === 0) { say('OK schema matches the tree'); process.exit(0); }

for (const f of missing) say(`  PENDING ${f}`);

if (!APPLY) {
  say('REFUSING — the schema is behind the tree. A gate run now would fail as');
  say('           assertion errors, not as a schema error. Re-run with --apply,');
  say('           or apply them yourself, then run the gate.');
  process.exit(3);
}

for (const f of missing) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
  try {
    db.transaction(() => {
      db.exec(sql);
      db.exec("CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(f);
    })();
    say(`  applied ${f}`);
  } catch (e) { say(`FAIL applying ${f}: ${e.message}`); process.exit(4); }
}

// Re-read rather than trust the writes above: the question is what the database
// says now, not what this process believes it did.
missing = pending();
if (missing.length !== 0) { say(`FAIL still ${missing.length} pending after --apply`); process.exit(4); }
say('OK schema matches the tree after applying');
process.exit(0);
