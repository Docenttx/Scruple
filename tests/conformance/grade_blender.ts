// WO-B6 — run the Blender grade, and prove the grader can move.
//
//   node --import tsx \
//     /data/scruple-blender/tests/conformance/grade_blender.ts [--json <path>]
//
// Run from scruple-web because @scruple/conformance imports `lib/capture/**`
// by relative path and is not published anywhere this addon could install it.
//
// THE MUTATION CONTROL IS HALF THE OUTPUT. A grade of an integration that
// cannot pass proves nothing on its own — the harness might be returning FAIL
// for everything. So after the real grade, one fact at a time is changed in a
// COPY of the derived evidence and the grade is re-run: each mutation must
// move the cell it is about. A mutation that changes nothing is reported as a
// failure of this file, not as a pass.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { deriveBlender, type ReadSource } from './derive_blender';
import { gradePath } from '../../../scruple-web/packages/scruple-conformance/src/grade';
import { renderGradeTable } from '../../../scruple-web/packages/scruple-conformance/src/render';

const ADDON = process.env.SCRUPLE_ADDON_ROOT ?? '/data/scruple-blender';
const WEB = process.env.SCRUPLE_WEB_ROOT ?? '/data/scruple-web';

/** Read a path from a repo, pinned to a commit when one is given. */
function pinnedReader(repo: string, ref: string | null): ReadSource {
  return (rel) => {
    if (!ref) {
      const p = path.join(repo, rel);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    }
    try {
      return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: repo, encoding: 'utf8' });
    } catch {
      return null;
    }
  };
}

function head(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

function dirty(repo: string): boolean {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim() !== '';
}

// A grade with no source ref is an opinion with line numbers. When the tree is
// dirty the working copy is read and the grade says so, rather than grading a
// commit that is not what ran.
const addonRef = dirty(ADDON) ? null : head(ADDON);
const webRef = dirty(WEB) ? null : head(WEB);

const input = deriveBlender(pinnedReader(ADDON, addonRef), pinnedReader(WEB, webRef), null);
const grade = gradePath(input);

const out = {
  graded_at: new Date().toISOString(),
  addon_commit: addonRef ?? `${head(ADDON)} (WORKING TREE — dirty)`,
  web_commit: webRef ?? `${head(WEB)} (WORKING TREE — dirty)`,
  profile: input.profile,
  grade,
  mutations: [] as Array<{ mutation: string; cell: string; before: string; after: string; moved: boolean }>,
};

console.log(renderGradeTable({ version: 'blender-0.1.0', paths: [grade] } as never));
console.log(`\ncompliant: ${grade.compliant}`);
console.log(`lifecycle: ${grade.lifecycle}`);
console.log(`class scope: inScope=${grade.classScope.inScope}`);
console.log(`liveness: ${grade.liveness.verdict} — ${grade.liveness.reason}`);
for (const [item, g] of Object.entries(grade.items)) {
  console.log(`  ${item}  ${g.disposition.padEnd(12)} ${g.reason}`);
}

// ── THE CONTROLS ─────────────────────────────────────────────────────────
//
// Each mutation changes ONE fact and names the cell it must move. These are
// hypotheticals applied to a copy — nothing here is written back to the
// derivation, and none of them is a claim about the addon.
type Mutation = { name: string; cell: string; apply: (i: typeof input) => typeof input };

const clone = (i: typeof input): typeof input => structuredClone(i);

// P1 and P3 ARE DECIDED BY PLACEMENT BEFORE ANY EVIDENCE IS READ, and the
// first cut of this file got that wrong. It mutated `attestation` to
// 'verified' and `keyCustody.reachableByMeasuredParty` to false, and neither
// moved a cell — because `enforcement: 'none'` degrades Blender's DECLARED
// `attested-client` to an EFFECTIVE `unattested-client`, and at that placement
// `assuranceFor` fails P1 and P3 outright and ignores attestation by design
// (surface.ts, REQUIRED_ENFORCEMENT: 'attested-client' requires
// 'host-enforced-signature').
//
// That is not a broken control, it is the answer to a question worth asking:
// no amount of attestation evidence and no key-custody improvement can move
// Blender's P1 or P3 while the zip is unsigned. The two inert mutations are
// kept below, named as inert and asserted to be inert, next to the two that
// fix the placement first and then do move. A file that had silently deleted
// the pair that did not fire would have deleted the finding.
const MUTATIONS: Mutation[] = [
  {
    name: 'the addon zip is host-signed, so the declared attested-client placement survives',
    cell: 'P1',
    apply: (i) => {
      const c = clone(i);
      (c.profile as { enforcement: string }).enforcement = 'host-enforced-signature';
      (c.profile as { attestation: string }).attestation = 'verified';
      return c;
    },
  },
  {
    name: 'placement fixed AND the key is out of the measured party\'s reach',
    cell: 'P3',
    apply: (i) => {
      const c = clone(i);
      (c.profile as { enforcement: string }).enforcement = 'host-enforced-signature';
      (c.profile as { attestation: string }).attestation = 'verified';
      c.evidence.keyCustody.value.reachableByMeasuredParty = false;
      return c;
    },
  },
  {
    name: 'the principal comes from a server-side session instead of the client',
    cell: 'P4',
    apply: (i) => {
      const c = clone(i);
      c.evidence.principalIdentity.value.suppliedByMeasuredParty = false;
      return c;
    },
  },
  {
    name: 'the capture carries payload bytes',
    cell: 'P6',
    apply: (i) => {
      const c = clone(i);
      c.evidence.zeroContent.value.carriesPayloadBytes = true;
      return c;
    },
  },
  {
    name: 'no leaf is created at all',
    cell: 'P5',
    apply: (i) => {
      const c = clone(i);
      c.evidence.eventChain.value.leavesCreated = false;
      return c;
    },
  },
];

/** Mutations that MUST NOT move a cell. The reason is the finding. */
const INERT: Mutation[] = [
  {
    name: 'attestation becomes verified while the zip stays unsigned',
    cell: 'P1',
    apply: (i) => {
      const c = clone(i);
      (c.profile as { attestation: string }).attestation = 'verified';
      return c;
    },
  },
  {
    name: 'the key moves out of reach while the zip stays unsigned',
    cell: 'P3',
    apply: (i) => {
      const c = clone(i);
      c.evidence.keyCustody.value.reachableByMeasuredParty = false;
      return c;
    },
  },
];

console.log('\nmutation controls — each must move the cell it names');
let allMoved = true;
for (const m of MUTATIONS) {
  const before = grade.items[m.cell as keyof typeof grade.items].disposition;
  const after = gradePath(m.apply(input)).items[m.cell as keyof typeof grade.items].disposition;
  const moved = before !== after;
  if (!moved) allMoved = false;
  out.mutations.push({ mutation: m.name, cell: m.cell, before, after, moved });
  console.log(`  ${moved ? 'MOVED    ' : 'NO CHANGE'} ${m.cell}  ${before} -> ${after}   (${m.name})`);
}

console.log('\ninert controls — each must NOT move, because placement decides it first');
for (const m of INERT) {
  const before = grade.items[m.cell as keyof typeof grade.items].disposition;
  const after = gradePath(m.apply(input)).items[m.cell as keyof typeof grade.items].disposition;
  const stayed = before === after;
  if (!stayed) allMoved = false;
  out.mutations.push({ mutation: `INERT: ${m.name}`, cell: m.cell, before, after, moved: stayed });
  console.log(`  ${stayed ? 'INERT    ' : 'MOVED — UNEXPECTED'} ${m.cell}  ${before} -> ${after}   (${m.name})`);
}

// ── the honesty assertion ────────────────────────────────────────────────
//
// A compliant Blender grade would mean the harness is broken, not that the
// addon is finished: the registered profile is attested-client / none / none.
const honest = grade.compliant === false;
console.log(`\nnot-compliant, as the registered profile requires: ${honest}`);
out.mutations.push({
  mutation: 'the grade itself must not come out compliant',
  cell: 'compliant',
  before: String(grade.compliant),
  after: 'false (expected)',
  moved: honest,
});

const jsonAt = process.argv.indexOf('--json');
if (jsonAt !== -1 && process.argv[jsonAt + 1]) {
  fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 2));
  console.log(`\nwrote ${process.argv[jsonAt + 1]}`);
}

if (!allMoved || !honest) {
  console.error('\nFAILED: a control did not fire. See the NO CHANGE rows above.');
  process.exit(1);
}
