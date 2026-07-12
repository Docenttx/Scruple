#!/bin/bash
# Regenerate the local-mode dev cert chain for services/c2pa-signer.
#
# Produces:
#   signer.key       — leaf ES256 private key (raw PEM, no password)
#   signer.pem       — leaf + root cert chain, in the order c2pa-rs expects (leaf first)
#   signer-root.pem  — root only (for future trust-anchor testing)
#
# Why not one openssl-req-x509 self-signed cert:
#   c2pa-rs 0.86+ rejects self-signed leaf certs ("Signature: the certificate
#   is invalid") — the leaf MUST be issued by a distinct CA cert whose Subject
#   != leaf's Subject. Isolated 2026-07-12.
#
# Why the full DN (C/ST/L/O/OU/CN):
#   c2pa-rs additionally requires the leaf's Distinguished Name to have all
#   the standard attributes present, not just CN. A CN-only DN passes the cert
#   validator but signatures produced under it fail with
#   `claimSignature.mismatch` from c2pa.Reader. Isolated 2026-07-12.
set -eu
D=$(dirname "$0")
cd "$D"

CONF=cert.cnf
[ -f "$CONF" ] || { echo "cert.cnf missing"; exit 1; }

# ---- Root CA ----
openssl ecparam -name prime256v1 -genkey -noout -out root.key
openssl req -new -x509 -key root.key -days 3650 \
    -subj "/C=US/ST=CA/L=Somewhere/O=Scruple Dev Root CA/OU=FOR TESTING_ONLY/CN=Scruple Dev Root CA" \
    -extensions v3_ca \
    -config <(cat <<'EOF'
[req]
distinguished_name = req_distinguished_name
prompt = no
[req_distinguished_name]
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
) -out signer-root.pem

# ---- Leaf (end-entity signing cert) ----
openssl ecparam -name prime256v1 -genkey -noout -out signer.key
openssl req -new -key signer.key -out /tmp/scruple-leaf-csr.$$ -config "$CONF"
openssl x509 -req -in /tmp/scruple-leaf-csr.$$ -CA signer-root.pem -CAkey root.key \
    -CAcreateserial -days 365 \
    -extfile "$CONF" -extensions v3_req \
    -out /tmp/scruple-leaf.$$

# Chain order: leaf first, then root (c2pa-rs walks the chain top-down)
cat /tmp/scruple-leaf.$$ signer-root.pem > signer.pem

rm -f /tmp/scruple-leaf-csr.$$ /tmp/scruple-leaf.$$ root.key ./*.srl

echo "-- signer.pem --"
grep -c "^-----BEGIN CERTIFICATE-----" signer.pem
openssl x509 -in signer.pem -noout -subject -issuer
