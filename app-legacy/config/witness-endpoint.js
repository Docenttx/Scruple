/**
 * witness-endpoint.js — WO-G1. ONE resolver for "which witness are we talking to".
 *
 * WHY THIS FILE EXISTS
 *
 * The app as it stood on the Windows rig named `http://129.80.23.93:5799` in five
 * places. Four of them read `SCRUPLE_WITNESS_URL` first; the fifth
 * (`lock/executors/lock-executor-server.js`) did not, so setting the environment
 * variable moved four call sites and silently left one pointed at a LIVE witness.
 * That is not a configuration mistake anyone would catch by reading the env, and
 * a test rig writing test locks into a production audit log is not recoverable by
 * deleting them afterwards — an audit log's value is that nothing is deleted.
 *
 * So: one resolver, and it REFUSES rather than warns.
 *
 * A production witness is reachable only when the operator says so out loud, in
 * the environment, on purpose. There is deliberately no config-file key and no UI
 * toggle for this — a value you can set by clicking is a value you can set by
 * accident.
 */

'use strict';

// Endpoints that serve the real audit log. Host:port, normalised, no scheme.
const PRODUCTION_WITNESSES = [
  '129.80.23.93:5799',
  '127.0.0.1:5799',
  'localhost:5799',
  'witness.scruple.ai:443',
  'witness.scruple.ai',
];

// Where a developer or a test rig should be pointed instead: the CVM surrogate.
// It is SOFTWARE-backed, so a leaf it signs is `passthrough` or `stale` and never
// `verified` — which is the point. Nothing it produces can be mistaken for the
// real thing.
const DEFAULT_WITNESS_URL = 'http://127.0.0.1:8799';

function normalise(url) {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return String(url);
  }
}

function isProduction(url) {
  return PRODUCTION_WITNESSES.includes(normalise(url));
}

/**
 * The witness URL this process may use.
 *
 * @throws if the configured endpoint serves the production audit log and
 *         SCRUPLE_ALLOW_PRODUCTION_WITNESS is not exactly '1'.
 */
function witnessUrl() {
  const configured = process.env.SCRUPLE_WITNESS_URL || DEFAULT_WITNESS_URL;

  if (isProduction(configured) && process.env.SCRUPLE_ALLOW_PRODUCTION_WITNESS !== '1') {
    const err = new Error(
      `witness_endpoint_refused: ${configured} serves the production audit log. ` +
      `Set SCRUPLE_ALLOW_PRODUCTION_WITNESS=1 to mean it, or point ` +
      `SCRUPLE_WITNESS_URL at the surrogate (${DEFAULT_WITNESS_URL}).`
    );
    err.code = 'witness_endpoint_refused';
    throw err;
  }

  return configured;
}

/** For startup logging: what we resolved, and whether it is the real one. */
function describe() {
  const url = witnessUrl();
  return { url, production: isProduction(url) };
}

module.exports = { witnessUrl, describe, isProduction, DEFAULT_WITNESS_URL, PRODUCTION_WITNESSES };
