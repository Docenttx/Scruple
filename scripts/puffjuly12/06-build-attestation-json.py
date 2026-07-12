"""Build the data/l2-attestations/<scrId>.json that the receipt page reads.

Populates the L2Attestation shape defined in lib/l2/attestation.ts using the
bundle we already assembled + the SEV-SNP evidence captured earlier today.
"""
import hashlib
import json
import re
import subprocess
from pathlib import Path
from datetime import datetime, timezone

BASE = Path("/tmp/puffjuly12")
KEYS = BASE / "keys"
SEV = Path("/data/scruple-web/docs/l2-evidence/2026-07-12T174954Z")
SCR_ID_ARG = "SCR_PUFFJULY12"  # override at CLI if minting

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def cert_subject_issuer(pem_path: Path) -> tuple[str, str]:
    out = subprocess.check_output(["openssl", "x509", "-in", str(pem_path), "-noout", "-subject", "-issuer"]).decode()
    subj = re.search(r"subject=(.+)", out).group(1).strip()
    iss  = re.search(r"issuer=(.+)", out).group(1).strip()
    return subj, iss

# ------ Load pieces already produced ------
sign_results = json.loads((BASE / "sign-results.json").read_text())
checkpoint = json.loads((BASE / "witness-checkpoint.json").read_text())
merkle_root = checkpoint["merkle_root_sha256"]

leaves = []
for lf in checkpoint["leaves"]:
    p = lf["preimage_json"]
    leaves.append({
        "iteration": p["iteration"],
        "output_sha256": p["output_sha256"],
        "signed_output_sha256": p["signed_output_sha256"],
        "workflow_sha256": p["workflow_sha256"],
        "c2pa_reader_state": p["c2pa_reader_state"],
    })

# ------ C2PA cert details ------
signer_leaf_pem = KEYS / "c2pa-signer-leaf.pem"
root_ca_pem     = KEYS / "c2pa-root-ca.pem"
signer_subj, signer_iss = cert_subject_issuer(signer_leaf_pem)
root_subj,   _          = cert_subject_issuer(root_ca_pem)
chain_pem = KEYS / "c2pa-cert-chain.pem"
signer_pubkey_sha = (KEYS / "c2pa-es256-pubkey-sha256.txt").read_text().strip()
chain_sha = sha256_file(chain_pem)

# ------ Witness signer details ------
witness_pubkey_sha = (KEYS / "witness-ed25519-pubkey-sha256.txt").read_text().strip()

# ------ SEV-SNP substrate details ------
sev_measurement = (SEV / "measurement.hex").read_text().strip()
sev_chip_id     = (SEV / "chip-id.hex").read_text().strip()
sev_tcb         = (SEV / "reported-tcb.hex").read_text().strip()
sev_vcek_sha    = sha256_file(SEV / "vcek.der")
sev_bound       = (SEV / "signer-pubkey-sha256.txt").read_text().strip()

# ------ Assemble ------
BUNDLE = next(p for p in BASE.iterdir() if p.name.startswith("bundle-"))
bundle_root_sha = sha256_file(BUNDLE / "BUNDLE.merkle-root.txt")

attestation = {
    "scr_id": SCR_ID_ARG,
    "bundle_root": bundle_root_sha,
    "bundle_relpath": f"docs/provenance-bundles/{BUNDLE.name}",
    "merkle_root_sha256": merkle_root,
    "c2pa": {
        "signer_cert_subject": signer_subj,
        "signer_cert_issuer":  signer_iss,
        "root_ca_subject":     root_subj,
        "signer_pubkey_sha256": signer_pubkey_sha,
        "cert_chain_sha256":    chain_sha,
        "profile_notes": "Full-DN cert (C/ST/L/O/OU/CN) issued by distinct root CA, EKU=critical emailProtection, KU=digitalSignature+nonRepudiation. Cert profile fix landed 2026-07-12 (commit 43cf346).",
    },
    "witness": {
        "signer_pubkey_sha256": witness_pubkey_sha,
        "signer_pubkey_alg": "Ed25519",
        "signature_b64": checkpoint["signature_ed25519_b64"],
        "sign_input_prefix": "puffjuly12/checkpoint/v1|",
    },
    "sev_snp_substrate": {
        "evidence_relpath": "docs/l2-evidence/2026-07-12T174954Z",
        "vm_measurement_hex": sev_measurement,
        "chip_id_hex": sev_chip_id,
        "reported_tcb_hex": sev_tcb,
        "vcek_der_sha256": sev_vcek_sha,
        "signer_pubkey_bound_sha256": sev_bound,
    },
    "leaves": leaves,
    "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}

# Write to the receipt's expected location
out_dir = Path("/data/scruple-web/data/l2-attestations")
out_dir.mkdir(parents=True, exist_ok=True)
out_path = out_dir / f"{SCR_ID_ARG}.json"
out_path.write_text(json.dumps(attestation, indent=2))
print(f"wrote {out_path}")
print(f"  merkle_root: {merkle_root}")
print(f"  bundle: {BUNDLE.name}")
