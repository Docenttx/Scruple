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
from typing import Any, Dict, Optional  # Optional used by admin function

import modal

# ── Admin shared secret ───────────────────────────────────────────────────
# Web backend (scruple-web) passes this in the X-Admin-Token header when
# calling admin_list / admin_fetch / admin_delete. Set the matching value
# in scruple-web/.env.local as SCRUPLE_MODAL_ADMIN_TOKEN.
# Deploy with the token attached via Modal secret:
#   modal secret create scruple-admin SCRUPLE_MODAL_ADMIN_TOKEN=<random>
# Then add  secrets=[modal.Secret.from_name("scruple-admin")]  to the
# admin functions. For local dev the env var falls back to empty string,
# which disables admin endpoints (they all 401).
ADMIN_TOKEN = os.environ.get("SCRUPLE_MODAL_ADMIN_TOKEN", "")


def _check_admin(token: Optional[str]) -> bool:
    """Constant-time-ish compare against the configured admin token.
    Returns False if no token is configured server-side."""
    if not ADMIN_TOKEN:
        return False
    if not token:
        return False
    if len(token) != len(ADMIN_TOKEN):
        return False
    # bitwise XOR over the bytes for constant-time-ish equality
    result = 0
    for a, b in zip(token.encode(), ADMIN_TOKEN.encode()):
        result |= a ^ b
    return result == 0

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
        # Modal Volumes can only be mounted onto empty directories. The git
        # clone above ships with placeholder subdirs under models/ that
        # would block our scruple-models volume mount. Clear them so the
        # Volume mount point is empty; subdirs are recreated on the Volume
        # by fetch_to_volume / the seed entrypoint.
        "rm -rf /opt/ComfyUI/models && mkdir /opt/ComfyUI/models",
    )
)

app = modal.App("scruple-runner", image=comfy_image)

# Pass-1A: Modal Volume for the model library. Persistent across deploys.
# Mounted at /opt/ComfyUI/models inside the runner container so ComfyUI
# finds checkpoints / loras / vae / controlnet via its standard
# filesystem-scan mechanism.
models_volume = modal.Volume.from_name("scruple-models", create_if_missing=True)


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
@app.function(
    gpu=GPU,
    timeout=600,
    volumes={"/opt/ComfyUI/models": models_volume},
    scaledown_window=600,  # 10-min warm window per session (was container_idle_timeout)
)
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


# ─────────────────────────────────────────────────────────────────────────
# Model library admin (Pass-1A)
# ─────────────────────────────────────────────────────────────────────────

@app.function(
    image=comfy_image,
    volumes={"/opt/ComfyUI/models": models_volume},
    timeout=3600,  # large models can take a while
)
def fetch_to_volume(source_url: str, target_subpath: str, hf_token: Optional[str] = None) -> Dict[str, Any]:
    """Download a model from a URL (HF, Civitai, direct) onto the shared
    Modal Volume. Idempotent — skips if the file already exists.

    target_subpath is relative to /opt/ComfyUI/models/, e.g.
       "checkpoints/sd-1.5.safetensors"
       "loras/user-123/myStyle.safetensors"
    """
    import os
    import shutil
    import hashlib
    import urllib.request

    target_path = os.path.join("/opt/ComfyUI/models", target_subpath)
    os.makedirs(os.path.dirname(target_path), exist_ok=True)

    if os.path.exists(target_path):
        size = os.path.getsize(target_path)
        print(f"[fetch_to_volume] already present: {target_subpath} ({size} bytes)")
        return {"ok": True, "skipped": True, "target": target_subpath, "size": size}

    tmp_path = target_path + ".part"
    print(f"[fetch_to_volume] fetching {source_url} → {target_subpath}")
    req = urllib.request.Request(source_url, headers={"User-Agent": "scruple-runner/1.0"})
    if hf_token and "huggingface.co" in source_url:
        req.add_header("Authorization", f"Bearer {hf_token}")

    started = time.time()
    bytes_seen = 0
    sha = hashlib.sha256()
    with urllib.request.urlopen(req, timeout=600) as r, open(tmp_path, "wb") as out:
        while True:
            chunk = r.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            sha.update(chunk)
            bytes_seen += len(chunk)
    shutil.move(tmp_path, target_path)
    models_volume.commit()
    duration = time.time() - started

    return {
        "ok": True,
        "skipped": False,
        "target": target_subpath,
        "size": bytes_seen,
        "sha256": sha.hexdigest(),
        "duration_seconds": round(duration, 1),
    }


@app.function(
    volumes={"/opt/ComfyUI/models": models_volume},
    timeout=60,
)
def list_volume() -> Dict[str, Any]:
    """List every file on the models volume with size + mtime + sha256-of-name.
    Used by the canvas stub-sync script to mirror filenames into the
    canvas.stooges.ai ComfyUI install."""
    import os
    out: Dict[str, list] = {}
    root = "/opt/ComfyUI/models"
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            top = rel.split(os.sep, 1)[0]  # checkpoints / loras / vae / etc.
            entry = {
                "path": rel,
                "size": os.path.getsize(full),
                "mtime": int(os.path.getmtime(full)),
            }
            out.setdefault(top, []).append(entry)
    return {"ok": True, "by_category": out}


@app.function(
    volumes={"/opt/ComfyUI/models": models_volume},
    timeout=60,
)
def delete_from_volume(target_subpath: str) -> Dict[str, Any]:
    """Remove a file from the volume. Used by the Settings UI's
    'Remove from library' button + the library-eviction job."""
    import os
    target = os.path.join("/opt/ComfyUI/models", target_subpath)
    if not os.path.exists(target):
        return {"ok": False, "error": "not_found"}
    os.remove(target)
    models_volume.commit()
    return {"ok": True, "removed": target_subpath}


# ─────────────────────────────────────────────────────────────────────────
# Admin HTTP endpoints (called by scruple-web Settings → Model Library)
# ─────────────────────────────────────────────────────────────────────────

# These need FastAPI's Header dependency so we can read X-Admin-Token off
# the request without going through Modal's payload arg.
from fastapi import Header  # noqa: E402

# Required Modal Secret holding the admin token. Create before deploy:
#   modal secret create scruple-admin SCRUPLE_MODAL_ADMIN_TOKEN=$(openssl rand -hex 32)
# The matching value goes in scruple-web/.env.local as
#   SCRUPLE_MODAL_ADMIN_TOKEN=<same>
ADMIN_SECRET = modal.Secret.from_name(
    "scruple-admin",
    required_keys=["SCRUPLE_MODAL_ADMIN_TOKEN"],
)


@app.function(
    timeout=60,
    volumes={"/opt/ComfyUI/models": models_volume},
    secrets=[ADMIN_SECRET],
)
@modal.fastapi_endpoint(method="GET", label="admin-list")
def admin_list(x_admin_token: str = Header(default="")) -> Dict[str, Any]:
    """List every file on the models volume — same shape as list_volume.
    Auth via X-Admin-Token header (must match SCRUPLE_MODAL_ADMIN_TOKEN
    in the scruple-admin Modal Secret)."""
    if not _check_admin(x_admin_token):
        return {"ok": False, "error": "unauthorized"}
    return list_volume.remote()


@app.function(timeout=60, secrets=[ADMIN_SECRET])
@modal.fastapi_endpoint(method="POST", label="admin-fetch")
def admin_fetch(payload: Dict[str, Any], x_admin_token: str = Header(default="")) -> Dict[str, Any]:
    """Kick off a fetch_to_volume in the background. Returns immediately
    with the FunctionCall handle id; client polls admin_job_status to
    track progress or admin_list to see the file appear.

    Body: {source_url, target_subpath, hf_token?}"""
    if not _check_admin(x_admin_token):
        return {"ok": False, "error": "unauthorized"}
    source_url = payload.get("source_url")
    target_subpath = payload.get("target_subpath")
    hf_token = payload.get("hf_token")
    if not isinstance(source_url, str) or not source_url:
        return {"ok": False, "error": "source_url required"}
    if not isinstance(target_subpath, str) or not target_subpath:
        return {"ok": False, "error": "target_subpath required"}
    # spawn fires async, returns immediately
    call = fetch_to_volume.spawn(source_url, target_subpath, hf_token)
    return {
        "ok": True,
        "function_call_id": call.object_id,
        "target_subpath": target_subpath,
    }


@app.function(
    timeout=60,
    volumes={"/opt/ComfyUI/models": models_volume},
    secrets=[ADMIN_SECRET],
)
@modal.fastapi_endpoint(method="POST", label="admin-delete")
def admin_delete(payload: Dict[str, Any], x_admin_token: str = Header(default="")) -> Dict[str, Any]:
    """Delete a file from the volume. Body: {target_subpath}."""
    if not _check_admin(x_admin_token):
        return {"ok": False, "error": "unauthorized"}
    target_subpath = payload.get("target_subpath")
    if not isinstance(target_subpath, str) or not target_subpath:
        return {"ok": False, "error": "target_subpath required"}
    return delete_from_volume.remote(target_subpath)


@app.function(timeout=60, secrets=[ADMIN_SECRET])
@modal.fastapi_endpoint(method="GET", label="admin-job-status")
def admin_job_status(call_id: str, x_admin_token: str = Header(default="")) -> Dict[str, Any]:
    """Check the status of a previously-spawned fetch. Returns the
    function call's result if complete, or {pending: true} if still running."""
    if not _check_admin(x_admin_token):
        return {"ok": False, "error": "unauthorized"}
    try:
        fc = modal.FunctionCall.from_id(call_id)
        try:
            result = fc.get(timeout=0)
            return {"ok": True, "pending": False, "result": result}
        except TimeoutError:
            return {"ok": True, "pending": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# Local invocation for testing without a web endpoint
@app.local_entrypoint()
def main(workflow_json: str = ""):
    if not workflow_json:
        print("Usage: modal run modal/scruple_runner.py::main --workflow-json '<json>'")
        return
    result = run_workflow.remote(json.loads(workflow_json))
    print(json.dumps({k: (v if k != "image_bytes_b64" else "<base64 omitted>") for k, v in result.items()}, indent=2))


@app.local_entrypoint()
def seed():
    """Seed the volume with the initial catalog. Idempotent."""
    seeds = [
        # SD 1.5 base — small, free, works as the smoke-test default
        (
            "https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors",
            "checkpoints/v1-5-pruned-emaonly.safetensors",
        ),
        # SD 1.5 VAE (separate file, useful for sharper outputs)
        (
            "https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors",
            "vae/vae-ft-mse-840000-ema-pruned.safetensors",
        ),
    ]
    for src, dst in seeds:
        print(f"\n→ {dst}")
        r = fetch_to_volume.remote(src, dst)
        print(json.dumps(r, indent=2))
    print("\n=== Final listing ===")
    print(json.dumps(list_volume.remote(), indent=2))


@app.local_entrypoint()
def ls():
    """Quick CLI: modal run modal/scruple_runner.py::ls"""
    print(json.dumps(list_volume.remote(), indent=2))
