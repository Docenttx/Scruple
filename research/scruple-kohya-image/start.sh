#!/usr/bin/env bash
# Scruple × Kohya-ss pod launcher — WO-KOHYA Phase 4.
#
# Runs Kohya-ss GUI headless on 0.0.0.0:7860. RunPod's proxy exposes
# that as https://<podId>-7860.proxy.runpod.net.

set -euo pipefail

# Sanity: confirm env from scruple-web (helps debugging)
echo "[scruple] SCRUPLE_USER_ID=${SCRUPLE_USER_ID:-<unset>}"
echo "[scruple] SCRUPLE_APP_ID=${SCRUPLE_APP_ID:-<unset>}"
echo "[scruple] SCRUPLE_SESSION_ID=${SCRUPLE_SESSION_ID:-<unset>}"
echo "[scruple] SCRUPLE_WITNESS_URL=${SCRUPLE_WITNESS_URL:-<unset>}"
# Presence only. Never echo the token itself into a log the tenant reads.
echo "[scruple] SCRUPLE_SESSION_TOKEN=${SCRUPLE_SESSION_TOKEN:+<set>}${SCRUPLE_SESSION_TOKEN:-<unset>}"
echo "[scruple] SCRUPLE_PLACEMENT=${SCRUPLE_PLACEMENT:-unattested-client} SCRUPLE_CAN_WITNESS=${SCRUPLE_CAN_WITNESS:-0}"
echo "[scruple] RUNPOD_POD_ID=${RUNPOD_POD_ID:-<unset>}"

cd /workspace/kohya_ss

# Kohya's --headless flag skips the browser open. --do_not_share
# disables Gradio's *.gradio.live tunnel (we're already exposed via
# RunPod's proxy — don't need two public URLs). --noverify skips
# self-check that hangs in some containerized envs.
exec python kohya_gui.py \
     --listen 0.0.0.0 \
     --server_port 7860 \
     --headless \
     --do_not_share \
     --noverify
