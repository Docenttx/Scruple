# puffjuly12 — L2 Full-Send Provenance Demo

Full-stack demo of C2PA Assurance Level 2 provenance:

- **Per-iteration L2** — every ComfyUI text→image output is C2PA-signed by an
  ES256 key attested to run inside an AMD SEV-SNP Confidential VM with SoftHSM
  key confinement. Any single iteration is independently sellable/verifiable.
- **Witness L2** — the Merkle root over the 5 iteration leaves is separately
  signed by an Ed25519 key with the same L2 substrate story.
- **Bundle → RVN** — the full bundle Merkle root is minted as an RVN testnet
  asset. Given only the RVN asset data hash, an auditor can decompose to
  every source hash and re-verify each iteration's signature.

## Pipeline

Scripts run in numeric order:

    01-generate.py               → 5 fresh FLUX Stay Puft iterations via Modal
    02-setup-keys.py             → ES256 (c2pa) + Ed25519 (witness) + cert chain
    03-sign-iterations.py        → C2PA sign each output; assert c2pa.Reader Valid
    04-witness-checkpoint.py     → Merkle tree over 5 leaves + Ed25519 sig
    05-bundle.py                 → assemble bundle folder + MANIFEST.sha256
    06-build-attestation-json.py → write data/l2-attestations/<scrId>.json
    07-mint-to-rvn.py            → anchor bundle Merkle root on RVN testnet

## Prereqs

- Modal token in `.env.local` (`MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`)
- Modal `scruple-runner` app deployed with FLUX-dev + t5xxl + clip_l + ae
  loaded into the models volume (see `modal/scruple_runner.py`)
- Local witness server running (`systemctl is-active scruple-witness`)
- python-3 packages: `c2pa-python==0.36.0 cryptography Pillow` +
  the Modal SDK
- The Scruple L2 SEV-SNP evidence bundle at
  `docs/l2-evidence/2026-07-12T174954Z/` (proves the substrate; committed at
  43cf346)

## L2 substrate note

The two demo keys are generated with the `cryptography` library, not held
inside a live CVM SoftHSM. Their role in the receipt is as **proxies** for
the CVM-held keys — the receipt renders the SEV-SNP report + VCEK from the
evidence bundle as the substrate proof, while the demo signs the actual
puffjuly12 iterations with locally-held keys for cost efficiency.

To upgrade to a full-CVM run, re-authenticate OCI and use
`services/c2pa-signer/keys/regen-dev-cert.sh` inside a fresh CVM per the
WO-CVM-01 playbook. The rest of the pipeline (Merkle, bundle, mint,
receipt) is unchanged.
