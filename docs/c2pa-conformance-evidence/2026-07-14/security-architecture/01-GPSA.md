# Scruple — Generator Product Security Architecture Document

**Filed against:** C2PA Generator Product Security Requirements, v0.1 (2025-06-02)
**Template:** Appendix C of the same document
**Applicant:** Docent LLC (dba Scruple)
**Generator Product:** Scruple Web Studio C2PA Signer
**Intake record ID:** `019f5856-bff8-7f57-a879-80594a6fb3fe`
**Filing date:** 2026-07-15
**Target Max Assurance Level:** Level 2
**Signatory:** Shaun Hargadine
**Contact:** `conformance@scruple.ai` / `compliance@scruple.ai`

---

## Cover statement

Per the Program's request of 2026-07-14, this document responds to the
Generator Product Security Requirements evidence ask for Scruple's
Intake submission. It is filed alongside the Generate / Raw.input /
Validate.output sample bundle at
`docs/c2pa-conformance-evidence/2026-07-14/`.

**Confirmation of validate scope (per the reviewer's bracketed question).**
Scruple is NOT a capture-only product. Every asserted `validate.<mime>`
in the Intake Form is exercised end-to-end in the accompanying bundle
(18 of 20 asserted VALIDATE MIMEs produce signed ingested output; the
two skipped are current c2pa-python wrapper limits for `application/pdf`
and `application/x-pytorch`).

**Assurance target.** This document files at Assurance Level 2. The
security substrate — a hardware Root-of-Trust anchored by AMD SEV-SNP
confidential compute inside Oracle Cloud Infrastructure, with the C2PA
end-entity signing key never leaving that trust boundary — was
architected from the beginning against the L2 §6.2.2 requirement. The
2026-07-12 evidence run demonstrated the substrate end-to-end (see §5
of the accompanying evidence dossier).

**Filing posture.** The C2PA Program's own guidance is that assessment
happens at design level for pre-production products. Scruple is
pre-production: no paying customers are currently signing content on
the production hot path. The architecture described below is the
production architecture that a customer signing on with Scruple would
be onboarded to, ready for immediate cutover once the Trust-List
end-entity certificate is issued (§C.2.1). The evidence dossier
attached is the pre-production validation of that architecture.

---

## C.1. Generator Product Information

### C.1.1. Applicant organization details

- **Full legal name:** Docent LLC
- **Trading name:** Scruple (`scruple.ai`), the marketing name used for
  the Generator Product and associated web / API surfaces
- **Jurisdiction:** United States (LLC)
- **Business address:** on file with the Program via the Intake Form
- **Primary contacts:**
  - Technical + product: `partners@scruple.ai`
  - Conformance / compliance: `compliance@scruple.ai`
  - Signatory (bound authority): Shaun Hargadine
- **Public product URL:** `https://scruple.ai`
- **Public source + evidence:** `https://github.com/Docenttx/Scruple`
- **Witness API (production):** `https://witness.scruple.ai`

### C.1.2. Distinguished name

For the production C2PA end-entity claim signing certificate:

| Field | Value |
|---|---|
| Common Name (CN) | `Scruple` |
| Organization (O) | `Docent LLC` |
| Organizational Unit (OU) | (omitted) |
| Country (C) | `US` |

The end-entity signing certificate will be issued under the C2PA Trust
List by DigiCert (Content Credentials product) or SSL.com (C2PA Signer
product). The CSR is generated inside the SEV-SNP CVM against the
SoftHSM-held key; only the CSR (never the private key) leaves the CVM.
Runbook at `runbooks/cert-enrollment.md`. Application to the Trust-List
CA is pending Program acceptance of this filing; the CA's own review
timeline is the only elapsed-time dependency between filing acceptance
and production cert circulation.

The signed samples in the accompanying evidence bundle carry a
development CA-issued end-entity certificate with subject
`CN=Scruple Dev Signer (DEV MODE — production uses OCI Vault)` for
demonstration and interop-testing purposes. Once the Trust-List
end-entity cert is issued, the production hot path swaps the cert
file in place; no code changes, no architectural changes.

### C.1.3. Generator Product Description

**Scruple Web Studio** is a browser-based generative-AI studio that
produces AI-generated images, video, and fine-tuned model weights via
third-party base models (Stable Diffusion 1.5 / SDXL, FLUX.1
dev/schnell, AnimateDiff + VideoHelperSuite, SeedVR2, Kohya-ss LoRA
trainer) and marks every output with a C2PA v2.x manifest at
generation time.

**Intended use cases.**
1. **Provenance-first generative AI production.** Individual artists
   and small teams produce images and video with cryptographically
   verifiable provenance from the first pixel through publication.
2. **B2B marking infrastructure via Witness API.** Third-party
   generative-AI products call `witness.scruple.ai` to obtain C2PA
   manifests and append-only audit-chain leaves against hashes of
   their own outputs, satisfying their Article 50(2) / Content
   Credentials marking obligations without operating the signing
   substrate themselves. This is Scruple's principal commercial
   deployment shape; onboarding a new integrator is a documented
   runbook operation (`runbooks/customer-onboarding.md`).
3. **Embedded integrations.** UXP plugins for Adobe apps (Photoshop,
   Illustrator, InDesign, Premiere, After Effects, Lightroom), a
   palette add-in for Autodesk Fusion 360, and a proxy for Kohya-ss on
   Modal Labs — each hooks the host application's save/export event
   and produces a signed manifest and audit-chain leaf.

**Target audience.** Independent creators; small-to-medium creative
studios; enterprise licensees under a custom single-tenant deployment
of the same stack; integrator products (creative-AI cloud platforms,
content-management systems, plugin publishers).

**Key features material to Conformance.**
- Every C2PA manifest carries the `c2pa.actions.v2` assertion with
  action `c2pa.created` (scratch generation) or `c2pa.opened +
  c2pa.edited` (derivative work), plus IPTC `digitalSourceType` values
  (`trainedAlgorithmicMedia`, `compositeSynthetic`, `algorithmicMedia`).
- Ingredient references bind derivative outputs to their inputs by
  cryptographic hash, producing a fully-linked provenance graph
  independent of media transport.
- Every signed output additionally emits a per-iteration canonical leaf
  (spec: `docs/architecture/SCRUPLE_STANDARD_v1.md` v1.2) into an
  append-only Merkle chain. Roots are anchored to a public ledger
  (Ravencoin, with IPFS + Arweave for high-assurance tier) on a fixed
  cadence.
- Independent verification is available via any C2PA v2.x reader
  (Adobe Verify, Truepic Lens, `c2pa-python`, `c2pa-rs`) OR via the
  open-source `scruple-verify` CLI (`packages/scruple-verify/` in the
  same repo, planned `@scruple/verify` npm publish) which additionally
  re-derives and validates the canonical audit leaves.

### C.1.4. Generator Product Target of Evaluation (TOE)

The Scruple TOE comprises the Claim Generator (browser + Next.js app),
the signing substrate (SEV-SNP CVM + SoftHSM + optional OCI Vault
wrap-key), the audit-chain substrate (Witness servers + Merkle
checkpointing), and the operational infrastructure that isolates them
(Cloudflare edge, Modal Labs runners for third-party model execution).
External public ledgers (Ravencoin, IPFS, Arweave) are consumed but are
OUTSIDE the TOE because their integrity is independent of Scruple.
Stripe is OUTSIDE the TOE because payment processing does not touch
asset bytes or C2PA assertions.

#### High-level architecture

```
                                  ┌─────────────────────────────────┐
                                  │      C2PA MANIFEST CONSUMERS    │
                                  │  Adobe Verify · Truepic Lens ·  │
                                  │  c2pa-rs · c2pa-python · own    │
                                  └─────────────────────────────────┘
                                                 ▲ read
                                                 │
  EDGE (In TOE)                                  │            OUTSIDE TOE
  ┌────────────────────────┐                     │            ┌─────────────┐
  │ Web browser            │  TLS 1.3           BACKEND       │ Ravencoin   │
  │ scruple.ai / Fusion    │──────────► ┌──────────────────┐ │ (public     │
  │ palette / Adobe UXP    │  (via CF)  │ Cloudflare Edge  │ │ ledger)     │
  │ plugins  OR  customer  │           │ TLS termination + │ │             │
  │ integrator API caller  │           │ tunnel-only route │ │ IPFS        │
  └────────────────────────┘           └────┬───────────────┘ │             │
                                            │ Tunneled TCP   │ Arweave     │
                                            ▼                 └─────────────┘
                              ┌──────────────────────────────┐        ▲
                              │  Scruple Web (Next.js)       │        │
                              │  ─ Claim Generator route     │────────┘ (write)
                              │  ─ /api/v1/log ingest        │
                              │  ─ Session / API-key auth    │
                              │  ─ HMAC-authenticated to     │
                              │    Signer over mTLS          │
                              └───────────┬──────────────────┘
                                          │ mTLS 1.3
                                          ▼
        ═══════════════════════════════════════════════════════════
        ║  OCI SEV-SNP Confidential VM  (attested trust boundary)  ║
        ║                                                          ║
        ║  ┌──────────────────────────────────────────────────┐    ║
        ║  │  scruple-c2pa-signer.service                     │    ║
        ║  │  services/c2pa-signer/sign.py                    │    ║
        ║  │  ─ c2pa-python 0.36                              │    ║
        ║  │  ─ Signer.from_callback → PKCS#11 SoftHSM sign   │    ║
        ║  │  ─ HTTP/1.1 over Unix domain socket 0660         │    ║
        ║  └──────────────────────────────────────────────────┘    ║
        ║                                                          ║
        ║  ┌──────────────────────────────────────────────────┐    ║
        ║  │  SoftHSM 2 PKCS#11 token                         │    ║
        ║  │  ─ ES256 private key, generated in-VM, sealed    │    ║
        ║  │  ─ Non-exportable (SoftHSM CKA_EXTRACTABLE=CK_   │    ║
        ║  │    FALSE); private key material never leaves VM  │    ║
        ║  └──────────────────────────────────────────────────┘    ║
        ║                                                          ║
        ║  ┌──────────────────────────────────────────────────┐    ║
        ║  │  AMD PSP + measured-boot chain                   │    ║
        ║  │  ─ Attestation report on demand                  │    ║
        ║  │  ─ report_data = sha256(SoftHSM SPKI DER)        │    ║
        ║  │  ─ VCEK signature chained to AMD Root Key        │    ║
        ║  └──────────────────────────────────────────────────┘    ║
        ═══════════════════════════════════════════════════════════
                                          │
                                          │ (optional wrap-key,
                                          ▼   for SoftHSM token DR)
                              ┌──────────────────────────────┐
                              │ OCI Vault (KMS)              │
                              │ ─ FIPS 140-2 Level 3 HSM     │
                              │ ─ Wraps SoftHSM token backups│
                              │ ─ Instance-Principal auth    │
                              └──────────────────────────────┘

                              ┌──────────────────────────────┐
                              │ Witness Server (:5799)       │
                              │ systemd scruple-witness      │
                              │ ─ HMAC-SHA-256 seal          │
                              │ ─ Ed25519 checkpoint sig     │
                              │ ─ Merkle chain               │
                              └───────────┬──────────────────┘
                                          │ Anchors on cadence
                                          ▼ (to public ledgers, above)

                              ┌──────────────────────────────┐
                              │ Modal Labs runner containers │
                              │ scruple_runner.py            │
                              │ ─ Per-user, ephemeral        │
                              │ ─ X-Admin-Token gated        │
                              └──────────────────────────────┘
```

**Subsystems and their in-TOE status:**

| Subsystem | Location | In TOE? | Rationale |
|---|---|---|---|
| Web browser + native plugins (Edge subsystem) | User device | Yes | Originates the sign request; carries the user session credential |
| Customer integrator API caller (Edge subsystem, B2B) | Customer premises / cloud | Yes | Originates sign requests from third-party systems; carries API-key credential |
| Cloudflare Edge (TLS termination + tunnel) | Cloudflare + `cloudflared` on host | Yes | Gate for all inbound network traffic; only ingress to the Backend |
| Scruple Web (Next.js app, Claim Generator) | OCI host, systemd | Yes | Constructs the C2PA manifest structure; invokes Signer |
| Scruple Signer subprocess (`services/c2pa-signer/`) | **Inside SEV-SNP CVM**, systemd `scruple-c2pa-signer.service` | Yes | Executes the ES256 signature via PKCS#11 SoftHSM |
| SoftHSM 2 PKCS#11 token | Inside SEV-SNP CVM | Yes | Holds the C2PA end-entity private key; signing performed inside; key never exported |
| AMD SEV-SNP + PSP | AMD Secure Processor + OCI Genoa host | Yes | Substrate providing memory encryption + measured boot + attestation reports |
| OCI Vault (KMS) | Oracle Cloud region IAD | Yes | Holds wrap-key for SoftHSM token disaster-recovery backups. Optional. |
| Witness Server (`:5799`, external systemd) | Same host as Web, `/opt/scruple-witness/` | Yes | HMAC-seals per-iteration canonical leaves; signs checkpoints; publishes trust manifest |
| Modal Labs runners | Modal Labs cloud, per-user containers | Partial | Runs the base-model inference. Bytes flow through and are captured; runner does NOT sign. In-TOE for content-processing (§C.2.4); OUT of TOE for signing (§C.2.2) |
| Ravencoin, IPFS, Arweave | Public infrastructure | No | Anchoring targets; their operation is not under Scruple's control |
| Stripe | Third-party SaaS | No | Payment processing; does not touch asset bytes, assertions, or C2PA manifests |

**Data flow for a single C2PA sign event (production hot path):**

1. Edge subsystem (browser session, plugin API key, or B2B integrator
   API key) authenticates to Scruple Web via NextAuth database session
   cookie OR SHA-256-hashed API-key bearer.
2. Web routes any needed generation to Modal Labs runner (via Modal
   Client SDK, authenticated by shared-secret `X-Admin-Token`).
3. Modal runner executes base-model inference, returns bytes + metadata.
4. Web computes SHA-256 of output bytes, constructs manifest candidate
   with `c2pa.actions.v2` assertions and IPTC `digitalSourceType`,
   appends any ingredient references.
5. Web sends a signed request over mTLS 1.3 to the Signer service
   endpoint (`sign.scruple.internal:8443`, reachable only via a
   private VCN subnet from the Web host's Compute instance to the
   CVM's Compute instance). Request auth uses a shared HMAC token
   plus mTLS client cert pinned to the Web host's Instance Principal.
6. Signer service inside the SEV-SNP CVM receives the request, invokes
   `c2pa.Signer.from_callback(pkcs11_sign_es256, ES256, cert_pem,
   tsa_url)`. The callback dispatches ES256 raw signature to the
   SoftHSM PKCS#11 token. Raw key material never leaves the SoftHSM,
   never leaves the CVM, never leaves the memory-encrypted region.
7. Signer returns the signed asset bytes and manifest URN to Web.
8. Web copies signed asset to user's storage tier, emits per-iteration
   canonical leaf to `/api/v1/log/_scruple.c2pa.sign` (Witness API,
   HMAC-authenticated internal stream).
9. Witness server seals leaf, chains it, includes in next checkpoint
   epoch. Checkpoint super-root anchored to Ravencoin (asset issuance)
   + optionally IPFS + Arweave on cadence configured per tier.

**Architectural diagrams** — the above ASCII plus the Mermaid version
at `security-architecture/evidence/architecture-diagram.md`. A rendered
PNG is at `security-architecture/evidence/architecture-diagram.png`
(available in the accompanying Drive folder alongside this document).

### C.1.5. Implementation Class

**Distributed.**

- The **Edge subsystem** is the user's browser (Scruple Web session
  cookie), embedded native plugin (API-key), OR customer integrator
  API caller (API-key). It originates the sign intent, but does not
  itself compute the C2PA signature.
- The **Backend subsystem** decomposes into two co-tenanted-but-
  compartmentalised components:
  - **Backend-Web:** the Scruple Next.js application on a normal
    hardened OCI Compute instance. It authenticates the Edge, builds
    the manifest, and forwards signing to Backend-Signer.
  - **Backend-Signer:** the Signer service inside the SEV-SNP CVM.
    It is authenticated by Backend-Web via mTLS + HMAC, and executes
    the signature via SoftHSM.
- Communication:
  - Edge ↔ Backend-Web: Cloudflare-tunneled TLS 1.3 (§C.2.5).
  - Backend-Web ↔ Backend-Signer: mTLS 1.3 over private OCI VCN
    subnet, with per-request HMAC over `${timestamp}\n${body_hash}`
    (5-min skew tolerance).

Per §6.5.1 of the Requirements Document, this triggers the additional
Distributed-Class requirements for mutual authentication between
subsystems and TLS 1.3 (or higher) encryption. Both are in place; see
§C.2.5 for evidence.

### C.1.6. Target Max Assurance Level

**Level 2.**

Per-objective self-assessment:

| Objective | Level | Notes |
|---|---|---|
| **O.1** Automated cert enrollment | **N/A** — the Program-designated CAs (DigiCert Content Credentials, SSL.com C2PA Signer) use manual CSR-submission enrollment. §6.1 requirements are "only applicable if conforming GP instances rely on automated certificate enrollment for initial certificate issuance or rotation." We do not; §6.1 is N/A. |
| **O.2** Signing key confidentiality | **L2 satisfied** | ES256 private key generated + held inside SoftHSM inside SEV-SNP CVM. Non-exportable. Attestation report cryptographically binds pubkey to CVM measurement. See §C.2.2 + evidence at `security-architecture/evidence/l2-evidence-2026-07-12T174954Z/` |
| **O.3** Claim Generator hardening | **L2 satisfied** | SCA/SBOM + Semgrep static analysis wired in `.github/workflows/security.yml`. SEV-SNP measurement pins patch recency (AMD firmware + kernel). See §C.2.3 |
| **O.4** Content-processing hardening | **L2 satisfied** | Same CI coverage as O.3. Signer isolation via dedicated `scruple-signer` user, systemd hardening, Unix domain socket 0660. See §C.2.4 |
| **O.5** Traffic protection | **L2 satisfied** | Cloudflare TLS 1.3 externally, mTLS 1.3 + HMAC between Web ↔ Signer, kernel IPC isolation via systemd hardening. See §C.2.5 |
| **O.6** Hosting environment | **L2 satisfied** | OCI IAM RBAC, OCI Audit logging, osquery HIDS with Fleet-style aggregation, VCN network segmentation. See §C.2.6 |

### C.1.7. Target Generator Product capabilities

**Claim generation** — per the Intake Form assertion:

- **Still image:** `image/jpeg`, `image/png`, `image/svg+xml`,
  `image/x-adobe-dng`, `image/tiff`, `image/webp`, `image/heic`,
  `image/heif`, `image/avif`
- **Video:** `video/mp4`, `video/quicktime`
- **Audio:** `audio/flac`, `audio/mpeg`, `audio/wav`, `audio/mp4`
- **ML models:** `pytorch`

**Claim validation** — per the Intake Form assertion:

- **Still image:** `image/jpeg`, `image/jxl`, `image/png`,
  `image/svg+xml`, `image/gif`, `image/x-adobe-dng`, `image/tiff`,
  `image/webp`, `image/heic`, `image/heif`, `image/avif`
- **Video:** `video/x-msvideo`, `video/mp4`, `video/quicktime`
- **Audio:** `audio/flac`, `audio/mpeg`, `audio/wav`, `audio/mp4`
- **Documents:** `application/pdf`
- **ML models:** `pytorch`

**Coverage evidence** — the Generate.output.<mime>/, Raw.input.<mime>/,
and Validate.output.<mime>/ folders in the accompanying bundle at
`docs/c2pa-conformance-evidence/2026-07-14/`:

- 15 of 16 asserted GENERATE MIMEs produce cryptographically-verified
  signed samples via c2pa-python 0.36. The one gap is
  `application/x-pytorch` — the c2pa-python wrapper does not yet
  expose signing for that MIME; the underlying `c2pa-rs` does. Raw
  sample provided; `NOT_SUPPORTED.txt` documents the wrapper cause.
- 18 of 20 asserted VALIDATE MIMEs round-trip through signed ingested
  output. Same wrapper-cause gap for `application/pdf` and
  `application/x-pytorch`. Both cases raw samples provided.
- The `_bundle_report.json` at the bundle root machine-parses all of
  the above, and every signed sample independently verifies as
  `validation_state=Valid` via a fresh `c2pa.Reader` against the
  included dev CA chain.

---

## C.2. Security architecture details

### C.2.1. Authentication for certificate enrollment

#### Certificate enrollment process

**Manual enrollment via the Program-designated Trust List CA** (DigiCert
Content Credentials or SSL.com C2PA Signer). The C2PA Trust List CA
processes CSR submissions manually per their standard workflow. §6.1 of
the Requirements Document is only applicable to products that rely on
automated cert enrollment; Scruple does not, so §6.1 does not apply.

The CSR ceremony:

1. Web-side administrator invokes the CSR-generation runbook
   (`runbooks/cert-enrollment.md`).
2. Runbook opens a mTLS session to the Signer service in the CVM and
   requests a CSR for the SoftHSM-held key.
3. Signer service invokes `openssl req -engine pkcs11 -keyform engine
   -key <slot-uri> -new -subj "<DN from §C.1.2>" -out csr.pem`.
   Only the CSR (a public-key-plus-Signature-of-that-public-key
   structure) leaves the CVM; the private key remains sealed.
4. Administrator submits the CSR to the Trust List CA account under
   Docent LLC via the CA's standard portal.
5. Once the CA issues the end-entity cert, administrator installs it
   at `services/c2pa-signer/keys/es256.pub` (chain) via the runbook.
   No architecture change; no restart of the SoftHSM required.

**Cert rotation.** Same ceremony, invoked annually or on suspected
compromise. Trust manifest at
`https://witness.scruple.ai/.well-known/witness-trust.json` publishes
all currently-valid signer certs with `active_from` / `deprecated_at`
metadata so downstream verifiers can select the right cert per sign
timestamp.

#### Management of certificate enrollment authentication secrets *(Required for Level 1 and Level 2 — N/A)*

Not applicable — no automated enrollment. The Trust List CA
authenticates Docent LLC's account via the CA portal's own MFA-gated
login. No shared secret, client certificate, username/password,
challenge-response, or symmetric key MAC is used between the GP TOE
and the CA during enrollment — enrollment is a human ceremony.

#### Confirming GP binary identity *(Required for Level 2 — N/A here, satisfied structurally elsewhere)*

§6.1.2 L2 requires hardware-RoT binary confirmation during **automated
certificate enrollment**. Because our enrollment is manual, this
requirement is N/A at the enrollment step.

Structurally, the Signer binary IS confirmable via hardware Root of
Trust at any point after boot via the SEV-SNP attestation report (see
§C.2.2 + §C.2.3). Any verifier — including the Program assessor — can
request a live attestation report and cross-verify that the Signer
running today is the same one whose measurement is pinned in the
2026-07-12 evidence run.

### C.2.2. Key generation, storage, and usage

#### Key generation and storage method *(Required for Level 1 and Level 2)*

- **Algorithm and key size:** ES256 (P-256 ECDSA / SHA-256) per
  RFC 8152 COSE_Sign1 conventions. Consistent with C2PA Content
  Credentials v2.x claim signature format.
- **Storage.** The ES256 private key is generated inside a SoftHSM 2
  PKCS#11 token that lives inside an OCI SEV-SNP Confidential VM.
  Provisioning ceremony documented at `runbooks/cvm-provision.md`.
  The key is generated with `CKA_EXTRACTABLE=CK_FALSE` and
  `CKA_SENSITIVE=CK_TRUE`, meaning PKCS#11 API calls cannot extract
  the key material — the only permitted operation is `C_Sign`.
  Combined with SEV-SNP memory encryption, this means the plaintext
  private key material exists only inside SoftHSM's protected memory
  region inside the CVM's encrypted memory region, and is not
  accessible to:
  - The Oracle hypervisor (SEV-SNP encrypts memory at the CPU level
    with a per-VM key derived by the AMD PSP; hypervisor access
    yields ciphertext only)
  - Any other tenant on the same physical host (same protection)
  - Any Docent operator (no operator has runtime access to SoftHSM's
    protected memory; PKCS#11 `C_GetAttributeValue` cannot retrieve
    `CKA_VALUE` on a sensitive-extractable-false key)
  - The Signer subprocess itself, in raw form (Signer holds the
    session handle; SoftHSM performs the sign operation internally)
- **Signing key access controls (encryption + IAM).**
  - **SoftHSM PIN gate.** SoftHSM token operations require the PIN.
    The PIN is stored as an OCI Vault Secret and injected as an
    environment variable at CVM boot via a systemd `EnvironmentFile`.
    The Signer service reads the PIN from environment, calls
    `C_Login`, then zeroes the environment variable. This is the ONE
    plaintext-secret handoff, and it happens inside the CVM's
    encrypted memory region.
  - **IAM policy on the Vault Secret holding the PIN.** Only the
    CVM's Instance Principal identity has `read` on the Secret;
    nothing else. This means only a CVM instance whose SEV-SNP
    attestation matches the pinned measurement can request the PIN.
    (Instance Principal is issued by OCI's identity broker per-boot
    and is cryptographically bound to the Compute instance.)
- **Key rotation.** SEV-SNP-sealed private keys are intentionally
  non-recoverable. Rotation cadence: annually, or immediately on any
  suspected compromise. The trust manifest published at
  `https://witness.scruple.ai/.well-known/witness-trust.json` carries
  all currently-active signer certs with `active_from` /
  `deprecated_at` metadata; verifiers select the correct cert per
  sign timestamp. Rotation runbook at
  `runbooks/cert-enrollment.md#rotation`.
- **Distributed / Backend Implementation Class additions.**
  - **Mutual authentication Backend-Web ↔ Backend-Signer.** Every
    request from Backend-Web to Backend-Signer is:
    (a) mTLS 1.3 — Backend-Signer verifies Backend-Web's client cert
    against a pinned SPKI list; Backend-Web verifies Backend-Signer's
    server cert against a pinned SPKI list;
    (b) HMAC-SHA-256 sealed over `${timestamp}\n${body_hash}` with a
    per-key material provisioned into both hosts at CVM bring-up.
    Both must validate before Signer accepts the request.
  - **Mutual authentication Edge ↔ Backend-Web.** NextAuth
    database-strategy session cookie (browser) or SHA-256-hashed
    API-key bearer (`sk_test_/sk_live_` prefix, 32-byte base64url
    secret, stored hash-only in `api_keys.key_hash`). Sessions are
    HTTP-only + Secure + SameSite=Lax; API keys are scope-bound and
    revocation-timestamped.
  - **Role appropriateness.** Edge subsystems author no manifest
    bytes and hold no signing key. Backend-Web authors manifest
    structure but holds no key. Backend-Signer holds the key and
    authors the signature only. Each role is authenticated to the
    role above.

#### Attestation of key generation and storage *(Required for Level 2)*

**Approach: hardware-RoT attestation (§6.2.2 L2(d)(i)).** Full
end-to-end demonstration on the 2026-07-12 evidence run under
`security-architecture/evidence/l2-evidence-2026-07-12T174954Z/`.

**Key management environment properties (§6.2.2 L2(1)a–d):**

- **(a) Access-controlled to authenticated callers.** SoftHSM enforces
  PIN-gated `C_Login` on every session. The PIN is only obtainable by
  an authenticated CVM Instance Principal (see above).
- **(b) Private key material never in the Claim Generator's memory.**
  Backend-Web (the Claim Generator) never touches the private key.
  Backend-Signer never touches the raw key either — it holds a PKCS#11
  session handle and issues `C_Sign` calls; SoftHSM performs the
  operation internally against key material sealed at
  `CKA_EXTRACTABLE=CK_FALSE`.
- **(c) Hardware-derived wrapping keys.** SEV-SNP memory encryption
  uses per-VM keys derived by the AMD PSP (Platform Security Processor)
  — hardware root of trust. The Oracle hypervisor and any other tenant
  see only encrypted memory. SoftHSM's protected memory region + the
  private key inside it are inside this encrypted region. Optionally,
  SoftHSM tokens can be wrapped by an OCI Vault master key
  (FIPS 140-2 Level 3 HSM-backed) for disaster-recovery backups; the
  Vault master key is itself hardware-derived.
- **(d) One of: hardware-RoT attestation of key possession, OR
  independent auditor certification.** We satisfy **(d)(i)** —
  hardware-RoT attestation. The SEV-SNP attestation report's
  `report_data` field is populated by the caller with the SHA-256 of
  the SoftHSM ES256 SPKI DER. Any verifier holding
  (report, public key) can independently confirm that the specific
  private key was possessed by the attested CVM at the time of the
  report. Evidence:

| Artifact | Description | Bytes |
|---|---|---|
| `sev-snp-report.bin` | AMD SEV-SNP attestation report (ABI v5) | 1184 |
| `vcek.der` | AMD-issued Versioned Chip Endorsement Key certificate | 1347 |
| `amd-cert-chain.pem` | AMD Root Key → SEV-Genoa chain | 4602 |
| `measurement.hex` | VM measurement recorded by AMD PSP at boot | 96 |
| `reported-tcb.hex` | AMD firmware + kernel TCB at attestation time | 16 |
| `chip-id.hex` | Unique chip identifier for VCEK lookup | 128 |
| `signer-pubkey-sha256.txt` | SHA-256 of SoftHSM ES256 SPKI DER (matches `report_data`) | 64 |
| `signer-cert-chain.pem` | End-entity cert (dev CA) + issuer chain | ~2000 |
| `signed-test-asset.png` | C2PA-signed asset produced by the ceremony signer | 16050 |

All under `security-architecture/evidence/l2-evidence-2026-07-12T174954Z/`.

Reproducibility: given the artifact bundle, any verifier can:
1. Verify VCEK signature on `sev-snp-report.bin` (VCEK chained to AMD
   Root Key at `https://kdsintf.amd.com/vcek/v1/Genoa/{chip_id}?...`)
2. Extract `report_data` from the report body
3. Compute SHA-256 of the SoftHSM SPKI DER (public half of
   `signer-pubkey.pem`)
4. Confirm the two 32-byte values match
5. Verify the C2PA signature on `signed-test-asset.png` under
   `signer-cert-chain.pem`

The chain of cryptographic proof: the specific SoftHSM key
(pubkey byte-for-byte identifiable) was in the possession of a specific
SEV-SNP CVM (measurement 7237c44b...) using specific AMD firmware
(TCB 0x581c00000000000a) at a specific time (report timestamp), and
that key signed a specific C2PA asset (test-asset.png).

We do not currently claim SOC 2 Type 2 for the key-management
environment (per §6.2.2 L2(d)(ii)); the hardware-RoT attestation
option is sufficient.

#### Authentication before using keys *(Required for Level 2 for Distributed or Backend)*

- **Backend-Signer authentication of the calling client.** Every sign
  request to Backend-Signer is:
  1. mTLS-terminated against a pinned client SPKI list (only
     Backend-Web can present a matching cert).
  2. HMAC-SHA-256 verified against a shared secret provisioned at
     CVM bring-up.
  3. Timestamp-skew-checked (±300 seconds).
  4. Only after all three pass does Signer invoke `C_Sign`.
- **Verifiable artifact backed by hardware Root of Trust from Edge
  subsystems.** For browser Edge subsystems, session cookies are
  HTTP-only + Secure + SameSite=Lax + database-strategy validated on
  every request. For native plugin Edge subsystems (Adobe UXP,
  Fusion) and B2B integrator API callers, authentication is API-key
  based; hardware-attested Edge integrity is not currently required
  by our threat model for those clients (the Edge is a display /
  consent / integrator-boundary surface only, not a signing surface).
  Backend-Signer's mTLS + HMAC gate prevents any Edge subsystem
  compromise from reaching the key.

### C.2.3. Protections against Claim Generator misconfiguration and abuse

#### SCA/SBOM dependency vulnerability scanning *(Required for Level 1 and Level 2)*

**Wired in CI**: `.github/workflows/security.yml` runs on every PR
and every push to `main`:

- **Dependency vulnerability scanning (SCA):** OSV-Scanner across
  all Python (`requirements.txt`, `poetry.lock`) and Node
  (`package-lock.json`) dependencies. Blocks merge on any CRITICAL
  or HIGH severity per CVSS v3+.
- **Container image scanning:** Grype scans the built Signer image
  and any container-based deployment artifacts. Blocks merge on
  CRITICAL or HIGH.
- **SBOM emission:** CycloneDX SBOM emitted per build and attached
  as GitHub release artifact.
- **Dependabot** enabled for Node and Python packages via
  `.github/dependabot.yml`, weekly cadence.
- **90-day fix guarantee:** the workflow includes a "known-vulnerable
  release blocker" gate that fails any release attempt where a
  detected CRITICAL/HIGH is >90 days past first detection.

#### Basic exploit countermeasures, static analysis, software image authentication, patch recency *(Required for Level 2)*

- **Build scripts and build flags confirming enablement of
  countermeasures.** The Signer image is a reproducibly-built
  container image (Debian 12 base + pinned Python 3.12 + pinned
  c2pa-python 0.36 + pinned SoftHSM 2.6). Debian's default build
  flags for Python 3.12 include `-fstack-protector-strong`,
  `-D_FORTIFY_SOURCE=2`, `-Wl,-z,relro,-z,now`, PIE. Node.js runtime
  is the packaged Debian distribution (Node 20 LTS), compiled with
  the standard V8 hardening set. ASLR + DEP/NX are enforced by the
  Linux kernel. Build-flags manifest per `runbooks/cvm-provision.md`.
- **Countermeasures functional test report.** CI emits a
  countermeasures verification report per build via
  `checksec` (from `paxtest`), attached as a workflow artifact.
  Sample at `security-architecture/evidence/checksec-signer-latest.txt`.
- **Static analysis tools used.** CI runs:
  - **Semgrep** — open-source SAST across TypeScript + Python
    surfaces. Rules: OWASP Top 10 + Semgrep-community security packs.
  - **ESLint** with `next/core-web-vitals` + `eslint-plugin-security`.
  - **TypeScript strict mode** (`"strict": true` in `tsconfig.json`).
  - **mypy** on the Signer's Python surface with `--strict`.
  - **CodeQL** on GitHub-provided workflow.
- **Access control methods.** The Signer service accepts connections
  only from the Backend-Web host's Instance Principal (mTLS-pinned).
  The Signer subprocess runs as a dedicated `scruple-signer` OS user
  with `ProtectSystem=strict`, `PrivateTmp=yes`, `NoNewPrivileges=yes`,
  `MemoryDenyWriteExecute=yes`, `SystemCallFilter=@system-service`,
  `InaccessiblePaths=/data/services/c2pa-signer/keys/` (path only
  reachable by the SoftHSM daemon, not by any other process). Full
  systemd unit at `runbooks/cvm-provision.md#systemd`.
- **Binary image authentication methods.** The SEV-SNP measurement
  (`measurement.hex` in evidence) is a cryptographic hash of the
  CVM's boot image + firmware. Because the boot image is the
  reproducibly-built Signer image, the measurement is a fingerprint
  of the exact binary set that was running at attestation time.
  Combined with the reproducible-build hash, this pins the Signer
  binary to a specific commit SHA.
- **External input validation methods.** The Web layer validates all
  external inputs via `zod` schemas per route. Signer service input
  is JSON-schema validated at entry and rejects any mismatched
  payload. C2PA manifest structure is validated by `c2pa-python`'s
  own reader before signing (structural compliance) and after
  signing (round-trip verification).
- **Access control lists for external input ingress points.**
  Cloudflare Edge blocks all non-tunneled inbound traffic. Only the
  `cloudflared` tunnel to Backend-Web is exposed. Signer is on a
  private OCI VCN subnet, unreachable from the public Internet
  regardless of Cloudflare state. Web-layer routes enforce
  authentication before invoking any Signer code path.
- **Patch recency attestation.** The SEV-SNP attestation report's
  `reported_tcb` field (0x581c00000000000a in the 2026-07-12
  evidence run) pins the AMD firmware version + OS kernel version at
  attestation time. Verifiers can cross-reference against AMD's
  published advisory list to confirm no known-vulnerable firmware
  version is in use. The 90-day fix guarantee in the CI workflow
  (above) covers dependency-side patch recency.

### C.2.4. Protections against misconfiguration and abuse of software that processes or modifies Digital Content or assertions

Software in scope for §C.2.4: `services/c2pa-signer/sign.py`
(constructs manifest, invokes signer), `lib/c2pa/signAsset.ts`
(Node-side wrapper), plus the `c2pa-python 0.36` third-party package
they depend on. Modal Labs runner containers are also in scope
because they generate the Digital Content bytes upstream of the
manifest, even though they do not sign.

#### SCA/SBOM dependency vulnerability scanning *(Required for Level 1 and Level 2)*

Same CI coverage as §C.2.3, covering both `services/c2pa-signer/`
(Python) and `lib/`, `app/`, `services/` (TypeScript). See
`.github/workflows/security.yml`.

#### Basic exploit countermeasures, static analysis, software image authentication, patch recency *(Required for Level 2)*

- **Image authentication methods for all sources of assets and
  assertions implemented in software.** For the Signer path,
  SEV-SNP measurement as §C.2.3. For the Modal Labs runner path,
  container image identity is managed by Modal's platform (the
  runner image is built from a pinned `Image.debian_slim()` +
  explicit package pins), and admin access to the runner is gated
  by an `X-Admin-Token` header validated against a Modal-Secret-
  stored value (`services/scruple_runner.py` `_check_admin`).
- **Build scripts and build flags confirming enablement of
  countermeasures.** As §C.2.3 for the Signer path. Modal's
  `Image.debian_slim()` uses Debian's standard hardened build flags.
- **Countermeasures functional test report.** As §C.2.3.
- **Static analysis tools used.** As §C.2.3.
- **Binary image authentication methods.** SEV-SNP measurement for
  the CVM Signer path; Modal's image-pinning + shared-secret admin
  authentication for the Modal runner path.
- **Isolation of source processes and threads + IPC protection.**
  - **Signer service:** runs as dedicated `scruple-signer` OS user
    inside the CVM under a systemd unit hardened per §C.2.3.
    Communication with Backend-Web is over private OCI VCN
    subnet (network-level isolation) with mTLS + HMAC (transport
    integrity). No process-space sharing with any other subsystem.
  - **Modal runner containers:** each is a per-user, ephemeral
    container instance on Modal's platform, with kernel-enforced
    isolation between users. Modal's own SOC 2 attestation covers
    the isolation boundary. Runner containers do not share process
    space with any other tenant's runner.
  - **Witness server:** external systemd unit (`scruple-witness.
    service` at `/opt/scruple-witness/`), separate OS user, IPC to
    Scruple Web only via localhost HTTP with HMAC-SHA-256 seal per
    request. Not sharing process space with Web.
- **Patch recency.** SEV-SNP TCB pins AMD firmware + kernel for the
  CVM Signer path (§C.2.3). Modal runner container base images are
  rebuilt monthly against latest Debian security patches (Modal
  build cadence). The 90-day fix guarantee in the CI workflow
  covers dependency-side patch recency.

### C.2.5. Protections against interception and/or modification of traffic

#### Encryption of network traffic *(Required for Level 1 for Distributed and Backend)*

- **TLS 1.3 on all external subsystem-to-subsystem network
  communication.**
  - **Edge ↔ Backend-Web:** Cloudflare Edge terminates TLS 1.3
    (with TLS 1.2 as backwards-compat floor per Cloudflare's
    default; every Scruple production hostname has TLS 1.3
    enabled and TLS 1.0/1.1 disabled). Cipher suites:
    `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`,
    `TLS_AES_128_GCM_SHA256`.
  - **Cloudflare Tunnel (`cloudflared`)** establishes a mutually-
    authenticated persistent connection from the Backend-Web host
    to Cloudflare Edge; there is no directly-Internet-facing
    listener on the Backend-Web host.
  - **Backend-Web ↔ Backend-Signer:** mTLS 1.3 over private OCI
    VCN subnet, with per-request HMAC-SHA-256 over
    `${timestamp}\n${body_hash}` (5-min skew).
  - **Backend-Web ↔ OCI Vault (for wrap-key ops):** TLS 1.2+
    per OCI SDK defaults (typically TLS 1.3 on modern OCI
    regions). Certificate pinning by OCI SDK.
  - **Backend-Web ↔ Modal runner:** TLS 1.3 to Modal's cloud
    endpoint, plus `X-Admin-Token` shared-secret header layer.
- **Internal same-host IPC:** Backend-Web ↔ Witness server is
  localhost HTTP with HMAC-SHA-256 sealing (redundant TLS is
  omitted on localhost per common security-engineering practice
  where kernel-level isolation is sufficient).

**Evidence artifacts:**

- Cloudflare TLS configuration is visible in the Cloudflare dashboard
  for each hostname (`scruple.ai`, `witness.scruple.ai`,
  `beta.scruple.ai`, etc.). Screenshot:
  `security-architecture/evidence/cloudflare-tls-config.png`.
- `cloudflared` config file (redacted of tunnel-secret; structure
  only): `security-architecture/evidence/cloudflared-config.yml`.
- Live TLS handshake proof:
  `security-architecture/evidence/ssllabs-scruple-ai.txt` — output
  of Qualys SSL Labs test against `scruple.ai`.
- Backend-Web ↔ Backend-Signer mTLS: cert-pinning code at
  `services/c2pa-signer/mtls-config.yml` and Signer-side systemd
  unit config in `runbooks/cvm-provision.md`.

#### Protection of inter-process communication

- **Support of isolation of source processes and/or threads.**
  - CVM subsystems: Signer runs as dedicated OS user with systemd
    hardening (`ProtectSystem=strict`, `PrivateTmp=yes`,
    `NoNewPrivileges=yes`, `MemoryDenyWriteExecute=yes`,
    `SystemCallFilter=@system-service`,
    `InaccessiblePaths=<keys-dir>`).
  - Web and Witness on Backend-Web host: separate OS users, separate
    systemd units, separate `PrivateTmp` regions.
  - Modal runner containers: per-user ephemeral, kernel-isolated by
    Modal's platform.
- **IPC channel protection.**
  - Backend-Web ↔ Backend-Signer: mTLS 1.3 + HMAC (see above).
  - Backend-Web ↔ Witness (same host): localhost HTTP + HMAC-SHA-256
    seal.
  - No shared-memory IPC (all boundaries are network or authenticated
    HTTP).
- **ACL limits on IPC connection endpoints.** Signer service accepts
  connections only from Backend-Web's Instance Principal identity
  (VCN security list + mTLS client-cert pin). Witness accepts
  connections only from Backend-Web on localhost. Modal admin
  endpoint accepts only requests bearing the correct `X-Admin-Token`.

### C.2.6. Protections against exploitation of hosting environment

#### IAM, RBAC, vulnerability process *(Required for Level 1 and Level 2 for Distributed and Backend)*

- **IAM system and security boundaries.** OCI IAM controls all
  Cloud-resource access for Backend-Web + Backend-Signer + OCI Vault
  + related Object Storage. Coverage:
  - **Compute instance (Backend-Web host):** Dynamic Group matched
    by Instance OCID pattern; IAM policy grants read on Object
    Storage buckets for user asset staging; nothing else in the
    Vault or Signer namespaces.
  - **Compute instance (Backend-Signer CVM):** Dynamic Group
    matched by Instance OCID pattern; IAM policy grants read on
    the Vault Secret holding the SoftHSM PIN, and read on the
    Vault Key holding the SoftHSM-token wrap key (optional DR
    path only). Nothing else.
  - **OCI Vault:** access exclusively via Instance Principals (no
    user accounts have `use` on the production key or `read` on
    the PIN secret).
  - **OCI Object Storage:** used for user-uploaded assets; per-
    bucket IAM policies scope access to the specific Compute
    Dynamic Group + a small set of human admin accounts under
    principle-of-least-privilege.
- **Human access policies.** Two Docent LLC principals have
  production admin access to the OCI tenancy under named user
  accounts with MFA-required sign-in. All privileged operations
  are logged to OCI Audit (retention 365 days per OCI default).
- **Non-human principal policies.** All non-human access is via
  Instance Principals or Dynamic Groups, not long-lived service-
  account credentials. Each host carries its own Instance Principal
  identity; each has only the IAM policies specifically required
  for its function.
- **IAM policies for main cloud resources.** Documented in the OCI
  tenancy at `Identity → Policies`. Policy statements attached (in
  redacted form for OCID specifics) as
  `security-architecture/evidence/oci-iam-policies-redacted.txt`.
- **Vulnerability scanning / security review process.** OSV-Scanner
  + Grype + Semgrep in CI (§C.2.3), covering the OWASP Top 10 web
  application vulnerabilities. Cloudflare + OCI security advisory
  feeds monitored by the security contact
  (`compliance@scruple.ai`) with a 24-hour acknowledgment SLA.
- **Vulnerability remediation timeline.** 30 / 90 / 180 days for
  high / moderate / low severity CVSS-rated vulnerabilities, per
  the Requirements Document footnote 9. CI-enforced by the
  known-vulnerable release blocker.

#### Level 2 additions *(Required for Level 2 for Distributed and Backend)*

- **Audit logging.** Two layers:
  - **OCI Audit** is enabled at the tenancy level (default) and
    captures all administrative API operations against Compute,
    Vault, IAM, Object Storage, and Networking resources. Retention
    365 days. Access via `oci audit event list`.
  - **Application-level audit** emits security-relevant events
    (auth failures, sign operations, IAM changes at app layer,
    PII denylist matches, `_scruple.c2pa.sign` stream events) into
    the Witness canonical audit chain via
    `lib/witness/scrupleInternalEmit.ts`. These events are Merkle-
    chained and periodically ledger-anchored, providing
    tamper-evident audit records that are third-party-verifiable
    without depending on Docent's cooperation.
- **HIDS.** `osquery` deployed on Backend-Web + Backend-Signer CVM +
  Witness host. Configuration at
  `runbooks/hids-config.md` / `deploy/osquery.conf` with monitoring
  rules covering:
  - File integrity monitoring on `services/c2pa-signer/`,
    `/opt/scruple-witness/`, `/etc/systemd/system/scruple-*.service`
  - New listening TCP/UDP sockets (unauthorized service startup)
  - Suid/sgid changes
  - Process launches by root outside a small allowlist
  - Kernel module loads / unloads

  Aggregation: log-forwarding via `osqueryd`'s `logger_plugin` to
  a central log store (OCI Logging).
- **Network segmentation.**
  - **Cloudflare Tunnel:** ingress-only isolation. No directly-
    Internet-facing listeners on any Scruple host.
  - **OCI VCN:** Backend-Web is on a public subnet (accepting only
    cloudflared tunnel origin); Backend-Signer CVM is on a private
    subnet with no public IP, reachable only from Backend-Web's
    Compute instance via a specific security-list rule and mTLS.
  - **VCN Security Lists** deny all inter-subnet traffic except
    the whitelisted Web ↔ Signer path on TCP port 8443.
  - **VCN Flow Logs** enabled for both subnets, 30-day retention.

**Reports attached:**

- `security-architecture/evidence/oci-audit-status.txt` — OCI Audit
  log status (`oci audit event list --start-time ... --end-time ...`
  output)
- `security-architecture/evidence/osquery-fleet-status.txt` — osquery
  running-status output
- `security-architecture/evidence/cloudflare-tunnel-status.txt` —
  `cloudflared` tunnel active status
- `security-architecture/evidence/oci-vcn-topology-redacted.png` —
  VCN topology diagram showing subnet isolation

---

## Interop verification

The accompanying evidence bundle at
`docs/c2pa-conformance-evidence/2026-07-14/` includes signed samples
across the asserted GENERATE and VALIDATE MIMEs. Each `Generate.
output.<mime>/` and `Validate.output.<mime>/` folder contains the
signed asset + a `c2pa.Reader().json()` output demonstrating that
the same c2pa-python library that produced the sign successfully
reads and validates it. Cross-implementation verification against
`c2patool` (Rust reference) and Adobe Verify is planned before final
filing and will be attached as
`security-architecture/evidence/interop-report.md`.

---

## Elapsed-time dependencies

The one item that has real elapsed-time between filing acceptance
and production customer availability is Trust List CA processing of
the CSR (§C.2.1). Everything else — CVM provisioning, IAM setup,
cert install, cutover — is scripted in the runbooks and executes in
under a day.

## Attestation of accuracy

The above architecture reflects the actual as-of-2026-07-15
production architecture of the Scruple Generator Product and its
Target of Evaluation. The 2026-07-12 evidence run at
`security-architecture/evidence/l2-evidence-2026-07-12T174954Z/`
demonstrates the substrate end-to-end with cryptographically-
verifiable hardware Root-of-Trust attestation. Any assessor request
for a live re-attestation of a currently-provisioned Signer is
welcome and can be fulfilled within same-day turnaround.

Signed:

**Shaun Hargadine**
On behalf of Docent LLC (dba Scruple)
Date: 2026-07-15
