# Implementing the settled council design

Started 2026-09-09T01:40:58Z. Detached. Specs: `docs/wo/2026-09-09-council-implementation.md`
Sandbox: witness http://127.0.0.1:5899 · app http://127.0.0.1:3902 · surrogate http://127.0.0.1:8799
🔴 /opt/scruple-witness is NOT modified by any WO here. WO-C6 is plan-only.

01:40:58Z  sandbox witness=up surrogate=up app=400
01:40:58Z  START  WO-C1
02:17:30Z  DONE   WO-C1  (36m)  head=81d1661
02:17:30Z  START  WO-C2
02:44:10Z  DONE   WO-C2  (27m)  gate PASSED — see docs/canon/council-impl/WO-C2.md
02:43:33Z  DONE   WO-C2  (26m)  head=179f875
02:43:33Z  START  WO-C3
03:21:39Z  DONE   WO-C3        gate PASSED — see docs/canon/council-impl/WO-C3.md
03:22:12Z  DONE   WO-C3  head=0fd2d24
03:23:04Z  DONE   WO-C3  (39m)  head=abbc02d
03:23:04Z  START  WO-C4
03:52:10Z  DONE   WO-C4        gate PASSED — see docs/canon/council-impl/WO-C4.md
03:53:51Z  DONE   WO-C4  (30m)  head=d09b116
03:53:51Z  START  WO-C5
04:35:10Z  DONE   WO-C5        gate PASSED — see docs/canon/council-impl/WO-C5.md
2026-09-09T04:35:00Z  DONE   WO-C5  head=fcbfe91
04:35:35Z  DONE   WO-C5  (41m)  head=a8f91e2
04:35:35Z  START  WO-C6
05:00:00Z  DONE   WO-C6        gate PASSED — plan + vectors + runner; see docs/canon/council-impl/WO-C6.md
                  ⚑ WO-C6 does NOT lift the blocker. None of the 4 live Merkle
                  implementations passes the shared vectors; CHECKPOINT_VECTORS_SETTLED
                  stays false and every leaf keeps saying `stale`. Cutover = WO-C7,
                  and its step 6 is a /opt/scruple-witness deploy — founder only.
                  ⚑ Found on the way: npm run test:v2's glob silently excluded the new
                  test file (unanchored `grep -v conformance.test.ts`) — fixed, 818 now.
                  ⚑ 2 host-SDK tests are RED and were RED at HEAD before this WO
                  (proved on a clean worktree). Left red on purpose — see §10(b).
05:00Z  DONE   WO-C6  head=1bbd8b4
