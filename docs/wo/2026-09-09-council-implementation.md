# WO series — implementing the settled council design

_2026-09-09. The Blender×ComfyUI council closed at 35 rounds (artifact
`1a978a6`). Six items came back to us. Five are implemented here. The sixth is
**planned only** — it changes a production audit log._

## The rail that governs this whole series

🔴 **`/opt/scruple-witness` IS NOT TO BE MODIFIED BY ANY WO IN THIS SERIES.**
It serves `witness.scruple.ai` and is live. WO-C6 produces a plan and test
vectors; it changes nothing.

⚑ **CORRECTED 2026-09-09 by the founder, and it changes WO-C6 substantially.**
An earlier draft of this document said already-minted chain locks are anchored
on RVN/Arweave against the old root and cannot be recomputed, so
canonicalisation had to be versioned rather than retroactive. **That is wrong.
There are no real provenance packages — every anchored artefact to date is test
work.** So there is no irreversible history to preserve and no reason to carry
two rules. Pick the correct construction, apply it everywhere, and **delete the
others** rather than maintaining a legacy path for records that were never real.

The version stamp still ships — but as **forward insurance**, so that a future
change to the construction is survivable once real packages exist. That is the
cheap half of the original plan without the expensive half.

Everything else from the standing rails still applies: never contact
`127.0.0.1:5799` (production witness) or `:3001` (live site); the sandbox is the
scratch witness on 5899 and the scratch app on 3902; the CVM surrogate on 8799
is SOFTWARE-backed and a leaf it signed is never hardware-backed.

**Verify by side effect.** Every gate names an observable and a control that
must NOT fire. A green test with no control proves only that it cannot fail —
this series exists because a prose rule failed exactly that way inside the
council itself.

---

## WO-C1 — The three-valued basis, and `stale` until the roots agree

The council settled a per-leaf attestation basis that every field-level
`source: measured` is conditional on. One basis per leaf. **No per-field
`basis_ref` pointer** — twelve fields pointing at one basis still read as twelve
measurements to anyone not following the pointer.

- Basis is `verified` | `stale`/`unbound` | `passthrough`. Absent or malformed
  is **never** `verified`; legacy leaves resolve to `source: unknown` for trust
  decisions, and new v1 leaves must not emit `attestation_status: null`.
- `verified` requires the quote to bind to *this* emission (freshness nonce
  generated **outside** the box, plus what the quote covers). A quote that
  cannot be bound is `stale`, **not** folded into `passthrough` — those are
  different operational conditions with different fixes.
- ⚑ **Until WO-C6 lands, every new leaf emits `stale`.** The Merkle roots do not
  agree, so no checkpoint can be claimed settled.
- ⚑ **`verified` is unreachable on the desktop profile by construction** — PCRs
  attest boot, the threat is runtime root, and an interval bound cannot exclude
  a compromise inside its own interval. Make it unrepresentable there, not
  merely unlikely.
- The validator must **reject `close_detection` as a provenance or completion
  field**, so the retracted `IN_CLOSE_WRITE` dependency cannot return as a dead
  schema reference. Enforce in the validator, not in prose.

**Gate:** a leaf emitted today reads `stale`. Controls: a leaf claiming
`verified` on the desktop profile is **rejected**; a leaf with
`attestation_status: null` is rejected; a `close_detection` value used as a
provenance field is rejected. Show each control failing before the fix and
passing after.

## WO-C2 — The handles go inside the signed preimage

Moving proofs out of the leaf made the handles security-critical: an attacker
who can rewrite an unsigned endpoint redirects resolution to a service that will
confirm anything — the handle becomes the attack surface the proof used to
close.

Put the witness endpoint, the authority identity, `checkpoint_id`, and the
preceding checkpoint id with its quote time **inside the signed preimage**
(`lib/leaf/componentPreimage.ts`), not merely in `leaf.ts`.

**Gate:** altering any handle by one byte invalidates the signature. Control: a
leaf with handles present but outside the preimage must FAIL the new test —
demonstrate it red before the change.

## WO-C3 — `retention_policy_digest` binds duration, not identity

A resolution attempted after the evidence is legitimately gone must yield a
named `evidence_expired` state rather than being indistinguishable from a forged
handle.

Also carry the settlement machinery the council agreed: `settlement_deadline`
plus the retention digest in the leaf, an unresolved gap flipping to terminal
`expired` at the deadline, and `expired` recorded as `source: measured` against
a **named clock** — a deadline derived from a locally-set timestamp is the
config-inherited field class already refused.

**Gate:** three distinguishable states from one query path — resolvable,
`evidence_expired`, and forged/unresolvable. Control: they must not collapse
into one another.

## WO-C4 — Storage confinement, measured per leaf and refused at startup

Two halves, and the second is the one that was missed:

- **Startup:** refuse to bind the proxy socket when `stat(stateDir).st_dev ===
  stat(outputVolume).st_dev`, or when `statvfs` shows no enforced quota or
  minimum reservable capacity. An uncaptured runaway write on a shared
  filesystem exhausts blocks, the ratchet's local append cannot `fsync`, and
  because the MAC is the *blocking* half of `emit()` the gate fails closed —
  fail-closed becomes fail-stopped, triggered by the artifact class the gate
  cannot even see.
- **Per leaf:** re-read the device identity **at emission** and carry it as
  `source: measured | unknown`. A startup-only check is a config-inherited fact
  by the time a leaf is emitted — volumes can be remounted or bind-mounted
  after boot, which is the inheritance pattern already killed on `pinned_build`.
- ⚑ Use **raw `stat()` st_dev, not cached path lookups**, or a mid-session mount
  namespace rewrite drops the check silently. That is the difference between the
  check working and looking like it works.
- Degraded operation is permitted only when the session's leaves are tagged
  `confinement: "degraded_shared_storage"` with `source: measured`, and it must
  be **visible** — never a silent degradation of a required capture session.

**Gate:** a bind mount performed *after* startup is detected at the next
emission. Control: the startup-only check must be shown NOT to catch it.

## WO-C5 — Upstream restart detection

Nothing tracks upstream identity today; the only restart handling is our own
re-provisioning in `identity.ts`. A silent ComfyUI restart resets its in-memory
history ring (`MAXIMUM_HISTORY_SIZE = 10000`, evicted oldest-first, lost on
restart) and currently masquerades as a normal short history.

Poll `/system_stats`, record the upstream's identity and a history epoch plus
the low watermark at **both** ends of any history query, and raise an
eviction-uncertainty flag rather than letting a restart look like a quiet
afternoon. `declared_uncaptured` must distinguish "not enumerated because
evicted/restarted" from "not queried" — otherwise the operator loses the only
signal telling them to shorten their query interval.

**Gate:** restart the scratch upstream mid-session and show the flag raised.
Control: an unrestarted session of the same length must NOT raise it.

## WO-C6 — Canonical Merkle: PLAN AND VECTORS ONLY. CHANGE NOTHING.

🔴 **Do not modify `/opt/scruple-witness`. Do not change any existing root
calculation. Produce a plan, test vectors and a conformance harness.**

Measured on 2026-09-09 — three live constructions:

| implementation | construction | domain separation |
|---|---|---|
| `lib/scruple/merkle.ts` | sorted-pair (`a<b ? a+b : b+a`), duplicate-last, hex | **none** |
| `lib/witness/merkle.ts` + `packages/scruple-verify/src/core/merkle.mjs` | RFC 6962, bytes | `0x01` leaf / `0x00` node |
| `/opt/scruple-witness/server.js:490` | hex concat | **none** |

Three facts the plan must address:

1. ⚑ **A sorted-pair Merkle cannot bind an index.** Pair order comes from hash
   value, not position, so an inclusion proof proves membership but not
   position — and the design requires `checkpoint_id, index, leaf_hash`. The
   canonical choice is therefore *forced*: RFC 6962.
2. Two of the three lack domain separation — the second-preimage weakness
   RFC 6962 exists to prevent.
3. 🔴 `server.js:883-888` anchors **whichever root the caller supplies**, else
   its own. The anchored root's algorithm is caller-dependent, so "the root" is
   not a well-defined value today.

**Deliverables:** one canonical preimage, tree ordering, domain separation and
proof format; a shared test-vector file every implementation must pass; a
conformance runner that executes those vectors against all three; and a
**cutover** plan.

⚑ **A cutover, not a migration.** There is no real history to preserve (see the
correction at the top of this document), so do NOT design a dual-rule scheme,
a legacy verification path, or a per-record compatibility branch. Say plainly
which of the three constructions survives, and which files should be **deleted**
once it does — a wrong implementation left in the tree is a future caller's
default.

Do still specify a `merkle_version` field stamped on each record. Its purpose is
forward insurance for a change made after real packages exist, not compatibility
with the test artefacts we are discarding. Say that explicitly in the plan, so
nobody later mistakes it for evidence that a legacy path once existed.

**Gate:** the vector file exists, the runner executes it against all three
implementations, and the report states plainly which pass and which fail today.
A runner that cannot show the current three disagreeing has not been proven to
work.
