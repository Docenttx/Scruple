# Prompt: Write trustworthy canonical documentation for a codebase

> Reusable prompt for handing a fresh Claude Code (or any agent) the task
> of producing canonical orientation docs for an unfamiliar codebase. The
> prompt is deliberately domain-agnostic — it describes intent, method,
> and outcome, not the specifics of any application.

You're being asked to produce documentation that another engineer (or another Claude Code session with no prior context) can rely on without re-deriving from git history. The output must be **load-bearing, not aspirational** — every claim either matches the code byte-for-byte, or is explicitly marked unverified.

## Deliverable shape

Two complementary documents in the project's `docs/` folder:

1. **`CANONICAL_GUIDE.md` — by-component reference.** What the system is, how it's organized, where each piece lives, how to do common operations. Roughly: TL;DR → system map → repo layout → per-component descriptions → auth/identity model → state machine of the core workflow → external integrations → common operations with working commands → known gotchas → files-never-to-touch → open follow-ups → quick-reference card.

2. **`END_TO_END_FLOW.md` — linear narrative trace.** Follow one full user journey through every system in the order it actually happens. Show every transformation, every external call, every piece of state that gets persisted. Structure as phases (static setup → auth → preparation → the core operation in step-by-step detail → finalization → public surface → third-party verification flow if applicable). Include: ASCII swim-lane sequence diagram, a cross-reference table mapping every distinct piece of state to where it's computed and where it's stored on each side, and one concrete real example with actual values pulled live from the running system.

The two are complementary, not overlapping. The first answers "where is X?"; the second answers "what happens when?".

## Method

**Phase A — Draft from current working knowledge.** Get the structure and narrative down. Don't worry about perfect accuracy yet; capture intent and flow.

**Phase B — Systematic verification in layers.** Don't trust your memory. Layer the verification so coverage is exhaustive. Natural layers usually include:

1. **Paths/files** — does every file path you cited actually exist?
2. **Data shapes** — every DB column, every type definition you named: real?
3. **API surface** — every endpoint you listed: present, with the same method/path?
4. **Code primitives** — function signatures, algorithm implementations, canonical formulas: byte-identical?
5. **Operations** — every command in "how to do X" actually runs and produces the claimed result?
6. **Narratives** — does the step-by-step "what happens" match the actual control flow line by line?
7. **Cross-references** — every concrete example, every mapped value, real?

Run each layer's checks programmatically where possible (grep, schema dumps, file existence, function-signature lookups, actually executing the commands). Don't infer; observe. Batch independent checks in parallel.

**Phase C — Categorize every finding.** For each claim that didn't survive verification, label it:
- **Wrong** — claim contradicts reality. Fix immediately.
- **Incomplete** — claim is true but omits structure (e.g., listed 3 of 5 tables). Decide whether to expand or scope explicitly.
- **Out-of-date** — was true when written, now stale. Update or stamp with the version it applied to.
- **Unverifiable** — depends on ephemeral state (logs that expire, environment that varies, time-bound assertions). Mark as a known limitation and explain when it's expected to drift.

**Phase D — Honest framing.** Never claim what you didn't verify. If a regression-style check (e.g., "all tests pass") has caveats — ephemeral state, environment-specific assumptions, time-bound assertions — say so up front. The reader's trust budget is small; over-claiming once invalidates the whole document.

**Phase E — Commit with accountability.** Each commit message lists what was wrong, what was incomplete, what was right, what you fixed, and what limitations remain. The git history of the docs should let the next session diff "what we thought" against "what we found." Re-run any test suite the docs reference after your edits to confirm nothing broke.

## Outcome

When you're done:

- Every concrete claim in both docs either matches the code as observed during this session, or is explicitly marked as unverified with a reason.
- A fresh agent can read these two docs in ~15 minutes and be productive on the codebase without re-deriving state from git history.
- The verification protocol is reproducible: someone can re-run the same layered checks in a future session and identify exactly what's drifted since.
- Known limitations — ephemeral state, environment-specific behavior, deferred work, unverified-by-design surfaces — are listed in one place, not scattered.
- A durable pointer (memory file, README link, or equivalent) directs the next agent at both docs as the primary orientation surface, so they're found first.

## Mindset

- **Treat your own memory as untrusted.** The code is the source of truth. Recall is a draft; verification is the publish step.
- **Prefer "I haven't verified X"** over a confident claim about X. Honesty is load-bearing here — the docs only have value if every claim can be trusted, and one confident wrong claim invalidates the rest.
- **When asked "did you verify this against the code?" — actually verify.** Don't hand-wave the answer. If you didn't, say so and do it now.
- **Drift is normal.** The discipline isn't avoiding drift; it's surfacing it the moment someone asks. Catch it in your own pass before someone else has to.
- **Distinguish "documentation drift" from "system bug."** If a verification check fails for a reason that's NOT a code regression (stale environment, expired logs, time-bound state), separate the diagnoses clearly: "the system is fine; the bookkeeping isn't." Don't fix code in a doc commit; report it.
- **Write for the agent who reads this with no context.** If they'd have to re-derive something from git log, that something belongs in the doc.
