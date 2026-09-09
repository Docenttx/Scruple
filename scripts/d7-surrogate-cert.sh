#!/usr/bin/env bash
# A CERTIFICATE FOR THE KEY THAT ACTUALLY SIGNS.
#
# WO-D7 found this and it is the reason this script exists. With
# SCRUPLE_C2PA_VAULT_KEY_OCID + SCRUPLE_C2PA_KMS_ENDPOINT set, the C2PA signer
# signs through the CVM surrogate — a DIFFERENT key from the local dev one —
# and still embeds `keys/signer.pem`, the certificate issued for the LOCAL key.
# The signer does not check that the two agree, so it returns `ok: true` and
# c2pa.Reader answers `claimSignature.mismatch`: a credential nothing can
# verify, produced by a call that reported success.
#
# This issues a leaf certificate whose PUBLIC KEY IS THE SURROGATE'S, under a
# root generated here, so a surrogate-signed credential validates as far as a
# dev chain can — `signingCredential.untrusted` remains and MUST remain, because
# nobody has any business trusting this root.
#
# 🔴 The surrogate's PRIVATE key is never touched, read or copied: the public
# half comes off its own /testnet/pubkey.pem endpoint and openssl's
# -force_pubkey does the rest. The root key produced here stays under .run/
# (gitignored) and is deleted at the end, exactly as
# services/c2pa-signer/keys/regen-dev-cert.sh deletes its own.
set -euo pipefail
cd "$(dirname "$0")/.."
SURROGATE="${SCRUPLE_CVM_SURROGATE:-http://127.0.0.1:8799}"
OUT="${D7_CERT_DIR:-$PWD/.run/d7/c2pa-surrogate}"
CNF="${SCRUPLE_WEB_ROOT:-/data/scruple-web}/services/c2pa-signer/keys/cert.cnf"

case "$SURROGATE" in *:5799*|*:3001*) echo "!! $SURROGATE is production; refusing"; exit 2;; esac
[ -f "$CNF" ] || { echo "!! no cert.cnf at $CNF"; exit 2; }

mkdir -p "$OUT"; chmod 700 "$OUT"
curl -sS -m 15 "$SURROGATE/testnet/pubkey.pem" > "$OUT/surrogate-pub.pem"
grep -q "BEGIN PUBLIC KEY" "$OUT/surrogate-pub.pem" || { echo "!! the surrogate served no public key"; exit 2; }

# The root. Its DN differs from the leaf's, which c2pa-rs requires — a
# self-signed leaf is rejected outright (regen-dev-cert.sh, isolated 2026-07-12).
openssl ecparam -name prime256v1 -genkey -noout -out "$OUT/root.key" 2>/dev/null
chmod 600 "$OUT/root.key"
openssl req -new -x509 -key "$OUT/root.key" -days 365 \
  -subj "/C=US/ST=CA/L=Somewhere/O=Scruple Surrogate Dev Root CA/OU=FOR TESTING_ONLY/CN=Scruple Surrogate Dev Root CA" \
  -extensions v3_ca \
  -config <(printf '[req]\ndistinguished_name=d\nprompt=no\n[d]\n[v3_ca]\nbasicConstraints=critical, CA:TRUE\nkeyUsage=critical, keyCertSign, cRLSign\nsubjectKeyIdentifier=hash\n') \
  -out "$OUT/surrogate-root.pem" 2>/dev/null

# A throwaway key makes the CSR; -force_pubkey replaces its public half with the
# surrogate's, so the issued certificate attests a key this box cannot use.
openssl ecparam -name prime256v1 -genkey -noout -out "$OUT/throwaway.key" 2>/dev/null
openssl req -new -key "$OUT/throwaway.key" -out "$OUT/leaf.csr" -config "$CNF" 2>/dev/null
openssl x509 -req -in "$OUT/leaf.csr" -force_pubkey "$OUT/surrogate-pub.pem" \
  -CA "$OUT/surrogate-root.pem" -CAkey "$OUT/root.key" -CAcreateserial -days 365 \
  -extfile "$CNF" -extensions v3_req -out "$OUT/surrogate-leaf.pem" 2>/dev/null

cat "$OUT/surrogate-leaf.pem" "$OUT/surrogate-root.pem" > "$OUT/surrogate-chain.pem"
rm -f "$OUT/root.key" "$OUT/throwaway.key" "$OUT/leaf.csr" "$OUT"/*.srl

# The check that makes this script's claim a measurement: the certificate's
# public key and the surrogate's public key are the same bytes.
A=$(openssl x509 -in "$OUT/surrogate-leaf.pem" -noout -pubkey | openssl ec -pubin -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
B=$(openssl ec -pubin -in "$OUT/surrogate-pub.pem" -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
if [ "$A" != "$B" ]; then echo "!! the issued cert does not carry the surrogate's public key"; exit 2; fi
echo "chain      $OUT/surrogate-chain.pem"
echo "public key $A  (== the surrogate's)"
openssl x509 -in "$OUT/surrogate-leaf.pem" -noout -subject -issuer
