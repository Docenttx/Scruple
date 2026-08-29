# Overnight — Studio to full L2

An unattended investigation, running detached. It survives the session
disconnecting.

## Watch it

```
cat  docs/canon/studio-l2/STATUS.md      # phase progress
tail -f /tmp/studio-l2-phase.log         # live agent output
pgrep -af overnight-studio-l2            # is it still running
```

## Stop it

```
pkill -f overnight-studio-l2
```

## What it produces

| File | Phase |
|---|---|
| `01-leaf-signature.md` | Studio's leaves are unsigned — the cheapest L2 win, and the `/v2/verify` correctness bug it fixes |
| `02-watermark.md` | §9.2 into Studio. The hard question is whether watermarking happens before or after the leaf commits to the output hash |
| `03-c2pa.md` | Studio has never produced a manifest. How the asset reaches the signer, and which assertions it carries |
| `04-PLAN.md` | The merged implementation plan, folding in the relevant parts of WO-05 |

## Rules it runs under

**Read only.** No edits, no commits, no pushes. The output is analysis and
precise before/after descriptions, so a human reviews before anything lands.

**The surrogate, not the real CVM.** All signing work targets
`services/cvm-surrogate` at `127.0.0.1:8799`. The real Signer CVM stays
down.

**Never the production witness.** `WITNESS_SERVER_URL` is pinned to a dead
port and the prompts say so explicitly. On 2026-08-29 a local test run
wrote 9 rows into `/opt/scruple-witness/witness.db`, a live audit log,
because that variable defaults to the real service. The rows were removed
and the witness now refuses `tenant:`-prefixed project ids outright, but
the rail belongs here too — defence in depth for an unattended job.

`SCRUPLE_DB_PATH` also points at a scratch database.
