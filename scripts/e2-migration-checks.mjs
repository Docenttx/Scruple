// WO-E2 stage 4 — migration 059's cross-column CHECKs, exercised from the
// shell against a FRESH database, with no validator in the path.
//
// THE THIRD GUARD, ON ITS OWN. `lib/capture/declaredUncaptured.ts` stops the
// code being written, `captureClaims.ts` rule 8 stops the JSON arriving, and
// this stops any OTHER writer — present or future — that reaches the table
// through neither. A guard that is only ever reached through the two above it
// has never been shown to be a guard.
//
//   node scripts/e2-migration-checks.mjs <path to a migrated sqlite file>
import Database from 'better-sqlite3';

const db = new Database(process.argv[2]);
db.prepare(`INSERT INTO projects (id, user_id, name, created_at) VALUES (1, 1, ?, ?)`).run(
  'e2',
  new Date().toISOString(),
);

const st = db.prepare(`INSERT INTO iterations
  (project_id, run_sequence, timestamp, leaf_hash, output_hash, output_kind,
   uncaptured_enumeration_method, uncaptured_scope, uncaptured_scope_source,
   declared_uncaptured_count, declared_uncaptured_hash, declared_uncaptured)
  VALUES (1, ?, ?, ?, ?, 'image', ?, ?, ?, ?, ?, ?)`);

let n = 0;
const row = (...rest) => {
  n += 1;
  return [n, new Date().toISOString(), `lh${n}`, `oh${n}`, ...rest];
};

const CASES = [
  ['ACCEPT  the not_enumerated shape', true, ['none', 'not_enumerated', 'unknown', null, null, null]],
  ['REFUSE  not_enumerated carrying a count (CHECK 1)', false, ['none', 'not_enumerated', 'unknown', 0, 'ab', null]],
  // ⚑ THE EMPTY-SET RULE, IN SQL. Without CHECK 2 the two states this field
  // exists to distinguish — "looked and found nothing" and "did not look" —
  // are one NULL apart at the database.
  ['REFUSE  an enumerated scope with a NULL count (CHECK 2)', false, ['live_history', 'complete', 'unknown', null, 'ab', '{}']],
  ['ACCEPT  an enumerated scope with count 0', true, ['live_history', 'complete', 'unknown', 0, 'ab', '{}']],
  ['REFUSE  a scope claim with method none (CHECK 3)', false, ['none', 'partial', 'unknown', 2, 'ab', '{}']],
  ['REFUSE  a non-empty set with no document (CHECK 4)', false, ['live_history', 'partial', 'unknown', 2, 'ab', null]],
  ['REFUSE  a negative cardinality', false, ['live_history', 'partial', 'unknown', -1, 'ab', '{}']],
  // NULL is "the question was never asked of this leaf", and 057's and 058's
  // rule is that it is not backfilled into an answer nobody gave.
  ['ACCEPT  a legacy row: all NULL', true, [null, null, null, null, null, null]],
];

let bad = 0;
for (const [label, shouldAccept, args] of CASES) {
  let accepted = true;
  try {
    st.run(...row(...args));
  } catch {
    accepted = false;
  }
  const good = accepted === shouldAccept;
  if (!good) bad += 1;
  console.log(`   ${good ? 'ok  ' : 'FAIL'} ${label} -> ${accepted ? 'accepted' : 'refused'}`);
}
process.exit(bad === 0 ? 0 : 1);
