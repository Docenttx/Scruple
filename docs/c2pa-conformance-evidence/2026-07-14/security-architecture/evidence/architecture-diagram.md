# Scruple TOE — architecture diagram

Companion to `../01-GPSA.md` §C.1.4. Same data flow, rendered as Mermaid
for viewers that prefer graphical representation.

## Trust boundaries

```mermaid
flowchart TB
    subgraph EDGE ["Edge subsystem (in TOE)"]
        BROWSER["Web browser<br/>scruple.ai session cookie"]
        PLUGIN["Native plugin<br/>Adobe UXP / Fusion palette<br/>API key"]
        API["Integrator API caller<br/>ComfyOrg, etc.<br/>API key"]
    end

    subgraph CFEDGE ["Cloudflare (in TOE)"]
        CF["Cloudflare Edge<br/>TLS 1.3 termination"]
        TUN["cloudflared tunnel<br/>ingress-only route"]
    end

    subgraph BEWEB ["Backend-Web (in TOE)"]
        WEB["Scruple Web<br/>Next.js on OCI Compute<br/>Auth: session + API key"]
        WITNESS["Witness server<br/>systemd :5799<br/>HMAC-SHA-256 seal<br/>Ed25519 checkpoint"]
    end

    subgraph BESIG ["Backend-Signer (in TOE, SEV-SNP CVM)"]
        SIGNER["scruple-c2pa-signer.service<br/>c2pa-python 0.36<br/>Signer.from_callback"]
        HSM["SoftHSM 2 token<br/>ES256 key<br/>CKA_EXTRACTABLE=false"]
        PSP["AMD PSP<br/>attestation report<br/>report_data = sha256(pubkey)"]
    end

    subgraph MODAL ["Modal Labs (partial TOE)"]
        RUNNER["Per-user ephemeral<br/>container<br/>X-Admin-Token gated"]
    end

    subgraph VAULT ["OCI Vault (in TOE)"]
        WRAP["Wrap-key + SoftHSM PIN Secret<br/>FIPS 140-2 Level 3 HSM"]
    end

    subgraph LEDGER ["Public ledgers (outside TOE)"]
        RVN["Ravencoin<br/>asset issuance"]
        IPFS["IPFS<br/>content pins"]
        ARW["Arweave<br/>permanent anchoring"]
    end

    subgraph CONSUMER ["Manifest consumers (external verifiers)"]
        ADOBE["Adobe Verify"]
        TRUEPIC["Truepic Lens"]
        RS["c2pa-rs CLI"]
        PY["c2pa-python"]
        SCRV["scruple-verify"]
    end

    BROWSER -- "TLS 1.3<br/>session cookie" --> CF
    PLUGIN -- "TLS 1.3<br/>API key" --> CF
    API -- "TLS 1.3<br/>API key" --> CF
    CF -- "tunneled TCP" --> TUN
    TUN --> WEB

    WEB -- "spawn / local pipe" --> WITNESS
    WEB -- "mTLS 1.3 + HMAC<br/>private VCN subnet" --> SIGNER
    WEB -- "TLS 1.3<br/>X-Admin-Token" --> RUNNER

    SIGNER -- "PKCS#11 C_Sign<br/>never sees raw key" --> HSM
    HSM -.-> PSP
    PSP -- "attestation<br/>on demand" --> SCRV

    WEB -- "OCI SDK TLS<br/>Instance Principal" --> WRAP
    SIGNER -- "PIN retrieved at boot" --> WRAP

    WITNESS -- "checkpoint anchor<br/>on cadence" --> RVN
    WITNESS -- "cadence" --> IPFS
    WITNESS -- "cadence" --> ARW

    WEB -- "signed manifest<br/>+ receipt" --> CONSUMER
    ADOBE -.-> RS
    TRUEPIC -.-> RS
    PY -.-> RS
    SCRV -- "reads witness leaves<br/>+ verifies attestation" --> WITNESS
```

## Data flow — single C2PA sign event

```mermaid
sequenceDiagram
    autonumber
    participant E as Edge<br/>(browser/plugin/API)
    participant W as Backend-Web<br/>Scruple Next.js
    participant M as Modal Runner
    participant S as Backend-Signer<br/>(inside SEV-SNP CVM)
    participant H as SoftHSM 2
    participant WIT as Witness Server
    participant L as Public Ledgers<br/>(RVN + IPFS + Arweave)

    E->>W: Auth (session cookie OR sk_live_ API key)
    W->>W: Validate credential
    W->>M: Generate content (X-Admin-Token)
    M-->>W: Output bytes + metadata
    W->>W: sha256(output), construct manifest<br/>c2pa.actions.v2 + digitalSourceType
    W->>S: mTLS 1.3 + HMAC-SHA-256<br/>(sign request over private VCN)
    S->>S: Validate mTLS + HMAC + timestamp skew
    S->>H: PKCS#11 C_Sign (ES256)<br/>via c2pa.Signer.from_callback
    H->>H: Sign inside protected memory<br/>(never exposes raw key)
    H-->>S: signature bytes
    S-->>W: signed asset + manifest URN
    W->>W: Copy to user storage
    W->>WIT: POST /api/v1/log/_scruple.c2pa.sign<br/>(HMAC-authenticated)
    WIT->>WIT: Seal leaf, chain, include in checkpoint
    WIT->>L: Anchor super-root on cadence
    W-->>E: signed asset + receipt
```

## TLS + auth summary

```mermaid
flowchart LR
    subgraph "External TLS 1.3 (Cloudflare-terminated)"
        A["Edge → Backend-Web"]
    end
    subgraph "Internal mTLS 1.3 + HMAC (private VCN)"
        B["Backend-Web → Backend-Signer"]
    end
    subgraph "OCI SDK TLS + Instance Principal"
        C["Any host → OCI Vault"]
    end
    subgraph "TLS 1.3 + shared-secret header"
        D["Backend-Web → Modal Runner"]
    end
    subgraph "localhost HTTP + HMAC (kernel-isolated)"
        E["Backend-Web ↔ Witness"]
    end
```

## Legend

- Solid arrows: authenticated, encrypted request/response paths on
  the hot path.
- Dashed arrows: read-only or metadata paths.
- Trust boundaries shown as subgraphs; the CVM boundary is the
  cryptographic trust root, attested via AMD SEV-SNP.

## Rendering

To render as PNG:

```bash
npx -y @mermaid-js/mermaid-cli \
  -i architecture-diagram.md \
  -o architecture-diagram.png
```

Or paste any of the above blocks into `https://mermaid.live` for an
interactive view.
