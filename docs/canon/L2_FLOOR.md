# The L2 Floor

**Principle (founder, 2026-08-26):** *"We can't have an evidence standard
below a simple compliance standard."*

**Status:** Analysis and target. Nothing here is implemented.
**Applies to:** everything Scruple signs, not only the C2PA modality.

---

## 1. The problem in one table

Scruple went from C2PA Level 1 to Level 2 to satisfy the Conformance
Program. That upgrade landed on the C2PA signing path. It did not land on
the path Scruple's own Standard describes as the substrate underneath
C2PA.

| | C2PA manifest | Witness leaf |
|---|---|---|
| Algorithm | ECDSA, asymmetric | **HMAC, symmetric** |
| Key custody | PKCS#11 HSM; key never leaves the TEE | `SCRUPLE_WITNESS_SECRET` in a **systemd unit env var** |
| Compute | AMD SEV-SNP Confidential VM, attested | the **same Linux host as the web application** |
| Under measurement | in git, in the GPSA TOE | **not in git** (`/opt/scruple-witness/`) |
| Third-party verifiable | yes — any C2PA tool, no Scruple involvement | **no** |
| Non-repudiation | yes | **no** — Scruple can mint any leaf |
| Patch-recency gated | yes (C.2.3.0, added in GPSA v3) | no |

Source: `docs/CANONICAL_GUIDE.md:162-166`, `lib/scruple/witness.ts:5`,
`services/c2pa-signer/`.

The commercial position — stated in
`SCRUPLE_C2PA_RELATIONSHIP_CHART_v1.md` — is that C2PA is **one modality
inside** Scruple's evidentiary framework. The assurance runs the other
way: the modality is at L2 and the framework containing it is not.

---

## 2. The counter-argument, and where it stops

`CANONICAL_GUIDE.md:166` argues the symmetric seal is acceptable:

> Symmetric — fine for web (it's a server-side seal; the public verifier
> is the RVN mint wallet, which is asymmetric by virtue of being
> on-chain).

**This is correct for chain-locked events.** An on-chain inscription is
publicly verifiable without Scruple's cooperation, and it carries the
leaf hash. For those events the HMAC is a transport seal and the ledger
is the evidence.

**It does not hold anywhere else, and "anywhere else" is most events.**
Standard §9.4 makes local lock the default terminal modality on *every*
event, and §9.5 explicitly contemplates a customer selecting C2PA only,
or watermark only, or neither. For an event that is not chain-locked, the
HMAC seal is the entire evidentiary claim — a secret Scruple holds,
verifiable by nobody else, forgeable by Scruple.

So the argument does not fail; it has a scope, and the Standard's own
modality design puts most events outside it.

---

## 3. Scruple paths against the GPSR L2 families

The GPSA is organised on these. Each row asks the same question the
reviewer asked of the signer, of everything else.

| GPSR family | C2PA signer | Witness / baseline / lock | Client (plugins) |
|---|---|---|---|
| **C.2.1** authentication for certificate enrollment | MEETS | **N/A → gap.** No certificate: an HMAC secret has no enrollment story at all | N/A |
| **C.2.2** key generation, storage, usage | MEETS — HSM, TEE-resident | **FAILS.** Secret in a systemd env var on the app host | **FAILS.** CAD shells write API keys to `%APPDATA%` in plaintext; Kohya uses one global HMAC across every pod and user |
| **C.2.3** protections against misconfiguration and abuse | MEETS — incl. C.2.3.0 patch recency, fail-closed | **UNASSESSED.** Not in git, so not measured, not patch-gated | **UNASSESSED** |
| **C.2.4** content-processing software | MEETS — assertion partition, fail-closed | N/A | Partial — MIME handling is inconsistent across six forks |
| **C.2.5** interception and modification of traffic | MEETS | Partial — loopback only, but `/api/diag/fusion` and `/embed/fusion/debug` are unauthenticated by design | **FAILS.** Fusion's handoff bridge is commented as dev-grade in-memory, single-process |
| **C.2.6** hosting environment exploitation | MEETS — CVM, ephemeral fleet, HIDS | **FAILS.** Shares a host with the web app; compromise of the app tier yields the witness secret | N/A |

**The circularity worth naming separately.** Standard §3 says a baseline
covers "the code, configuration, and attested compute environment" of the
integration. The witness server computes baselines and is not in git,
so it cannot itself be measured. The component that establishes what
counts as unmodified is the one component nothing can check.

---

## 4. Harmonization target

**The rule:** any artifact Scruple offers as evidence is signed by a key
held to at least GPSR L2 custody, inside the attested TOE, and is
verifiable by a third party without Scruple's cooperation.

**H-1 · The witness stops signing. It becomes a client of the Signer.**
Leaves are ECDSA-signed over the canonical record by the same
HSM-resident key already in the TOE. §2's claim that both are witnessed
"through the same signing key" becomes literally true rather than
aspirational, and the L2 evidence applies uniformly.

**H-2 · HMAC survives, demoted to what it is.** A shared secret between
the app tier and the witness is a legitimate transport-integrity check.
It stops being an evidence claim. Nothing in a receipt derives its
trustworthiness from it.

**H-3 · The witness server enters git and the TOE.** Un-measured code
cannot compute a baseline. This also makes it patch-gateable under
C.2.3.0, which today it is not.

**H-4 · Client-side key custody rises to the same bar.** Plaintext API
keys in `%APPDATA%`, a single global Kohya secret shared across pods and
users, and a dev-grade in-memory handoff bridge all fail a client-side
reading of C.2.2 and C.2.5. The canon SDK owns this in one place.

**H-5 · §12.4 verifiers chain to a vendor root or say they did not.**
Structural-only verification presented as verified is the one clause the
estate actively violates, and it is an evidence claim below the standard
of the thing it sits beside.

---

## 5. What this costs, stated plainly

**The CVM stops being optional.** Today it is powered down to save money
and only C2PA needs it. Under H-1 every witnessed event needs it, so it
becomes always-on infrastructure with a running cost. That is a real
commercial input and it should be decided as one, not discovered later.

There is a cheaper middle path that should be considered and rejected on
its merits rather than ignored: sign leaves asymmetrically with a key
held outside a TEE. That gets third-party verifiability and
non-repudiation — most of the benefit — without CVM uptime. It does not
get C.2.2 custody, so the evidence layer would sit below L2 while
claiming parity. Given the principle above, it fails.

---

## 6. Questions for the founder

1. **Is §2's "same signing key" a description of intent, or a claim
   already made to a counterparty?** It appears in a public-facing
   capability register. If it has been shown to the C2PA reviewer, to the
   EU AI Office, or to a customer, the gap between claim and
   implementation is more urgent than the engineering.

2. **Does the L2 floor bind the client side?** §6 says security ends at
   the signing moment and Phase 1 is the integrator's discipline. A
   plugin holding a plaintext API key is Phase 1. Reading the floor as
   client-binding makes H-4 mandatory; reading it as server-only makes it
   a recommendation.

3. **Do chain-locked events keep a cheaper path?** The RVN argument
   genuinely holds for them. Uniformity is simpler to explain and to
   audit; a two-tier evidence path is defensible but has to be stated in
   the Standard rather than left implicit in an implementation.
