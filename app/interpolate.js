/**
 * interpolate.js — `${...}` resolution for scenario specs.
 *
 * Shared by the main-process scenario runner (which resolves a step's arguments
 * against the fixtures and the steps before it) and by scripts/desktop-run.mjs
 * (which resolves an assertion's operands against the same scope plus the
 * results the app returned). One implementation, because two would eventually
 * disagree about what `${steps.a.sha256}` means and the disagreement would look
 * like a failing assertion.
 *
 * A string that is EXACTLY one reference resolves to the referenced value with
 * its type intact — `"${steps.a.bytes}"` is the number 4096, not "4096" — so a
 * spec can assert on a byte count without the driver having to guess.
 * Anything else is substituted textually.
 *
 * An unresolvable reference throws. Silently producing `undefined` would turn a
 * typo in a spec into an assertion that compares undefined to undefined and
 * passes.
 */

'use strict';

const REF = /\$\{([^}]+)\}/g;
const WHOLE = /^\$\{([^}]+)\}$/;

function lookup(scope, expr) {
  const parts = expr.trim().split('.');
  let cur = scope;
  for (const part of parts) {
    if (cur === null || cur === undefined || !(part in Object(cur))) {
      throw new Error(`cannot resolve \${${expr}}: no "${part}"`);
    }
    cur = cur[part];
  }
  return cur;
}

function interpolate(value, scope) {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE);
    if (whole) return lookup(scope, whole[1]);
    return value.replace(REF, (_m, expr) => String(lookup(scope, expr)));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, scope);
    return out;
  }
  return value;
}

module.exports = { interpolate, lookup };
