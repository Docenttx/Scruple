"""
Scruple Canvas — Modal-hosted long-running ComfyUI for Pro/Enterprise users.

Separate Modal app from `scruple_runner.py`:

  scruple-runner    — per-request synchronous / spawn+poll Modal function.
                       Used by /api/generate (project-page generation, CLI).
                       Single shared image, single endpoint per GPU class.

  scruple-canvas    — long-running web server. One container per (user,
                       machine) pair, exposed via Modal @web_server so the
                       canvas page can iframe it. ComfyUI HTTP + WS go
                       straight through Modal's HTTPS gateway.

See docs/wo/2026-06-22-canvas-on-modal.md for the full architecture +
provenance integration via the in-process intercept JS.

Deploy:

    modal deploy modal/canvas_app.py

Modal prints one URL per declared class (one per GPU). Set them in
.env.local as:

    MODAL_CANVAS_APP_URL_T4_FREE=https://<workspace>--scruple-canvas-comfyuit4-serve.modal.run
    MODAL_CANVAS_APP_URL_A10G_PRO=https://<workspace>--scruple-canvas-comfyuia10g-serve.modal.run
    MODAL_CANVAS_APP_URL_A100_PREMIUM=https://<workspace>--scruple-canvas-comfyuia100-serve.modal.run
    MODAL_CANVAS_APP_URL_H100CC_ENTERPRISE=https://<workspace>--scruple-canvas-comfyuih100cc-serve.modal.run

lib/canvas/session.ts reads those at session-mint time.
"""

from __future__ import annotations

import subprocess
import time
import urllib.request
import urllib.error

import modal

# ── Image build ───────────────────────────────────────────────────────────
# Full custom-node set. Mirrors what canvas.stooges.ai's on-host CPU
# install has, so workflows compose-and-execute on the same machine
# (no node-set parity problem).
canvas_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "wget", "libgl1", "libglib2.0-0", "ffmpeg")
    .pip_install(
        "torch==2.4.0",
        "torchvision==0.19.0",
        "torchaudio==2.4.0",
        index_url="https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        "transformers>=4.40",
        "diffusers",
        "accelerate",
        "safetensors",
        "Pillow",
        "numpy",
        "psutil",
        "tqdm",
        "aiohttp",
        "einops",
        "scipy",
        "torchsde",
        "opencv-python-headless",
        "matplotlib",
        "peft",
        "omegaconf",
        "rotary-embedding-torch",
        "fastapi[standard]",
    )
    .run_commands(
        # ComfyUI core — pinned to match canvas + runner.
        "git clone --depth=1 --branch v0.18.5 "
        "https://github.com/comfyanonymous/ComfyUI /opt/ComfyUI",
        "pip install -r /opt/ComfyUI/requirements.txt",

        # ── Custom node packs (must match canvas-host inventory) ──────
        # ComfyUI-Easy-Use — same pin as scruple_runner.py.
        "git clone --depth=1 --branch v1.3.6 "
        "https://github.com/yolain/ComfyUI-Easy-Use "
        "/opt/ComfyUI/custom_nodes/ComfyUI-Easy-Use",
        "pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-Easy-Use/requirements.txt || true",
        "pip install lark opencv-python-headless",

        # VideoHelperSuite — required for any video workflow.
        "git clone --depth=1 "
        "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite "
        "/opt/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite",
        "pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt || true",

        # ComfyUI Manager — user-facing custom-node installer + graph
        # tools. Pinned to a known-good tag so image builds are
        # reproducible.
        "git clone --depth=1 --branch 3.7.5 "
        "https://github.com/ltdrdata/ComfyUI-Manager "
        "/opt/ComfyUI/custom_nodes/ComfyUI-Manager",
        "pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-Manager/requirements.txt || true",

        # SeedVR2 video upscaler — upstream is fine because Modal
        # containers always have real CUDA, so the scruple-canvas-fork's
        # CPU-fallback patch (see external/scruple-nodes/) is a no-op
        # here. When the scruple-nodes GitHub org goes live, switch
        # the URL to <scruple-org>/seedvr2_videoupscaler @ scruple-canvas-fork
        # branch for stricter parity.
        "git clone --depth=1 "
        "https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler "
        "/opt/ComfyUI/custom_nodes/seedvr2_videoupscaler",
        "pip install -r /opt/ComfyUI/custom_nodes/seedvr2_videoupscaler/requirements.txt || true",

        # ── Models volume mount prep ──────────────────────────────────
        # ComfyUI ships placeholder subdirs under models/; the Volume
        # mount requires an empty dir. Same trick scruple_runner.py uses.
        "rm -rf /opt/ComfyUI/models && mkdir /opt/ComfyUI/models",
    )
    # Canvas v2 (WO-4): scruple_nodes pack is no longer baked into the
    # default Modal image. Reason: its 4 node classes (ScrupleStudio*,
    # ScrupleTrainingTerminal, etc.) target the desktop Electron Studio
    # at localhost:5742 — dead code in scruple-web. Its js/ intercept
    # scripts (scruple-canvas-witness.js, scruple-queue-intercept.js)
    # are superseded by the scruple-web HTTP+WS proxy that captures
    # workflow + output bytes server-side.
)

app = modal.App("scruple-canvas", image=canvas_image)

# Same models volume the runner uses — cached weights are shared so a
# canvas-launched workflow uses the same model bytes as a runner-launched
# one. Provenance reads the same model_fingerprints either way.
models_volume = modal.Volume.from_name("scruple-models", create_if_missing=True)


# ── ComfyUI subprocess management ─────────────────────────────────────────
def _comfy_running() -> bool:
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:8188/system_stats", timeout=2
        ) as r:
            return r.status == 200
    except (urllib.error.URLError, Exception):
        return False


def _start_comfy() -> None:
    """Spawn ComfyUI in the background; stream logs to /tmp/comfyui.log."""
    if _comfy_running():
        return
    log_fd = open("/tmp/comfyui.log", "ab", buffering=0)
    # Bind to 0.0.0.0, NOT 127.0.0.1 — Modal's port-probe runs from a
    # side-car namespace that can't reach loopback. The canvas server-
    # side proxy is the only gate, so exposure inside the container is
    # not a security concern.
    subprocess.Popen(
        ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188",
         "--disable-auto-launch", "--enable-cors-header"],
        cwd="/opt/ComfyUI",
        stdout=log_fd,
        stderr=log_fd,
    )
    # Wait up to 240s for the HTTP listener to come up (matches the
    # web_server startup_timeout headroom).
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        if _comfy_running():
            return
        time.sleep(1)
    raise RuntimeError("ComfyUI failed to start within 90s; check /tmp/comfyui.log")


# ── One Modal class per GPU tier ──────────────────────────────────────────
# Each class is a separate Modal function with its own GPU + its own
# public URL. lib/canvas/session.ts picks the URL by machine_id.
#
# Canvas v2 (WO-4) auth model: scruple-web's HTTP+WS proxy is the gate.
# Modal's @web_server publishes the port directly via Modal's HTTPS
# gateway — Modal itself does no auth. Scruple-web sends every proxied
# request with `X-Scruple-Shared-Secret: $SCRUPLE_CANVAS_SHARED_SECRET`.
# ComfyUI on port 8188 doesn't enforce that header; the production
# deployment needs an in-container auth shim on a different port (e.g.
# uvicorn @ 8189 -> ComfyUI @ 8188) which the @web_server then targets.
# That shim is a follow-up WO (canvas-v2-04a). Until it ships, the
# defense-in-depth is URL secrecy: the Modal URL never leaves the
# server-side proxy and the .env.local file.
#
# Why classes rather than one parameterized function: Modal's web_server
# routes by function identity, and GPU class is fixed at function-define
# time. Different GPU → different function → different URL.
#
# concurrency_limit=1 means each container handles one user at a time;
# a second user on the same GPU tier spawns a second container.
#
# scaledown_window=300 idles the container after 5 minutes of no
# HTTP activity (Modal counts requests against this window).
#
# timeout=3600 caps any one session at 1h to bound runaway sessions.

CANVAS_KWARGS = dict(
    scaledown_window=300,
    max_containers=1,
    timeout=60 * 60,
    volumes={"/opt/ComfyUI/models": models_volume},
)


@app.cls(gpu="T4", **CANVAS_KWARGS)
class ComfyUIT4:
    @modal.enter()
    def _boot(self):
        _start_comfy()

    @modal.web_server(port=8188, startup_timeout=300)
    def serve(self):
        # Modal proxies all HTTP+WS to port 8188.
        pass


@app.cls(gpu="A10G", **CANVAS_KWARGS)
class ComfyUIA10G:
    @modal.enter()
    def _boot(self):
        _start_comfy()

    @modal.web_server(port=8188, startup_timeout=300)
    def serve(self):
        pass


@app.cls(gpu="A100-40GB", **CANVAS_KWARGS)
class ComfyUIA100:
    @modal.enter()
    def _boot(self):
        _start_comfy()

    @modal.web_server(port=8188, startup_timeout=300)
    def serve(self):
        pass


# H100-CC: confidential computing mode for L3 trust-tier attestation.
# Note: H100 requires Modal's confidential computing plan.
@app.cls(gpu="H100", **CANVAS_KWARGS)
class ComfyUIH100CC:
    @modal.enter()
    def _boot(self):
        _start_comfy()

    @modal.web_server(port=8188, startup_timeout=300)
    def serve(self):
        pass
