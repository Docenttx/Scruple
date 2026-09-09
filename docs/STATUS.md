04:10:01Z  waiting for the council run to finish — it shares this sandbox
04:57:03Z  council run complete — starting
04:57:05Z  sandbox witness=up surrogate=up app=400
04:57:05Z  START  WO-D1
05:03:54Z  DONE   WO-D1  (6m)  head=c2625c4
05:03:54Z  START  WO-D2
05:18:37Z  DONE   WO-D2  (14m)  head=b532929
05:18:37Z  START  WO-D3
05:44:30Z  DONE   WO-D3  (25m)  head=2efb467
05:44:30Z  START  WO-D4
06:20:56Z  DONE   WO-D4  (36m)  head=fce1d16
06:20:56Z  START  WO-D5
07:01:01Z  WO-D5 gate passed — 38 checks, 0 failures; sweep clean (see .run/d5/gate.log)
07:01:30Z  DONE   WO-D5  (40m)  head=f452cc1
07:01:30Z  START  WO-D6
09:15:12Z  WO-D6 gate passed — both levels observable; blind/declined/supplied
           distinct on three real leaves; stage-1 controls RED before, GREEN after
           (see .run/d6-gate.log)
09:15:12Z  ⚑ found on the way: /api/v2/witness still allocated run_sequence with
           MAX+1 — the race migration 051 fixed in the OTHER door. One ComfyUI
           generation makes two concurrent observations, so it fired live.
           Fixed; canvas baseline re-recorded (server 4ee9370).
09:15:12Z  ⚑ found on the way: scripts/d5-gate.sh pinned its "RED before" to
           HEAD, which stopped being the pre-change tree the moment WO-D5
           committed. It passed once and was red on every re-run since. Both it
           and d6-gate.sh now resolve the before-tree from the commit that
           introduced the change.
09:15:12Z  gates re-run after the change: d1 d2 d3 d4 PASS, d5 PASS (after the
           fix above), d6 PASS. Server suites: v2 863/863, conformance 47/47,
           integration 19/19, host SDK 214 pass / 2 pre-existing red.
09:15:12Z  DONE   WO-D6  head=fcd5841  (server head=4ee9370)
08:24:36Z  DONE   WO-D6  (83m)  head=5314d00
08:24:36Z  START  WO-D7
09:36:52Z  WO-D7 gate passed — the whole flow in one app, one launch: launch ·
           gate · generate · vault · witness · receipt · C2PA. 27 checks, 6
           leaves, every artifact re-hashes, every receipt resolves, every
           basis `stale`, none `verified`. Table printed (see .run/d7-gate.log
           and docs/STATE.md §1).
09:36:52Z  ⚑ found on the way: the C2PA signer embeds `keys/signer.pem` — the
           certificate for the LOCAL key — even when SCRUPLE_C2PA_KMS_ENDPOINT
           makes it sign through the surrogate. It answers ok:true and
           c2pa.Reader answers `claimSignature.mismatch`: a credential nothing
           can verify, from a call that reported success. Worked around in the
           sandbox (scripts/d7-surrogate-cert.sh issues a cert for the
           surrogate's own public key); NOT fixed at the source, because the
           guard belongs in the server's signing path and affects Fusion too.
           docs/STATE.md §4.3 says so and names the fix.
09:36:52Z  ⚑ found on the way: two of this gate's own controls were wrong on
           their first run — the `verified` INSERT collided on
           UNIQUE(project_id, run_sequence) so the honest half failed for the
           wrong reason, and the surrogate-down control signed before the
           surrogate had stopped and then scored the result. Both fixed; the
           second now reports INCONCLUSIVE rather than passing or failing when
           it cannot stop the surrogate. docs/STATE.md §3.
09:36:52Z  ⚑ honest gaps, recorded not worked around: leaves in this sandbox are
           HMAC-sealed only (the scratch witness runs H-1 signing `disabled`),
           so `independently_verifiable: false`; a desktop artifact cannot earn
           a C2PA tier above `bare` because those bind to projects.scr_id, which
           only the retired lock routes set; the sign event's own audit leaf is
           not emitted here. All of them in docs/STATE.md §4.
09:58:40Z  ⚑ found on the way: WO-D7's vault fixture was named `training-vault`
           — the same name WO-D3's is — and scripts/d3-gate.sh's stage 2 picked
           its vault by globbing that NAME and taking the newest. So the D3
           ceiling control silently ran against a directory with no oversize
           file and reported NOT DEMONSTRATED. Renamed the D7 fixture, and
           d3-gate now selects a vault by the files the control needs rather
           than by what the directory is called, so the collision cannot recur.
           d1 d2 d4 d5 d6 PASS; d3 PASS after the fix.
10:12:30Z  suites re-run after the change: desktop d1 d2 d3 d4 d5 d6 d7 all
           PASS. Server (no code changed by this WO): v2 863/863, conformance
           47/47, integration 19/19, host SDK 214 pass / 2 pre-existing red
           (test_model_write.py, red before this WO started).
10:12:30Z  DONE   WO-D7  head=880ceee  — docs/STATE.md is the close-out
09:43:06Z  DONE   WO-D7  (78m)  head=22e0ef3
09:43:06Z  ALL WORK ORDERS COMPLETE
