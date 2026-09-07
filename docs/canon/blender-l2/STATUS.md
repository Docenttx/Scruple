# Overnight — Scruple for Blender to the L2 floor

Started 2026-09-07T08:10:50Z. Detached; survives disconnect.
Specs: `docs/wo/2026-09-07-blender-l2.md`

**Sandbox** — nothing here touches production:
- witness  http://127.0.0.1:5899  (scratch DB; prod :5799 is NEVER contacted)
- app      http://127.0.0.1:3902  (own distDir + DB; live :3001 is NEVER contacted)
- surrogate http://127.0.0.1:8799  (signs real ECDSA, SOFTWARE-backed — never record it as hardware)
- Blender  Color management: using fallback mode for management

08:10:51Z  sandbox: witness=up surrogate=up app=400
08:10:51Z  START  WO-B1
08:22:54Z  DONE   WO-B1  (12m)  commits=8
08:22:54Z  START  WO-B2
08:53Z  DONE   WO-B2  (30m)  commits=3
        lib/ deleted (12 modules); SDK vendored in vendor/ with per-file
        sha256 + source commit 4683e0a; suite 94 -> 176 passed; 4 controls
        demonstrated red and reverted; verified inside Blender 3.0.1 from
        the built zip (real render, content_hash == sha256sum on disk).
        Surfaced: inherited path resolution never appended the file
        extension, so every headless render went unwitnessed. Fixed
        against 7 rules measured from Blender.
08:49:34Z  DONE   WO-B2  (26m)  commits=11
08:49:34Z  START  WO-B3
09:12:57Z  DONE   WO-B3  (23m)  commits=12
09:12:57Z  START  WO-B4
09:47:25Z  DONE   WO-B4  (34m)  commits=14
09:47:25Z  START  WO-B5
09:50:08Z  START  WO-S1 (parallel, server+SDK)
10:14:40Z  DONE   WO-S1  (24m)
10:16:25Z  DONE   WO-B5  (29m)  commits=16
10:16:25Z  START  WO-B6
10:51:00Z  DONE   WO-B6  (34m)  commits=19
10:51:00Z  START  WO-B7
11:03Z  DONE   WO-B7  commits=20
        STATE.md written in the ADDON repo (docs/canon/blender-l2/STATE.md).
        Re-verified at close-out, from the shell: 7/7 artifacts re-hash,
        7/7 signatures verify against the published key (+2 controls each
        failing), 4/4 C2PA Valid and both tampered controls Invalid, the
        B4 gap still absent, prod witness DB untouched (mtime 09-02).
        NEW: the addon's SHIPPED SDK can carry an H-4 envelope — measured
        from vendor/ alone; gap 0,0,0 then a skipped counter -> gap 1.
        H-4 is UNWIRED, not impossible. Two false sentences in
        adapter/reconcile.py corrected, with a control test.
        🔴 A `next dev -p 3001` started at 10:15:54 by this run is still
        listening and logging into the scratch tree; it rebuilt
        /data/scruple-web/.next. Left running; founder call.
11:04:55Z  DONE   WO-B7  (13m)  commits=20
11:04:55Z  ALL WORK ORDERS COMPLETE
