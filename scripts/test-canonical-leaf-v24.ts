// Test — cross-language parity for canonicalLeafV24.
//
// Two modes:
//   * `pnpm exec tsx scripts/test-canonical-leaf-v24.ts` — verify against
//     the frozen expected values in the fixture.
//   * `pnpm exec tsx scripts/test-canonical-leaf-v24.ts --freeze` — recompute
//     and write expected values (used only on first build / rebase).
//
// See lib/witness/canonicalLeafV24.ts header for version-bump discipline.

import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalLeafV24,
  leafHashV24,
  chainHashV24,
} from '../lib/witness/canonicalLeafV24';

const FIXTURE_PATH = path.join(
  process.cwd(),
  'test',
  'fixtures',
  'canonical-leaf-v24-vectors.json',
);

interface Vector {
  name: string;
  input: Record<string, unknown>;
  expected_preimage?: string;
  expected_leaf_hash?: string;
  _note?: string;
}

interface ChainVector {
  name: string;
  prev_chain_hash: string;
  leaf_hash: string;
  expected_chain_hash?: string;
  _note?: string;
}

interface Fixture {
  _notes: string[];
  vectors: Vector[];
  chain_hash_vectors: ChainVector[];
}

const mode: 'verify' | 'freeze' = process.argv.includes('--freeze')
  ? 'freeze'
  : 'verify';

const fixture: Fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

let failures = 0;
let changed = false;

for (const v of fixture.vectors) {
  const preimage = canonicalLeafV24(v.input as never);
  const hash = leafHashV24(v.input as never);

  if (mode === 'freeze') {
    if (v.expected_preimage !== preimage || v.expected_leaf_hash !== hash) {
      v.expected_preimage = preimage;
      v.expected_leaf_hash = hash;
      changed = true;
    }
  } else {
    if (v.expected_preimage === undefined || v.expected_leaf_hash === undefined) {
      console.error(`[${v.name}] MISSING expected — run with --freeze`);
      failures++;
      continue;
    }
    if (preimage !== v.expected_preimage) {
      console.error(`[${v.name}] PREIMAGE MISMATCH`);
      console.error(`  expected: ${v.expected_preimage}`);
      console.error(`  got:      ${preimage}`);
      failures++;
    }
    if (hash !== v.expected_leaf_hash) {
      console.error(`[${v.name}] LEAF_HASH MISMATCH`);
      console.error(`  expected: ${v.expected_leaf_hash}`);
      console.error(`  got:      ${hash}`);
      failures++;
    }
  }
}

for (const c of fixture.chain_hash_vectors) {
  const computed = chainHashV24(c.prev_chain_hash, c.leaf_hash);
  if (mode === 'freeze') {
    if (c.expected_chain_hash !== computed) {
      c.expected_chain_hash = computed;
      changed = true;
    }
  } else {
    if (c.expected_chain_hash === undefined) {
      console.error(`[${c.name}] MISSING expected_chain_hash — run --freeze`);
      failures++;
      continue;
    }
    if (computed !== c.expected_chain_hash) {
      console.error(`[${c.name}] CHAIN_HASH MISMATCH`);
      console.error(`  expected: ${c.expected_chain_hash}`);
      console.error(`  got:      ${computed}`);
      failures++;
    }
  }
}

if (mode === 'freeze' && changed) {
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`[freeze] wrote expected values to ${FIXTURE_PATH}`);
} else if (mode === 'freeze') {
  console.log('[freeze] no changes needed');
}

if (mode === 'verify') {
  if (failures > 0) {
    console.error(`\nFAIL — ${failures} mismatch(es)`);
    process.exit(1);
  }
  console.log(
    `PASS — ${fixture.vectors.length} leaf vectors + ${fixture.chain_hash_vectors.length} chain vectors verified.`,
  );
}
