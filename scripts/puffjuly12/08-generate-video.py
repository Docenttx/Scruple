"""Run one LTX-Video img2vid iteration on Modal using puffjuly12 iter 1 as source frame."""
import base64
import hashlib
import json
import time
from pathlib import Path

import modal

WORKFLOW = Path("/tmp/puffjuly12/video-workflow.json")
INPUT_IMG = Path("/tmp/puffjuly12/iterations/1/output.png")
OUT_DIR = Path("/tmp/puffjuly12/video-iteration")
OUT_DIR.mkdir(parents=True, exist_ok=True)

def sha256_hex(data): return hashlib.sha256(data).hexdigest()

workflow = json.loads(WORKFLOW.read_text())
input_bytes = INPUT_IMG.read_bytes()
inputs = [{"filename": "puff-input.png", "bytes_b64": base64.b64encode(input_bytes).decode()}]

fn = modal.Function.from_name("scruple-runner", "run_workflow")
print(f"submitting video workflow with puff-input.png ({len(input_bytes)} bytes, sha256={sha256_hex(input_bytes)[:16]}...)")
t0 = time.time()
result = fn.remote(workflow, inputs)
dt = time.time() - t0
print(f"modal returned in {dt:.1f}s")

if not isinstance(result, dict) or not result.get("ok"):
    print("FAILED:")
    print(json.dumps(result, indent=2, default=str)[:2000] if isinstance(result, dict) else str(result))
    import sys; sys.exit(1)

# Success — extract output
b64key = "image_bytes_b64" if "image_bytes_b64" in result else "output_bytes_b64"
out_bytes = base64.b64decode(result[b64key])
content_type = result.get("content_type", "video/webm")
ext = {"video/webm":".webm", "video/mp4":".mp4", "image/gif":".gif"}.get(content_type, ".bin")
out_path = OUT_DIR / f"output{ext}"
out_path.write_bytes(out_bytes)

# Save the workflow + meta
wf_bytes = json.dumps(workflow, indent=2, sort_keys=True).encode()
(OUT_DIR / "workflow_api.json").write_bytes(wf_bytes)
(OUT_DIR / "input-frame.png").write_bytes(input_bytes)
if result.get("model_fingerprints"):
    (OUT_DIR / "model-fingerprints.json").write_text(json.dumps(result["model_fingerprints"], indent=2))

meta = {
    "iteration": 1,
    "kind": "img2vid",
    "model": "ltx-video-2b-v0.9.5",
    "input_image_sha256": sha256_hex(input_bytes),
    "workflow_sha256": sha256_hex(wf_bytes),
    "output_sha256": sha256_hex(out_bytes),
    "output_content_type": content_type,
    "output_bytes": len(out_bytes),
    "modal_filename": result.get("output_filename"),
    "modal_gpu": result.get("gpu"),
    "modal_duration_ms": result.get("duration_ms"),
    "modal_prompt_id": result.get("prompt_id"),
}
(OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2))
print(f"video written: {out_path} ({len(out_bytes)} bytes, sha256={meta['output_sha256'][:16]}..., type={content_type})")
