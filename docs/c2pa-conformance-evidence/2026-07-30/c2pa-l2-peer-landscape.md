# C2PA Level 2 Peer Landscape — where Scruple sits vs. the field

_Compiled 2026-08-05 against the live C2PA Conforming Products List, commit-of-day snapshot._

---

## 1. Top-line verdict

The C2PA Conformance Program at Level 2 is not a crowded field. As of 2026-08-05, only **five distinct Generator Products** hold a Level 2 certificate (seven records total, with three of them representing successive minVersions of the same Google Pixel Camera). Every listed Level 2 signer today is either an on-device mobile capture app riding platform hardware attestation (Google Pixel Camera, Evergreen Labs GreenCheckmark, Nuevo.Studio VWFNDR MBL, Qualcomm's Snapdragon 8 Elite Gen 5 SoC) or one cloud video signer (EZDRM DynamicSigner on AWS Nitro Enclaves + Azure Attestation). No AMD SEV-SNP-based signer is on the L2 list; no AI generator (OpenAI, Amazon Bedrock, Google Media Processing Services, Getty Images, Stability's Monolith) has gone above L1; **Adobe is present only as a Validator, not as a Generator**, and **Truepic has no direct listing** — its enterprise C2PA library is on the registry through Qualcomm's Snapdragon filing. This means Scruple's SEV-SNP + HSM-inside-CVM architecture is, at time of writing, unique among applicants and, if landed, would be **the first cloud L2 signer targeting AI-generated still-image workloads and the first L2 signer of any kind built on AMD confidential computing**.

## 2. The Level 2 field (official registry, 2026-08-05)

Data source: [`c2pa-org/conformance-public/conforming-products/conforming-products-list.json`](https://raw.githubusercontent.com/c2pa-org/conformance-public/main/conforming-products/conforming-products-list.json), 154 records total (134 generator, 20 validator). Filtered to `maxAssuranceLevel == 2`:

| # | Applicant | Product | Attestation methods | Conformed | Media |
|---|-----------|---------|---------------------|-----------|-------|
| 1 | Google LLC | Pixel Camera (minVersion 68566598) | `Android_KeyAttestation` | 2025-06-27 | JPEG |
| 2 | EZDRM, Inc | DynamicSigner (OU: Video) | `AWS_NitroEnclaveAttestation`, `Microsoft_AzureAttestation` | 2025-08-28 | MP4 video, AAC/MP4 audio |
| 3 | Evergreen Labs (CA) | GreenCheckmark - Android | `Google_PlayIntegrity`, `Android_KeyAttestation` | 2026-02-06 | JPEG, MP4 |
| 4 | Google LLC | Pixel Camera (minVersion 69134609) | `Android_KeyAttestation` | 2026-01-12 | JPEG, DNG |
| 5 | Nuevo.Studio LLC (JP) | VWFNDR MBL Android | `Android_KeyAttestation`, `Google_PlayIntegrity` | 2026-03-18 | JPEG, DNG |
| 6 | Google LLC | Pixel Camera (minVersion 69307851) | `Android_KeyAttestation` | 2026-03-16 | JPEG, DNG, MP4 |
| 7 | Qualcomm Technologies, Inc. | Snapdragon 8 Elite Gen 5 | `Qualcomm_WES` | 2026-06-29 | JPEG, PNG, TIFF, WebP, HEIC/HEIF, AVIF, MP4, WAV, MP4-audio |

That is the whole L2 pool: three re-filings of the Pixel Camera as its Android minVersion rolls forward, a video-specific cloud signer from EZDRM ([product page](https://www.ezdrm.com/c2pa-video-signature-service-ezdrm), [case study](https://www.ezdrm.com/blog/c2pa-for-live-video-signing-and-authentication-in-real-time)), two small-shop mobile capture apps, and Qualcomm's Snapdragon SoC (which is the platform Truepic's Secure Media Library rides on — see the [Truepic-Qualcomm announcement](https://www.truepic.com/blog/qualcomm-embeds-truepics-secure-media-library-as-feature-in-snapdragon-8-elite-gen-5)).

For contrast, the L1 field is 127 generator products, dominated by Google (44 records), vivo (9), Getty Images (4), and a long tail of AI/creator-tools filings including **OpenAI Media Service** (no attestation method declared), **Amazon Bedrock** (no attestation method declared), **Stability Solutions' Monolith**, four Getty Images products, and infrastructure players such as **DigiCert Content Trust Manager**. Cloud/TEE-based L1 attestations appear only sporadically: 4 filings use `AWS_NitroEnclaveAttestation` (VBrick, two Trufo entries, TMKR), 4 use `GoogleCloud_CloudHSMKeyAttestation` (Pixlmob, Pixelstream, REVERCE Reference Models, REVERCE CRESTAG), 1 uses `Microsoft_AzureAttestation + Microsoft_AzureManagedHSMAttestation` (Inborn Technologies ContentLens), and 1 uses `IETF_RATS` (IMATAG).

Named-absentees worth calling out: **Adobe Inc. is on the Validator list** ("Adobe Content Authenticity Inspect", conformed 2025-08-05), not on the Generator list — Firefly and Adobe's cloud-signing pipeline are not yet filed as a conforming Generator Product at any level. **Microsoft, Nvidia, Meta, Anthropic, Midjourney, Runway, Digimarc, Steg.AI, DataTrails** — none appear at any level. **Nikon, Sony, Leica** — none appear (the on-device Composite camera play is currently represented only by Google's Pixel and, at the silicon layer, by Qualcomm).

## 3. Architectural comparison — Scruple vs. peers with public info

Legend for _Implementation Class_: **D** = Distributed, **C** = Composite, **?** = not publicly declared. Level column is the L on the Conforming Products List today; a dash indicates "not on the CPL at any level".

| Product | Level | Class | Attestation substrate | Key custody | Cert enrollment | Patch-recency mechanism | TOE boundary / manifest construction |
|---------|-------|-------|-----------------------|-------------|-----------------|--------------------------|--------------------------------------|
| **Scruple (this GPSA)** | filed L2 | D | **AMD SEV-SNP CVM on OCI**, VCEK-chained | PKCS#11 HSM inside the CVM, ES256, non-extractable | Manual CSR to Program Trust List CA | **Per-sign extraction of OS security-patch date from dnf/apt logs, refuse-to-sign > 90 days, date bound into manifest** | Whitelist at API boundary; only Scruple-authored labels land in `created_assertions`; unknown labels rejected fail-closed; manifest built inside TOE |
| Google Pixel Camera | L2 | C | Titan M2 secure element + Tensor G5 (StrongBox), CC PP.0084 AVA_VAN.5 | Titan M2 hardware-backed keystore, one-time-use keys | Google-run C2PA CA verifies keys via Android Key Attestation before issuing cert [[source]](https://www.googblogs.com/how-pixel-and-android-are-bringing-a-new-level-of-trust-to-your-images-with-c2pa-content-credentials/) | [inference] Handled via Android platform patch cadence; not documented as a per-sign check | Signing occurs in image signal pipeline as part of capture; single vendor-controlled Composite pipeline; [inference] TOE boundary is the vendor SoC |
| Qualcomm Snapdragon 8 Elite Gen 5 | L2 | C | Snapdragon Secure Element + WES (Wireless Edge Services) attestation and provisioning | On-die secure element; keys never leave silicon | Qualcomm WES trust chain [[Qualcomm brief]](https://www.qualcomm.com/content/dam/qcomm-martech/dm-assets/documents/Snapdragon-8-Elite-Gen-5-SM8850-5-AC-Product-Brief.pdf) | [inference] Bound to SoC firmware release cadence, not per-sign at software layer | Truepic's Secure Media Library runs on the SoC; hardware-embedded C2PA generator |
| EZDRM DynamicSigner (video) | L2 | D | **AWS Nitro Enclave** + **Azure Attestation** (dual-cloud) [[EZDRM]](https://www.ezdrm.com/c2pa-video-signature-service-ezdrm) | Not publicly disclosed; [inference] cloud KMS or in-enclave key material | Not publicly disclosed | Not publicly disclosed | API-centric microservice; fragment ingestion → hash-chain → sign → embed in fMP4 uuid box; supports live streaming (HLS/DASH/CMAF) |
| Evergreen Labs GreenCheckmark (Android) | L2 | C | `Play Integrity` + `Android_KeyAttestation` — platform-level | Android hardware keystore (per-device) | Ships on device via Android app | [inference] Bound to Android OS update cadence | Mobile capture app; no public architecture doc |
| Nuevo.Studio VWFNDR MBL (Android) | L2 | C | Same as above (KeyAttestation + Play Integrity) | Android hardware keystore | Ships on device | [inference] Bound to Android OS update cadence | Mobile capture app; no public architecture doc |
| Adobe Firefly / Content Credentials | — (not on L1 or L2 as Generator) | D [inference] | Not publicly disclosed | [inference] KMS/HSM-backed; Adobe has not published a Generator GPSA | Adobe self-run CA prior to Program; migration to Program CA implied | Not publicly disclosed | Firefly-generated assets carry a C2PA manifest naming model and version; construction pipeline internal |
| Truepic Enterprise C2PA (as library) | — (via Qualcomm L2 record) | C on SoC / D as library [[Truepic]](https://www.truepic.com/blog/truepic-first-with-c2pa-2-0-support-for-enterprises) | Vendor-integrated (e.g. Snapdragon SE) or vendor's HSM | Per-integration | Per-integration | Vendor pipeline | Truepic marketing describes "combined claim generation and signing process within one secure library" |
| Microsoft Bing Image Creator / Copilot | — | ? | Not publicly disclosed | [inference] Azure Managed HSM | Not publicly disclosed | Not publicly disclosed | Manifest carries model/version and edit history [[Windows Forum overview]](https://windowsforum.com/windows-news.4/microsoft-copilot-and-c2pa-content-credentials-ai-provenance-in-images-and-text.398029/) |
| OpenAI Media Service (DALL·E / Sora) | L1 | ? | **No attestation method declared** on CPL | Not publicly disclosed | Program CA (Level 1 path) | Not publicly disclosed | Standard C2PA manifest embedded in JUMBF; Sora signs generated video [[OpenAI help]](https://help.openai.com/en/articles/8912793-c2pa-in-chatgpt-images) |
| Amazon Bedrock | L1 | ? | **No attestation method declared** on CPL | [inference] AWS Secrets Manager / KMS per [AWS reference architecture](https://docs.aws.amazon.com/solutions/media-provenance-with-c2pa-on-aws/) | Program CA | Not publicly disclosed | AWS reference: Lambda/Fargate + c2pa toolchain; **no Nitro Enclave in the reference stack** — Secrets Manager holds the key |
| Getty Images (4 filings) | L1 | ? | **No attestation method declared** on CPL | Not publicly disclosed | Program CA | Not publicly disclosed | Assertions distinguish AI-Generated vs. AI-Modified |
| VBrick, Trufo, TMKR (cloud L1) | L1 | D | `AWS_NitroEnclaveAttestation` | [inference] KMS or in-enclave | Program CA | Not publicly disclosed | Enterprise media/AI provenance services |
| REVERCE, Pixlmob, Pixelstream (cloud L1) | L1 | D | `GoogleCloud_CloudHSMKeyAttestation` | Google Cloud HSM | Program CA | Not publicly disclosed | Cloud-signer services |
| Inborn Technologies ContentLens | L1 | D | `Microsoft_AzureAttestation` + `Microsoft_AzureManagedHSMAttestation` | Azure Managed HSM | Program CA | Not publicly disclosed | Enterprise AI provenance |

## 4. Where Scruple looks like the field

- **Distributed Implementation Class** is the norm for cloud/AI signers. EZDRM (the only other L2 Distributed signer) and the entire cloud L1 cohort (VBrick, Trufo, TMKR, REVERCE, Pixlmob, Pixelstream, Inborn) are Distributed. Composite is currently a mobile-hardware and camera-silicon thing.
- **HSM-hosted key with non-extractable ECDSA P-256** is standard practice. The [AWS reference architecture](https://docs.aws.amazon.com/solutions/media-provenance-with-c2pa-on-aws/) uses Secrets Manager (weaker than HSM); the Google Cloud HSM cohort and the Azure Managed HSM filer show the same "cloud-vendor HSM + attestation" pattern; Scruple's PKCS#11 HSM matches this shape.
- **Manual CSR to the Program-designated Trust List CA** is the enrollment pattern documented for the Program at both levels ([opensource.contentauthenticity.org/docs/conformance](https://opensource.contentauthenticity.org/docs/conformance/), [SSL.com how-to](https://www.ssl.com/article/how-to-submit-to-the-c2pa-conformance-program/)). Automated enrollment is not yet a Program feature.
- **A single, custom manifest built inside the signer TOE per request** (no delegated blind-sign of externally supplied manifests) is the pattern implicit in every credible L2 filing. Blind-signing an external claim would violate the Level 2 boundary expectations described in the C2PA Security Considerations.
- **Fleet management with fixed rotation windows and CI-verified golden images** is [inference] consistent with what a cloud L2 filer would need to satisfy the Program's Product Security Architecture template; it is not novel but it is well-scoped.

## 5. Where Scruple is novel or unusual

- **AMD SEV-SNP CVM as the attestation substrate is unique on the CPL.** The registry's attestation-method enumeration does not even contain a SEV-SNP identifier today; every cloud filer uses `AWS_NitroEnclaveAttestation`, `GoogleCloud_CloudHSMKeyAttestation`, `Microsoft_AzureAttestation`, or `Microsoft_AzureManagedHSMAttestation`. The Program will have to accept an AMD-VCEK-chain proof under a new or ad-hoc attestation-method label. [inference] This is a moderate reviewer-education burden but not a policy blocker — the Security Requirements are attestation-substrate-agnostic, and SEV-SNP's threat model is favorably compared with Nitro Enclaves in the academic literature (e.g. [Confidential VMs Explained, ACM SIGMETRICS 2025](https://dl.acm.org/doi/10.1145/3700418)).
- **HSM-inside-CVM (rather than cloud KMS beside the enclave) is uncommon.** The prevailing cloud pattern is "TEE attests → TEE calls cloud KMS to sign." Scruple keeps the key custody inside the confidential VM's own PKCS#11 module, so the sign operation never leaves the attested boundary. That is architecturally stronger than the AWS reference stack (which parks the key in Secrets Manager outside any enclave) and matches, on paper, what the Azure Managed HSM + Azure Attestation filing gets.
- **Per-sign OS security-patch-date extraction with a 90-day fail-closed gate is genuinely rare.** No competitor's public architecture description mentions per-sign patch-recency enforcement. The mobile Composite filings inherit patch cadence from the OS vendor; the cloud filings appear to satisfy 6.3.2/6.4.2 through operational commitments rather than in-band evidence. Binding the extracted date into the signed manifest via `ai.scruple.signer-runtime.v1` gives verifiers an out-of-band cross-check that no peer offers today. [inference] This is a strength for reviewer confidence but a maintenance liability if the extraction breaks silently on OS upgrades.
- **Explicit assertion allow-list at the API boundary, with created_assertions vs. gathered_assertions routing and unknown-label rejection, is not documented anywhere else publicly.** The C2PA spec distinguishes the two assertion sets but leaves TOE boundary enforcement to implementers. Scruple's fail-closed whitelist is the strongest public interpretation of the 6.3.1 requirement.
- **Not offering device-attached capture, hardware camera integration, or watermarking-only mode** matches the shape of most cloud AI-generator filings (OpenAI, Bedrock, Getty). It differs from Truepic's product-line breadth and from the Nikon/Sony/Leica Composite direction, but those aren't Scruple's markets.

## 6. What Scruple could learn from peers

- **Video signing surface.** EZDRM is the only Distributed L2 filer today, and their differentiator is fragment-level signing for live HLS/DASH/CMAF. If Scruple ever pursues video, EZDRM's `uuid`-box embedding pattern and anchor-point hash-chain are the reference to study. Not a Scruple priority right now.
- **Dual-cloud attestation posture.** EZDRM lists **both** `AWS_NitroEnclaveAttestation` and `Microsoft_AzureAttestation` on a single record, suggesting portable-signer engineering across two TEE substrates. [inference] Scruple could pre-empt a future single-vendor blast-radius argument from the reviewer by documenting a portability path from SEV-SNP to Intel TDX or Nitro Enclaves. Not required for filing, but a strong answer if asked.
- **Firmware/OS attestation as a first-class assertion.** The academic "TEE-assisted signing" literature (see [Signing Right Away, arxiv 2510.09656](https://arxiv.org/pdf/2510.09656)) argues for including TEE attestation *in the manifest itself*, not just in the enrollment moment. Scruple already binds the runtime patch date; extending `ai.scruple.signer-runtime.v1` to also carry the SEV-SNP measurement digest at sign time would push the state of the art and is a small marginal cost.
- **Mobile hardware attestation is table-stakes at L2 for anything that touches a phone.** All non-Google L2 filings ride Android KeyAttestation + Play Integrity; Apple's `Apple_AppAttest` shows up only at L1 today. If Scruple ever exposes a client-side capture SDK, plan for both Android and iOS attestation from day one.
- **Adobe's absence from the Generator side is a market signal, not a Program signal.** The fact that Adobe is only a Validator applicant so far means the Generator field is genuinely open. Scruple can position as "the L2 AI-generator signer" without a Firefly comparison to worry about.

## 7. Program-level signals

- **Reviewer identity.** Scott Perry is **Conformance Program Administrator** (not a rotating panel), serving as the fixed operational owner of the review process; he is also Co-chair of Trust Over IP's Foundations Steering Committee and founder/CEO of the Digital Governance Institute ([ToIP recap of his 2025-05-15 EGWG session](https://trustoverip.org/blog/2025/05/20/egwg-2025-05-15-the-c2pa-conformance-program-scott-perry/), [Dialectica profile](https://www.dialectica.io/community-hub/standardizing-trust-inside-the-c2pa-movement)). His governance-role definitions map C2PA into three tiers — Governing Authority (Steering Committee), Administering Party (Conformance Task Force he chairs), Governed Parties (CAs, Generator/Validator applicants). Reviewer reports from Perry are the standard artifact.
- **Program launch and timeline.** Formal Conformance Program launched **mid-2025** (June 4, 2025 launch date referenced in the ToIP recap). Interim/legacy trust model was frozen on **January 1, 2026**; all new certificates now flow through the Program's Trust List CA.
- **Four levels planned, two open.** The program is designed for four assurance levels; L1 and L2 are the only two currently open. Higher levels (independent attestation, presumably a formal external lab) are on the roadmap but not yet accepting filings.
- **Pipeline volume.** Roughly 127 L1 generator products, 7 L2 records (5 distinct products), 20 validators. Cadence in mid-2026 has been ~20 new L1 filings per month; L2 has averaged closer to one per quarter. The L2 pipeline is genuinely thin.
- **IPTC signaled a 2026 filing** ([IPTC news](https://iptc.org/news/iptc-announces-passing-c2pa-conformance-program-at-the-2026-spring-meeting/)) — already reflected on CPL as "IPTC C2PA Signer Tool" at L1.
- **The Conformance Explorer** is an Angular SPA at [`spec.c2pa.org/conformance-explorer/`](https://spec.c2pa.org/conformance-explorer/), driven live by the JSON list in [`c2pa-org/conformance-public`](https://github.com/c2pa-org/conformance-public). Fetching the JSON directly is the reliable way to audit the field.

## 8. Confidence notes

Well-cited, load-bearing:
- The L2 field of 7 records / 5 distinct products, and the attestation-method enumeration — direct read of the CPL JSON at [conforming-products-list.json](https://raw.githubusercontent.com/c2pa-org/conformance-public/main/conforming-products/conforming-products-list.json).
- The claim that no SEV-SNP-based signer is on the CPL today — same source, exhaustive attestation-method scan.
- Scott Perry's role as Conformance Program Administrator — [ToIP recap](https://trustoverip.org/blog/2025/05/20/egwg-2025-05-15-the-c2pa-conformance-program-scott-perry/) and [Dialectica profile](https://www.dialectica.io/community-hub/standardizing-trust-inside-the-c2pa-movement).
- Pixel Camera's use of Titan M2 + StrongBox + Android Key Attestation — [Google Security Blog announcement](https://security.googleblog.com/2025/09/pixel-android-trusted-images-c2pa-content-credentials.html) via search results and [c2pa.ai Pixel 10 news item](https://c2pa.ai/news/pixel-10).
- Truepic's ride into Snapdragon 8 Elite Gen 5 — [Truepic Qualcomm announcement](https://www.truepic.com/blog/qualcomm-embeds-truepics-secure-media-library-as-feature-in-snapdragon-8-elite-gen-5).
- EZDRM DynamicSigner uses Nitro Enclave + Azure Attestation and holds the only cloud L2 record — CPL attestationMethods field + [EZDRM's product page](https://www.ezdrm.com/c2pa-video-signature-service-ezdrm).
- AWS's C2PA reference architecture parks keys in Secrets Manager, not an enclave — [AWS Solutions Guidance page](https://docs.aws.amazon.com/solutions/media-provenance-with-c2pa-on-aws/).
- Adobe is on the Validator list, not the Generator list — CPL JSON.

Marked [inference] in the report body:
- Whether cloud L1 filers using Nitro/Google Cloud HSM would be Distributed vs. Composite (none publish an Implementation Class in their CPL record).
- Whether any peer performs per-sign patch-recency extraction at all (absence of public documentation is not proof of absence).
- The specific patch-cadence mechanism inside Pixel Camera or the Android L2 apps.
- The exact key custody model inside EZDRM's enclaves.
- Reviewer education cost for a SEV-SNP-based filing (based on the CPL's current attestation-method vocabulary not containing SEV-SNP, but the Security Requirements being substrate-agnostic).
- Adobe's internal signer architecture; Firefly-generated assets clearly carry manifests, but no GPSA has been published.
- Microsoft's Copilot/Bing Image Creator signer architecture; C2PA signing is confirmed but not documented publicly at the substrate level.
- Whether Sora / OpenAI Media Service uses any TEE — CPL record explicitly declares no attestation method, which is the ground truth at the Program level.

Genuinely unavailable publicly:
- Any Generator Product Security Architecture Document (GPSA) other than a small number of vendor-published summaries. GPSAs are submitted privately to the Program and are not part of the Conforming Products List surface.
- Adobe Firefly's implementation class and key custody at the signer level.
- The private-key custody model for OpenAI Media Service, Amazon Bedrock, or any of the L1 AI generator filings that omit an attestation method.
- Whether Truepic's enterprise C2PA library will be filed as a standalone Generator Product independent of the Qualcomm SoC filing.

---

**Bottom line for the reviewer conversation:** Scruple is not out-of-family with the L2 field's shape — Distributed class, HSM-backed non-extractable ES256, Trust List CA enrollment, in-TOE manifest construction — but it is **the first filing to use AMD SEV-SNP**, **the first cloud L2 signer for AI-generated stills**, and (based on public documentation) **the only Generator Product publishing an in-band per-sign patch-recency assertion**. That combination reads as "conservative on the axes the Program cares about (6.3.1 TOE boundary, 6.3.2/6.4.2 patch recency, cert enrollment discipline) and forward on the axes the Program has left open (attestation substrate, in-manifest runtime evidence)." The main reviewer novelty is substrate familiarity, not architectural risk.
