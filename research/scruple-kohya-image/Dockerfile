# Scruple × Kohya-ss custom RunPod image — WO-KOHYA Phase 4.
#
# Bakes Kohya-ss GUI + our scruple-safetensors-hook shim so every
# checkpoint save POSTs a witnessed leaf to scruple-web.
#
# Build:
#   docker build -t <registry>/scruple-kohya:latest .
#   docker push <registry>/scruple-kohya:latest
#
# Then register as a RunPod template with:
#   - Container image: <registry>/scruple-kohya:latest
#   - Expose HTTP: 7860
#   - Container start command: (empty — CMD in Dockerfile handles it)
#   - Container disk: 40 GB
#   - Volume mount: /workspace
#   - Env: (RunPod injects SCRUPLE_USER_ID, SCRUPLE_APP_ID,
#     SCRUPLE_WITNESS_URL, SCRUPLE_WITNESS_SECRET, SCRUPLE_SESSION_ID
#     when scruple-web spawns the pod)
#
# Save the RunPod template id into .env.local as RUNPOD_KOHYA_TEMPLATE_ID.

FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Clone Kohya-ss GUI. Pin to a known-good tag; bmaltais releases
# regularly, so we lock a specific ref.
RUN git clone --depth=1 --branch v25.0.3 \
      https://github.com/bmaltais/kohya_ss.git \
      /workspace/kohya_ss \
    && cd /workspace/kohya_ss \
    && git submodule update --init --recursive

RUN cd /workspace/kohya_ss \
    && pip install -r requirements.txt

# The scruple-safetensors-hook: a sitecustomize.py that Python auto-loads
# at startup. It monkey-patches safetensors.torch.save_file so every
# checkpoint write triggers a POST to scruple-web/api/apps/kohya/witness
# with { path, sha256, size, metadata, session_id, user_id }.
COPY scruple_safetensors_hook.py /usr/local/lib/python3.11/dist-packages/sitecustomize.py

# Launch script: honors the pod-injected env, starts Kohya headless on
# 0.0.0.0:7860 (the port RunPod's proxy is configured to expose).
COPY start.sh /workspace/start.sh
RUN chmod +x /workspace/start.sh

EXPOSE 7860
CMD ["/workspace/start.sh"]
