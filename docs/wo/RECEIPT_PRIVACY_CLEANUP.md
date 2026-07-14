# WO — Receipt page privacy cleanup (flag for daylight review)

**Discovered:** 2026-07-14 evening, during watermark design v1.2 review.
**Priority:** medium (design intent mismatch, not a security incident).
**Blocking:** any product decisions that assume the current public receipt behavior.

## The finding

`app/receipt/[scrId]/page.tsx` currently serves as a public, unauthenticated
HTML page. The file header states:

```typescript
// Public, unauthenticated provenance receipt at /receipt/SCR_XXXXXX.
// Renders project metadata + Merkle proof + witness signatures so any
// visitor can verify a project's claim.
export const dynamic = 'force-dynamic';
```

Anyone who knows `SCR_XXXXXX` can visit `scruple.ai/receipt/SCR_XXXXXX`
and see whatever the artist's `publication_mode` (`full` / `hash-only` /
`witness-only`) allows to be rendered.

**This behavior contradicts the stated Scruple design intent** (confirmed
2026-07-14 by user): receipts are user-controlled. The only things
Scruple affirmatively publishes are the RVN asset ID (via chain-lock)
and the Arweave TX ID (via pinned tier). Everything else on the receipt
page — workflow, model, machine manifest, prompt, witness signature,
cert chain, etc. — is supposed to stay under the artist's control unless
they explicitly opt to publish (e.g. via IPFS pinning).

## Discrepancy summary

| Aspect | Current code | Stated intent |
|---|---|---|
| Receipt HTML page | Public URL, no auth | Private by default, user-controlled |
| SCR_ID discoverability | Via anyone who knows it | Via anyone who knows it (same) |
| RVN asset ID | Public (on-chain) | Public (on-chain) — matches |
| Arweave TX ID | Public (on-chain, if pinned) | Public (on-chain, if pinned) — matches |
| Full receipt content | Rendered publicly per publication_mode | Only rendered privately to owner unless artist pushed to IPFS |
| Publication modes | Controls WHAT shows on the public page | Should probably control WHETHER the page is served publicly at all |

The `publication_mode` field appears to be a partial mitigation — it
lets the artist restrict what a visitor sees. But the page itself is
still publicly reachable. The stated intent is a stricter model: the
page shouldn't be reachable by third parties unless the artist opted
into public disclosure via a positive action (IPFS pin).

## Options for daylight review

**Option 1 — enforce owner-only auth on the receipt page:**
Wrap `/receipt/[scrId]/page.tsx` in a session check. Only the owning
user can view. Third parties who need to verify get the receipt data
from the owner directly (as an exported JSON/PDF/whatever).

**Option 2 — auth gate + explicit "public link" opt-in:**
Add a `publish_publicly` boolean on the project. Default false. Auth
required unless the artist has flipped the flag. Provides current
behavior for artists who want a shareable link; matches intent for
everyone else.

**Option 3 — cross-check with IPFS pinning state:**
Serve the receipt page publicly if and only if the artist has pinned
the provenance package to IPFS (the affirmative public-disclosure
action). Otherwise, auth-only. Ties HTML publication to the same
disclosure decision the artist already makes for the package.

Option 3 is the cleanest fit for the stated intent — the artist's
disclosure decision is a single choice ("pin to IPFS"), and it drives
both what's on public infra and what's reachable via the HTML page.

## Adjacent surfaces to check

While reviewing:

- `/api/projects/[id]/lora-sidecar.c2pa` — currently gated on
  `LOCKED_STATUSES` (local_locked / chain_locked / persistent_locked /
  permanent_locked). Consistency check: same gate applies?
- `/api/artifact/[hash]` — serves output bytes by content hash. Who can
  fetch? Should this be auth-gated too?
- Any social preview / OpenGraph endpoints — do they leak receipt content
  to link previewers before the auth check runs?
- The `stoogel receipt <SCR_ID>` CLI (if it exists) — same question.

## Implications for other in-flight work

- **Watermark design v1.2** — already accounts for this by removing the
  Scruple-hosted watermark registry (tier 1-3 self-contained, tier 4-5
  use public RVN). No re-work needed on the watermark side.
- **EU AI Office evidence bundle** — the bundle references
  `witness.scruple.ai/v1/watermark-lookup` in its coverage matrix as a
  future capability. Now removed. Update the coverage matrix and the
  interoperability roadmap to reflect the simplified architecture.
- **Public verification URL (Q1 2027 roadmap)** — `scruple.ai/verify`
  should be scoped correctly: it verifies a file that a user gives it,
  not a receipt looked up by SCR_ID. The receipt part stays private.
- **C2PA Conformance bundle** — no impact; C2PA has no public receipt
  concept.

## Recommended next steps

1. Confirm the design intent with a decision on Option 1/2/3.
2. Write the code change (a session check on the receipt route + a
   `publish_publicly` toggle if going with Option 2, or a check against
   IPFS pin state if going with Option 3).
3. Add a smoke test that anonymous fetches return 401/302, authenticated
   owner fetches return 200.
4. Sweep the adjacent surfaces (§4 above) for consistency.
5. Update the receipt-page code comments to reflect the new posture.

## Non-goals

- Not deleting historical receipts already served publicly (whoever
  cached them, cached them; can't unring the bell).
- Not restricting the on-chain data — RVN and Arweave are inherently
  public by design; the pin/lock decision is where privacy is chosen.

## Owner

Assign in daylight; this doc exists so the discovery survives context
compaction.
