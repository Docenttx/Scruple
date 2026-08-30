# The L2 floor is already the banking floor

_2026-08-30. Answers: can the vendor-integration structure be built with the
L2 harmonization items as its floor? Yes — four of the five already are the
mechanism. Two things are missing and one founder question is settled._

## The mapping

Payments does not trust the merchant. It trusts a component on the merchant's
counter that the merchant cannot modify, and it reconciles afterwards. Every
part of that has an L2 item already written.

| Banking mechanism | What it does | Scruple L2 item | Status |
|---|---|---|---|
| **PCI PTS device** — key injected at a certified facility, tamper-responsive, operator cannot extract | Puts the trust boundary in a *component*, not a *site* | **H-1** (leaf signed by the HSM-resident key inside the TOE) + **H-4** (client-side custody to the same bar) | H-1 implemented against the surrogate; **H-4 not started** |
| **P2PE scope reduction** — crypto inside the device puts the merchant's whole estate out of PCI scope | Makes the untrusted middle *irrelevant* rather than securing it | The consequence of H-1 + H-4 — **not currently stated as a rule** | **Missing** |
| **DUKPT** — per-transaction derived keys; the terminal never holds the base key | One compromise is not a systemic compromise | **H-4**, made concrete | **Missing the detail** |
| **Store-and-forward + settlement reconciliation** | Local nodes run disconnected; divergence is *detected* at settlement | `packages/scruple-host-sdk/queue.py` exists and is unwired; no gap detection anywhere | **Missing — new floor item** |
| **EMV Level 3** — the *configuration* is certified, not the operator | Conformance is per-integration, re-run on material change | The conformance loop (`oss-study/sonobuoy-conformance.md`) | Designed, not built |
| **Two-tier assurance** | Declares what backed a given transaction | **H-5** verified vs passthrough | **Implemented** |

## What this settles

### 1. Founder question 2 in `L2_FLOOR.md` §6 — answered

> *"Does the L2 floor bind the client side? Reading the floor as
> client-binding makes H-4 mandatory; reading it as server-only makes it a
> recommendation."*

**Client-binding. H-4 is mandatory.** In payments the client side *is* where
custody is enforced hardest — the entire P2PE scope reduction rests on the
device on the counter, not on the acquirer's data centre. A reading that
exempts the client would be PCI applying to the acquirer but not the terminal,
which is the one shape the industry has never permitted.

This is also the reading the vendor strategy forces. If vendors embed
witnessing in their own stack, **the client side is the product.** A floor
that stops at our server governs the part nobody is worried about.

### 2. H-5 is the answer to the "irreducible" residue — not trademark law

The `oss-study/SYNTHESIS.md` conclusion reached for CNCF's revocation clause as
the primary mechanism for P1/P3. That over-reached. **Verified vs passthrough
already is the two-tier model**, it is implemented, and it is honest per-leaf
rather than per-vendor.

Keep the distinction clean, because it is the one that stops this becoming a
gradation of certification:

- **Compliance is binary** (Standard §5). A vendor meets P1–P8 or does not
  claim the standard. No tiers.
- **Attestation strength is a declared property of each leaf** (P7/P8). Ran on
  attestable hardware → `verified`. Did not → `passthrough`. Both are
  compliant; the receipt says which.

Revocation stays as a backstop for a vendor who lies about the first one. It is
not the primary machinery.

## What is actually missing

### Missing 1 — the capture component as a shipped, measured artifact

H-3 put the witness server into git and under measurement, on the principle
that un-measured code cannot compute a baseline. **The same rule has to extend
to the thing running in the vendor's space.** Today there is no such artifact:
each integration authors its own capture, which is why Studio's two paths grade
so differently and why six forks each carried their own copy of the same queue.

The component ships from us with a published measurement, and every leaf
carries which build produced it — the analogue of the terminal's firmware
version riding in the transaction. That makes P1 checkable at ingest for the
first time: we know what we shipped, so we can tell whether a leaf claims a
build we published.

**The honest limit:** a modified build can claim any version string. Banking's
answer is that the key is injected into the certified build, so a modified one
has no valid key — which is why H-4 and this item are one piece of work, not
two. Where the vendor has attestable hardware, the measurement is bound to it
and the leaf is `verified`. Where they do not, it is `passthrough` and says so.
That is not a weakness in the design; it is the design reporting its own
strength accurately.

### Missing 2 — reconciliation

Nothing in the estate notices when a vendor **stops** witnessing.

Kohya is the proof: the pod hook silently no-ops if an env var is absent
(`kohya_safetensors_hook.py:23-24`), the route swallows write failures as
non-fatal, and the canvas path swallows ingest failures
(`lib/canvas/witness.ts:155`). A capture path that goes dark produces exactly
the same observable as a quiet afternoon.

Banking's answer is settlement: terminals run offline under floor limits, and
end-of-day reconciliation catches the one that diverged or went silent. We have
the first half — `queue.py` is a crash-durable JSONL queue with backoff — and
none of the second. What is needed at the witness server is per-component
sequence accounting: a monotonic counter per capture-component instance, gap
detection, and an expected-heartbeat window.

**This is the better answer to the P1 residue than revocation, and it is the
one banking actually uses.** You do not prove continuously that the component
is unmodified. You make its absence, and its divergence, *visible* — and you
make the vendor's own operators the first to see it.

## The shape, end to end

1. **Component.** We ship the capture component. The vendor deploys it; they do
   not author it. It sits where output bytes come into existence, positioned so
   a tenant workflow cannot produce a retrievable artifact that bypasses it
   (for ComfyUI: both the write path and `/view`, plus whatever WS carries
   next).
2. **Key.** Base key in the vendor's KMS; per-session derived key in the
   component. Never a global secret, never a key in a tenant-readable shell.
   This is H-4 done as DUKPT rather than as a patch to the current global HMAC.
3. **Hash local, sign central.** The component hashes the customer's bytes in
   the vendor's space — it must, there is nowhere else the bytes exist — and
   submits the leaf. The witness server signs it with the HSM-resident key
   (H-1). The vendor never holds signing authority over evidence.
4. **Scope.** Everything in the vendor's stack outside the component is out of
   scope, by the P2PE argument. This is what makes the ask small enough for a
   vendor to accept.
5. **Offline.** Queue on failure, drain on recovery — `queue.py`, wired into
   the failure path this time.
6. **Reconcile.** Sequence accounting per component instance; gaps and silence
   raise.
7. **Declare.** Attested compute → `verified`; otherwise `passthrough` (H-5).
8. **Certify the configuration**, EMV L3-style, re-run on material change.

## Correction to the record

`L2_FLOOR.md` still reads *"Status: Analysis and target. Nothing here is
implemented."* That is now stale: H-1, H-3 and H-5 are implemented (H-1 against
the CVM surrogate). **H-2 and H-4 remain unstarted**, and H-4 is the item this
whole structure rests on — the global `SCRUPLE_APPS_WITNESS_SECRET` in a
tenant-readable pod env var is still live as of today's grade.
