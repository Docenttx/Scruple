// Grade → Markdown, in STUDIO_P1-P8_GRADE.md's shape.
//
// The shape is not cosmetic. That document's argument is that the grade is a
// vendor-produced artefact and that an unflattering one is normal; a vendor
// only believes that if the file they are asked to produce looks exactly like
// the one Scruple published about itself, down to the summary table. So the
// table renders with the same column order, the same cell vocabulary
// (`**PASS** (conditional)`, `**FAIL**`, `n/a`) and the same bottom-line
// sentence.

import type { Disposition, Grade, ItemGrade, PathGrade } from './grade';
import { P_ITEMS } from './types';

const ITEM_TITLES: Record<string, string> = {
  P1: 'runtime boundary integrity',
  P2: 'baseline coverage',
  P3: 'API key custody',
  P4: 'principal identity',
  P5: 'immutable event chain',
  P6: 'zero-content posture',
  P7: 'attestation declaration',
  P8: 'attestation import',
};

export function renderCell(d: Disposition, qualifier?: string): string {
  const q = qualifier ? ` (${qualifier})` : '';
  switch (d) {
    case 'PASS':
      return `**PASS**${q}`;
    case 'PASS-CONDITIONAL':
      return '**PASS** (conditional)';
    case 'FAIL':
      return `**FAIL**${q}`;
    case 'n/a':
      return 'n/a';
  }
}

export function renderGradeTable(g: Grade): string {
  const header = `| | ${g.paths.map((p) => p.path).join(' | ')} |`;
  const rule = `|---|${g.paths.map(() => '---').join('|')}|`;
  const rows = P_ITEMS.map(
    (item) =>
      `| **${item}** ${ITEM_TITLES[item]} | ` +
      g.paths.map((p) => renderCell(p.items[item].disposition, p.items[item].qualifier)).join(' | ') +
      ' |',
  );
  return [header, rule, ...rows].join('\n') + '\n';
}

function renderItem(i: ItemGrade): string {
  const out = [`### ${i.item} — ${renderCell(i.disposition, i.qualifier).replace(/\*\*/g, '')}`, '', i.reason];
  if (i.conditions.length) {
    out.push('', 'Conditions on this pass, all of which must be evidenced:', '');
    i.conditions.forEach((c, n) => out.push(`${n + 1}. ${c}`));
  }
  if (i.citations.length) {
    out.push('', ...i.citations.map((c) => `> ${c}`));
  }
  out.push('', `_Basis: ${i.basis}._`);
  return out.join('\n');
}

function renderPath(p: PathGrade): string {
  return [
    `## Path — ${p.path}`,
    '',
    `Placement resolved: **${p.assurance.resolution.effective}** ` +
      `(declared \`${p.assurance.resolution.declared}\`, enforcement \`${p.assurance.resolution.enforcement}\`). ` +
      p.assurance.resolution.reason,
    '',
    ...P_ITEMS.map((item) => renderItem(p.items[item])),
  ].join('\n\n');
}

export function renderGradeMarkdown(g: Grade): string {
  const noncompliant = g.paths.filter((p) => !p.compliant);
  const out: string[] = [
    '# Formal grade against Integration Requirements P1–P8',
    '',
    `_Graded ${g.gradedAt} against source ref \`${g.sourceRef}\`. Produced by ` +
      '@scruple/conformance — the grading rules are code, not a careful reader._',
    '',
    '## Bottom line',
    '',
    noncompliant.length === 0
      ? `All ${g.paths.length} capture path(s) pass every applicable item.`
      : `**${noncompliant.map((p) => p.path).join(' and ')} ${noncompliant.length === 1 ? 'is' : 'are'} ` +
        'non-compliant.** Compliance is binary (Standard §5): one FAIL ends the question, ' +
        'and a conditional PASS is a statement about what makes the claim checkable, not a ' +
        'third compliance state.',
    '',
    '## Summary table',
    '',
    renderGradeTable(g).trimEnd(),
    '',
    ...g.paths.map(renderPath),
    '',
    '---',
    '',
    '## How to read a FAIL here',
    '',
    'A FAIL is the expected output of an honest first grade. The document this format',
    'comes from published two of them about Scruple\'s own reference implementation and',
    'made that the point: we are asking vendors to submit to P1–P8 inside a boundary we',
    'cannot see, and a reference implementation that grades itself honestly is more',
    'persuasive than one that claims a clean sheet.',
    '',
  ];
  return out.join('\n');
}
