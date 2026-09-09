15:58:16Z  E series start
15:58:19Z  sandbox witness=up surrogate=up app=200
15:58:19Z  START  WO-E1
17:24:30Z  WO-E1 RED demonstrated at parent caf7bc4 in a worktree: the route
           answered ok:true / http 200 / kms-http and the manifest read
           ['claimSignature.mismatch','signingCredential.untrusted'],
           get_validation_state()=Invalid.
17:24:30Z  ⚑ found on the way: stage 2's "no output asset" probe searched the
           GATE shell's TMPDIR, not the app's, so its zero meant nothing. Now
           read from the captured app environment and calibrated in stage 1,
           where an asset certainly is written — uncalibrated it read 0 there
           too, calibrated it reads 1. An uncalibrated control is not a
           control. /data/scruple-web 2420608.
17:24:30Z  suites: services/c2pa-signer 134 pass (118 before, 16 new),
           v2 863/863, conformance 47/47, integration 19/19, cvm-surrogate
           13/13, tsc clean.
17:24:30Z  ⚑ not covered: real OCI `vault` mode is unexercised — same callback,
           but inference not measurement; and the guard proves the certificate
           carries the signing key, NOT that c2pa-rs will accept the
           certificate (cert.cnf records a second cause of the same
           claimSignature.mismatch). docs/WO-E1.md "What this does NOT buy".
17:24:30Z  DONE   WO-E1  gate 4 pass / 0 fail  server=ae89b7f
