#!/usr/bin/env node
// CI baseline drift check.
//
// Reads scruple-baseline.yaml (if present) at the repo root, expands
// its code/dependencies globs to a file set, and compares against the
// changed files in this PR (via `git diff --name-only <base>..HEAD`).
// Fails if any changed file is in the baselined tamper-surface AND the
// PR doesn't declare a baseline decision via one of these tags in the
// PR title or body (or a commit message):
//
//   [baseline-decision: rebaseline]     — will rebaseline post-merge
//   [baseline-decision: expand-manifest] — will update the manifest to
//                                          exclude this file (with reason)
//   [baseline-decision: false-positive] — glob matched a file that
//                                          doesn't actually participate
//                                          in the tamper-surface
//
// Usage:
//   node scripts/ci-baseline-drift-check.mjs [--base <ref>] [--decision <tag>]
//
// Env:
//   GITHUB_BASE_REF          — auto-detected base ref (GitHub Actions)
//   PR_TITLE, PR_BODY        — PR title/body if not being run locally
//
// Exit codes:
//   0 — no drift OR drift + explicit decision tag
//   1 — drift + no decision tag (BLOCK MERGE)
//   2 — script error (bad manifest, git failures)

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import path from 'node:path';

const MANIFEST_PATH = 'scruple-baseline.yaml';
const DECISION_RE = /\[baseline-decision:\s*(rebaseline|expand-manifest|false-positive)\]/i;

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

if (!existsSync(MANIFEST_PATH)) {
  console.log(`no ${MANIFEST_PATH} found in repo root — skipping baseline drift check`);
  process.exit(0);
}

// Minimal YAML parser sufficient for the manifest subset we care about
const raw = readFileSync(MANIFEST_PATH, 'utf-8');

function extractListSection(text, key) {
  const re = new RegExp(`^${key}:\\s*\\n((?:  - .+\\n?|  path: .+\\n?)+)`, 'm');
  const m = text.match(re);
  if (!m) return [];
  const results = [];
  for (const line of m[1].split('\n')) {
    const litMatch = line.match(/^\s*-\s+(.+)\s*$/);
    if (litMatch) {
      const val = litMatch[1].trim();
      if (val.startsWith('path:')) results.push(val.slice('path:'.length).trim());
      else results.push(val);
      continue;
    }
    const pathMatch = line.match(/^\s*path:\s*(.+)\s*$/);
    if (pathMatch) results.push(pathMatch[1].trim());
  }
  return results;
}

const codePatterns = extractListSection(raw, 'code');
const depPatterns = extractListSection(raw, 'dependencies');
const allPatterns = [...codePatterns, ...depPatterns];

if (allPatterns.length === 0) {
  console.log('manifest declares no code or dependencies globs — nothing to guard');
  process.exit(0);
}

// Expand globs to concrete files
const baselinedFiles = new Set();
for (const pat of allPatterns) {
  try {
    for (const f of globSync(pat, { cwd: process.cwd() })) {
      baselinedFiles.add(path.normalize(f));
    }
  } catch (e) {
    fail(`glob '${pat}' failed: ${e.message}`, 2);
  }
}

// Determine changed files via git diff
const base = argVal('--base', process.env.GITHUB_BASE_REF || 'main');
let changed;
try {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf-8' });
  changed = out.split('\n').filter(Boolean).map((f) => path.normalize(f));
} catch (e) {
  fail(`git diff failed (base=${base}): ${e.message}`, 2);
}

const drifted = changed.filter((f) => baselinedFiles.has(f));

if (drifted.length === 0) {
  console.log('no baseline drift — 0 tamper-surface files changed in this PR');
  process.exit(0);
}

console.log('BASELINE DRIFT DETECTED — the following files are in the tamper-surface:');
for (const f of drifted) console.log('  •', f);

const decisionTag =
  argVal('--decision') ||
  (process.env.PR_TITLE || '').match(DECISION_RE)?.[1] ||
  (process.env.PR_BODY || '').match(DECISION_RE)?.[1] ||
  (() => {
    try {
      const log = execFileSync('git', ['log', `${base}..HEAD`, '--format=%B'], { encoding: 'utf-8' });
      return log.match(DECISION_RE)?.[1];
    } catch { return undefined; }
  })();

if (decisionTag) {
  console.log(`\nBaseline decision declared: [baseline-decision: ${decisionTag}]`);
  console.log('CI check PASS — merge is allowed. Ensure the declared action follows post-merge.');
  process.exit(0);
}

console.error('\nCI check FAIL — no baseline-decision tag found in PR title/body/commits.');
console.error('One of the following tags MUST appear in the PR title, body, or a commit message:');
console.error('  [baseline-decision: rebaseline]');
console.error('  [baseline-decision: expand-manifest]');
console.error('  [baseline-decision: false-positive]');
console.error('See docs/wo/2026-07-13-baseline-attestation/WO-16-ci-drift.md.');
process.exit(1);
