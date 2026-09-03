// WO-62/63/64 — three honest states, and a response is not a witness.
//
// WO-27 settled the rule once, for input_hash: bind it, or decline; never
// assert an empty set. It was applied in exactly one place. These are the
// other places.
//
// Against the L2 floor this is H-5 — two-tier assurance, the one item marked
// implemented: a record declares what actually backed it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}

const ingestSrc = fs.readFileSync(path.join(process.cwd(), 'lib/iterations/ingest.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(process.cwd(), 'lib/db/migrations/050_measurement_provenance.sql'),
  'utf8',
);

describe('WO-62 — machine_manifest_hash records WHICH of three documents answered', () => {
  test('all four rungs are distinguishable, including "we do not know"', () => {
    for (const rung of ['container', 'caller', 'db-default', 'unavailable']) {
      assert.match(ingestSrc, new RegExp(`'${rung}'`), `rung ${rung} must be expressible`);
    }
    assert.match(migration, /ALTER TABLE iterations ADD COLUMN machine_manifest_source/);
  });

  test('the db-default rung is recorded as such and NOT as a measurement', () => {
    // The silent fallback is the defect: when the container manifest is
    // absent the ladder reaches "whichever machine row this user created most
    // recently" and the leaf still looked complete.
    assert.match(
      ingestSrc,
      /machineManifestSource = machineManifestHash \? 'db-default' : 'unavailable'/,
    );
    // MUST NOT FIRE — a db-default must never be labelled 'container'.
    assert.ok(
      !/machineManifestSource\s*=\s*'container'\s*;?\s*\n\s*.*mrow/.test(ingestSrc),
      'the DB lookup must not be able to claim the container measured it',
    );
  });

  test('the backfill refuses to guess rows it cannot know', () => {
    // A row with a stored container manifest was measured — the evidence sits
    // in the column beside it. Every other row keeps NULL, because it could
    // have come from rung 2 or rung 3 and the record does not say.
    assert.match(migration, /WHERE container_machine_manifest IS NOT NULL/);
    assert.ok(
      !/SET machine_manifest_source = 'db-default'/.test(migration),
      'backfilling a guess would destroy the only honest thing left about those rows',
    );
  });
});

describe('WO-63 — a failed measurement is not an empty one', () => {
  test('three states exist and unavailable is reachable', () => {
    for (const s of ['measured', 'none', 'unavailable']) {
      assert.match(ingestSrc, new RegExp(`'${s}'`));
    }
    // The distinguishing input: the runner's error. Without it, a read
    // failure and a genuinely model-free run are the same row.
    assert.match(ingestSrc, /modelFingerprintsError !== null\s*\n?\s*\? 'unavailable'/);
  });

  test('the runner ships the error rather than swallowing it', () => {
    const runner = fs.readFileSync(path.join(process.cwd(), 'modal/scruple_runner.py'), 'utf8');
    assert.match(runner, /model_fingerprints_error = str\(e\)\[:400\]/);
    assert.match(runner, /"model_fingerprints_error": model_fingerprints_error/);
  });
});

describe('WO-64 — a response is not a witness', () => {
  test('witnessed requires a signature and a witness_id, not merely a body', () => {
    // It was `witnessResult !== null`, so an HTTP 200 carrying `{}` marked the
    // leaf witnessed. The field the column is named after was never checked.
    assert.match(ingestSrc, /witnessResult\.signature\.length > 0/);
    assert.match(ingestSrc, /witnessResult\.witness_id\.length > 0/);

    // MUST NOT FIRE — the old predicate must be gone from the write path.
    assert.ok(
      !/witnessResult \? 1 : 0/.test(ingestSrc),
      'the truthiness test must not survive anywhere that decides witnessed',
    );
  });

  test('a signature-less response degrades loudly rather than silently', () => {
    assert.match(ingestSrc, /recording as UNWITNESSED/);
  });
});
