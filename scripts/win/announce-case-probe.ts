// Does the announce lookup correlate a generation to a scene it did not come
// from, because NTFS is case-insensitive?
//
// ⚑ WHY THIS IS NOT A FILESYSTEM TRIVIA QUESTION. `hostAdapter.ts` resolves an
// announcement by BUILDING A FILENAME out of the correlation id:
//
//     const safe = path.basename(String(o.correlationId));
//     const p = path.join(announceDir, `${safe}.json`);
//     if (!fs.existsSync(p)) return null;
//
// On Linux `A.json` and `a.json` are two files, so announcing under one id and
// submitting under another yields `declined` — that is the `blender-host`
// scenario's `announce-under-a-different-id` mutation, and it is the CORRELATION
// CONTROL: it exists to prove that choosing the id grants nothing. On NTFS the
// two names are ONE file. If the lookup matches, the gate attaches a document
// describing scene X to an artifact generated under a different id, and the leaf
// says something FALSE rather than saying less. `host_semantics` reads
// `supplied` when the honest answer is `declined`.
//
// This runs the REAL code path: the real `openHostDeclaration`, the real SDK
// `registerHost`, and a declaration written by the real add-on in an earlier run.
//
//   scripts/tsx.sh scripts/win/announce-case-probe.ts
//
// VERIFY BY SIDE EFFECT. Four observations, and two of them are controls that
// decide whether the other two mean anything:
//
//   exact      the id as written           MUST resolve — if it does not, the
//                                          probe is broken and nothing below
//                                          can be read
//   case       the same id, upper-cased    the finding
//   different  a different UUID, same      MUST NOT resolve — if a genuinely
//              case, one hex digit moved   different id also resolves, the
//                                          lookup matches everything and the
//                                          `case` result proves nothing
//   traversal  `../../scruple-host`        MUST NOT resolve — the basename
//                                          guard is a separate defence and this
//                                          probe must not be read as impeaching
//                                          it
//
// Exit code is 0 when the controls behaved, 2 when a control misfired (the run
// is INCONCLUSIVE, which is not a pass), regardless of what `case` did.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openHostDeclaration } from '../../app/comfy/hostAdapter';

const REPO = path.resolve(__dirname, '..', '..');

/** A declaration the ADD-ON wrote, not one this file made up. */
function realDeclaration(): { json: string; from: string } {
  const runs = path.join(REPO, '.run');
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || found.length) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'scruple-host.json') { found.push(p); return; }
    }
  };
  walk(runs, 0);
  if (!found.length) {
    throw new Error(
      `no scruple-host.json under ${runs} — run a blender-host scenario first; ` +
      'this probe deliberately will not invent a declaration',
    );
  }
  return { json: fs.readFileSync(found[0], 'utf8'), from: path.relative(REPO, found[0]) };
}

const decl = realDeclaration();

const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-announce-case-'));
const announceDir = path.join(hostDir, 'announce');
fs.mkdirSync(announceDir, { recursive: true });
fs.writeFileSync(path.join(hostDir, 'scruple-host.json'), decl.json);

// The id the "host" announced under and would submit under. Canonical lowercase
// UUID, which is what current ComfyUI now REQUIRES (v0.35.0 rejects anything
// else with `invalid_prompt_id`), so this is the shape the product must handle.
const ANNOUNCED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UPPER = ANNOUNCED.toUpperCase();
// One hex digit different, SAME case. Differs from ANNOUNCED by content, not by
// case — which is exactly what makes it the control.
const DIFFERENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef';

// A document that is complete against the declaration's own `required` list, so
// a `declined` in the results is about correlation and not about the schema.
const evidence = {
  scene: 'THE-SCENE-THAT-WAS-ANNOUNCED',
  frame: 7,
  camera: 'CAM_hero',
  engine: 'BLENDER_EEVEE_NEXT',
  resolution: [1920, 1080],
  resolution_percentage: 100,
  file_format: 'PNG',
};
fs.writeFileSync(
  path.join(announceDir, `${ANNOUNCED}.json`),
  JSON.stringify(evidence, null, 2),
);

const { outcome, adapter } = openHostDeclaration(hostDir);
if (!adapter) {
  console.error(`the real declaration did not register: ${outcome.reason}`);
  process.exit(2);
}

async function lookup(correlationId: string) {
  const doc = await adapter!.semanticsFor({
    hook: 'artifact.produced',
    surface: 'host-api-callback',
    observedAt: new Date().toISOString(),
    correlationId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return doc;
}

// What the filesystem itself says, independent of our code, so a reader can see
// whether the behaviour is NTFS's or ours.
const rawExists = (id: string) => fs.existsSync(path.join(announceDir, `${id}.json`));

(async () => {
  const cases: Array<{ key: string; id: string; expect: 'resolve' | 'null'; control: boolean }> = [
    { key: 'exact', id: ANNOUNCED, expect: 'resolve', control: true },
    { key: 'case', id: UPPER, expect: 'null', control: false },
    { key: 'different', id: DIFFERENT, expect: 'null', control: true },
    { key: 'traversal', id: '../../scruple-host', expect: 'null', control: true },
  ];

  const results: Record<string, unknown> = {};
  for (const c of cases) {
    const doc = await lookup(c.id);
    results[c.key] = {
      id: c.id,
      resolved: doc !== null,
      scene: doc ? (doc as Record<string, unknown>).scene : null,
      fsExistsSync: rawExists(c.id),
      expected: c.expect,
      isControl: c.control,
    };
  }

  const onDisk = fs.readdirSync(announceDir);

  console.log('platform            :', process.platform, os.release());
  console.log('declaration from    :', decl.from);
  console.log('announce dir holds  :', JSON.stringify(onDisk));
  console.log('');
  for (const c of cases) {
    const r = results[c.key] as Record<string, unknown>;
    const ok = c.expect === 'resolve' ? r.resolved === true : r.resolved === false;
    const tag = c.control ? (ok ? 'CONTROL ok' : 'CONTROL MISFIRED') : (ok ? 'as on Linux' : '⚑ FINDING');
    console.log(
      `${c.key.padEnd(10)} resolved=${String(r.resolved).padEnd(5)} ` +
      `existsSync=${String(r.fsExistsSync).padEnd(5)} scene=${String(r.scene).padEnd(30)} ${tag}`,
    );
  }

  const controlsOk = cases
    .filter((c) => c.control)
    .every((c) => {
      const r = results[c.key] as Record<string, unknown>;
      return c.expect === 'resolve' ? r.resolved === true : r.resolved === false;
    });

  const caseResolved = (results.case as Record<string, unknown>).resolved === true;

  console.log('');
  if (!controlsOk) {
    console.log('INCONCLUSIVE — a control misfired, so the `case` row cannot be read.');
  } else if (caseResolved) {
    console.log(
      '⚑ FINDING. A case-variant correlation id resolves to an announcement it does\n' +
      '  not name. The controls held: a genuinely different id did NOT resolve, and\n' +
      '  the traversal id did NOT resolve, so this is case-folding specifically.\n' +
      '  Consequence: `announce-under-a-different-id` — the correlation control of\n' +
      '  the blender-host scenario — cannot fail on this filesystem when the two ids\n' +
      '  differ only in case, and a leaf reads `supplied` carrying a scene the\n' +
      '  artifact did not come from.',
    );
  } else {
    console.log('No case-folding: the lookup is case-sensitive here.');
  }

  // Keep the fixture only when there is something to look at.
  if (controlsOk && !caseResolved) fs.rmSync(hostDir, { recursive: true, force: true });
  else console.log(`\nfixture kept at ${hostDir}`);

  process.exit(controlsOk ? 0 : 2);
})();

void execFileSync;
