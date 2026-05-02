import fs from 'node:fs';
import path from 'node:path';
import { conn } from './sqlite';

const MIGRATIONS_DIR = path.join(process.cwd(), 'lib', 'db', 'migrations');

export function runMigrations(verbose = false): { applied: string[]; skipped: string[] } {
  const db = conn();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set<string>(
    db.prepare('SELECT filename FROM _migrations').all().map((r: any) => r.filename),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    if (verbose) console.log(`[migrate] applying ${file}…`);
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    });
    tx();
    newlyApplied.push(file);
    if (verbose) console.log(`[migrate] applied ${file}`);
  }

  return { applied: newlyApplied, skipped };
}
