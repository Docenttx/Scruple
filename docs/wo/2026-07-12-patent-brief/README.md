# Patent Brief — Witnessed AI Model Training with Cryptographic Provenance

**Date drafted:** 2026-07-12
**Status:** DRAFT technical brief for patent counsel review. NOT a filing document. NOT legal advice.

## Contents

- `00-patent-claim-brief-for-counsel.md` — ~5,600-word technical brief covering the six-feature architecture (canonical training-time leaf, SEV-SNP-attested SoftHSM signer, Merkle checkpoint, public-blockchain anchor, C2PA sidecar, offline verification), prior-art analysis, five proposed claim slices (A-E), filing-strategy recommendations, and open questions for counsel.

## Reader warnings

- **This is a technical brief, not a filing.** It is written to help patent counsel understand the architecture and identify defensible claim scope. It contains DRAFT claim language that has not been vetted for 35 U.S.C. §101, §102, §103, §112, or infringement scope.
- **Prior-art references contain uncertain claims.** The brief cites specific patent numbers (Adobe, Verisart, Truepic, Numbers Protocol) as inventor's starting points; counsel MUST independently verify all patent numbers before drafting. Every uncertain reference is flagged inline with "counsel to verify."
- **Slice E (runtime tier gate) is flagged as likely unpatentable** post-*Alice*. Included for completeness; defensive publication is the inventor's recommendation.
- **Docent's prior filings (Filing 2, Filing 3) are referenced but not attached.** Counsel should pull their specifications to determine written-description overlap before deciding CIP vs. new provisional.

## Next steps

1. **Deliver to external patent counsel** with the concrete embodiment artifacts referenced in §7.4 (commits `7497f78`, `8adb9ff`, `0d45097`; `docs/l2-evidence/2026-07-12T174954Z/`; `docs/provenance-bundles/bundle-29e9a40e1d43/`).
2. **Have counsel independently verify prior-art patent numbers** cited in §7.2 (specifically Adobe, Verisart, Truepic, Numbers Protocol filings) and conduct a formal freedom-to-operate + prior-art search covering the identified assignees.
3. **Decide CIP vs. new provisional** after counsel reviews the specifications of Filings 2 and 3 for written-description overlap with the four viable slices (A-D).
4. **File provisional application(s)** — inventor's preliminary recommendation is one provisional covering all four viable slices with full enabling specification, then split into up to three non-provisionals at 12-month conversion (see §5.2).
5. **Engage the C2PA Working Group** with a FRAND letter of intent on the anchor-tuple custom assertion pattern once the provisional is on file (see §6 open question 4).

## Related documents

- `../../architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md` — canonical design document; §18 in particular for the SEV-SNP + SoftHSM path
- `../../architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md` — Continuous Audit API schema and leaf canonicalization
- `../../l2-evidence/2026-07-12T174954Z/POPULATED_SECURITY_ARCH_DOC.md` — the C2PA L2 Security Architecture Document filled with live evidence-run values (captured SEV-SNP measurements, VCEK, ARK chain, `report_data`-bound SoftHSM pubkey)
- `../../provenance-bundles/bundle-29e9a40e1d43/` — concrete puffjuly12 evidence bundle including the Project 181 LoRA sidecar
- `../2026-07-12-witnessing-l2/INDEX.md` — WO manifest for the L2 build this patent covers
