# SCRUPLE CC WORK ORDER: NAVY ZT DESIGN SCOPE, GAP CHECK, AND EXPANSION ASSESSMENT
## Topic DON26BZ03-NV059 (NAVSEA), "Real-time Zero Trust Data and Access Control for Combat Systems"

You are the Scruple repository authority. You know nothing about the FPGA
product line beyond what this document tells you. Do not claim fabric
capabilities as Scruple's. Do not conflate Scruple with the network security
fabric or with the AI-model containment product; those are separate product
lines and stay separate.

Rules for your reply:
- Evidence grading on every claim: SHIPPED (in the repo, tested), BUILD
  (code exists, unproven), CONCEPT (documented only). Cite files.
- No timeline language anywhere.
- Mark UNVERIFIED where the repo does not confirm.
- Strategic decisions are reserved for the operator. Flag options; do not
  resolve them.

---

## PART 1. THE COMPLETE DESIGN (context; read, do not re-litigate)

The proposal is a capability-based design deliberately divorced from any
current dev board. One architectural invariant governs everything:

**A single programmable-logic fabric is the only physical path to protected
data. All transports are untrusted. All cryptography terminates in fabric
RTL. The host processor is a client of the fabric, never a mediator of
trust, and enforcement remains correct with the host OS and firmware fully
compromised.** (The Navy Q&A confirms this posture verbatim: enforcement
must be architecturally independent of the host software stack.)

The seven planes:

1. **Storage plane.** Fabric-owned NVMe on dedicated channels; DDR staging;
   host receives data only through the fabric. Compartments are physical
   (channel/partition) and generalize to N regions.
2. **Authentication engine.** Three factors, all verified in fabric with no
   host agent anywhere in the protocol:
   - CAC/PKI: mandatory per Navy Q&A, per-person, per-session (X.509 parse
     plus signature verify in fabric).
   - QSFP-cage crypto-ignition token: station custody, per-watch,
     challenge-response to RTL over cage sideband/management pins; no
     network path, no data path.
   - COTS cardiac-biometric wearable (Nymi-class): continuous presence and
     liveness; the wearable and its radio are commercial parts; the novel
     contribution is that its signed assertions terminate in fabric, host
     excluded. Radio transport is EMCON-adaptive (BLE in green states,
     contact/dock paths in restricted states) and the RF chip is outside
     the trust boundary (it can deny service, never forge presence).
   Factors compose into an assurance level; assurance level selects which
   time-scheduled access windows a principal is eligible for.
3. **TSN control fabric.** Time-aware scheduled arbitration of storage
   channels (802.1Qbv analog), per-stream policing (802.1Qci analog),
   disciplined time base with holdover. Grants are gate windows, not
   sessions; every grant expires at epoch end and re-verifies. Continuous
   verification is enforced by the clock. Temporal micro-segmentation
   stacks on spatial.
4. **Attestation ledger.** Hash-chained, signed, append-only record of every
   access decision (principal, resource, verdict, assurance, gate window,
   disciplined timestamp), head sealed against rollback, offline
   accumulation with replication and cross-node anchoring when connectivity
   permits. The Navy Q&A confirms verbatim that exactly this satisfies the
   blockchain element and that distributed consensus is not required.
   **This plane is Scruple's home. See Part 2.**
5. **Observation/ML plane.** Access-pattern telemetry per principal per
   epoch feeds anomaly scoring; the actuator is assurance demotion
   (windows narrow or close). Wearable HRV/morphology drift provides a
   person-level behavioral signal. No inline traffic-classification claims.
6. **Policy engine.** Edge-resident, attested; consumes signed policy
   bundles verified in hardware before acceptance (rejects unsigned blobs
   even pre-lock); cached signed CRLs with validity epochs; local
   decisions continue across disconnections of minutes, hours, and days
   (Navy Q&A envelope).
7. **Root of trust.** Filed-provisional boot stack: fused-key bitstream
   authentication, runtime self-integrity via configuration readback, PUF
   device-plus-configuration attestation token, signed-policy-blob
   verification. Open operator decision: on-die only versus on-die plus a
   discrete secure element (which would add silicon-vendor birth
   certificates and a monotonic counter for ledger head sealing).

Numeric targets (Navy): authentication time from 15 s to under 5 s
(measured from user initiation to access granted, per Q&A definition);
access latency reduced at least 50%; unauthorized-access risk reduced at
least 90%; administrative overhead of data management reduced at least 25%.
Representative Phase II environment (Q&A): 50-200 users, 100-500 devices,
segmented multi-tier topology, 10-100 Mbps per segment, latency under
100 ms for critical data, intermittent connectivity including EMCON.
Quantum-resistant cryptography is a Phase I architecture consideration
(CNSA 2.0 / FIPS 204 ML-DSA named in Q&A).

---

## PART 2. SCRUPLE'S ASSIGNED ROLES IN THIS DESIGN

Prior assessment (your own, earlier) established: local-first hash chain,
mint failure does not fail the seal, deferred anchoring, zero-content
posture, subject-agnostic leaf schema, independent verifier trust manifest,
C2PA qualification and EU code signature. Build on that; re-cite, do not
re-derive.

Assigned roles to validate against the repo:

- **R-A. Access-event ledger schema.** The fabric writes the chain in RTL;
  Scruple defines the record schema, the chain discipline, the verifier
  tooling, and the anchoring/replication protocol. Formalize the inversion:
  leaf schema for a data-access event (principal, device, resource,
  authorization decision, assurance level, gate window, timestamp) in place
  of an inference step. State exactly what changes and what is untouched.
- **R-B. Provisioning custody ledger.** The root-of-trust ceremony (device
  certification, key enrollment, PUF binding, bitstream measurement, token
  issuance, each bitstream update) recorded as a Scruple provenance chain:
  a cryptographic birth certificate and chain of custody for the
  enforcement device itself. Assess fit of existing machinery.
- **R-C. Cross-node anchoring and checkpoint distribution.** Ledger
  checkpoints replicated across enclave nodes when connectivity permits;
  the same distribution channel doubles as signed-CRL transport. Assess
  what exists for multi-node replication/anchoring and what is new.
- **R-D. Verifier and audit tooling.** Shore-side or afloat auditor
  verifies a node's chain offline against the trust manifest. Assess
  current verifier maturity and what a Navy after-action audit workflow
  would need.
- **R-E. PQ posture.** State current signature/hash algorithms in the seal
  and mint paths and the distance to an ML-DSA (FIPS 204) capable profile.

---

## PART 3. THE GAPS (the point of this work order)

These are the Navy requests the design currently has NO new answer for.
For each: state whether Scruple code, expanded Scruple code, or a Scruple
design pattern can close or partially close it. Cite files. Grade evidence.
If Scruple has nothing to offer a gap, say so in one line.

- **GAP 1. Non-person entities.** All three factors authenticate humans and
  stations. MTC-A/X access is mostly machine-tempo: services, track
  processors, sensor pipelines. Needed: workload/application identity
  (attested-process principals, service certificates, channel-bound
  identities) consumable by the fabric per request. Question for you: does
  Scruple's signing/manifest machinery already model non-person actors
  (build systems, pipelines, models as identities) in a way that
  generalizes to NPE principals?
- **GAP 2. Mission-prioritized failure (break-glass).** Navy Q&A prefers
  mission assurance when disconnected; our mechanisms all fail closed. 
  Needed: a hardware-attested emergency mode, mission-authority invocable,
  degraded-but-nonzero access, exhaustively ledgered. Question for you:
  does Scruple have any override/exception recording pattern (a signed
  "deviation event" with elevated evidentiary weight) that makes
  break-glass auditable rather than trust-destroying?
- **GAP 3. Enclave scale-out.** One fabric node is designed; 50-200 users
  and 100-500 devices across segments are not. Needed: multi-node policy
  consistency, remote-assertion transport, cross-node ledger anchoring
  mechanics. Your R-C answer is the core of this gap; extend it to state
  what a multi-node Scruple deployment topology looks like today, if any.
- **GAP 4. Administrative overhead, 25%.** We have narrative, no mechanism.
  Question for you: can Scruple's audit automation (verifier manifest,
  chain verification, evidence packaging) be quantified as reduction of
  data-management and after-action labor? Is there any measurable workflow
  in the repo (steps eliminated, artifacts auto-generated) we can model in
  Phase I M&S honestly?
- **GAP 5. ICAM enrollment and revocation mechanics.** Cached signed CRLs
  with validity epochs is a concept, not a design. Question for you: does
  Scruple's trust-manifest distribution or key-rotation machinery provide a
  working pattern for revocation-data distribution to disconnected nodes?

---

## PART 4. STOOGES, STOOGES JUNIOR, AND STIFFS

The operator directs that this assessment include Stooges, Stooges Junior,
and Stiffs. The claude-web coordinator holds NO current ground truth on any
of the three; any definition seen elsewhere is stale. The repo and its
documentation are the only authority.

**The weighting rule: the Part 3 gaps drive the audit, not the products.**
Audit all three equally. For each gap (and each Part 1 plane still thin on
mechanism), sweep all three repos for any concept, mechanism, schema, or
pattern that transfers. Transfers will not be one for one; that is
expected. A partial mechanism, an analogous protocol, or a reusable schema
is a finding. Report by GAP, not by product: under each gap, list what any
of the three (or core Scruple) contributes, cited and graded.

Include a one-line definition and maturity grade for each of the three so
the operator's coordinator has current ground truth, then move on. If any
of the three is absent from the repo, say ABSENT for it and continue with
the others. Do not speculate beyond the repo.

---

## PART 5. DELIVERABLE

One file: SCRUPLE_NAVY_EXPANSION_ASSESSMENT.md containing:
1. Role validation R-A through R-E (cited, graded)
2. Gap responses GAP 1 through GAP 5 (cited, graded, one-line "nothing to
   offer" where true)
3. Stooges / Stooges Junior / Stiffs section per Part 4
4. A single honest summary paragraph: what Scruple delivers today, what it
   delivers after a small fork, what it cannot deliver, for this design
5. Open questions for the operator, flagged not resolved

Write the file and stop.
