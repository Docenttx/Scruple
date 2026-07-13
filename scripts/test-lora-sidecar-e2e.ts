// E2E smoke — LoRA C2PA sidecar path.
//
// Verifies the full training-provenance chain of custody:
//   1. GET /api/projects/<id>/lora-sidecar.c2pa returns a valid .c2pa file
//      for a locked training project
//   2. The returned sidecar validates via scripts/verify-c2pa-reader.py
//      (state:Valid or state:Invalid with only benign codes)
//   3. Refuses to serve pre-lock projects with a 409
//   4. Refuses non-training projects with a 400
//   5. Refuses unknown project ids with a 404
//
// Prereqs:
//   - Dev server on SCRUPLE_TEST_URL (default http://localhost:3005)
//   - data/scruple.db has:
//       - a training-type project in a locked status (Project 181 default)
//       - a training-type project NOT yet locked (skipped if not present)
//       - a non-training project (any type='image' project works)

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const BASE = process.env.SCRUPLE_TEST_URL ?? 'http://localhost:3005';
const DB_PATH = process.env.SCRUPLE_DB_PATH || path.join(process.cwd(), 'data', 'scruple.db');
const VERIFIER = path.join(process.cwd(), 'scripts', 'verify-c2pa-reader.py');

let failures = 0;
function assert(cond: unknown, name: string, detail?: unknown): void {
  if (cond) {
    console.log(`  ok — ${name}`);
  } else {
    console.error(`  FAIL — ${name}`);
    if (detail !== undefined) console.error('         detail:', detail);
    failures++;
  }
}

async function main(): Promise<number> {
  console.log(`[lora-sidecar-e2e] BASE=${BASE} DB=${DB_PATH}`);

  const db = new Database(DB_PATH, { readonly: true });

  // Pick candidate projects from the current DB
  const lockedTraining = db
    .prepare(
      `SELECT id, name, status FROM projects
        WHERE type = 'training'
          AND status IN ('local_locked','chain_locked','persistent_locked','permanent_locked')
        ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; name: string; status: string } | undefined;

  const unlockedTraining = db
    .prepare(
      `SELECT id, name, status FROM projects
        WHERE type = 'training'
          AND status = 'unlocked'
        ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; name: string; status: string } | undefined;

  const nonTraining = db
    .prepare(
      `SELECT id, name, type FROM projects
        WHERE type != 'training'
        ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; name: string; type: string } | undefined;

  db.close();

  if (!lockedTraining) {
    console.error('FATAL — no locked training project in DB; nothing to test');
    return 2;
  }

  console.log(`\n[1] locked training project → sidecar served + validates`);
  console.log(`    project ${lockedTraining.id} (${lockedTraining.name}, ${lockedTraining.status})`);

  const url = `${BASE}/api/projects/${lockedTraining.id}/lora-sidecar.c2pa`;
  const resp = await fetch(url);
  assert(resp.status === 200, 'sidecar endpoint returns 200', { url, status: resp.status });
  assert(
    resp.headers.get('content-type') === 'application/c2pa',
    'Content-Type is application/c2pa',
    resp.headers.get('content-type'),
  );
  const disposition = resp.headers.get('content-disposition') ?? '';
  assert(
    disposition.startsWith('attachment; filename='),
    'Content-Disposition sets a filename',
    disposition,
  );

  const bytes = new Uint8Array(await resp.arrayBuffer());
  assert(bytes.length > 1000, 'sidecar has meaningful size', { bytes: bytes.length });
  assert(bytes.length < 100_000, 'sidecar under 100 KB cap', { bytes: bytes.length });

  const tmpPath = `/tmp/lora-sidecar-e2e-${lockedTraining.id}.c2pa`;
  writeFileSync(tmpPath, bytes);

  const verifyRun = spawnSync('python3', [VERIFIER, tmpPath], { encoding: 'utf-8' });
  console.log(`    verify-c2pa-reader.py: ${verifyRun.stdout.trim()}`);
  if (verifyRun.stderr.trim()) console.log(`    stderr: ${verifyRun.stderr.trim()}`);
  const verifyResult = verifyRun.stdout.trim()
    ? (JSON.parse(verifyRun.stdout.trim()) as { ok: boolean; validation_state: string; fatal_codes: string[] })
    : null;
  assert(verifyRun.status === 0, 'verifier exits 0 (no fatal codes)', verifyResult);
  assert(verifyResult?.ok === true, 'verifier reports ok=true', verifyResult);
  assert(
    verifyResult?.fatal_codes.length === 0,
    'no fatal validation codes',
    verifyResult?.fatal_codes,
  );

  unlinkSync(tmpPath);

  if (unlockedTraining) {
    console.log(`\n[2] unlocked training project → sidecar refuses with 409`);
    console.log(`    project ${unlockedTraining.id} (${unlockedTraining.name}, ${unlockedTraining.status})`);
    const r = await fetch(`${BASE}/api/projects/${unlockedTraining.id}/lora-sidecar.c2pa`);
    assert(r.status === 409, 'unlocked project returns 409', { status: r.status });
    const body = (await r.json()) as { error: string; current_status?: string };
    assert(
      /must be locked/i.test(body.error),
      'error message mentions locking requirement',
      body,
    );
  } else {
    console.log(`\n[2] SKIP — no unlocked training project in DB to test 409 path`);
  }

  if (nonTraining) {
    console.log(`\n[3] non-training project → sidecar refuses with 400`);
    console.log(`    project ${nonTraining.id} (${nonTraining.name}, type=${nonTraining.type})`);
    const r = await fetch(`${BASE}/api/projects/${nonTraining.id}/lora-sidecar.c2pa`);
    assert(r.status === 400, 'non-training project returns 400', { status: r.status });
  } else {
    console.log(`\n[3] SKIP — no non-training project in DB to test 400 path`);
  }

  console.log(`\n[4] unknown project id → sidecar refuses with 404`);
  const r = await fetch(`${BASE}/api/projects/999999999/lora-sidecar.c2pa`);
  assert(r.status === 404, 'unknown project returns 404', { status: r.status });

  console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c));
