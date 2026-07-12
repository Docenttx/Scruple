"""Build a witness Merkle tree over the 5 iteration leaves + Ed25519-sign the root.

Leaf preimage per iteration (canonical JSON, sorted keys, no whitespace):
  {
    "iteration": <n>,
    "output_sha256": <hex>,
    "signed_output_sha256": <hex>,
    "workflow_sha256": <hex>,
    "modal_prompt_id": <str>,
    "modal_gpu": <str>,
    "c2pa_reader_state": "Valid"
  }
leaf_hash = SHA256(canonical_json)

Merkle: balanced tree, duplicate the last leaf when odd.
Ed25519 signature over: sha256("puffjuly12/checkpoint/v1|" || bundle_root)
"""
import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

BASE = Path("/tmp/puffjuly12")
KEYS = BASE / "keys"
ITERS = BASE / "iterations"

sign_results = json.loads((BASE / "sign-results.json").read_text())
by_iter = {r["iteration"]: r for r in sign_results if r.get("ok")}


def canon(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


leaves = []
leaf_preimages = []
for i in sorted(by_iter.keys()):
    r = by_iter[i]
    d = ITERS / str(i)
    meta = json.loads((d / "meta.json").read_text())
    preimage = {
        "iteration": i,
        "output_sha256": r["input_output_sha256"],
        "signed_output_sha256": r["signed_output_sha256"],
        "workflow_sha256": meta["workflow_sha256"],
        "modal_prompt_id": meta.get("modal_prompt_id"),
        "modal_gpu": meta.get("modal_gpu"),
        "c2pa_reader_state": r["c2pa_reader_state"],
    }
    j = canon(preimage)
    h = sha256_hex(j)
    leaf_preimages.append({"iteration": i, "preimage_json": preimage, "leaf_hash": h})
    leaves.append(bytes.fromhex(h))


def merkle_root(nodes: list[bytes]) -> tuple[bytes, list[list[str]]]:
    """Return (root_bytes, levels_hex). levels_hex[0] = leaves, levels_hex[-1] = [root]."""
    levels = [[n.hex() for n in nodes]]
    cur = nodes[:]
    while len(cur) > 1:
        if len(cur) % 2:
            cur.append(cur[-1])  # duplicate last leaf on odd count
        nxt = []
        for i in range(0, len(cur), 2):
            nxt.append(hashlib.sha256(cur[i] + cur[i+1]).digest())
        cur = nxt
        levels.append([n.hex() for n in cur])
    return cur[0], levels


root_bytes, levels = merkle_root(leaves)
root_hex = root_bytes.hex()

# Ed25519 sign
w_priv_pem = (KEYS / "witness-ed25519.pem").read_bytes()
w_priv = serialization.load_pem_private_key(w_priv_pem, password=None)
assert isinstance(w_priv, Ed25519PrivateKey)

sign_input = b"puffjuly12/checkpoint/v1|" + root_bytes
sig = w_priv.sign(sign_input)

checkpoint = {
    "scheme": "puffjuly12/checkpoint/v1",
    "epoch": 1,
    "leaf_count": len(leaves),
    "merkle_root_sha256": root_hex,
    "sign_input_sha256": hashlib.sha256(sign_input).hexdigest(),
    "signature_ed25519_b64": __import__("base64").b64encode(sig).decode(),
    "signer_pubkey_pem": (KEYS / "witness-ed25519-pubkey.pem").read_text(),
    "signer_pubkey_sha256": (KEYS / "witness-ed25519-pubkey-sha256.txt").read_text().strip(),
    "leaves": leaf_preimages,
    "merkle_levels_hex": levels,
}
(BASE / "witness-checkpoint.json").write_text(json.dumps(checkpoint, indent=2))

# Verify sig against pubkey (defensive: prove independence)
from cryptography.exceptions import InvalidSignature
w_pub = w_priv.public_key()
try:
    w_pub.verify(sig, sign_input)
    verify_ok = True
except InvalidSignature:
    verify_ok = False
print(f"witness checkpoint written — merkle_root: {root_hex}")
print(f"  leaves: {len(leaves)}, ed25519 sig verify OK: {verify_ok}")
