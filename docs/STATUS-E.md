15:58:16Z  E series start
15:58:19Z  sandbox witness=up surrogate=up app=200
15:58:19Z  START  WO-E1
16:34:00Z  WO-E1 RED demonstrated at parent caf7bc4 in a worktree: the route
           answered ok:true / http 200 / kms-http and the manifest read
           ['claimSignature.mismatch','signingCredential.untrusted'],
           get_validation_state()=Invalid.
16:34:00Z  ⚑ found on the way: stage 2's "no output asset" probe searched the
           GATE shell's TMPDIR, not the app's, so its zero meant nothing. Now
           read from the captured app environment and calibrated in stage 1,
           where an asset certainly is written — uncalibrated it read 0 there
           too, calibrated it reads 1. An uncalibrated control is not a
           control. /data/scruple-web 2420608.
16:34:00Z  suites: services/c2pa-signer 134 pass (118 before, 16 new),
           v2 863/863, conformance 47/47, integration 19/19, cvm-surrogate
           13/13, tsc clean.
16:34:00Z  ⚑ not covered: real OCI `vault` mode is unexercised — same callback,
           but inference not measurement; and the guard proves the certificate
           carries the signing key, NOT that c2pa-rs will accept the
           certificate (cert.cnf records a second cause of the same
           claimSignature.mismatch). docs/WO-E1.md "What this does NOT buy".
16:34:00Z  DONE   WO-E1  gate 4 pass / 0 fail  server=ae89b7f
16:34:29Z  DONE   WO-E1  (36m)  desktop=69cf155 web=ae89b7f
16:34:29Z  START  WO-E2
17:04:00Z  WO-E2 settled the scope rule FIRST, in its own commit:
           /data/scruple-web 61b1138 docs/canon/DECLARED_UNCAPTURED.md, then
           634c66e the implementation. Round 5 §3 asked whether the set carries
           the scope it enumerated over; line 369 answered it; the doc makes
           that answer decidable — four closure conditions, a completeness
           result with its own source, and one place it reads the spec rather
           than transcribing it (§5, with the argument).
17:42:00Z  WO-E2 RED demonstrated at parent 61b1138 in a worktree: all 13
           distinct leaves carry scope=(ABSENT), the gate is NOT RAISED and
           BOTH controls fire. Red because the field does not exist, asserted
           as such — an inconclusive control is not a pass.
17:40:00Z  ⚑ found on the way: MUTANT 5 SURVIVED the first mutation sweep.
           "record the captured-set ledger BEFORE buildLeaf, so an artifact
           never names itself as uncaptured" was implemented and documented and
           NOT ASSERTED. Fixed with a test, not a code change; all six mutants
           now die in the right places. docs/WO-E2.md.
17:42:00Z  suites: v2 912/912 (was 863, +49 new), conformance 47/47,
           integration 19/19, host SDK 214 passing with the same 2 pre-existing
           test_model_write.py failures, tsc clean.
17:45:00Z  ⚑ not covered: `uncaptured_scope_source` is `unknown` on EVERY leaf
           and stays so — Coder's round 5 fact (b) requires an INDEPENDENT
           observer of the history window and none exists; the blocker is a
           named constant, not a hardcode, and the tests drive both branches.
           `complete` is closure over what /history REPORTED, never over what
           the machine wrote. The captured-set ledger is process state and does
           not survive a component restart. One unreproduced watermark-chain
           flake, recorded rather than explained. docs/WO-E2.md "What this does
           NOT buy".
17:43:00Z  DONE   WO-E2  gate 8 pass / 0 fail  server=634c66e
17:46:00Z  DONE   WO-E2  (72m)  desktop=3ecad6a web=634c66e
