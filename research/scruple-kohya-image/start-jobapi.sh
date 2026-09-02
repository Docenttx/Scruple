#!/usr/bin/env bash
# Scruple × Kohya, JOB-API image launcher — WO-19.
#
# ---------------------------------------------------------------------------
# THE DIFFERENCE FROM start.sh IS THE WHOLE POINT
# ---------------------------------------------------------------------------
#
# start.sh runs `python kohya_gui.py --listen 0.0.0.0`. Gradio is not a form:
# kohya_gui/lora_gui.py builds an `accelerate launch ...` argv and runs it
# through subprocess.Popen, and common_gui.py::run_cmd_advanced_training
# appends whatever the tenant typed into the GUI's `additional_parameters` box
# to that argv. That box is a general injection point for --network_module,
# --dataset_class and --optimizer_type — three import paths. So the tenant has
# code execution in the container, the placement is `unattested-client`, and no
# leaf may be issued for anything observed inside it.
#
# RunPod did not do that. We did, by choosing what to expose. Pods run under
# OUR API key; RunPod gives the customer no console, no SSH and no exec.
#
# This script exposes the capture component instead. It accepts jobs through
# the whitelist in lib/apps/kohya/job-spec.ts — data and hyperparameters, never
# a command — and starts the trainer itself as a child.
#
# `exec` IS LOAD-BEARING. It replaces this shell so the component becomes
# PID 1, which is placement.ts's fifth obligation. If the component were a
# child instead, killing it would leave the container running with an
# unobserved trainer in it — a checkpoint written to a volume nobody is
# watching, which is NO LEAF FOR AN EVENT THAT HAPPENED
# (PLACEMENT_AND_SURFACES.md §2.2), the failure that is invisible rather than
# visible. As PID 1, the same act ends the container: the tenant can stop being
# witnessed, but not while continuing to train.
#
# There is no `--listen` for a GUI here because there is no GUI here.

set -euo pipefail

# WO-35 — THIS BLOCK USED TO ECHO SEVEN VARIABLES NO CODE READS.
#
# SCRUPLE_USER_ID, SCRUPLE_APP_ID, SCRUPLE_SESSION_ID, SCRUPLE_SESSION_TOKEN,
# SCRUPLE_WITNESS_URL, SCRUPLE_PLACEMENT and SCRUPLE_CAN_WITNESS appear
# nowhere in services/scruple-capture, lib/apps/kohya or lib/capture. They
# were printed at boot, which made them look load-bearing, and the RunPod
# template instructions in Dockerfile.jobapi listed exactly those seven while
# omitting the ones below. A pod built to that template died at boot.
#
# Echoing a variable is not reading it. What is printed here is now what the
# component actually requires.
echo "[scruple] SCRUPLE_API_URL=${SCRUPLE_API_URL:-<unset>}"
# Presence only, never the value: these are credentials and the tenant may
# read this log.
echo "[scruple] SCRUPLE_API_KEY=${SCRUPLE_API_KEY:+<set>}${SCRUPLE_API_KEY:-<unset>}"
echo "[scruple] SCRUPLE_CAPTURE_PROVISIONING_TOKEN=${SCRUPLE_CAPTURE_PROVISIONING_TOKEN:+<set>}${SCRUPLE_CAPTURE_PROVISIONING_TOKEN:-<unset> (first boot needs one)}"
echo "[scruple] SCRUPLE_CAPTURE_STATE_DIR=${SCRUPLE_CAPTURE_STATE_DIR:-/var/lib/scruple-capture}"
echo "[scruple] SCRUPLE_CAPTURE_BASELINE_REF=${SCRUPLE_CAPTURE_BASELINE_REF:-<unset>}"
echo "[scruple] surface: training-job-api only. No Gradio, no Jupyter, no shell."

# Fail here rather than 30 seconds later inside node. Same argument as the
# directory check below: a component that cannot reach the API cannot
# provision, cannot MAC, and must not look like it started.
: "${SCRUPLE_API_URL:?[scruple] FATAL: SCRUPLE_API_URL is required}"
: "${SCRUPLE_API_KEY:?[scruple] FATAL: SCRUPLE_API_KEY is required (needs the component:provision scope)}"

# Fail loudly rather than starting a component that watches nothing. A surface
# that silently fails to open is the ComfyUI WS gap by another name.
for d in "${SCRUPLE_KOHYA_OUTPUT_ROOT:?}" "${SCRUPLE_KOHYA_DATASETS_ROOT:?}" \
         "${SCRUPLE_KOHYA_MODELS_ROOT:?}" "${SCRUPLE_KOHYA_LOGGING_ROOT:?}"; do
  [ -d "$d" ] || { echo "[scruple] FATAL: $d does not exist"; exit 1; }
done

cd /opt/scruple-capture
# `exec` replaces this shell, so node — the component — becomes PID 1.
# See the header, and lib/apps/kohya/placement.ts obligation 5.
exec node --import tsx services/scruple-capture/kohya/job-api-server.ts
