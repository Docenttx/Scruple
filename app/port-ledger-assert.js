/**
 * port-ledger-assert.js — score one side of the port ledger, three-valued.
 *
 * WO-D5's rule is that a host fact is `measured`, `unavailable` or `refused`,
 * never a plausible default and never a missing field. `app/comfy/ports.js`
 * obeys it: on a host with no `/proc` it reports `state: 'unavailable'` with a
 * reason code and leaves `count` / `allOwnedByExpected` / `allLoopback` null.
 *
 * The ASSERTIONS did not obey it. They were `equals ${…ledger.gate.count} 1`,
 * which can only say "measured, and wrong" — a different and much stronger
 * claim than "this host cannot see its own listening sockets".
 *
 * 🔴 AND LOOSENING THEM TO "PASS WHEN NULL" WOULD BE WORSE THAN LEAVING THEM
 * BROKEN. `upstream-is-loopback-only` is H-4 §2's "the only route to the
 * tenant" — a ComfyUI on 0.0.0.0 is reachable without passing the gate and
 * every byte taken that way has no leaf. An assertion that passes on null would
 * go on passing if the ledger silently stopped measuring on Linux too, which is
 * the exact shape of the five vacuous controls this project has already caught.
 *
 * So this is a decision table with three outcomes and no fourth:
 *
 *   measured     → the field must equal `expected`
 *   unavailable  → there must be a `reasonCode`, AND the field must be null.
 *                  A side that says it could not measure while still reporting
 *                  a value has DEFAULTED, and that is the defect being refused.
 *   anything else → fail. `refused` in particular is not a pass: being denied
 *                  the read is a finding about the deployment.
 *
 * ⚑ IT IS A MODULE SO IT CAN BE TESTED. The table is the load-bearing part and
 * `scripts/win/port-ledger-selftest.mjs` drives every branch, including the
 * ones that MUST fail — because on Windows every real run takes the
 * `unavailable` branch, so a green suite here proves nothing about whether this
 * can still say no.
 */

'use strict';

/**
 * @param {unknown} side     one side of the ledger — `ledger.gate` or `ledger.upstream`
 * @param {string}  field    'count' | 'allOwnedByExpected' | 'allLoopback'
 * @param {unknown} expected what a measuring host must report
 * @returns {{pass: boolean, detail: object}}
 */
function scorePortLedger(side, field, expected) {
  if (!side || typeof side !== 'object') {
    return { pass: false, detail: { why: 'no ledger side at that path', side } };
  }

  const value = side[field];

  if (side.state === 'measured') {
    return { pass: value === expected, detail: { state: side.state, field, actual: value, expected } };
  }

  if (side.state === 'unavailable') {
    const hasReason = typeof side.reasonCode === 'string' && side.reasonCode.length > 0;
    const noValue = value === null;
    return {
      pass: hasReason && noValue,
      detail: {
        state: side.state,
        field,
        reasonCode: side.reasonCode ?? null,
        reason: side.reason ?? null,
        value,
        why: !hasReason
          ? 'unavailable without a reasonCode is not an answer'
          : (!noValue ? 'unavailable, but a value was still reported — that is a default' : undefined),
      },
    };
  }

  return {
    pass: false,
    detail: {
      state: side.state ?? null,
      field,
      why: side.state === 'refused'
        ? 'the read was REFUSED — a finding about this deployment, not a pass'
        : 'the ledger side declares no state',
    },
  };
}

module.exports = { scorePortLedger };
