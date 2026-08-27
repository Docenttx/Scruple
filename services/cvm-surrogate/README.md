# CVM surrogate

A live HTTP service that answers the same requests the real Signer CVM
answers, with the same response shapes, so the signing path can be built
and exercised without an Oracle Confidential VM running.

**The model is Ravencoin testnet, not a mocking library.** Testnet speaks
the real protocol over a real socket; what makes it safe is that its
addresses carry a prefix that cannot collide with mainnet. Same idea
here — the wire format is identical, and every identifier is visibly a
surrogate identifier.

## Run it

```
python3 surrogate.py                    # 127.0.0.1:8799
SURROGATE_PORT=9000 python3 surrogate.py
python3 -m pytest tests/                # 13 tests
```

Point the signer at it:

```
export SCRUPLE_C2PA_VAULT_KEY_OCID=ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey
export SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT=http://127.0.0.1:8799
```

## Surfaces

| Method | Path | Stands in for |
|---|---|---|
| POST | `/20180608/sign` | OCI KMS Crypto Sign — what `vault_sign.py` calls |
| GET | `/opc/v2/instance/` | OCI IMDSv2 — what `signer_runtime.py` reads |
| GET | `/20180608/keys/{ocid}` | KMS key metadata |
| GET | `/testnet/pubkey.pem` | the verifying key. **Not an OCI surface** — real KMS serves this from the management API. Here so a verifier can check a surrogate-signed leaf with no OCI credentials |
| GET | `/health` | liveness |

The signatures are **real ECDSA P-256 over a real key**. They verify.
What is absent is any hardware that protected the key.

## What makes it unmistakable

- Every OCID contains `.surrogate.`; the region is `us-surrogate-1`.
  No real OCI identifier can look like this.
- Every response carries `X-Scruple-Surrogate: 1` — one header to check
  if a caller wants to refuse to talk to a surrogate.
- Key metadata reports `protectionMode: SOFTWARE`, never `HSM`. A
  surrogate claiming hardware protection would be precisely the
  dev-indistinguishable-from-production failure this exists to avoid, and
  a test asserts it.
- The key lives in `surrogate-key.pem`, gitignored, generated on first
  run at mode 0600.

**`/dev/sev-guest` is deliberately not faked.** The real signer treats
that device's presence as its production signal, and making it spoofable
would turn a security check into a suggestion. A caller pointed here is
therefore still, correctly, a dev-mode signer.

## It fails where production fails

A mock more permissive than the real service teaches the wrong lesson, so
the surrogate reproduces OCI's rejections: IMDS 401s without
`Authorization: Bearer Oracle`, an unknown key OCID 404s, a non-ECDSA
algorithm 400s, malformed base64 400s.

Verified against the unmodified production module: `signer_runtime.py`,
pointed at this service, parses the epoch-millisecond `timeCreated`,
computes an age of 3 days, passes its own age guard, and emits a real
`ai.scruple.signer-runtime.v1` assertion.

## What it cannot tell you

- Whether OCI Vault's real latency is tolerable per leaf.
- Whether instance-principal auth works from inside the instance pool.
- Anything about SEV-SNP attestation. It has no measurement and does not
  pretend to have one.
- **Whether attestation survives a stop/start** — the open question in
  `docs/canon/L2_FLOOR.md` §5. Only the real machine answers that.

Those are a day of validation against a live CVM, not a redesign, so long
as the interface is right — which is what this service exists to get
right first.
