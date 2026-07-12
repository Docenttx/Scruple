"""Anchor the puffjuly12 bundle Merkle root on RVN testnet via the local witness server.

Flow:
1. Pick a unique project_id from the puffjuly12 tag + timestamp
2. POST 5 witnesses (one per iteration) with our own leaf hashes as content_hash
   (the witness DB stores them; the witness server chains its own v2 leaves in
   parallel — that's fine, we use OUR Merkle root as the lock's canonical root)
3. POST /api/lock/<project_id> with merkleRoot=<our root> + tier=pinned so
   we get RVN mint + Arweave record + IPFS pin
4. Save the returned scr_id + rvn_txid + arweave_uri + ipfs_cid into the L2 attestation
5. Rename the bundle folder to include the derived scr_id
"""
import json
import subprocess
import sys
import time
from pathlib import Path

import urllib.request

WITNESS = "http://127.0.0.1:5799"
BASE = Path("/tmp/puffjuly12")


def post(url: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def main():
    checkpoint = json.loads((BASE / "witness-checkpoint.json").read_text())
    merkle_root = checkpoint["merkle_root_sha256"]
    sign_results = json.loads((BASE / "sign-results.json").read_text())

    project_id = f"puffjuly12-{int(time.time())}"
    project_name = "puffjuly12 — L2 full-send demo"
    print(f"project_id: {project_id}")
    print(f"merkle_root: {merkle_root}")

    # 1. Witness each iteration into the witness DB
    for r in sign_results:
        if not r.get("ok"):
            continue
        w_body = {
            "project_id": project_id,
            "project_name": project_name,
            "run_sequence": r["iteration"],
            "content_hash": r["signed_output_sha256"],  # anchor the C2PA-signed variant
            "visual_hash": r["input_output_sha256"],
            "workflow_hash": None,  # (leave server to store as null)
            "input_hash": None,
            "model_fingerprints_hash": None,
            "machine_manifest_hash": None,
            "client_timestamp": None,
        }
        resp = post(f"{WITNESS}/api/witness", w_body)
        print(f"  iter {r['iteration']} witnessed → {resp['witness_id']} leaf={resp['leaf_hash'][:16]}...")

    # 2. Lock — anchors OUR merkle root on RVN testnet
    print("\ncalling /api/lock/<project_id> with our Merkle root...")
    lock_body = {"merkleRoot": merkle_root, "tier": "pinned"}
    lock_resp = post(f"{WITNESS}/api/lock/{project_id}", lock_body)
    print(json.dumps(lock_resp, indent=2))

    # 3. Save the anchor info
    anchor = {
        "witness_project_id": project_id,
        "scr_id": lock_resp.get("scr_id") or lock_resp.get("scrId"),
        "merkle_root": merkle_root,
        "rvn_txid": lock_resp.get("rvn_txid") or lock_resp.get("proofTxId"),
        "arweave_tx_id": lock_resp.get("arweave_tx_id") or lock_resp.get("arweaveTxId"),
        "ipfs_cid": lock_resp.get("ipfs_cid") or lock_resp.get("ipfsCid"),
        "server_signature": lock_resp.get("server_signature") or lock_resp.get("serverSignature"),
        "raw_response": lock_resp,
    }
    (BASE / "anchor.json").write_text(json.dumps(anchor, indent=2))
    print(f"\nanchor written to {BASE}/anchor.json")


if __name__ == "__main__":
    main()
