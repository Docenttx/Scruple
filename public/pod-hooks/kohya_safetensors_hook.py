"""Scruple × Kohya-ss safetensors hook — WO-KOHYA Phase 4.

Installed as `sitecustomize.py` so Python auto-loads it before any
user code. Monkey-patches `safetensors.torch.save_file` — the single
call site Kohya-ss (via networks/lora.py::LoRANetwork.save_weights)
uses to write every LoRA checkpoint.

On every save:
  1. Original save_file runs (writes the safetensors file to disk).
  2. Hook sha256-hashes the file, extracts the header and a sha256 of
     the raw header bytes (header_hash), and POSTs both to scruple-web
     with the pod-side identity + session id.
  3. scruple-web RECORDS the checkpoint — it inserts an
     app_kohya_progress row and a training_runs row — but does NOT
     sign a witness leaf from this path. `POST /api/apps/kohya/witness`
     says so honestly: its response carries `witnessed: false`.
     Checkpoints trained through this hook are recorded, not
     witnessed, until capture moves out of the pod. See
     docs/canon/STUDIO_P1-P8_GRADE.md (Path B — Kohya) and
     docs/canon/WO-05-studio-comfyui-kohya.md (T-4) for why and what
     the fix looks like. Step 3 above must not be read as "a leaf gets
     signed" — it does not, today.

Env vars set by scruple-web when it spawned the pod:
  SCRUPLE_USER_ID          — user's account id
  SCRUPLE_APP_ID           — 'kohya'
  SCRUPLE_WITNESS_URL      — https://scruple.stooges.ai/api/apps/kohya/witness
  SCRUPLE_WITNESS_SECRET   — HMAC shared secret (rotate per-deploy)
  SCRUPLE_SESSION_ID       — the app_sessions row id
  RUNPOD_POD_ID            — auto-injected by RunPod

Two KNOWN EVIDENTIARY GAPS below are left unchanged on purpose —
training must not break on account of our instrumentation — but they
are gaps, not features, and are tracked as such in
docs/canon/STUDIO_P1-P8_GRADE.md (Path B — Kohya, P1/P5):
  - If any env var is missing, the hook is a silent no-op: Kohya still
    trains, but the checkpoint is neither recorded nor witnessed, and
    nothing surfaces that to the operator beyond a one-time log line.
  - POST errors to scruple-web are swallowed: a checkpoint can go
    unrecorded with no surfaced failure if scruple-web is unreachable.

CANONICAL COPY — there are two copies of this file in the repo and
they must be kept byte-identical:
  - public/pod-hooks/kohya_safetensors_hook.py is what production
    actually runs: the RunPod template's dockerStartCmd curls this
    exact URL (https://scruple.stooges.ai/pod-hooks/
    kohya_safetensors_hook.py) at pod boot and drops it in as
    sitecustomize.py. This is the one that wins if the two ever
    disagree.
  - research/scruple-kohya-image/scruple_safetensors_hook.py is baked
    by that directory's Dockerfile into a custom image build, which
    docs/canon/WO-05-studio-comfyui-kohya.md marks superseded —
    production does not use that image. The file is kept in sync
    anyway so the Dockerfile still builds a working image if that path
    is ever revived.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
import traceback
from typing import Any

_LOGGED_ONCE: dict[str, bool] = {}


def _log_once(key: str, msg: str) -> None:
    if _LOGGED_ONCE.get(key):
        return
    _LOGGED_ONCE[key] = True
    print(f"[scruple-hook] {msg}", flush=True)


def _sha256_of(path: str) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def _extract_safetensors_header(path: str) -> tuple[dict[str, Any] | None, str | None]:
    """Parse a safetensors file's JSON header + return SHA-256 of the raw header bytes.

    The header_hash lets a verifier confirm the model's structural fingerprint
    (layer names + shapes + dtypes) independently of the full content_hash —
    it survives metadata-only tampering that changes bytes elsewhere in the
    file but preserves the tensor structure. Both hashes are written into
    training_runs by the /api/apps/kohya/witness route.
    """
    try:
        with open(path, "rb") as f:
            header_len_bytes = f.read(8)
            if len(header_len_bytes) < 8:
                return None, None
            header_len = int.from_bytes(header_len_bytes, "little")
            if header_len <= 0 or header_len > 20_000_000:  # sanity
                return None, None
            header_bytes = f.read(header_len)
        header_hash = hashlib.sha256(header_bytes).hexdigest()
        return json.loads(header_bytes.decode("utf-8")), header_hash
    except Exception:
        return None, None


def _post_witness(payload: dict[str, Any]) -> None:
    """Fire-and-forget POST to scruple-web. Ignores errors."""
    url = os.environ.get("SCRUPLE_WITNESS_URL")
    secret = os.environ.get("SCRUPLE_WITNESS_SECRET", "")
    if not url:
        _log_once("no_url", "SCRUPLE_WITNESS_URL unset — hook is no-op")
        return

    body = json.dumps(payload, sort_keys=True).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest() if secret else ""

    try:
        # stdlib only — don't add a requests dep to Kohya's env
        import urllib.request
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Scruple-Signature": signature,
            },
            method="POST",
        )
        # 10s timeout so we don't hang training if scruple-web is down
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
    except Exception as e:
        _log_once("post_err", f"witness POST failed: {type(e).__name__}: {e}")


def _install() -> None:
    try:
        import safetensors.torch as _st  # type: ignore
    except ImportError:
        _log_once("no_safetensors", "safetensors.torch not importable — skip")
        return

    original_save_file = _st.save_file

    def scruple_save_file_hook(tensors: Any, filename: str, metadata: dict[str, Any] | None = None) -> None:
        # Delegate first so we never break Kohya even if our hook errors
        original_save_file(tensors, filename, metadata)

        try:
            sha, size = _sha256_of(filename)
            header, header_hash = _extract_safetensors_header(filename)
            # Compact structural summary — layers + shapes + dtypes.
            structural_summary: dict[str, Any] = {}
            if header:
                meta = header.pop("__metadata__", {}) if isinstance(header, dict) else {}
                structural_summary = {
                    "layer_count": len(header) if isinstance(header, dict) else 0,
                    "layers": (
                        [
                            {"name": name, "shape": info.get("shape"), "dtype": info.get("dtype")}
                            for name, info in list(header.items())[:50]
                        ]
                        if isinstance(header, dict)
                        else []
                    ),
                    "metadata": meta,
                }

            payload = {
                "event": "checkpoint_save",
                "path": filename,
                "output_hash": sha,
                "header_hash": header_hash,
                "size_bytes": size,
                "structural_summary": structural_summary,
                "pod_id": os.environ.get("RUNPOD_POD_ID"),
                "user_id": os.environ.get("SCRUPLE_USER_ID"),
                "app_id": os.environ.get("SCRUPLE_APP_ID", "kohya"),
                "session_id": os.environ.get("SCRUPLE_SESSION_ID"),
                "client_timestamp": time.time(),
            }
            # Fire in a background thread so training's save loop
            # isn't blocked on network I/O.
            threading.Thread(
                target=_post_witness,
                args=(payload,),
                daemon=True,
                name="scruple-witness-post",
            ).start()
        except Exception:
            _log_once("hook_err", f"post-save hook error:\n{traceback.format_exc()}")

    _st.save_file = scruple_save_file_hook  # type: ignore
    _log_once("installed", "safetensors.torch.save_file wrapped")


_install()
