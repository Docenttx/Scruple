#!/usr/bin/env python3
"""Build a REAL, LOADABLE model file for the WO-D4 model store.

⚑ WHY THIS IS NOT `head -c 7384 /dev/urandom`.

The whole claim under test is that the fingerprint is of the FILE, taken from
a model store a real ComfyUI really loaded from. Random bytes with a .safetensors
extension would fingerprint identically well and would prove nothing, because
`UpscaleModelLoader` would refuse them and there would be no generation to
attach the leaf to. So this writes a genuine SRVGGNetCompact ("RealESRGAN
Compact") state dict — spandrel detects the architecture from the tensor names,
ComfyUI's `ImageUpscaleWithModel` runs it on CPU, and the output PNG is the
product of THESE weights.

It is tiny on purpose: num_feat=8, num_conv=1 is 1700 parameters and ~7 KB, so
a full generation costs milliseconds and the overnight loop can afford one per
mutation.

THE SEED IS THE CONTROL. Two seeds give two different sets of weights with
IDENTICAL tensor names and shapes — so the file is the same length and its
safetensors HEADER hash is unchanged, while its CONTENT hash moves. That is
exactly the swap WO-D4 asks for: "swap a model file's bytes while keeping its
filename and show the fingerprint changes."

    python3 scripts/d4-make-model.py <out.safetensors> <seed:int>
"""
import sys, hashlib, json

import torch
from safetensors.torch import save_file
from spandrel.architectures.Compact import Compact

out, seed = sys.argv[1], int(sys.argv[2])
torch.manual_seed(seed)
model = Compact(num_in_ch=3, num_out_ch=3, num_feat=8, num_conv=1, upscale=2)
save_file({k: v.contiguous() for k, v in model.state_dict().items()}, out)

raw = open(out, "rb").read()
header_len = int.from_bytes(raw[:8], "little")
print(json.dumps({
    "path": out,
    "seed": seed,
    "bytes": len(raw),
    "sha256": hashlib.sha256(raw).hexdigest(),
    "header_size": header_len,
    "header_hash": hashlib.sha256(raw[8:8 + header_len]).hexdigest(),
}))
