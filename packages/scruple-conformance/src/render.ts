// Grade → Markdown, in STUDIO_P1-P8_GRADE.md's shape.
//
// The shape is not cosmetic. That document's argument is that the grade is a
// vendor-produced artefact and that an unflattering one is normal; a vendor
// only believes that if the file they are asked to produce looks exactly like
// the one Scruple published about itself, down to the summary table. So the
// table renders with the same column order, the same cell vocabulary
// (`**PASS** (conditional)`, `**FAIL**`, `n/a`) and the same bottom-line
// sentence.

import { RUNTIME_COMPLETENESS_PROFILE, type Disposition, type Grade, type ItemGrade, type PathGrade } from './grade';
import { P_ITEMS } from './types';

const ITEM_TITLES: Record<string, string> = {
  P1: 'runtime boundary integrity',
  // P2 IS NAMED AFTER WHAT IT MEASURES, AND WHAT IT MEASURES CHANGED. A grade
  // issued under the frozen profile keeps the old row heading, because a
  // reader comparing it to the published document has to be able to line the
  // rows up; a grade issued under the rule in force says what that rule asks.
  P2: 'pipeline seal',
  P3: 'API key custody',
  P4: 'principal identity',
  P5: 'immutable event chain',
  P6: 'zero-content posture',
  P7: 'attestation declaration',
  P8: 'attestation import',
};

function itemTitles(profile: string): Record<string, string> {
  return profile === RUNTIME_COMPLETENESS_PROFILE.id
    ? { ...ITEM_TITLES, P2: 'baseline coverage' }
    : ITEM_TITLES;
}

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
  const titles = itemTitles(g.profile);
  const header = `| | ${g.paths.map((p) => p.path).join(' | ')} |`;
  const rule = `|---|${g.paths.map(() => '---').join('|')}|`;
  const rows = P_ITEMS.map(
    (item) =>
      `| **${item}** ${titles[item]} | ` +
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

/**
 * The class section, and it goes ABOVE the items on purpose.
 *
 * A reader who does not know which Protection Profile a Security Target was
 * graded against cannot read the table below it: a `n/a` that means "out of
 * scope for this class" and a `FAIL` that means "in scope and not met" are the
 * two answers this WO exists to keep apart, and the reader needs the scope in
 * hand before the first row.
 */
function renderClassScope(p: PathGrade): string {
  const c = p.classScope;
  const na = <T extends string>(items: readonly { item: T; status: string; reason: string }[]) =>
    items.filter((i) => i.status === 'not-applicable');
  const out: string[] = [
    `### Capability class — ${c.audited.map((x) => `\`${x}\``).join(' + ')}`,
    '',
    c.ambiguityResolved
      ? 'DECLARED: none. CAPABILITY_CLASSES.md — "where it is ambiguous, the broader class ' +
        `applies" — so this is audited as \`${c.audited.join(', ')}\`, the broadest.`
      : `Declared: ${c.declared.map((x) => `\`${x}\``).join(' + ')}. A deployment spanning two ` +
        'classes is audited against both: required items are the union, and an item is out of ' +
        'scope only when every audited class says so.',
    '',
    `In scope: **${c.inScope ? 'yes' : 'no'}**.` +
      (c.inScope
        ? ''
        : ' A blocking class finding stands, so the item table below is a grade against a class ' +
          'this deployment is not a member of, or does not meet the floor of. Compliance is ' +
          'refused for that reason and not only for the items.'),
  ];

  if (c.custody) {
    out.push(
      '',
      `**Custody — \`${c.custody.locus}\` at \`${c.custody.placement}\` → ` +
        `\`${c.custody.claim}\`.** ${c.custody.reason}`,
      '',
      c.custody.canClaim
        ? `Permitted sentence: _"${c.custody.sentence}"_.`
        : 'No custody sentence is permitted at this placement.',
    );
    if (c.custody.mustNotImply.length) {
      out.push(
        '',
        'MUST NOT be allowed to imply:',
        '',
        ...c.custody.mustNotImply.map((m) => `- _"${m}"_`),
      );
    }
  }

  const naProbes = na(c.probes);
  if (naProbes.length) {
    out.push(
      '',
      'Out of scope for this class — declared by the class, checked against the profile:',
      '',
      ...naProbes.map((i) => `- **${i.item}** — ${i.reason}`),
    );
  }
  const naShapes = [...na(c.hooks), ...na(c.surfaces)];
  if (naShapes.length) {
    out.push('', ...naShapes.map((i) => `- \`${i.item}\` — ${i.reason}`));
  }
  if (c.unmeasured.length) {
    out.push(
      '',
      `**Applicable and not measured: ${c.unmeasured.join(', ')}.** Nobody looked. That is ` +
        'neither a pass nor a failure, and it aggregates as NOT PASSED everywhere.',
    );
  }
  if (c.findings.length) {
    out.push(
      '',
      'Findings:',
      '',
      ...c.findings.map(
        (f) =>
          `- **${f.id}${f.blocking ? '' : ' (observation)'} — ${f.title}.** ${f.detail}` +
          (f.impliedClass ? ` Implied class: \`${f.impliedClass}\`.` : ''),
      ),
    );
  }
  out.push(
    '',
    `Permitted claim wording: ${c.permittedClaims.map((x) => `_"${x}"_`).join(', ')}.`,
    c.forbiddenClaims.length
      ? `Must not imply: ${c.forbiddenClaims.map((x) => `_"${x}"_`).join(', ')}.`
      : '',
  );
  return out.filter((l) => l !== undefined).join('\n');
}

function renderPath(p: PathGrade): string {
  return [
    `## Path — ${p.path}`,
    '',
    renderClassScope(p),
    '',
    `Lifecycle: **${p.lifecycle}**. ` +
      (p.lifecycle === 'sealed'
        ? 'Sealed deployments may claim the standard.'
        : 'A deployment that is not `sealed` cannot claim the standard. That is not a third ' +
          'compliance state — compliance is binary (Standard §5) — it is which side of the ' +
          'line this deployment is on.'),
    '',
    `Placement resolved: **${p.assurance.resolution.effective}** ` +
      `(declared \`${p.assurance.resolution.declared}\`, enforcement \`${p.assurance.resolution.enforcement}\`). ` +
      p.assurance.resolution.reason,
    '',
    ...P_ITEMS.map((item) => renderItem(p.items[item])),
    '',
    // REPORTED BESIDE THE ITEMS AND NOT AS ONE. The counter says whether this
    // deployment went dark or was suppressed; it never said whether capture
    // was complete, and grading it as though it did made a componentless path
    // look permanently non-compliant. It bears on no P-item and on `compliant`
    // nowhere.
    [
      `### Liveness — ${p.liveness.verdict}`,
      '',
      p.liveness.reason,
      '',
      ...p.liveness.citations.map((c) => `> ${c}`),
      '',
      '_Operational, not a compliance item: it does not enter the binary._',
    ].join('\n'),
  ].join('\n\n');
}

export function renderGradeMarkdown(g: Grade): string {
  const noncompliant = g.paths.filter((p) => !p.compliant);
  const out: string[] = [
    '# Formal grade against Integration Requirements P1–P8',
    '',
    `_Graded ${g.gradedAt} against source ref \`${g.sourceRef}\`, under grading profile ` +
      `\`${g.profile}\`. Produced by @scruple/conformance — the grading rules are code, not a ` +
      'careful reader._',
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
