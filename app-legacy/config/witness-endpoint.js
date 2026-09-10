/**
 * witness-endpoint.js — WO-G1, revised on the founder's call. ONE resolver for
 * "which witness are we talking to", and it defaults to the real one.
 *
 * WHY THIS FILE EXISTS
 *
 * The app as it stood on the Windows rig named `http://129.80.23.93:5799` in five
 * places. Four of them read `SCRUPLE_WITNESS_URL` first; the fifth
 * (`lock/executors/lock-executor-server.js`) did not. So setting the environment
 * variable moved four call sites and silently left one pointed somewhere else —
 * you could read the config, believe the app was aimed at a test server, and
 * still be writing to production from the lock path.
 *
 * That is the bug this file closes, and it is the only one it closes. One
 * resolver, twelve call sites, one answer.
 *
 * ⚑ THE DEFAULT IS THE LIVE SERVER, DELIBERATELY.
 *
 * An earlier version of this file defaulted to the CVM surrogate and REFUSED
 * production unless an environment variable said otherwise. That was wrong, and
 * the founder's reasoning is the right reasoning: there are no real users yet, so
 * there is nothing to break, and testing against the real server is worth more
 * than protecting an audit log that has nothing in it to protect. A packaged app
 * that would not witness until somebody set an environment variable is not
 * cautious — it is broken, and it fails in the direction that loses a user's
 * evidence.
 *
 * ⚑ AND THIS HOST IS NOT ONLY THE WITNESS. The same server answers
 * `/api/stripe-config`, `/api/create-payment-intent` and the TSD balance routes.
 * Blocking it does not merely skip witnessing; it takes payments down with it.
 * That is a second reason a refusal here was the wrong shape.
 *
 * WHEN TO POINT IT SOMEWHERE ELSE
 *
 * `SCRUPLE_WITNESS_URL` moves every call site at once — which is what it always
 * claimed to do and now actually does. A gate that does not want its rehearsal
 * traffic on the real server sets it; nothing else needs to.
 */

'use strict';

//: The real one. Witness, Stripe and TSD all answer here.
const DEFAULT_WITNESS_URL = 'http://129.80.23.93:5799';

//: The CVM surrogate. SOFTWARE-backed, so a leaf it signs is `passthrough` or
//: `stale` and never `verified` — which is what makes it safe to rehearse
//: against and useless as evidence. Named here so a gate can reach for it
//: without spelling the port out again.
const SURROGATE_WITNESS_URL = 'http://127.0.0.1:8799';

//: Endpoints that serve the real audit log. Kept — not to refuse them, but so
//: `describe()` can SAY which one is in use. A log line naming the live server
//: is the cheap version of the protection this file used to enforce, and it
//: costs nobody anything.
const PRODUCTION_WITNESSES = [
  '129.80.23.93:5799',
  '127.0.0.1:5799',
  'localhost:5799',
  'witness.scruple.ai:443',
  'witness.scruple.ai',
];

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

/** The witness URL this process uses. */
function witnessUrl() {
  return process.env.SCRUPLE_WITNESS_URL || DEFAULT_WITNESS_URL;
}

/** For startup logging: what we resolved, and whether it is the real one. */
function describe() {
  const url = witnessUrl();
  return { url, production: isProduction(url) };
}

module.exports = {
  witnessUrl,
  describe,
  isProduction,
  DEFAULT_WITNESS_URL,
  SURROGATE_WITNESS_URL,
  PRODUCTION_WITNESSES,
};
