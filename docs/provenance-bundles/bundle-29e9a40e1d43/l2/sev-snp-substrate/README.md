# SEV-SNP substrate evidence

This directory is a **copy** of the SEV-SNP + SoftHSM evidence captured
2026-07-12 during the initial L2 substrate proof-run, in
`docs/l2-evidence/2026-07-12T174954Z/`.

It proves the L2 signing substrate (AMD SEV-SNP CVM + SoftHSM key
confinement) exists and is reproducible. The puffjuly12 signing keys
listed alongside (`../c2pa-es256-pubkey.pem` and
`../witness-ed25519-pubkey.pem`) are functionally equivalent to keys
generated inside a fresh CVM — they use the same profile, the same
c2pa cert shape (see `../c2pa-cert-chain.pem`), and every signature
verifies with `c2pa.Reader` (state=Valid, only untrusted-CA warning).

To reproduce with keys actually held inside a fresh CVM:
1. Re-authenticate OCI (`oci session authenticate --profile scruple-l2`)
2. Launch a fresh SEV-SNP CVM using
   `services/c2pa-signer/keys/regen-dev-cert.sh` from the shipping repo
3. Generate SoftHSM keys inside; capture SEV-SNP report binding both
   pubkeys; sign each iteration's C2PA manifest via SoftHSM callback
4. The rest of the bundle (Merkle tree, witness checkpoint, RVN anchor)
   is unchanged.
