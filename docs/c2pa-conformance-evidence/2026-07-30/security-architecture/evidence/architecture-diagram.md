# Scruple TOE — architecture diagram

Companion to `../01-GPSA.md` §C.1.4. Black-box view of the trust
boundaries and mutual-authentication paths material to L1/L2
conformance.

```mermaid
flowchart TB
    subgraph CLIENT ["Client (in TOE)"]
        C["Authenticated caller"]
    end

    subgraph APP ["Application tier (in TOE)"]
        A["Constructs C2PA manifest.<br/>Delegates signing to Signer.<br/>No key material."]
    end

    subgraph TEE ["Signer (in TOE — hardware-attested TEE)"]
        S["Signer service"]
        H["PKCS#11 HSM<br/>ES256 key, non-extractable"]
        RoT["Hardware Root of Trust<br/>SEV-SNP attestation"]
    end

    C -- "TLS 1.3<br/>authenticated" --> A
    A -- "mTLS 1.3 + per-request seal" --> S
    S -- "C_Sign only<br/>(raw key never leaves HSM)" --> H
    H -.-> RoT
    RoT -. "attestation on demand<br/>binds pubkey to TEE" .-> C
```

## Boundaries and authentication

| Boundary | Protection |
|---|---|
| Client → Application tier | TLS 1.3, caller-authenticated |
| Application tier → Signer | mTLS 1.3 + per-request authentication seal, on an isolated network segment |
| Signer → HSM | PKCS#11 in-process, raw key never exposed |
| Signer / HSM → external verifier | Hardware Root of Trust attestation binding the specific HSM public key to the specific attested TEE |

## What the diagram is intended to convey (and only that)

- The end-entity signing key resides only inside a hardware-attested TEE.
- No component upstream of the TEE ever holds the raw key.
- Every subsystem boundary is mutually authenticated.
- The attestation report cryptographically proves the key ↔ TEE
  binding to any independent verifier without requiring Scruple's
  cooperation.

Detailed provisioning, ceremony, and operational procedures are
Scruple internal and are not required to demonstrate conformance
to §6 of the Generator Product Security Requirements.
