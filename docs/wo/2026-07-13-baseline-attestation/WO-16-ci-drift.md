# WO-16 — CI drift check

**Phase:** 6 (Lifecycle + Transparency)
**Depends on:** WO-14
**Blocks:** none (final WO)
**Owner:** developer tooling
**Effort:** ~1 day

## Purpose

Prevent silent baseline invalidation by catching P1/P2 file changes in
CI. If a PR touches a file in the integration's `scruple-baseline.yaml`
`code` or `dependencies` section, CI requires an explicit re-baseline
decision from the PR author before merge.

## Deliverables

### 1. CI check script

`scripts/ci-baseline-drift-check.mjs`:

- Read `scruple-baseline.yaml`.
- Expand `code[]` and `dependencies[]` globs to a file list.
- Compare against `git diff --name-only <base-ref>...HEAD`.
- If any changed file is in the baselined file list:
  - Look for a `[baseline-decision]` tag in the PR title or body OR a
    commit message on the branch.
  - The tag MUST be one of:
    - `[baseline-decision: rebaseline]` — I intend to rebaseline this
      integration after merge
    - `[baseline-decision: expand-manifest]` — this file should NOT
      have been in the baselined set; the manifest is being updated
      to exclude it
    - `[baseline-decision: false-positive]` — this file is included by
      the glob but doesn't actually participate in witnessing (docs,
      comments, tests) — with justification in the PR body
  - If none of the tags is found, fail the CI check with an actionable
    error explaining the tag requirement.

### 2. GitHub Actions integration

`.github/workflows/baseline-drift-check.yml`:

- Runs on pull_request events for the main branch.
- Executes `node scripts/ci-baseline-drift-check.mjs`.
- Posts a comment on the PR summarizing the drift decision + which
  files triggered it.

For non-GitHub environments (GitLab, Bitbucket, self-hosted), document
how to wire the same script.

### 3. Documentation

Extend the retrofit checklist in `SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md`
(v1.3 minor bump) to reference this CI check as a "recommended
developer practice" (not a compliance requirement — the requirement is
that re-baselines actually happen, which is P7/P8; this is developer
ergonomics for keeping them from being forgotten).

Also add to `docs/api/witness-integration.md` (customer guide).

## Acceptance criteria

- [ ] Drift check runs successfully on a PR that changes a non-baselined
  file: passes without decision tag required.
- [ ] Drift check on a PR that changes a baselined file WITHOUT a tag:
  fails with clear error message pointing at the file + tag requirement.
- [ ] Drift check on a PR with `[baseline-decision: rebaseline]` in title
  or body: passes.
- [ ] GitHub Actions workflow lands and runs in the scruple-web repo's
  own CI (dogfooding — we should be the first customer of our own drift
  check on `scruple-baseline.yaml`).

## Notes

- This WO also implies that scruple-web itself gets a
  `scruple-baseline.yaml` in the repo root (per the WO-05 worked
  example). Landing this WO effectively dogfoods the whole baseline
  system on our own codebase.
- The three tag options cover the realistic scenarios; don't over-add.
  Any weird case can escalate to a manual reviewer override.

## Landing

One commit: `feat(baseline): CI drift check + GitHub Action + docs`.

## WO set completion

Once WO-16 lands and its check runs green in scruple-web's own CI, the
full baseline + attestation WO set is complete. Update memory:

- Update [[project_scruple_ai_infrastructure_2026_07_13]] to note
  baseline + attestation shipped
- Add a new project memory summarizing what shipped end-to-end
- Bump Standard + Requirements to v1.3 if any doc drift emerged during
  the build

Following work streams that can then start:
- Prepare/commit for gating events (Standard §12-14 reserved slots)
- Rust rewrite of the shared verifier library (if perf-motivated)
- Postgres migration for the baseline tables (post-first-enterprise)
- Receipt UI updates to render baseline + attestation chains
