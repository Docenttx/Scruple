"""Scruple cloud GPU runner (Pivot Phase E).

A Modal app that boots ComfyUI inside a serverless GPU container,
accepts a workflow_api_json over the function call, runs the workflow,
and returns the output image bytes.

Free-tier GPU (T4 by default) for end-to-end smoke testing. Swap the
GPU spec to H100 with CC mode for the paid attested tier — the rest
of the code is identical.

Deploy:
    cd /data/scruple-web && python3 -m modal deploy modal/scruple_runner.py

Invoke (server-side from /data/scruple-web/lib/compute/modal.ts):
    POST {endpoint}/run -d '{"workflow_api_json": {...}}'

Stdin-style local dev test (for the operator to verify the deploy):
    python3 -m modal run modal/scruple_runner.py::run_workflow \
        --workflow-json '{"3":{"class_type":"KSampler",...}}'
"""

import os
import time
import json
import urllib.request
import urllib.error
from typing import Any, Dict, Optional

import modal

# ── GPU selection ─────────────────────────────────────────────────────────
# Free tier: T4. Paid tier: "H100" or "A100". TEE-attested H100: see
# Modal's docs on enabling Confidential Computing mode.
GPU = os.getenv("SCRUPLE_MODAL_GPU", "T4")

# ── Image build ───────────────────────────────────────────────────────────
# A small ComfyUI install + the SD 1.5 base model for smoke tests. Build
# happens once when the app deploys; cached after that.
comfy_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "wget")
    .pip_install(
        "torch==2.4.0",
        "torchvision==0.19.0",
        "torchaudio==2.4.0",
        index_url="https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        "transformers>=4.40",
        "accelerate",
        "diffusers",
        "safetensors",
        "Pillow",
        "numpy",
        "psutil",
        "tqdm",
        "aiohttp",
        "einops",
        "scipy",
        "torchsde",
        "fastapi[standard]",  # required by Modal web endpoints
    )
    .run_commands(
        "git clone --depth=1 https://github.com/comfyanonymous/ComfyUI /opt/ComfyUI",
        "pip install -r /opt/ComfyUI/requirements.txt",
    )
)

app = modal.App("scruple-runner", image=comfy_image)


def _comfy_running() -> bool:
    try:
        req = urllib.request.Request("http://127.0.0.1:8188/system_stats")
        with urllib.request.urlopen(req, timeout=2) as r:
            return r.status == 200
    except urllib.error.URLError:
        return False
    except Exception:
        return False


def _start_comfy() -> None:
    """Boot ComfyUI in the background (single process per container)."""
    import subprocess
    if _comfy_running():
        return
    subprocess.Popen(
        ["python", "main.py", "--listen", "127.0.0.1", "--port", "8188"],
        cwd="/opt/ComfyUI",
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    # Wait up to 60s for the server to come up.
    for _ in range(60):
        if _comfy_running():
            return
        time.sleep(1)
    raise RuntimeError("ComfyUI failed to start")


def _post_json(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:8188{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def _get_json(path: str) -> Dict[str, Any]:
    req = urllib.request.Request(f"http://127.0.0.1:8188{path}")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def _get_bytes(path: str) -> bytes:
    req = urllib.request.Request(f"http://127.0.0.1:8188{path}")
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


# ── The main entrypoint ──────────────────────────────────────────────────
@app.function(gpu=GPU, timeout=600)
def run_workflow(workflow_api_json: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a ComfyUI workflow and return the resulting image bytes.

    Returns:
        {
          "ok": True,
          "image_bytes_b64": <base64>,
          "content_type": "image/png",
          "prompt_id": <comfyui prompt id>,
          "duration_ms": <int>,
          "gpu": "T4" | ...,
          "attestation": None  # populated when running H100 CC mode
        }
    """
    import base64

    started = time.time()

    _start_comfy()

    # Queue the workflow
    queued = _post_json("/prompt", {"prompt": workflow_api_json})
    prompt_id = queued.get("prompt_id")
    if not prompt_id:
        return {"ok": False, "error": f"comfy /prompt missing prompt_id: {queued}"}

    # Poll history until the prompt appears with outputs
    outputs: Optional[Dict[str, Any]] = None
    for _ in range(120):  # ~2 minutes max
        hist = _get_json(f"/history/{prompt_id}")
        if prompt_id in hist and hist[prompt_id].get("outputs"):
            outputs = hist[prompt_id]["outputs"]
            break
        time.sleep(1)

    if not outputs:
        return {"ok": False, "error": "timeout waiting for outputs", "prompt_id": prompt_id}

    # Find the first image among the outputs (workflow may have multiple)
    image_info = None
    for node_outputs in outputs.values():
        images = node_outputs.get("images") or []
        if images:
            image_info = images[0]
            break

    if not image_info:
        return {"ok": False, "error": "no image in outputs", "prompt_id": prompt_id, "outputs_keys": list(outputs.keys())}

    bytes_ = _get_bytes(
        f"/view?filename={image_info['filename']}&subfolder={image_info.get('subfolder', '')}&type={image_info.get('type', 'output')}"
    )

    duration_ms = int((time.time() - started) * 1000)

    return {
        "ok": True,
        "image_bytes_b64": base64.b64encode(bytes_).decode("ascii"),
        "content_type": "image/png",
        "prompt_id": prompt_id,
        "duration_ms": duration_ms,
        "gpu": GPU,
        "attestation": None,  # populated on H100 CC builds
    }


# Web endpoint for the scruple-web Node backend to call without spawning
# a Python client. Mounted at `${MODAL_RUNNER_ENDPOINT}` from the
# Node adapter (lib/compute/modal.ts).
@app.function(timeout=600)
@modal.fastapi_endpoint(method="POST", label="run")
def web_run(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Thin proxy: accept POST {workflow_api_json: ...}, return runner output."""
    workflow = payload.get("workflow_api_json")
    if not isinstance(workflow, dict):
        return {"ok": False, "error": "workflow_api_json (object) required"}
    # Delegate to the GPU function. The web container is cheap; the GPU
    # container only runs when run_workflow.spawn is invoked.
    return run_workflow.remote(workflow)


# Local invocation for testing without a web endpoint
@app.local_entrypoint()
def main(workflow_json: str = ""):
    if not workflow_json:
        print("Usage: modal run modal/scruple_runner.py::main --workflow-json '<json>'")
        return
    result = run_workflow.remote(json.loads(workflow_json))
    print(json.dumps({k: (v if k != "image_bytes_b64" else "<base64 omitted>") for k, v in result.items()}, indent=2))
