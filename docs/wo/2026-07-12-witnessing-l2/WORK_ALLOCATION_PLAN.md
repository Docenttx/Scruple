# Sprint 1 Work Allocation Plan

**Companion to:** `INDEX.md` (WO manifest + dependencies) and
`CANONICAL_SCRUPLE_WITNESSING_L2.md` (the design)
**Purpose:** dispatch Sprint 1 across parallel tracks so wall-clock beats
the serial estimate. Structured so each track can be handed to a separate
implementer (human or Claude Code sub-agent) with a self-contained briefing.

## Wall-clock target

- Serial estimate (single track): ~78 owner-hours.
- Parallel estimate (4 tracks): ~28–32 wall-clock hours.
- Rate-limiting item: **Track B critical path** — schema → ingest →
  checkpoints → C2PA emit. Every other track fits inside its shadow.

## Track layout

```
Day 1                Day 2                Day 3                Day 4-5
─────                ─────                ─────                ──────
Track A ▶ WO-01 ─────┐              (WO-02 wait on issuer, weeks)
                     │
Track B ▶ WO-05 ─────┼─▶ WO-06 ─────┬─▶ WO-07 ─────┬─▶ WO-08
                     │              │              │
Track C ▶            └─▶ WO-03 ─────┤              │
                                    └─▶ WO-04 ─────┘
Track D ▶       WO-09 (starts mid-Day-1, ships Day 3) ─────────┐
                                                                │
Gate ▶                                                          └─▶ WO-10
```

Dependency-precise:

- **A** starts Day 1, is done by end-of-Day-1 (WO-01) or has submitted the
  cert application (WO-02) and hands off ownership of the wait to a shared
  ticket.
- **B** starts Day 1 with WO-05. Once WO-05's schema + parity is landed
  (target: end of Day 1), Track C can start using the `SCRUPLE_C2PA_VAULT_
  KEY_OCID` from Track A, and Track D can copy `canonicalLeafV23.ts` into
  the verifier CLI.
- **C** starts as soon as WO-01 outputs are handed to the implementer
  (Vault OCID + endpoint URL). No blocking on Track B until WO-08.
- **D** starts as soon as WO-05 canonical modules are stable — typically
  mid-Day-1.
- WO-10 (the gate) runs when A, B, C, D are all green.

## Per-track briefing packets

Each track's implementer needs a specific reading list. Do NOT hand them
the full canonical doc unless the WOs cite specific sections — that
context bloats the working memory. Cite sections.

### Track A — Infrastructure (WO-01 + WO-02)

**Read first:**
- `docs/wo/2026-07-12-witnessing-l2/WO-01-oci-vault-provisioning.md`
- `docs/wo/2026-07-12-witnessing-l2/WO-02-c2pa-cert-application.md`
- Canonical design **§4 only** (Key Custody)
- Existing OCI infrastructure in this repo: `grep -r "OCI_" .env.example`
  (probably nothing today; you're the first to add it)

**Prerequisites (human-owned):**
- OCI account admin credentials for the production tenancy.
- Ability to procure a Docent Technologies signing cert from DigiCert
  Content Credentials (or SSL.com). Requires the authorized signatory
  letter.

**Deliverables:**
- Vault key OCIDs (both keys) captured in a secure secrets doc.
- IAM policy + Dynamic Group + audit archive bucket, per WO-01 acceptance.
- CSR submitted to issuer, ticket ID recorded.
- `docs/architecture/lifecycle/key-generation.md` stub committed.
- `infra/oci/` new files: policy JSON, CSR script, cert placeholder.

**Handoffs:**
- To Track C: `SCRUPLE_C2PA_VAULT_KEY_OCID` +
  `SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT` values.
- To Track B (WO-07): `SCRUPLE_WITNESS_CHECKPOINT_KEY_OCID` +
  `SCRUPLE_WITNESS_CHECKPOINT_CRYPTO_ENDPOINT` values.

**No touch on:** application source tree, migrations, existing routes.

**Estimated wall-clock:** 6h for WO-01 (Day 1). WO-02 submit is ~4h once
identity docs are ready; then a multi-week wait handled by shared ticket
tracker, not this sprint.

---

### Track B — Audit backend (WO-05 → WO-06 → WO-07 → WO-08)

**Read first:**
- `docs/wo/2026-07-12-witnessing-l2/WO-05-audit-api-schema.md`
- `docs/wo/2026-07-12-witnessing-l2/WO-06-audit-api-ingest.md`
- `docs/wo/2026-07-12-witnessing-l2/WO-07-checkpoint-service.md`
- `docs/wo/2026-07-12-witnessing-l2/WO-08-c2pa-emit-leaf.md`
- Canonical design **§3, §6, §9, §14**
- `docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md` **§4.0, §5.1,
  §6** (leaf schema + checkpoint mechanics)
- Existing DB conn pattern: `lib/db/sqlite.ts`
- Existing witness signing pattern: `lib/witness/*` (if any), search
  `grep -r "witness_sig" lib/`
- Existing migration numbering: `ls migrations/` — pick 022 for WO-05, 023
  for WO-08 (or next available)

**Prerequisites (from Track A):**
- Vault checkpoint key OCID + crypto endpoint (needed by WO-07 only —
  can be dev-mocked until Track A completes).

**Deliverables (in order):**
1. **WO-05 (~10h, Day 1):** migration 022 + `lib/witness/canonicalLeafV23.ts`
   + Python parallel + parity tests. **This must land first** — all other
   tracks reference the canonical leaf spec.
2. **WO-06 (~10h, Day 2):** `/v1/log/*` + `/v1/streams` routes + HMAC
   middleware + rate limits.
3. **WO-07 (~12h, Day 2–3):** checkpoint scheduler + Merkle + Ed25519
   signing (via mock or real Vault) + trust manifest route.
4. **WO-08 (~6h, Day 4):** wire C2PA daemon → leaf ingest. **Blocks on
   Track C's WO-04 completing.**

**Handoffs:**
- To Track D: canonical leaf module signature (fixed after WO-05) so
  Track D can copy it verbatim.
- To Track C's WO-08 stage: `/v1/log/scruple.c2pa.sign` endpoint URL +
  the `TEN_scruple` internal API key + HMAC secret.

**Touches on existing files:**
- Adds new tables via migration (no schema conflicts expected).
- New route tree under `app/api/v1/` — no collisions.
- WO-08 modifies `app/api/scruple/c2pa/sign/route.ts` (adds
  `principal_id` + `witness` response field).

**Estimated wall-clock:** 3–4 days for the four WOs sequentially within
this track.

---

### Track C — Signer refactor (WO-03 + WO-04)

**Read first:**
- `docs/wo/2026-07-12-witnessing-l2/WO-03-signer-refactor.md`
- `docs/wo/2026-07-12-witnessing-l2/WO-04-signer-isolation.md`
- Canonical design **§4, §5** (Key Custody + C2PA Signing Path)
- Existing signer source: `services/c2pa-signer/sign.py`, `lib/c2pa/signAsset.ts`,
  `app/api/scruple/c2pa/sign/route.ts` — read them end-to-end before
  touching.
- Current interop evidence: `docs/c2pa-interop/2026-07-12-interop-test-report.md`
  — the refactor MUST preserve the interop that already works.

**Prerequisites (from Track A):**
- Vault OCID + crypto endpoint for the C2PA signer key. Track C can
  scaffold with placeholders and wire up once Track A delivers.

**Deliverables:**
1. **WO-03 (~8h, Day 2):** refactor `sign.py` to `Signer.from_callback`.
   New `services/c2pa-signer/vault_sign.py`. Delete `keys/es256.pem`.
   Update `.gitignore` + pre-commit hook. Update `.env.example`.
2. **WO-04 (~6h, Day 3):** systemd unit + dedicated OS user + Unix socket
   transport. Update `lib/c2pa/signAsset.ts` to talk to the socket.
   Rate limits on the API route.

**Handoffs:**
- To Track B WO-08: signer daemon accepts extended job spec with
  `principal_id`, emits leaves via the ingest endpoint.

**Touches on existing files:**
- `services/c2pa-signer/sign.py` — heavily modified (~15 lines).
- `services/c2pa-signer/keys/es256.pem` — deleted (public sample key).
- `services/c2pa-signer/keys/.gitignore` — modified (broader patterns).
- `lib/c2pa/signAsset.ts` — significant refactor (~40 lines of ~200).
- `.env.example` — env vars added.
- `README.md` — pre-commit hook setup note.

**Interop preservation gate:** after WO-03, re-run the interop test from
`docs/c2pa-interop/` against the refactored path with the sample dev
cert. If any verifier's `validation_status` regresses vs. today's report,
the refactor is not done.

**Estimated wall-clock:** 2 days.

---

### Track D — Verifier CLI (WO-09)

**Read first:**
- `docs/wo/2026-07-12-witnessing-l2/WO-09-verify-cli-v1.md`
- Canonical design **§7, §14** (Reference Verifier CLI + critical-path
  discipline)
- `packages/` (probably empty today; Track D creates it)
- Existing c2pa-node use: `docs/c2pa-interop/reproduce-verify.mjs` —
  this is the reference for how c2pa-node is called

**Prerequisites (from Track B):**
- Stable `canonicalLeafV23.ts` from WO-05 (Day 1 end) — copy verbatim
  into `packages/scruple-verify/src/core/`.
- Stable `canonicalCheckpointV1.ts` from WO-07 (Day 2 mid) — copy
  verbatim.

**Deliverables:**
1. **WO-09 (~12h, spans Day 1 late → Day 3):** full CLI with `leaf`, `c2pa`,
   `trust-manifest` subcommands, `--offline` mode, fixture library,
   published as `@scruple/verify@0.1.0-rc.1` to npm (RC tag until Sprint 1
   sign-off).

**Handoffs:**
- To Sprint 1 gate (WO-10): CLI must be `npm i -g @scruple/verify`-installable
  and pass the Sprint 1 demo script.

**Touches on existing files:** none. Entirely new package tree.

**Estimated wall-clock:** 2 days from mid-Day-1 to Day 3.

---

### Gate — Sprint 1 sign-off (WO-10)

**Owner:** you + me (coordinator role, not an implementer).

**Runs when:** A/B/C/D acceptance criteria all green.

**Deliverables:**
- Demo script executes end-to-end sign → witness → verify in <2 min.
- Recorded asciinema + screenshots for sales use.
- Sprint 1 sign-off note appended to `INDEX.md` with commit SHA and date.

## Coordination rules

Six rules that keep the tracks from stepping on each other.

1. **WO-05 is the pacing item.** No track finalizes design decisions
   that depend on the leaf spec until WO-05 lands. If Track B hits an
   issue with the schema, ALL tracks pause because the fix propagates
   to Track C (signer daemon leaf preimage) and Track D (verifier
   re-derivation).

2. **Canonical modules are copied, not depended-on.** Track D copies the
   TypeScript canonical modules from `lib/witness/` verbatim into
   `packages/scruple-verify/src/core/`. Any change post-copy triggers
   a re-copy + fixture regeneration + CI parity check. See WO-09.

3. **No cross-track commits without coordination.** Each track commits
   to its own set of files. If Track C's WO-04 needs to modify
   `lib/c2pa/signAsset.ts` at the same time Track B's WO-08 needs to
   modify the C2PA API route, they coordinate through this doc's Section
   below or a shared standup.

4. **Vault OCIDs never appear in git.** Placeholders like
   `<c2pa-key-ocid>` in committed docs; real OCIDs go in
   `/etc/scruple/c2pa-signer.env` (mode 0640) on the deploy host and a
   secrets doc. Enforce via pre-commit hook grep for `ocid1.key.oc1`.

5. **Zero-content posture is a CI gate, not a code-review nice-to-have.**
   Any code path in Track B or Track C that permits `payload_bytes` on
   a non-preservation stream fails CI. Track B owns writing that CI check
   as part of WO-06.

6. **Interop must not regress.** Track C's WO-03 pass includes re-running
   the 2026-07-12 interop test. If any verifier regresses, that WO isn't
   done. Track C owns this gate.

## Sync cadence

- **Daily 15-min standup** across track leads while Sprint 1 is active.
  Attendance: whoever owns each active WO.
- **End-of-day snapshot** to `INDEX.md` — mark each WO as
  `in progress` / `done` / `blocked`. This is the compaction-survival
  status board.
- **Blocker escalation** to canonical design owner (you) within the
  same day; do not sit on a blocker overnight.

## Handoff artifacts

At the end of Sprint 1, each track produces one summary paragraph in
`INDEX.md` under a new **"Sprint 1 outcomes"** section listing:

- Files touched (new / modified / deleted).
- Acceptance criteria status.
- Any deferred sub-items with a rationale + follow-up ticket.
- Interop or evidence artifacts produced.

That paragraph is what a Sprint 2 kickoff reads to know what state the
system is in.

## Sub-agent dispatch (if using Claude Code agents)

Optional. If you choose to fan out via sub-agents rather than human
implementers:

- **Agent-A** (Infrastructure): general-purpose. Briefing packet =
  Track A section above + the WO-01 + WO-02 files. Give it
  Bash + Read + Edit access. Requires interactive OCI login → user must
  provide OCI credentials or run OCI CLI commands on the user's behalf.
- **Agent-B** (Audit backend): general-purpose. Briefing packet = Track B
  section + WO-05/06/07/08 files + `canvas-v2.md` for the existing
  witness scaffold reference. All tools.
- **Agent-C** (Signer refactor): general-purpose. Briefing packet =
  Track C section + WO-03/04 files + the existing signer sources listed.
  All tools + the interop-preservation gate.
- **Agent-D** (Verifier CLI): general-purpose. Briefing packet =
  Track D section + WO-09 + `docs/c2pa-interop/reproduce-verify.mjs`
  reference. Isolated in a worktree since it creates a new
  `packages/scruple-verify/` tree — recommend `isolation: 'worktree'`.

The coordinator (you + me) handles WO-10 gate and the six coordination
rules. Do NOT dispatch WO-10 to a sub-agent — the gate is where human
judgment lives.

## Failure modes to watch

- **Agent-B stalls on WO-05.** Fatal if not caught quickly — all other
  tracks eventually block on the canonical leaf spec. Escalate at
  ~4 hours if WO-05 not converging.
- **OCI Vault provisioning slower than expected** (WO-01). Track C can
  scaffold against placeholders but cannot ship without real OCIDs.
  Have Track A start FIRST regardless of other track order.
- **Cert issuer turnaround >2 weeks** (WO-02). Non-blocking for Sprint 1
  demoable but blocking for L2 evidence package (WO-18). Escalate to
  procurement early.
- **`Signer.from_callback` FFI regression.** The c2pa-python callback
  path had bugs during the 2026-07-12 interop pass; test early on
  Track C and be ready to fall back to the callback-with-cryptography
  pattern we already validated.

## Where this doc fits

- `INDEX.md` — WHAT to build, in what order.
- `WORK_ALLOCATION_PLAN.md` (this doc) — WHO builds what, in parallel.
- `CANONICAL_SCRUPLE_WITNESSING_L2.md` — WHY the design decisions are
  what they are.
- Individual `WO-*.md` files — HOW each unit of work is executed.

Read all four before dispatch; the four together are the compaction-proof
briefing packet.
