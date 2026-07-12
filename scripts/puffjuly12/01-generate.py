"""Generate 5 fresh puffjuly12 iterations via Modal scruple-runner.

Same FLUX Stay Puft workflow as project 180 but with FRESH seeds so we get
distinct outputs. Downloads each result + saves alongside its input manifest
+ output SHA-256.
"""
import json
import sys
import os
import time
import hashlib
import base64
from pathlib import Path

import modal

WORKSPACE = "aquanomous"
APP = "scruple-runner"

WORKFLOW_PATH = Path("/tmp/puffjuly12/workflow-api.json")
OUT_DIR = Path("/tmp/puffjuly12/iterations")

# Fresh seeds for puffjuly12. Bumped to 26071201-26071205 (date-derived) after
# ComfyUI cache-hit on the initial 712120 range wasted a Modal cold start.
SEEDS = [26071201, 26071202, 26071203, 26071204, 26071205]

def make_workflow(base: dict, seed: int, iter_num: int) -> dict:
    """Return a workflow tweaked for this iteration."""
    w = json.loads(json.dumps(base))
    w["25"]["inputs"]["noise_seed"] = seed
    w["9"]["inputs"]["filename_prefix"] = f"puffjuly12-{iter_num}"
    return w

def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def main():
    if not WORKFLOW_PATH.exists():
        print(f"missing workflow at {WORKFLOW_PATH}")
        sys.exit(2)
    base_workflow = json.loads(WORKFLOW_PATH.read_text())
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("connecting to modal function scruple-runner:run_workflow")
    fn = modal.Function.from_name(APP, "run_workflow")

    for i, seed in enumerate(SEEDS, start=1):
        iter_dir = OUT_DIR / f"{i}"
        iter_dir.mkdir(parents=True, exist_ok=True)
        if (iter_dir / "output.png").exists() and (iter_dir / "meta.json").exists():
            print(f"\n=== iteration {i} (seed={seed}) — already present, skipping")
            continue
        w = make_workflow(base_workflow, seed, i)

        # Save the workflow that was actually submitted
        wf_bytes = json.dumps(w, indent=2, sort_keys=True).encode()
        (iter_dir / "workflow_api.json").write_bytes(wf_bytes)

        print(f"\n=== iteration {i} (seed={seed}) ===")
        t0 = time.time()
        result = fn.remote(w, None)
        dt = time.time() - t0
        print(f"  modal returned in {dt:.1f}s")

        # Result shape (from modal/scruple_runner.py:run_workflow): image_bytes_b64 + attestation + model_fingerprints
        b64key = "image_bytes_b64" if "image_bytes_b64" in result else "output_bytes_b64"
        if not isinstance(result, dict) or b64key not in result:
            print(f"  UNEXPECTED result keys: {list(result.keys()) if isinstance(result, dict) else type(result)}")
            print(f"  result ok={result.get('ok') if isinstance(result, dict) else '?'}  error={result.get('error') if isinstance(result, dict) else '?'}")
            if isinstance(result, dict) and result.get("outputs_keys"):
                print(f"  outputs_keys: {result['outputs_keys']}")
            (iter_dir / "modal-error-dump.json").write_text(json.dumps({k: (v if isinstance(v, (str,int,float,list,dict,type(None))) else str(v)) for k,v in result.items()}, indent=2, default=str)[:20000])
            sys.exit(1)

        out_bytes = base64.b64decode(result[b64key])
        content_type = result.get("content_type") or result.get("output_content_type") or "image/png"
        ext = ".png" if content_type == "image/png" else ".bin"
        out_path = iter_dir / f"output{ext}"
        out_path.write_bytes(out_bytes)

        # Save the Modal-side attestation + model fingerprints as separate files (they're already-hashed inputs to leaf v2.2)
        if result.get("attestation"):
            (iter_dir / "modal-attestation.json").write_text(json.dumps(result["attestation"], indent=2))
        if result.get("model_fingerprints"):
            (iter_dir / "model-fingerprints.json").write_text(json.dumps(result["model_fingerprints"], indent=2))

        meta = {
            "iteration": i,
            "seed": seed,
            "workflow_sha256": sha256_hex(wf_bytes),
            "output_sha256": sha256_hex(out_bytes),
            "output_content_type": content_type,
            "output_bytes": len(out_bytes),
            "modal_filename": result.get("output_filename") or result.get("filename"),
            "modal_gpu": result.get("gpu"),
            "modal_duration_ms": result.get("duration_ms") or result.get("durationMs"),
            "modal_prompt_id": result.get("prompt_id"),
        }
        (iter_dir / "meta.json").write_text(json.dumps(meta, indent=2))
        print(f"  {out_path} ({len(out_bytes)} bytes, sha256={meta['output_sha256'][:16]}...)")

    print(f"\ndone. 5 iterations in {OUT_DIR}/")

if __name__ == "__main__":
    main()
