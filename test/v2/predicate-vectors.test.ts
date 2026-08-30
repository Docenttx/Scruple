// The shared predicate vectors are CURRENT — or this fails.
//
// test/vectors/vendor-baseline-predicate-vectors.json is generated from
// lib/envelope/predicate.ts and consumed by the Python implementation in
// packages/scruple-host-sdk/scruple_host_sdk/envelope.py. That only works
// while the committed file matches what the TypeScript emits today, so this
// regenerates it in memory and compares.
//
// The failure mode this closes is specific and quiet: someone changes the
// TypeScript predicate, the TypeScript tests still pass (they test the
// TypeScript), the vectors file is stale, and the PYTHON tests also still
// pass — against yesterday's contract. Neither suite fails and the two
// implementations have diverged. Exactly the shape
// test/vectors/ratchet-vectors.json exists to prevent for the key schedule.
//
// Fix on failure: `npm run gen:predicate-vectors`, then re-run the Python
// suite, because a regenerated file is a changed contract and the other
// implementation is entitled to disagree with it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const VECTORS = path.join(process.cwd(), 'test', 'vectors', 'vendor-baseline-predicate-vectors.json');

describe('scruple-vendor-baseline shared vectors', () => {
  test('the committed vectors are what the generator emits today', () => {
    const committed = fs.readFileSync(VECTORS, 'utf8');

    // Regenerate into a scratch copy rather than over the real one: a test
    // that repairs the artifact it is checking cannot fail twice, and the
    // second run would pass silently after the first "failed".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-predvec-'));
    const scratch = path.join(dir, 'out.json');
    try {
      fs.copyFileSync(VECTORS, scratch);
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-predicate-vectors.mjs'], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
      const regenerated = fs.readFileSync(VECTORS, 'utf8');
      fs.writeFileSync(VECTORS, committed);
      assert.equal(
        regenerated,
        committed,
        'test/vectors/vendor-baseline-predicate-vectors.json is stale. The Python predicate ' +
          'implementation is checked against it, so a stale file means the two languages are ' +
          'agreeing about different things. Run `npm run gen:predicate-vectors` and re-run ' +
          '`npm run test:sdk`.',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every placement x attestation cell is present, including the three refusals', () => {
    const doc = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    assert.equal(doc.assurance_table.length, 12);
    const refused = doc.assurance_table.filter((c: { leaf: string | null }) => c.leaf === null);
    // All three unattested-client cells and nothing else — including the
    // one holding a genuine root-verified quote. If this number ever
    // drops, something has learned to lift the placement the model exists
    // to refuse.
    assert.equal(refused.length, 3);
    for (const c of refused) {
      assert.equal(c.placement, 'unattested-client');
      assert.equal(c.can_claim, false);
    }
  });
});
