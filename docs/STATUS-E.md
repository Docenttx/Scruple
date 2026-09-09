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
17:46:30Z  DONE   WO-E2  (72m)  desktop=f07064d web=634c66e
17:46:30Z  START  WO-E3
18:20:38Z  DONE   WO-E3  (34m)  desktop=8590948 web=634c66e
18:20:38Z  START  WO-E4
19:05:00Z  WO-E4 RED demonstrated by building the addon zip at the parent of
           the commit that added adapter/host_hook.py and installing it into a
           Blender of its own: declaration_exists=false, host_announce absent
           (`RAISED: … could not be found`), announce_exists=false — GREEN on
           all three after, on the same Blender 4.2.23.
19:05:00Z  ⚑ found BEFORE changing anything: the scratch app database was one
           migration behind the server tree. 059_declared_uncaptured.sql
           (WO-E2, 17:43) had never been applied and :3902 is `next dev`, so
           every leaf submission answered 500 and WO-D6's own scenario failed
           11 assertions with `no iteration row` and queueDepth 2. D6's gate
           had been silently red since 17:43 and NOTHING IN ANY GATE APPLIES
           MIGRATIONS. Finding E4-0, docs/WO-E4.md.
19:05:00Z  ⚑ E4-2: hostAdapterSink's schema check is presence-only in BOTH
           languages (`k not in evidence`), so a required field present and
           NULL is accepted, hashed and put in the MAC — a leaf reading
           `supplied` with a null camera. NOT patched: the gate is not this
           WO's to change. The addon refuses to emit such a document instead.
           The next host to register hits this with nothing in between.
19:05:00Z  ⚑ E4-4: adapter/scene.py reported CYCLES' sample count for EEVEE
           renders — scene.cycles exists on every scene whatever the engine
           is, so a 4.2.23 default scene announced samples: 4096. Fixed at the
           source; it was riding in the standalone blender_render workflow
           dict too.
19:05:00Z  suites: addon 330 passed (306+2 failed on arrival → 308 after
           re-vendoring at web 634c66e, closing E3-4, → 330 with +22 new);
           d2-gate PASSED, d4-gate PASSED, d6's two scenarios PASSED as
           stage 8; npm run e3 re-run against the new zip with no change in
           its verdict.
19:05:00Z  ⚑ not covered: no render happened and no bridge was involved — E6
           owns both. The announcement is bound to the artifact by the
           prompt_id and nothing else (E4-5), and the host's RESOLVED
           placement is still not on the leaf, so `blender` (honest) and
           `phantom-cam` (degraded) produce indistinguishable leaves (E4-6).
           Every Blender measurement is on an emulated CPU (E3-2).
19:05:00Z  DONE   WO-E4  gate 9 stages pass / 0 fail  addon=47bc3d6
