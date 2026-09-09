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

