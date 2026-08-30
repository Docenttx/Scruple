// Guards Path B — Kohya (docs/canon/STUDIO_P1-P8_GRADE.md) against the
// exact failure the grade found: a checkpoint save reported as
// witnessed when no witness leaf was ever created, and a pod-hook
// docstring that told operators the opposite of what the code does.
//
// Two kinds of check, mirroring the drift-guard style used by
// services/c2pa-signer/tests/test_assertion_contract.py and
// packages/scruple-attestation-verifiers/src/status.test.ts (both scan
// source for a forbidden claim rather than only exercising behavior):
//
//   1. Behavioral — POST a validly-signed checkpoint through the real
//      route handler and assert the response tells the truth.
//   2. Source-scanning — the route must never hardcode `witnessed:
//      true`, and the pod-hook docstrings operators actually read must
//      not claim a leaf gets signed.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SCRUPLE_DB_PATH must be set BEFORE lib/db/sqlite is loaded — it reads
// the path at module scope. The test runner sets one shared path for
// every file matched by `test/v2/*.test.ts` (see the `test:v2` npm
// script). If it is unset we refuse to run rather than quietly
// migrating the real database.
if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error(
    'Refusing to run: set SCRUPLE_DB_PATH to a throwaway path first. ' +
      'Use `npm run test:v2`.',
  );
}

// That shared path is one sqlite FILE used by every test file in this
// run, and node's test runner executes files concurrently — concurrent
// `runMigrations()` calls against a single sqlite file race (observed:
// intermittent SQLITE_ERROR / cancelled tests once this file joined
// auth.test.ts as a second DB-touching suite). Give this file its own
// private db instead of sharing the inherited one. Modules that read
// SCRUPLE_DB_PATH at import time (lib/db/sqlite, and anything that
// imports it) must be imported AFTER this reassignment, via dynamic
// import — a static import hoists above this line and would still see
// the shared path.
const PRIVATE_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kohya-honesty-'));
process.env.SCRUPLE_DB_PATH = path.join(PRIVATE_DB_DIR, 'kohya-honesty.db');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

// The route reads this at request time (not at import time), so it is
// safe to set here even though the module is imported below.
process.env.SCRUPLE_APPS_WITNESS_SECRET =
  process.env.SCRUPLE_APPS_WITNESS_SECRET || 'test-secret-kohya-honesty';
const SECRET = process.env.SCRUPLE_APPS_WITNESS_SECRET;

// tsx compiles this file to CJS, which cannot use top-level await, so
// the actual dynamic import happens inside `before()` below — these
// are populated there before any test runs.
let runMigrations: typeof import('../../lib/db/migrate').runMigrations;
let conn: typeof import('../../lib/db/sqlite').conn;
let POST: typeof import('../../app/api/apps/kohya/witness/route').POST;

function sign(rawBody: string): string {
  return crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

function makeSignedRequest(body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  return new Request('https://scruple.ai/api/apps/kohya/witness', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-scruple-signature': sign(raw),
    },
    body: raw,
  });
}

let sessionId: string;
let userId: string;

before(async () => {
  ({ runMigrations } = await import('../../lib/db/migrate'));
  ({ conn } = await import('../../lib/db/sqlite'));
  ({ POST } = await import('../../app/api/apps/kohya/witness/route'));

  runMigrations(false);
  userId = 'kohya-honesty-user';

  const now = new Date().toISOString();
  const projectInfo = conn()
    .prepare(
      `INSERT INTO projects
         (user_id, name, type, status, created_at, iteration_count, is_active, witnessed_count, is_archived)
       VALUES (?, 'kohya-honesty-project', 'training', 'unlocked', ?, 0, 1, 0, 0)`,
    )
    .run(userId, now);
  const projectId = projectInfo.lastInsertRowid as number;

  sessionId = crypto.randomUUID();
  conn()
    .prepare(
      `INSERT INTO app_sessions
         (id, user_id, app_id, backend, machine_id, endpoint_id, endpoint_url,
          signed_token, expires_at, status)
       VALUES (?, ?, 'kohya', 'runpod', 'test-machine', ?, 'https://pod.example', 'tok',
               datetime('now', '+1 hour'), 'active')`,
    )
    // endpoint_id carries the project id as a string — that is how the
    // route's own JOIN resolves the project (route.ts:116-124).
    .run(sessionId, userId, String(projectId));
});

after(() => {
  try {
    fs.rmSync(PRIVATE_DB_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('the Kohya witness route never claims witnessing it did not do', () => {
  test('a checkpoint save reports witnessed: false with a real reason', async () => {
    const req = makeSignedRequest({
      event: 'checkpoint_save',
      path: '/workspace/out/checkpoint-001.safetensors',
      output_hash: crypto.randomBytes(32).toString('hex'),
      header_hash: crypto.randomBytes(32).toString('hex'),
      size_bytes: 12345,
      structural_summary: { layer_count: 2, layers: [], metadata: {} },
      pod_id: 'pod-abc123',
      user_id: userId,
      app_id: 'kohya',
      session_id: sessionId,
      client_timestamp: Date.now() / 1000,
    });

    const res = await POST(req as any);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.ok, true, 'the checkpoint IS recorded — ok:true is correct on its own');
    assert.equal(
      body.witnessed,
      false,
      'this route never POSTs to the witness server, so no leaf exists — reporting ' +
        'witnessed:true here would be exactly the misreporting ' +
        'docs/canon/STUDIO_P1-P8_GRADE.md (Path B — Kohya) found',
    );
    assert.equal(typeof body.reason, 'string');
    assert.ok(
      body.reason.length > 10,
      'a bare boolean with no reason is not an honest answer either — see the `witnessed`/`reason` ' +
        'vocabulary in app/api/v2/witness/route.ts (D-8)',
    );
  });

  test('a bad signature is still rejected before any of this is reached', async () => {
    const raw = JSON.stringify({ event: 'checkpoint_save', session_id: sessionId, user_id: userId });
    const req = new Request('https://scruple.ai/api/apps/kohya/witness', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-scruple-signature': 'not-a-real-signature' },
      body: raw,
    });
    const res = await POST(req as any);
    assert.equal(res.status, 401);
  });
});

describe('source does not contradict the response (drift guard)', () => {
  const ROUTE_PATH = path.join(REPO_ROOT, 'app/api/apps/kohya/witness/route.ts');
  const ROUTE_SRC = fs.readFileSync(ROUTE_PATH, 'utf8');

  test('the route never hardcodes witnessed: true', () => {
    assert.ok(
      !/witnessed:\s*true/.test(ROUTE_SRC),
      'app/api/apps/kohya/witness/route.ts must never claim witnessed:true — it does not POST ' +
        'to the witness server (see docs/canon/WO-05-studio-comfyui-kohya.md §3.1). If a real ' +
        'witness call has been wired in (T-4), delete this assertion in the same commit and say so.',
    );
  });

  test('the route response includes witnessed and reason fields', () => {
    assert.match(
      ROUTE_SRC,
      /witnessed:\s*false/,
      'the response must explicitly report witnessed:false — omitting the field would let a ' +
        'caller assume ok:true means witnessed, which is the original bug',
    );
    assert.match(ROUTE_SRC, /reason:/, 'the response must explain why, not just report a boolean');
  });

  for (const hookRelPath of [
    'public/pod-hooks/kohya_safetensors_hook.py',
    'research/scruple-kohya-image/scruple_safetensors_hook.py',
  ]) {
    describe(hookRelPath, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, hookRelPath), 'utf8');

      test('does not claim scruple-web signs a leaf', () => {
        assert.ok(
          !/signs a leaf/i.test(src),
          `${hookRelPath} must not claim scruple-web "signs a leaf" — it records the checkpoint ` +
            `into training_runs/app_kohya_progress and the route reports witnessed:false. This is ` +
            `the exact misreporting docs/canon/STUDIO_P1-P8_GRADE.md (Path B — Kohya) found.`,
        );
      });

      test('plainly states checkpoints are recorded, not witnessed', () => {
        assert.match(
          src,
          /recorded,?\s+not\s+witnessed/i,
          `${hookRelPath} must plainly say checkpoints are recorded but not witnessed`,
        );
      });

      test('references the grade doc that documents the gap', () => {
        assert.match(
          src,
          /STUDIO_P1-P8_GRADE\.md/,
          `${hookRelPath} should point readers at docs/canon/STUDIO_P1-P8_GRADE.md for the full finding`,
        );
      });

      test('marks the two silent-failure modes as known gaps, not features', () => {
        assert.match(src, /KNOWN EVIDENTIARY GAP/i, `${hookRelPath} must label its silent-failure modes as gaps`);
      });
    });
  }

  test('the two hook copies are byte-identical', () => {
    const a = fs.readFileSync(path.join(REPO_ROOT, 'public/pod-hooks/kohya_safetensors_hook.py'), 'utf8');
    const b = fs.readFileSync(
      path.join(REPO_ROOT, 'research/scruple-kohya-image/scruple_safetensors_hook.py'),
      'utf8',
    );
    assert.equal(
      a,
      b,
      'the two pod-hook copies have drifted — you cannot baseline a file that ships in two ' +
        'versions (docs/canon/STUDIO_P1-P8_GRADE.md, Path B — Kohya, P2). Reconcile them to one ' +
        'canonical behavior, or make them byte-identical again and say why in both file headers.',
    );
  });
});
