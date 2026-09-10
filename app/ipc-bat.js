/**
 * ipc-bat.js — `scruple:bat`: the Blender Asset Tracer, hosted, and the pack
 * turned into a witnessed event.
 *
 * ⚑ WHY THIS IS IN THE APP AT ALL
 *
 * WO-G6 went looking for ways a `.blend` changes without the add-on seeing it,
 * and the first one found is not an attack — it is Blender's own workflow.
 * **BAT (`blender-asset-tracer`, by sybren@blender.org)** parses and REWRITES
 * `.blend` files with Blender closed. It is what Blender Studio's own render
 * farm uses to ship a shot to a worker. `bat pack shot.blend /farm/` is an
 * ordinary thing for an artist to be told to run.
 *
 * And it is invisible to everything we built:
 *   · it is NOT a Blender add-on — no `bl_info`, never imports `bpy` — so the
 *     add-on set G5 baselines does not contain it and never will;
 *   · Blender is not running, so no handler of ours fires;
 *   · nothing about the machine's Blender install changes.
 *
 * The result is a `.blend` whose bytes differ from the one we last witnessed,
 * with no witnessed event in between — and the person who did it was following
 * their studio's instructions.
 *
 * 🔴 SO WE DO NOT TRY TO DETECT IT. WE HOST IT.
 * A tool the app runs is a tool the app can witness. Detection would be a losing
 * game against a first-party utility that is meant to be used; hosting turns the
 * same action into an event with a before and an after.
 *
 * ⚑ WHAT MAKES THE EVENT WORTH ANYTHING: REPATH IS NOT SWAP.
 * BAT rewrites WHERE an asset lives. It does not rewrite WHAT the asset is.
 * Measured on a real pack: the `.blend` hash changed, the byte count did not
 * (paths live in fixed-size arrays, so a size check sees nothing), and every
 * asset digest was identical. That is the whole distinction, and the record
 * WO-F3 already keeps carries it — because it hashes contents, not paths.
 *
 * THE INTERPRETER
 * BAT is pure Python and needs `requests`; `zstandard` too for the compressed
 * `.blend` files Blender writes by default. Both are already inside Blender's
 * bundled Python, so a machine with Blender needs no install — which is the
 * whole reason this lives behind the Blender tab. A system `python3` is tried
 * first because it is faster; Blender's is the fallback that always works.
 */

'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const BAT_LIB = process.env.SCRUPLE_BAT_LIB || path.join(__dirname, '..', 'vendor', 'bat', 'lib');
const TIMEOUT_MS = Number(process.env.SCRUPLE_BAT_TIMEOUT_MS || 600000);

function refuse(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Run a python with BAT importable. Returns {code, stdout, stderr}. */
function runPython(bin, args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PYTHONPATH: BAT_LIB, ...extraEnv },
      },
      (err, stdout, stderr) => resolve({
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        failed: !!err,
      })
    );
  });
}

/**
 * Which python can run BAT on this machine.
 *
 * ⚑ ASKED BY IMPORTING IT, not by looking for a file. An interpreter that exists
 * and cannot import `requests` is not an interpreter that can run BAT, and the
 * difference only shows up when a user presses the button.
 */
async function resolveInterpreter() {
  const candidates = [];
  if (process.env.SCRUPLE_BAT_PYTHON) candidates.push(process.env.SCRUPLE_BAT_PYTHON);
  candidates.push('python3', 'python');

  const probe = [
    '-c',
    'import sys,importlib.util as u;' +
    'ok=all(u.find_spec(m) for m in ("requests",));' +
    'import blender_asset_tracer as b;' +
    'print("BATOK", sys.version.split()[0], b.__version__ if hasattr(b,"__version__") else "?", ok)',
  ];

  for (const bin of candidates) {
    const r = await runPython(bin, probe);
    const line = r.stdout.split('\n').find((l) => l.startsWith('BATOK'));
    if (line) {
      const [, version, batVersion, deps] = line.trim().split(/\s+/);
      return { ok: true, python: bin, version, batVersion, depsPresent: deps === 'True' };
    }
  }
  return {
    ok: false,
    code: 'no_interpreter',
    error:
      'no python on this machine can import blender-asset-tracer. BAT ships with this app ' +
      `at ${BAT_LIB}; what is missing is an interpreter with \`requests\`. Blender's own ` +
      'bundled python has it — set SCRUPLE_BAT_PYTHON to it.',
  };
}

/** The asset record for one .blend, read by BAT — no Blender involved. */
async function traceAssets(python, blendPath) {
  const script = [
    '-c',
    'import sys, json, hashlib, pathlib;' +
    'from blender_asset_tracer import trace;' +
    'p = pathlib.Path(sys.argv[1]);' +
    'out = [];' +
    'exec("""\n' +
    'for usage in trace.deps(p):\n' +
    '    ap = usage.abspath\n' +
    '    try:\n' +
    '        d = hashlib.sha256(pathlib.Path(ap).read_bytes()).hexdigest()\n' +
    '        n = pathlib.Path(ap).stat().st_size\n' +
    '        u = None\n' +
    '    except OSError as e:\n' +
    '        d, n, u = None, None, type(e).__name__\n' +
    '    out.append({"path": str(ap), "name": pathlib.Path(ap).name, "digest": d, "bytes": n, "unreadable": u})\n' +
    '""");' +
    'print("BATJSON" + json.dumps(out))',
    blendPath,
  ];
  const r = await runPython(python, script);
  const line = r.stdout.split('\n').find((l) => l.startsWith('BATJSON'));
  if (!line) {
    return { ok: false, code: 'trace_failed', error: r.stderr.split('\n').slice(-4).join(' ').trim() };
  }
  return { ok: true, assets: JSON.parse(line.slice('BATJSON'.length)) };
}

/**
 * Compare two asset records.
 *
 * ⚑ THE VERDICT THIS FUNCTION EXISTS FOR. `repath` and `content_changed` are the
 * two things a changed `.blend` can mean, they are not distinguishable from the
 * file's own hash or its size, and only one of them should worry anybody.
 *
 * 🔴 AND THE SCOPE MATTERS MORE THAN THE VERDICT. What this answers depends
 * entirely on what it is given, and the two readings are a sentence apart:
 *
 *   pack(before → after)   "THIS PACK did not change any content."
 *   compare(witnessed, now) "Nothing has changed content SINCE WE WITNESSED IT."
 *
 * The first is what a `pack` action can honestly say, because both of its
 * records are read at pack time — a texture swapped an hour earlier is in BOTH,
 * and the pack is right to call itself a repath. Only the second catches a swap,
 * and it needs a record from the past. A caller who reads the first as the
 * second has been told a true thing and drawn a false conclusion, which is the
 * most dangerous shape a result can have — so `pack` returns `scope:
 * "this_operation"` and `compare` returns `scope: "since_witnessed"`, in the
 * payload, where a reader cannot miss it.
 */
function verdict(before, after) {
  const key = (a) => a.name;
  const digestsBefore = new Map(before.map((a) => [key(a), a.digest]));
  const digestsAfter = new Map(after.map((a) => [key(a), a.digest]));

  const changed = [];
  for (const [name, d] of digestsAfter) {
    const was = digestsBefore.get(name);
    if (was !== undefined && was !== d) changed.push(name);
  }
  const added = [...digestsAfter.keys()].filter((n) => !digestsBefore.has(n));
  const removed = [...digestsBefore.keys()].filter((n) => !digestsAfter.has(n));
  const moved = after.filter((a) => {
    const b = before.find((x) => key(x) === key(a));
    return b && b.path !== a.path && b.digest === a.digest;
  }).map(key);

  const contentMoved = changed.length || added.length || removed.length;
  return {
    verdict: contentMoved ? 'content_changed' : (moved.length ? 'repath' : 'unchanged'),
    moved,
    content_changed: changed,
    added,
    removed,
    // Said out loud, because it is the claim: every asset that survived the
    // operation is byte-identical to what it was.
    every_surviving_asset_identical: changed.length === 0,
  };
}

/**
 * The other half: is this `.blend` still made of what it was made of when we
 * witnessed it?
 *
 * ⚑ THIS IS THE ONE THAT CATCHES A SWAP, and it is a different question from
 * anything `pack` can answer. It needs a record from BEFORE — the asset digests
 * as they stood at a witnessed moment — because a comparison whose both halves
 * are read today cannot see a change made yesterday.
 */
function compareToWitnessed(witnessedAssets, currentAssets) {
  const v = verdict(witnessedAssets, currentAssets);
  return { ...v, scope: 'since_witnessed' };
}

function registerBatIpc() {
  ipcMain.handle('scruple:bat', async (_e, req) => {
    const action = req && req.action;

    if (action === 'probe') {
      const i = await resolveInterpreter();
      return { ...i, batLib: BAT_LIB, batLibPresent: fs.existsSync(BAT_LIB) };
    }

    const blend = req && req.blendPath;
    if (!blend || !path.isAbsolute(blend)) return refuse('bad_blend_path', 'blendPath must be absolute');
    if (!fs.existsSync(blend)) return refuse('blend_not_found', `no such file: ${blend}`);

    const i = await resolveInterpreter();
    if (!i.ok) return i;

    if (action === 'list') {
      const t = await traceAssets(i.python, blend);
      if (!t.ok) return t;
      return { ok: true, python: i.python, blend: { path: blend, sha256: sha256(blend) }, assets: t.assets };
    }

    if (action === 'pack') {
      const target = req.targetDir;
      if (!target || !path.isAbsolute(target)) return refuse('bad_target_dir', 'targetDir must be absolute');

      // ── the BEFORE, recorded before anything is touched ──────────────────
      const beforeBlend = { path: blend, sha256: sha256(blend), bytes: fs.statSync(blend).size };
      const beforeTrace = await traceAssets(i.python, blend);
      if (!beforeTrace.ok) return beforeTrace;

      const r = await runPython(i.python, [
        '-c',
        'import sys;from blender_asset_tracer.cli import cli_main;sys.argv=["bat"]+sys.argv[1:];\n' +
        'exec("try:\\n cli_main()\\nexcept SystemExit:\\n pass")',
        'pack', blend, target,
      ]);

      const packed = path.join(target, path.basename(blend));
      if (!fs.existsSync(packed)) {
        return refuse('pack_produced_nothing',
          `bat pack wrote no ${path.basename(blend)} into ${target}`,
          { stderr: r.stderr.split('\n').slice(-6) });
      }

      // ── the AFTER, and the only comparison that means anything ───────────
      const afterBlend = { path: packed, sha256: sha256(packed), bytes: fs.statSync(packed).size };
      const afterTrace = await traceAssets(i.python, packed);
      if (!afterTrace.ok) return afterTrace;

      const v = verdict(beforeTrace.assets, afterTrace.assets);
      return {
        ok: true,
        python: i.python,
        before: { blend: beforeBlend, assets: beforeTrace.assets },
        after: { blend: afterBlend, assets: afterTrace.assets },
        // ⚑ THE THREE FACTS A WITNESS NEEDS. The file changed; the byte count
        // did NOT (paths live in fixed-size arrays, so size proves nothing);
        // and every surviving asset is byte-identical. Only the third one is
        // the difference between a repath and a swap.
        blend_changed: beforeBlend.sha256 !== afterBlend.sha256,
        size_unchanged: beforeBlend.bytes === afterBlend.bytes,
        ...v,
        // 🔴 READ THIS BEFORE READING THE VERDICT. Both records above were taken
        // at pack time, so this says what THIS PACK did — not whether the scene
        // still holds what it held when it was witnessed. A texture swapped an
        // hour ago is in both records and this will, correctly, say `repath`.
        // `action: "compare"` is the one that answers the other question.
        scope: 'this_operation',
        stderr: r.stderr.split('\n').filter(Boolean).slice(-4),
      };
    }

    if (action === 'compare') {
      // The record from the witnessed moment, as `list` or `pack` returned it.
      const witnessed = req.witnessedAssets;
      if (!Array.isArray(witnessed)) {
        return refuse('no_witnessed_record',
          'compare needs `witnessedAssets` — the asset record as it stood when this .blend was ' +
          'witnessed. Without one there is nothing to compare against, and an answer derived from ' +
          'two readings taken today cannot see a change made yesterday.');
      }
      const now = await traceAssets(i.python, blend);
      if (!now.ok) return now;
      return {
        ok: true,
        python: i.python,
        blend: { path: blend, sha256: sha256(blend) },
        assets: now.assets,
        ...compareToWitnessed(witnessed, now.assets),
      };
    }

    return refuse('unknown_action', `action must be probe, list, pack or compare; got ${JSON.stringify(action)}`);
  });
}

module.exports = { registerBatIpc, resolveInterpreter, verdict, compareToWitnessed };
