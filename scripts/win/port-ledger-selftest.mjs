// Can the `port-ledger` assertion kind still say NO?
//
// ⚑ WHY THIS EXISTS. On Windows there is no `/proc`, so every real run takes
// the `unavailable` arm of `scorePortLedger` and passes. A green `comfy-generate`
// on this machine therefore says nothing about whether the kind can still fail —
// and a check that cannot fail is exactly what this project keeps catching.
// So the decision table is driven directly, with the failing cases named first.
//
//   node scripts/win/port-ledger-selftest.mjs
//
// Every case declares the answer it must get. The suite fails if ANY case
// disagrees, including — especially — the ones that must come back false.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { scorePortLedger } = createRequire(import.meta.url)(join(REPO, 'app', 'port-ledger-assert.js'));

const MEASURED = { state: 'measured', reasonCode: null, count: 1, allOwnedByExpected: true, allLoopback: true };
const UNAVAILABLE = {
  state: 'unavailable',
  reasonCode: 'no_proc_net_tcp',
  reason: '/proc/net/tcp does not exist on win32',
  count: null,
  allOwnedByExpected: null,
  allLoopback: null,
};

const CASES = [
  // ── The ones that MUST fail. These are the point of the file. ────────────
  {
    name: 'measured but the count is wrong',
    side: { ...MEASURED, count: 2 }, field: 'count', expected: 1, want: false,
  },
  {
    name: 'measured, and the upstream is NOT loopback-only — H-4 §2',
    side: { ...MEASURED, allLoopback: false }, field: 'allLoopback', expected: true, want: false,
  },
  {
    name: 'measured, and the port is held by someone else',
    side: { ...MEASURED, allOwnedByExpected: false }, field: 'allOwnedByExpected', expected: true, want: false,
  },
  {
    name: '⚑ unavailable, but a value came with it — that is a DEFAULT',
    side: { ...UNAVAILABLE, allLoopback: true }, field: 'allLoopback', expected: true, want: false,
  },
  {
    name: '⚑ unavailable with no reasonCode — not an answer',
    side: { ...UNAVAILABLE, reasonCode: null }, field: 'count', expected: 1, want: false,
  },
  {
    name: '⚑ unavailable with an empty reasonCode',
    side: { ...UNAVAILABLE, reasonCode: '' }, field: 'count', expected: 1, want: false,
  },
  {
    name: '🔴 refused is NOT a pass',
    side: { state: 'refused', reasonCode: 'eacces', count: null, allLoopback: null }, field: 'count', expected: 1, want: false,
  },
  {
    name: 'no state at all',
    side: { count: 1 }, field: 'count', expected: 1, want: false,
  },
  { name: 'no side (the step returned nothing)', side: null, field: 'count', expected: 1, want: false },
  { name: 'a string where a side should be', side: 'gate', field: 'count', expected: 1, want: false },
  {
    name: 'measured, field absent — undefined must not equal an expectation',
    side: { state: 'measured', reasonCode: null }, field: 'count', expected: 1, want: false,
  },
  {
    name: 'a truthy-but-different value does not satisfy a strict expectation',
    side: { ...MEASURED, count: '1' }, field: 'count', expected: 1, want: false,
  },

  // ── The ones that must pass. ─────────────────────────────────────────────
  { name: 'measured and correct — count', side: MEASURED, field: 'count', expected: 1, want: true },
  { name: 'measured and correct — loopback', side: MEASURED, field: 'allLoopback', expected: true, want: true },
  { name: 'measured and correct — ownership', side: MEASURED, field: 'allOwnedByExpected', expected: true, want: true },
  {
    name: 'unavailable, with a reason, reporting nothing — the Windows case',
    side: UNAVAILABLE, field: 'count', expected: 1, want: true,
  },
  {
    name: 'unavailable, with a reason, reporting nothing — loopback',
    side: UNAVAILABLE, field: 'allLoopback', expected: true, want: true,
  },
];

let failed = 0;
for (const c of CASES) {
  const got = scorePortLedger(c.side, c.field, c.expected);
  const ok = got.pass === c.want;
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  want=${String(c.want).padEnd(5)} got=${String(got.pass).padEnd(5)}  ${c.name}` +
    (ok ? '' : `\n        detail: ${JSON.stringify(got.detail)}`),
  );
}

const mustFail = CASES.filter((c) => !c.want).length;
console.log(
  `\n${CASES.length} case(s), ${mustFail} of which must come back false. ` +
  (failed ? `${failed} DISAGREED.` : 'All agreed.'),
);

if (failed) process.exit(1);

// A suite of only-passing cases would be the thing this file exists to prevent.
if (mustFail === 0) {
  console.error('this self-test declares no failing case and therefore proves nothing');
  process.exit(2);
}
