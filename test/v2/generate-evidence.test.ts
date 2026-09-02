// WO-27 — THE UI'S OWN DOOR THREW AWAY EVIDENCE THE RUNNER HAD ALREADY
// COMPUTED.
//
// `docs/canon/demo-readiness/comfyui-flows.md` §2.2/§2.3/§3.2 and
// SYNTHESIS.md name four losses at one door. Nothing here needs a GPU,
// Modal, or a witness server, because nothing that was lost had to be
// computed — it was computed, surfaced, and then not named by the caller.
// That is exactly why it is testable offline.
//
// WHAT EACH SECTION PINS
//
//   1. THE WRITER/LOADER TABLES ARE DATA AND THEY KNOW VIDEO.
//      `/^(Save|Preview)/` excluded `VHS_VideoCombine`, a node BOTH Modal
//      images install; `/^Load(Image|ImageMask|Audio|Video)/` excluded
//      `VHS_LoadVideo`. Each must-fire assertion is paired with a
//      must-NOT-fire control, because a table that says yes to everything
//      passes the same tests as a correct one.
//
//   2. A VIDEO IS STORED AS A VIDEO. The `.png`-named WebM had two
//      independent causes and both are pinned: the route not passing
//      `outputKind`, and `extFor` not knowing `video/webm` when it had to
//      fall back to the content type.
//
//   3. WO-B1's CONTAINER MANIFEST REACHES THE LEAF. It had zero consumers
//      in the whole repo. The control asserts that WITHOUT it the leaf
//      still gets a hash — from the DB descriptor — so "rung 1 is
//      unreachable" is a fact about the value, not about nullness.
//
//   4. AN ABSENT INPUT AND AN EMPTY INPUT LIST ARE DIFFERENT LEAVES.
//      `hashRunInputs` never declined, so three of four doors signed
//      `inputs: []` — an affirmative "there were none" — on every img2vid
//      run that had a frame. The control is the run that GENUINELY had no
//      inputs: it must still get a hash, or the fix has broken txt2img.
//
//   5. THE DOORS ACTUALLY NAME THE FIELDS. Read out of the route sources,
//      because a pass-through is deleted by an edit that no unit test of
//      ingest can see.
//
// TEST ISOLATION, as the other v2 files explain it: `npm run test:v2` runs
// every file CONCURRENTLY against one shared SCRUPLE_DB_PATH, so this file
// takes its own private database, assigned at module top level, with every
// module that reaches lib/db/sqlite imported DYNAMICALLY inside before().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-evidence-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'evidence.db');
// THE STANDING SAFETY RULE. 127.0.0.1:5799 is the PRODUCTION witness and a
// test that reaches it writes into a real audit log, which has happened
// once already. Port 1 refuses instantly; ingest swallows that by design
// (capture is non-blocking) and still writes the leaf row, which is all
// this file reads.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';
// The signer call site added by this work order is behind a flag and this
// file asserts it stays OFF by default — see §6. Nothing here spends.
delete process.env.SCRUPLE_C2PA_SIGN_ON_INGEST;

const REPO_ROOT = path.resolve(__dirname, '..', '..');

type Mod = {
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  conn: typeof import('../../lib/db/sqlite').conn;
  ingest: typeof import('../../lib/iterations/ingest');
  correlation: typeof import('../../services/scruple-capture/src/correlation');
  correlate: typeof import('../../lib/canvas/correlate');
  signOnIngest: typeof import('../../lib/iterations/signOnIngest');
};

let M: Mod;
const USER = 'u_wo27';
let PROJECT_ID = 0;
/** Artifact hashes this file wrote into the repo's content store. */
const WROTE: string[] = [];

before(async () => {
  M = {
    runMigrations: (await import('../../lib/db/migrate')).runMigrations,
    conn: (await import('../../lib/db/sqlite')).conn,
    ingest: await import('../../lib/iterations/ingest'),
    correlation: await import('../../services/scruple-capture/src/correlation'),
    correlate: await import('../../lib/canvas/correlate'),
    signOnIngest: await import('../../lib/iterations/signOnIngest'),
  };

  M.runMigrations();
  const db = M.conn();
  db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`).run(USER, 'wo27@test');
  PROJECT_ID = Number(
    db
      .prepare(
        `INSERT INTO projects (user_id, name, is_active, created_at)
         VALUES (?, 'wo27', 1, datetime('now'))`,
      )
      .run(USER).lastInsertRowid,
  );
});

after(() => {
  // The content-addressed store is `process.cwd()/artifacts`, which is the
  // repo. Only the files this file put there are removed — a blanket wipe
  // would delete a developer's working artifacts for a test's convenience.
  for (const h of WROTE) {
    try {
      fs.rmSync(path.join(REPO_ROOT, 'artifacts', h.slice(0, 2), h), { force: true });
    } catch {
      /* the store is gitignored either way */
    }
  }
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* the tmpdir outlives the assertion */
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────

/** A ComfyUI API-format img2vid graph in the shape VideoHelperSuite makes:
 *  VHS_LoadVideo in, VHS_VideoCombine out. Neither class matches the name
 *  shapes the correlator used to gate on. */
function vhsGraph(inputName = 'init-clip.mp4', prefix = 'ScrupleVid'): Record<string, unknown> {
  return {
    '1': { class_type: 'VHS_LoadVideo', inputs: { video: inputName, frame_load_cap: 25 } },
    '3': { class_type: 'KSampler', inputs: { seed: 26071231, latent_image: ['1', 0] } },
    '9': {
      class_type: 'VHS_VideoCombine',
      inputs: { filename_prefix: prefix, format: 'video/h264-mp4', images: ['3', 0] },
    },
  };
}

/** A txt2img graph: a real writer, and NO loader at all. The control for
 *  every "declined because an input was referenced" assertion. */
function txt2imgGraph(prefix = 'ScrupleImg'): Record<string, unknown> {
  return {
    '3': { class_type: 'KSampler', inputs: { seed: 7 } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['3', 0] } },
  };
}

let SEQ = 0;
/** One real ingest. Not a stand-in: the row the REAL path writes is the
 *  entire point, and every loss under test is a column on it. */
async function ingestOne(
  over: Partial<Parameters<Mod['ingest']['ingestIteration']>[0]> & { bytes?: Buffer } = {},
) {
  const { bytes, ...rest } = over;
  const body = bytes ?? Buffer.from(`wo27-${++SEQ}-${Math.random()}`);
  const r = await M.ingest.ingestIteration({
    userId: USER,
    projectId: PROJECT_ID,
    provider: 'comfydeploy',
    providerJobId: `p-${SEQ}`,
    prompt: '(canvas workflow / modal)',
    spec: { prompt: '(canvas workflow)' } as never,
    imageBytes: body,
    imageContentType: 'image/png',
    ...rest,
  });
  if (r.iteration.output_hash) WROTE.push(r.iteration.output_hash);
  return r;
}

function rowOf(id: number) {
  return M.conn()
    .prepare(
      `SELECT output_kind, output_content_type, image_filename, input_hash,
              machine_manifest_hash, container_machine_manifest,
              model_fingerprints_hash, metadata
         FROM iterations WHERE id = ?`,
    )
    .get(id) as {
    output_kind: string | null;
    output_content_type: string | null;
    image_filename: string | null;
    input_hash: string | null;
    machine_manifest_hash: string | null;
    container_machine_manifest: string | null;
    model_fingerprints_hash: string | null;
    metadata: string | null;
  };
}

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// 1. The writer/loader tables are DATA, and they know video
// ═══════════════════════════════════════════════════════════════════════

describe('1. writer and loader tables', () => {
  test('VHS_VideoCombine IS a writer, and carries its filename_prefix', () => {
    const writers = M.correlation.writingNodesOf(vhsGraph());
    assert.equal(writers.length, 1);
    assert.equal(writers[0].classType, 'VHS_VideoCombine');
    // Losing the prefix is the practical damage: without it the graph has
    // no filename-prefix attribution and every capture falls back to a
    // timing guess.
    assert.equal(writers[0].filenamePrefix, 'ScrupleVid');
  });

  test('VHS_LoadVideo IS a loader, and its `video` input is the name', () => {
    assert.deepEqual(M.correlation.referencedInputNames(vhsGraph()), ['init-clip.mp4']);
  });

  test('VHS_LoadVideoPath — a PATH the gate never saw is still a reference', () => {
    const g = {
      '1': { class_type: 'VHS_LoadVideoPath', inputs: { video_path: '/vol/in/hand-placed.mov' } },
    };
    assert.deepEqual(M.correlation.referencedInputNames(g), ['/vol/in/hand-placed.mov']);
  });

  test('the core classes did not regress', () => {
    assert.equal(M.correlation.writingNodesOf(txt2imgGraph())[0].classType, 'SaveImage');
    assert.ok(M.correlation.isWritingNodeClass('SaveAnimatedWEBP'));
    assert.ok(M.correlation.isWritingNodeClass('PreviewImage'));
    assert.ok(M.correlation.isInputLoaderClass('LoadImage'));
    assert.ok(M.correlation.isInputLoaderClass('LoadImageMask'));
  });

  test('MUST-NOT-FIRE — the tables are not "yes to everything"', () => {
    // A table that answers true for any class passes every assertion above
    // and is worthless. These are the controls.
    assert.equal(M.correlation.isWritingNodeClass('KSampler'), false);
    assert.equal(M.correlation.isWritingNodeClass('VHS_LoadVideo'), false);
    assert.equal(M.correlation.isWritingNodeClass('CheckpointLoaderSimple'), false);
    assert.equal(M.correlation.isInputLoaderClass('KSampler'), false);
    assert.equal(M.correlation.isInputLoaderClass('VHS_VideoCombine'), false);
    // LoraLoader loads a MODEL, not an input artifact. Model files are
    // bound by model_fingerprints_hash, not by input_hash, and conflating
    // them would make every txt2img graph "reference an unbound input".
    assert.equal(M.correlation.isInputLoaderClass('LoraLoader'), false);
    assert.deepEqual(M.correlation.referencedInputNames(txt2imgGraph()), []);
    assert.equal(M.correlation.writingNodesOf({ '1': { class_type: 'KSampler' } }).length, 0);
  });

  test('the shape fallback survives — an unheard-of vendor writer still counts', () => {
    // The tables must not have REPLACED the heuristic. A vendor's
    // custom_nodes directory can hold writers this component has never
    // heard of, and an unrecognised writer must yield an entry with no
    // declared MIME rather than no entry at all.
    const g = { '9': { class_type: 'SaveVendorThing', inputs: { filename_prefix: 'V' } } };
    const w = M.correlation.writingNodesOf(g);
    assert.equal(w.length, 1);
    assert.equal(M.correlation.isWritingNodeClass('SaveVendorThing'), true);
  });

  test('canvas reads the component table, not a second opinion', () => {
    // The estate-level consequence: a VHS graph pinned through canvas's
    // persisted correlator attributes by FILENAME-PREFIX — a real link —
    // instead of falling through to a timing guess.
    M.conn()
      .prepare(
        `INSERT OR REPLACE INTO canvas_sessions
           (id, user_id, machine_id, modal_url, signed_token, status, expires_at)
         VALUES ('cs_wo27', ?, 't4-free', 'https://x.modal.run/', 'not-a-credential',
                 'active', datetime('now', '+1 hour'))`,
      )
      .run(USER);
    const writers = M.correlate.openPrompt({
      sessionId: 'cs_wo27',
      userId: USER,
      promptId: 'pid_wo27',
      projectId: PROJECT_ID,
      workflowApiJson: vhsGraph(),
    });
    assert.equal(writers.length, 1, 'canvas pinned no writers for a VHS graph');
    const a = M.correlate.attribute('cs_wo27', 'ScrupleVid_00001_.mp4');
    assert.equal(a.method, 'filename-prefix');
    assert.equal(a.prompt?.prompt_id, 'pid_wo27');
    // VHS_VideoCombine's container is a widget argument, so mime.ts
    // declares nothing for it. Undeclared is the honest answer; a plausible
    // default would be a guess wearing a table.
    assert.equal(a.mime, null);
    assert.ok(M.correlate.isWritingNodeClass('VHS_VideoCombine'));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. A video is stored as a video
// ═══════════════════════════════════════════════════════════════════════

describe('2. output_kind and the stored extension', () => {
  test('extFor — a video/webm is never a .png, even if the KIND is wrong', () => {
    // THE EXACT DEFECT: `/api/generate` passed no outputKind, so the kind
    // was 'image', and the image tail knew mp4 but not webm. Both halves
    // are now closed; this is the half that does not depend on a caller.
    assert.equal(M.ingest.extFor('image', 'video/webm'), 'webm');
    assert.equal(M.ingest.extFor('video', 'video/webm'), 'webm');
    assert.equal(M.ingest.extFor('video', 'video/mp4'), 'mp4');
    // The old `kind === 'video'` branch collapsed everything non-webm to
    // mp4, so a MOV was stored as .mp4 — signable, and mislabelled.
    assert.equal(M.ingest.extFor('video', 'video/quicktime'), 'mov');
    assert.equal(M.ingest.extFor('video', 'image/gif'), 'gif');
  });

  test('MUST-NOT-FIRE — images and checkpoints are unchanged', () => {
    assert.equal(M.ingest.extFor('image', 'image/png'), 'png');
    assert.equal(M.ingest.extFor('image', 'image/jpeg'), 'jpg');
    assert.equal(M.ingest.extFor('image', 'image/webp'), 'webp');
    assert.equal(M.ingest.extFor('checkpoint', 'application/octet-stream'), 'safetensors');
    assert.equal(M.ingest.extFor('input', 'application/octet-stream'), 'safetensors');
    assert.equal(M.ingest.extFor('cad', 'application/x-unknown'), 'f3d');
  });

  test('a video generation stores output_kind=video with the video MIME', async () => {
    const r = await ingestOne({
      outputKind: 'video',
      imageContentType: 'video/webm',
      imageFilename: 'ScrupleVid_00001_.webm',
      spec: { prompt: '(canvas workflow)', providerExtras: { workflowApiJson: txt2imgGraph() } } as never,
    });
    const row = rowOf(r.iteration.id);
    assert.equal(row.output_kind, 'video');
    assert.equal(row.output_content_type, 'video/webm');
    assert.equal(row.image_filename, 'ScrupleVid_00001_.webm');
    assert.equal(M.ingest.extFor(row.output_kind as 'video', row.output_content_type!), 'webm');
  });

  test('MUST-NOT-FIRE — an image run still says image', async () => {
    const r = await ingestOne({ imageContentType: 'image/png' });
    assert.equal(rowOf(r.iteration.id).output_kind, 'image');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. WO-B1's container manifest reaches the leaf
// ═══════════════════════════════════════════════════════════════════════

describe('3. the container manifest', () => {
  const HASH = 'c0'.repeat(32);
  const MANIFEST = { comfyui_version: '0.18.5', packs: [{ name: 'VHS', commit_sha: 'deadbeef' }] };

  test('it reaches ingest, wins the ladder, and is recorded raw', async () => {
    const r = await ingestOne({
      containerMachineManifestHash: HASH,
      containerMachineManifest: MANIFEST,
    });
    const row = rowOf(r.iteration.id);
    // Rung 1 of ingest's own "resolution ladder (most trusted first)",
    // which had no caller anywhere in the repo before this work order.
    assert.equal(row.machine_manifest_hash, HASH);
    assert.deepEqual(JSON.parse(row.container_machine_manifest!), MANIFEST);
  });

  test('rung 1 beats an explicitly-passed rung 2', async () => {
    const r = await ingestOne({
      containerMachineManifestHash: HASH,
      machineManifestHash: 'ab'.repeat(32),
    });
    assert.equal(rowOf(r.iteration.id).machine_manifest_hash, HASH);
  });

  test('MUST-NOT-FIRE — without it the leaf still gets a hash, a DIFFERENT one', async () => {
    // The defect was never "the column is null". It is that the column
    // held the DESCRIPTOR's claim about the machine rather than the
    // container's measurement of itself, and nothing said which.
    const r = await ingestOne({});
    const row = rowOf(r.iteration.id);
    assert.notEqual(row.machine_manifest_hash, HASH);
    assert.equal(row.container_machine_manifest, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. An absent input and an empty input list are different leaves
// ═══════════════════════════════════════════════════════════════════════

describe('4. input_hash declines instead of asserting an empty set', () => {
  const withGraph = (g: Record<string, unknown>) =>
    ({ prompt: '(canvas workflow)', providerExtras: { workflowApiJson: g } }) as never;

  test('an img2vid graph whose input never reached us gets NULL', async () => {
    const r = await ingestOne({ spec: withGraph(vhsGraph('init-clip.mp4')) });
    const row = rowOf(r.iteration.id);
    assert.equal(row.input_hash, null, 'signed an empty input set for a graph with a loader');
    assert.equal(r.inputHash, null);
    assert.deepEqual(r.unboundInputs, ['init-clip.mp4']);
    // And the row says WHY, so a NULL here is distinguishable from a row
    // written before the question existed.
    const meta = JSON.parse(row.metadata!) as {
      inputBinding?: { declined: boolean; referenced: string[]; unbound: string[] };
    };
    assert.equal(meta.inputBinding?.declined, true);
    assert.deepEqual(meta.inputBinding?.referenced, ['init-clip.mp4']);
  });

  test('the same run WITH its input bound gets a real hash', async () => {
    const r = await ingestOne({
      spec: withGraph(vhsGraph('init-clip.mp4')),
      inputs: [
        {
          kind: 'init_image',
          bytes: Buffer.from('the frame that fed the video'),
          filename: 'init-clip.mp4',
          contentType: 'video/mp4',
        },
      ],
    });
    assert.ok(r.inputHash, 'declined a run whose input WAS bound');
    assert.deepEqual(r.unboundInputs, []);
    assert.equal(r.inputArtifacts.length, 1);
    assert.equal(rowOf(r.iteration.id).input_hash, r.inputHash);
    const meta = JSON.parse(rowOf(r.iteration.id).metadata!) as {
      inputBinding?: { declined: boolean };
    };
    assert.equal(meta.inputBinding?.declined, false);
  });

  test('MUST-NOT-FIRE — a genuinely input-free txt2img run still hashes', async () => {
    // This is the control that keeps the fix from being "return null when
    // the list is empty", which would NULL every historical txt2img leaf.
    // `inputs: []` is TRUE of a txt2img run and the leaf may say so.
    const r = await ingestOne({ spec: withGraph(txt2imgGraph()) });
    assert.ok(r.inputHash, 'a run with no loader in its graph must still assert its empty set');
    assert.deepEqual(r.unboundInputs, []);
    const meta = JSON.parse(rowOf(r.iteration.id).metadata!) as { inputBinding?: unknown };
    // Nothing was referenced, so there is nothing to explain.
    assert.equal(meta.inputBinding, undefined);
  });

  test('an absent input and an empty input list are NOT the same leaf', async () => {
    const free = await ingestOne({ spec: withGraph(txt2imgGraph()), bytes: Buffer.from('same') });
    const absent = await ingestOne({ spec: withGraph(vhsGraph()), bytes: Buffer.from('same') });
    assert.notEqual(free.inputHash, absent.inputHash);
    assert.ok(free.inputHash);
    assert.equal(absent.inputHash, null);
  });

  test('the preimage itself is untouched — this is not a scheme bump', async () => {
    // hashRunInputs is committed to by every leaf that already exists. The
    // decline is decided from the GRAPH and applied around the function,
    // never inside it.
    const hashes = await import('../../lib/leaf/hashes');
    const h = hashes.hashRunInputs({ provider: null, prompt: null, spec: null, inputs: [] });
    assert.equal(typeof h, 'string');
    assert.equal(h.length, 64);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. The doors actually name the fields
// ═══════════════════════════════════════════════════════════════════════

describe('5. the four doors pass the evidence through', () => {
  const FIELDS = [
    'outputKind',
    'modelFingerprints',
    'containerMachineManifestHash',
    'containerMachineManifest',
    'imageFilename',
  ];

  test('/api/generate (sync) names every field', () => {
    const src = read('app/api/generate/route.ts');
    for (const f of FIELDS) assert.ok(src.includes(`${f}:`), `/api/generate drops ${f}`);
  });

  test('/api/generate/status (the door CanvasBridge polls) names every field', () => {
    const src = read('app/api/generate/status/route.ts');
    for (const f of FIELDS) assert.ok(src.includes(`${f}:`), `/api/generate/status drops ${f}`);
  });

  test('/api/runs — both the sync and the async half pass the manifest', () => {
    const src = read('lib/runs/execute.ts');
    const hits = src.match(/containerMachineManifestHash:/g) ?? [];
    assert.equal(hits.length, 2, 'executeRun and pollRunJob must both pass it');
  });

  test('the async result TYPE declares the manifest, or no caller could pass it', () => {
    // The field was on the wire from the runner and absent from
    // WorkflowStatusDone.result, so the async path could not have passed
    // it without a type change. That is how a computed value ends up with
    // zero consumers.
    const src = read('lib/compute/modal.ts');
    assert.ok(src.includes('container_machine_manifest_hash?: string | null;'));
    assert.ok(src.includes('container_machine_manifest?: Record<string, unknown> | null;'));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. The C2PA signer has a caller, and it is OFF
// ═══════════════════════════════════════════════════════════════════════

describe('6. the signer call site', () => {
  test('it is wired and reports itself disabled — not silent', async () => {
    const r = await ingestOne({});
    assert.equal(r.c2pa.status, 'disabled');
    assert.match(r.c2pa.reason, /SCRUPLE_C2PA_SIGN_ON_INGEST/);
  });

  test('off by default, and only one env var turns it on', () => {
    assert.equal(M.signOnIngest.signOnIngestEnabled(), false);
    assert.equal(M.signOnIngest.SIGN_ON_INGEST_FLAG, 'SCRUPLE_C2PA_SIGN_ON_INGEST');
    // No second signing path: the call site imports the SAME signAsset()
    // that /api/scruple/c2pa/sign uses.
    const src = read('lib/iterations/signOnIngest.ts');
    assert.ok(src.includes("import('@/lib/c2pa/signAsset')"));
    assert.equal((src.match(/spawn\(/g) ?? []).length, 0, 'a second signer subprocess appeared');
  });

  test('an unsignable container is refused by the SERVER’s own answer', async () => {
    process.env.SCRUPLE_C2PA_SIGN_ON_INGEST = '1';
    try {
      // video/webm is excluded from C2PA_SIGNABLE, from the signer's
      // GENERATE_MIMES and from c2pa 0.36's own supported list. A demo that
      // emits webm gets a correct refusal and no credential.
      const r = await ingestOne({ outputKind: 'video', imageContentType: 'video/webm' });
      assert.equal(r.c2pa.status, 'unsupported_media');
      assert.ok(r.c2pa.reason.length > 0, 'a refusal with no reason reads as a bug');
    } finally {
      delete process.env.SCRUPLE_C2PA_SIGN_ON_INGEST;
    }
  });
});
