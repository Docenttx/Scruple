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
        # Pin ComfyUI to v0.18.5 — matches the user's local canvas
        # (v0.18.1-44-g...) and is compatible with Easy-Use 1.3.6. Latest
        # ComfyUI (0.21+) has a stricter prompt validator that rejects
        # Easy-Use's node names even when registered.
        "git clone --depth=1 --branch v0.18.5 https://github.com/comfyanonymous/ComfyUI /opt/ComfyUI",
        "pip install -r /opt/ComfyUI/requirements.txt",
        # ── Custom node packs ──────────────────────────────────────────
        # ComfyUI-Easy-Use — provides easy loraStack / loraStackApply /
        # and many other QoL nodes used in user workflows. Pinned to
        # v1.3.6 to match the user's local canvas (otherwise the schema
        # for `easy loraStack` can drift between versions and the same
        # workflow validates locally but 400s on Modal).
        "git clone --depth=1 --branch v1.3.6 https://github.com/yolain/ComfyUI-Easy-Use "
        "/opt/ComfyUI/custom_nodes/ComfyUI-Easy-Use",
        # Easy-Use has its own requirements; install them. Plus a couple
        # of indirect deps (lark, opencv-python-headless) that its newer
        # modules import directly.
        "pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-Easy-Use/requirements.txt || true",
        "pip install lark opencv-python-headless",
        # ── End custom nodes ──────────────────────────────────────────
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
    """Boot ComfyUI in the background (single process per container).
    Stdout/stderr land in /tmp/comfyui.log so failed custom-node imports
    show up via the diagnose_startup local_entrypoint."""
    import subprocess
    if _comfy_running():
        return
    logf = open("/tmp/comfyui.log", "ab", buffering=0)
    subprocess.Popen(
        ["python", "main.py", "--listen", "127.0.0.1", "--port", "8188"],
        cwd="/opt/ComfyUI",
        stdout=logf,
        stderr=subprocess.STDOUT,
    )
    # Wait up to 60s for the server to come up.
    for _ in range(60):
        if _comfy_running():
            return
        time.sleep(1)
    raise RuntimeError("ComfyUI failed to start")


@app.function(gpu=GPU, timeout=120, volumes={"/opt/ComfyUI/models": models_volume})
def diagnose_startup() -> Dict[str, Any]:
    """Boot ComfyUI, then read /tmp/comfyui.log. Reads the log even when
    startup fails so we can see WHY ComfyUI crashed."""
    import subprocess
    started = False
    err = None
    try:
        if not _comfy_running():
            logf = open("/tmp/comfyui.log", "ab", buffering=0)
            subprocess.Popen(
                ["python", "main.py", "--listen", "127.0.0.1", "--port", "8188"],
                cwd="/opt/ComfyUI",
                stdout=logf,
                stderr=subprocess.STDOUT,
            )
            # Wait up to 30s for it to come up. If it doesn't, that's fine —
            # we still want the log.
            for _ in range(30):
                if _comfy_running():
                    started = True
                    break
                time.sleep(1)
        else:
            started = True
    except Exception as e:
        err = str(e)
    # Always read the log
    try:
        with open("/tmp/comfyui.log", "rb") as f:
            data = f.read()
    except Exception as e:
        data = f"<could not read log: {e}>".encode()
    tail = data[-8000:].decode("utf-8", errors="replace")
    return {"started": started, "error": err, "log_tail": tail}


def _post_json(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """POST JSON to local ComfyUI. On HTTP errors, capture the response
    body and raise a RuntimeError with it inline — otherwise Modal's
    pickle serialization swallows the original HTTPError and we lose
    ComfyUI's validation message."""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:8188{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Read body BEFORE the BufferedReader gets closed/garbage-collected.
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = "<could not read response body>"
        raise RuntimeError(f"ComfyUI {path} HTTP {e.code}: {err_body}") from None


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
def run_workflow(workflow_api_json: Dict[str, Any], inputs: Optional[list] = None) -> Dict[str, Any]:
    """Execute a ComfyUI workflow and return the resulting artifact bytes.

    inputs (optional): list of input files to place in ComfyUI's input dir
    BEFORE queueing, so LoadImage / LoadVideo / training nodes can read them:
        [{ "filename": "init.png", "bytes_b64": "<base64>" }, ...]
    This is what lets the CC dev pipeline pump source materials (from user
    storage / Modal storage / local) into a workflow without the canvas.

    Returns:
        {
          "ok": True,
          "image_bytes_b64": <base64>,     # the output artifact (any kind)
          "content_type": "image/png" | "video/mp4" | "application/octet-stream",
          "output_kind": "image" | "video" | "checkpoint",
          "output_filename": <str>,
          "prompt_id": <comfyui prompt id>,
          "duration_ms": <int>,
          "gpu": "T4" | ...,
          "attestation": None  # populated when running H100 CC mode
        }
    """
    import base64
    import os
    import traceback

    started = time.time()

    try:
        _start_comfy()
    except Exception as e:
        return {"ok": False, "error": "start_comfy_failed", "detail": str(e), "traceback": traceback.format_exc()}

    # Place any provided inputs into ComfyUI's input dir so LoadImage et al.
    # resolve them by filename.
    if inputs:
        input_dir = "/opt/ComfyUI/input"
        try:
            os.makedirs(input_dir, exist_ok=True)
            for item in inputs:
                fn = os.path.basename(str(item.get("filename") or ""))
                b64 = item.get("bytes_b64")
                if not fn or not b64:
                    continue
                with open(os.path.join(input_dir, fn), "wb") as fh:
                    fh.write(base64.b64decode(b64))
        except Exception as e:
            return {"ok": False, "error": "input_write_failed", "detail": str(e)}

    # Queue the workflow — wrapped so HTTPErrors don't trip Modal's pickle layer.
    try:
        queued = _post_json("/prompt", {"prompt": workflow_api_json})
    except Exception as e:
        return {"ok": False, "error": "comfy_prompt_post_failed", "detail": str(e)}
    prompt_id = queued.get("prompt_id")
    if not prompt_id:
        return {"ok": False, "error": f"comfy /prompt missing prompt_id: {queued}"}

    # Poll history until the prompt appears with outputs. Flux dev FP8 +
    # a LoRA on T4 can take >2 min when the container is doing real work;
    # bump to 8 min so cold-loaded LoRAs + Flux don't get prematurely killed.
    # The function-level timeout is 10 min (600s) so we stay safely under.
    outputs: Optional[Dict[str, Any]] = None
    poll_started = time.time()
    while time.time() - poll_started < 480:  # 8 minutes max
        hist = _get_json(f"/history/{prompt_id}")
        if prompt_id in hist and hist[prompt_id].get("outputs"):
            outputs = hist[prompt_id]["outputs"]
            break
        time.sleep(2)

    if not outputs:
        return {
            "ok": False,
            "error": "timeout waiting for outputs",
            "prompt_id": prompt_id,
            "polled_seconds": int(time.time() - poll_started),
        }

    # Find the primary output across nodes. Order of preference: video
    # (gifs/videos keys from VHS_VideoCombine etc.) → image. ComfyUI reports
    # video outputs under "gifs" (mp4/webm included) in most video nodes.
    out_info = None
    out_kind = "image"
    for node_outputs in outputs.values():
        vids = node_outputs.get("gifs") or node_outputs.get("videos") or []
        if vids:
            out_info = vids[0]
            out_kind = "video"
            break
    if not out_info:
        for node_outputs in outputs.values():
            images = node_outputs.get("images") or []
            if images:
                out_info = images[0]
                out_kind = "image"
                break

    if not out_info:
        return {"ok": False, "error": "no image/video in outputs", "prompt_id": prompt_id,
                "outputs_keys": list(outputs.keys()), "outputs": outputs}

    fn = out_info["filename"]
    bytes_ = _get_bytes(
        f"/view?filename={fn}&subfolder={out_info.get('subfolder', '')}&type={out_info.get('type', 'output')}"
    )

    lower = fn.lower()
    if out_kind == "video":
        content_type = "video/webm" if lower.endswith(".webm") else "video/mp4"
    elif lower.endswith(".jpg") or lower.endswith(".jpeg"):
        content_type = "image/jpeg"
    elif lower.endswith(".webp"):
        content_type = "image/webp"
    else:
        content_type = "image/png"

    duration_ms = int((time.time() - started) * 1000)

    return {
        "ok": True,
        "image_bytes_b64": base64.b64encode(bytes_).decode("ascii"),
        "content_type": content_type,
        "output_kind": out_kind,
        "output_filename": fn,
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
    inputs = payload.get("inputs")
    if inputs is not None and not isinstance(inputs, list):
        return {"ok": False, "error": "inputs must be a list of {filename, bytes_b64}"}
    # Delegate to the GPU function. The web container is cheap; the GPU
    # container only runs when run_workflow.spawn is invoked.
    return run_workflow.remote(workflow, inputs)


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
@modal.fastapi_endpoint(method="POST", label="admin-spawn-workflow")
def admin_spawn_workflow(payload: Dict[str, Any], x_admin_token: str = Header(default="")) -> Dict[str, Any]:
    """Spawn a run_workflow function call. Returns the FunctionCall.object_id
    immediately so the caller can poll via admin-workflow-status. Body:
    {workflow_api_json: {...}}."""
    if not _check_admin(x_admin_token):
        return {"ok": False, "error": "unauthorized"}
    workflow = payload.get("workflow_api_json")
    if not isinstance(workflow, dict):
        return {"ok": False, "error": "workflow_api_json (object) required"}
    call = run_workflow.spawn(workflow)
    return {"ok": True, "call_id": call.object_id}


@app.function(timeout=60, secrets=[ADMIN_SECRET])
@modal.fastapi_endpoint(method="GET", label="admin-workflow-status")
def admin_workflow_status(call_id: str, x_admin_token: str = Header(default="")) -> Dict[str, Any]:
    """Poll a spawned run_workflow call. Returns one of:
      - {status: 'running'}                          — still in flight
      - {status: 'done',  result: {ok, image_bytes_b64, ...}}  — terminal success
      - {status: 'failed', error: str, preempted: bool}        — terminal failure
    `preempted: true` lets the caller decide to re-spawn the same workflow."""
    if not _check_admin(x_admin_token):
        return {"status": "failed", "error": "unauthorized"}
    try:
        fc = modal.FunctionCall.from_id(call_id)
    except Exception as e:
        return {"status": "failed", "error": f"unknown call_id: {e}"}
    try:
        result = fc.get(timeout=0)
        # run_workflow returns a dict — could be {ok: True, image_bytes_b64,...}
        # or {ok: False, error: '...'}. Pass through.
        if isinstance(result, dict) and result.get("ok") is False:
            err = result.get("error", "")
            return {
                "status": "failed",
                "error": result.get("detail") or err,
                "preempted": "preempt" in str(err).lower(),
                "result": result,
            }
        return {"status": "done", "result": result}
    except TimeoutError:
        return {"status": "running"}
    except Exception as e:
        # Modal raises certain exceptions when the FunctionCall failed
        # (e.g. preemption that exhausted Modal's own retries). Treat any
        # raise as terminal failure but flag preemption keywords.
        msg = str(e)
        return {
            "status": "failed",
            "error": msg,
            "preempted": "preempt" in msg.lower(),
        }


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


# Diagnostic — list installed custom nodes + verify Easy-Use is importable.
@app.function(timeout=30)
def inspect_image() -> Dict[str, Any]:
    import os, sys, importlib
    out: Dict[str, Any] = {}
    try:
        out["custom_nodes_dir"] = sorted(os.listdir("/opt/ComfyUI/custom_nodes"))
    except Exception as e:
        out["custom_nodes_dir_error"] = str(e)
    out["python_version"] = sys.version
    # Try importing dependencies the Easy-Use pack needs
    deps: Dict[str, str] = {}
    for mod in ("lark", "cv2", "torch", "comfy"):
        try:
            m = importlib.import_module(mod)
            deps[mod] = getattr(m, "__version__", "(no __version__)")
        except Exception as e:
            deps[mod] = f"IMPORT FAILED: {e}"
    out["deps"] = deps
    return out


@app.local_entrypoint()
def inspect():
    """Run inspect_image remotely and print its output."""
    result = inspect_image.remote()
    print(json.dumps(result, indent=2))


@app.local_entrypoint()
def diagnose():
    """Boot ComfyUI in a fresh container, print the startup log."""
    result = diagnose_startup.remote()
    print(f"started={result.get('started')}  error={result.get('error')}")
    print("--- log tail ---")
    print(result.get("log_tail", "(no log)"))


@app.function(gpu=GPU, timeout=120, volumes={"/opt/ComfyUI/models": models_volume})
def list_nodes(filter_substr: str = "") -> Dict[str, Any]:
    """Boot ComfyUI and return its registered node class names. Optionally
    filter by substring (case-insensitive)."""
    _start_comfy()
    info = _get_json("/object_info")
    keys = sorted(info.keys())
    if filter_substr:
        f = filter_substr.lower()
        keys = [k for k in keys if f in k.lower()]
    return {"count": len(keys), "names": keys}


@app.function(gpu=GPU, timeout=120, volumes={"/opt/ComfyUI/models": models_volume})
def probe_prompt_minimal() -> Dict[str, Any]:
    """Hit /object_info for 'easy loraStack' specifically (bypasses the
    full-dump issue), then POST a minimal /prompt with one loraStack node
    to see EXACTLY what ComfyUI says when the class lookup happens."""
    import urllib.parse
    _start_comfy()
    result: Dict[str, Any] = {}
    # 1. Direct lookup
    try:
        encoded = urllib.parse.quote("easy loraStack", safe="")
        obj = _get_json(f"/object_info/{encoded}")
        result["object_info_lookup"] = list(obj.keys())
    except Exception as e:
        result["object_info_error"] = str(e)

    # 2. Minimal /prompt with one easy loraStack node
    workflow = {
        "1": {
            "class_type": "easy loraStack",
            "inputs": {
                "toggle": True,
                "mode": "simple",
                "num_loras": 1,
                "lora_1_name": "None",
                "lora_1_strength": 1.0,
                "lora_1_model_strength": 1.0,
                "lora_1_clip_strength": 1.0,
            },
        },
    }
    try:
        r = _post_json("/prompt", {"prompt": workflow})
        result["prompt_response"] = r
    except Exception as e:
        result["prompt_error"] = str(e)
    return result


@app.local_entrypoint()
def probe():
    result = probe_prompt_minimal.remote()
    print(json.dumps(result, indent=2))


@app.local_entrypoint()
def nodes(filter_substr: str = ""):
    """List registered node class names, optionally filtered."""
    result = list_nodes.remote(filter_substr)
    print(json.dumps(result, indent=2))


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
