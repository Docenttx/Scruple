# Independent AI Event Witnessing Rider

**Template — for adaptation by counsel. Attach to master services agreement / DPA between Customer ("Principal") and Vendor.**

---

**1. Definitions.** "Witnessing Service" means an independent third-party service, not operated by or affiliated with Vendor, that receives cryptographic commitments to AI-related events and produces append-only, hash-chained records with signed interval checkpoints, trusted timestamps, and commitments anchored to publicly verifiable ledgers (e.g., the Scruple witness service operated by Docent Technologies, or an equivalent service meeting the requirements of §3). "Covered Events" means the event categories listed in Schedule W-1 (e.g., AI-interaction disclosures presented to end users; machine-readable marking of synthetic outputs; agent or automated-system actions of the classes listed; model/version identity at time of each event).

**2. Emission Obligation.** For all services performed for Principal involving AI systems, Vendor shall, contemporaneously with each Covered Event, emit to the Witnessing Service a record commitment comprising, at minimum, a cryptographic hash of the event payload, the event timestamp, the applicable stream identifier, and Principal's identifier. Vendor shall not batch beyond [60] seconds of event time, shall not filter, sample, suppress, or redact Covered Events, and shall maintain monotonic sequence integrity per stream. Sequence gaps shall be reported, not concealed.

**3. Service Requirements.** The Witnessing Service must provide: (a) per-event inclusion proofs against signed interval checkpoints at a cadence not longer than [Schedule W-1 tier]; (b) [qualified electronic timestamps under eIDAS Art. 42 / RFC 3161 timestamps] on each checkpoint; (c) periodic anchoring of checkpoint roots to at least [two] independent public ledgers; (d) consistency proofs demonstrating append-only operation; and (e) an offline-capable reference verifier.

**4. Principal Direct Access.** Principal shall hold verification credentials issued directly by the Witnessing Service. Vendor shall have no ability to access, condition, delay, or intermediate Principal's retrieval of proofs, consistency checks, or exports. Vendor's authorization to emit on Principal's behalf is granted by revocable delegation; upon revocation or termination of this Agreement, Vendor's emission authority ceases and Principal receives a complete proof-bundle export at no charge.

**5. Data Handling.** The Witnessing Service stores no event content: it receives and retains only cryptographic commitments (hashes, Merkle structures, signatures, and timestamps) and holds no means of reconstructing or re-identifying event payloads. Default emission is hash-only: raw payloads shall remain within [Vendor's / Principal's] retention systems on write-once storage for the retention period in Schedule W-1, and shall be producible against any committed hash upon Principal's request within [10] business days. No personal data shall be transmitted to the Witnessing Service except as expressly configured in Schedule W-1.

**6. Verification; Records as Evidence.** The parties agree that records satisfying §3, together with matching payloads under §5, constitute the authoritative operational record of Covered Events as between the parties, and that either party may rely on such records in any dispute, audit, or regulatory inquiry. Vendor shall reasonably cooperate with any regulator- or auditor-initiated verification.

**7. Compliance Mapping.** The parties acknowledge this Rider supports, without guaranteeing, Principal's obligations under applicable law, including Regulation (EU) 2024/1689 Article 50 (transparency, marking, and disclosure) and associated Codes of Practice, and Vendor's corresponding provider-side obligations. Nothing herein shifts a party's own statutory obligations to the other party or to the Witnessing Service.

**8. Failure; Remedies.** Emission unavailability exceeding [0.1]% of Covered Events in any calendar month, or any intentional suppression, is a material breach. Witnessing Service fees are borne by [Principal / Vendor] per Schedule W-1.

**9. Survival.** §§4–6 survive termination for the retention period.

---

## Schedule W-1 (per engagement)

| Item | Value |
|---|---|
| Covered Event streams | e.g., `voice.call.disclosure`; `gen.output.marking`; `agent.tool_call` |
| Assurance tier | standard / enhanced / qualified (checkpoint ≤ [3600/300/60] s) |
| Timestamp mode | none / RFC 3161 / eIDAS-qualified TSA |
| Anchor cadence | daily / hourly |
| Payload retention & locus | [7] years; [Vendor S3 Object Lock — compliance mode] |
| Personal-data emission | none (hash-only) unless: [__] |
| Fees & payer | [__] |

*Template provided for discussion purposes; not legal advice; adapt to governing law and the parties' DPA.*
