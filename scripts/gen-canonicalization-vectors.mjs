// Generate test/vectors/canonicalization-vectors.json.
//
//   node --import tsx scripts/gen-canonicalization-vectors.mjs
//
// WHY THE INPUTS ARE JSON *TEXT* AND NOT JSON VALUES
//
// The whole failure this file guards against is two languages holding the
// SAME DOCUMENT and computing different hashes for it. A vector file whose
// inputs were JSON values could not express the interesting half of that:
// JavaScript cannot write down a value distinguishable from `1` that Python
// reads as `1.0`, because JavaScript has no such value. Encoding each case as
// the raw document text and letting each language run its own parser is the
// only shape that reproduces the field condition — and it is also what an
// auditor actually has: a file, not a heap.
//
// Consequences worth stating, because they are the point rather than an
// inconvenience:
//
//   * `1.0` parses to a JS number and a Python float and MUST canonicalize to
//     `1` on both sides. That is JCS's type collapse, asserted rather than
//     assumed.
//   * `9007199254740993` parses EXACTLY in Python and LOSSILY in JavaScript.
//     No agreement is possible, so the case is marked `python_refuses` and
//     each suite asserts its own side's behaviour. A vector that demanded
//     agreement here would be a vector demanding a lie.
//
// The `canonical` and `sha256` fields are emitted from the TypeScript
// implementation. Python reproduces them. Same division of labour as
// test/vectors/ratchet-vectors.json and component-preimage-vectors.json.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  canonicalize,
  hashWorkflow,
  hashWorkflowInsertionOrder,
  CanonicalizationError,
} from '../lib/leaf/canonicalJson.ts';

const OUT = path.join(process.cwd(), 'test', 'vectors', 'canonicalization-vectors.json');

/**
 * Each case is `{name, why, json}` plus at most one of:
 *   refused        — both languages must refuse, with this reason code
 *   python_refuses — JS answers, Python refuses; the asymmetry is the finding
 */
const CASES = [
  // ── the reported bug ────────────────────────────────────────────────
  {
    name: 'learning rate 1e-5',
    why: 'WO-20 §6. JS JSON.stringify says 0.00001, Python json.dumps says 1e-05. The single most ordinary value in a training recipe.',
    json: '{"learning_rate":1e-5}',
  },
  {
    name: 'learning rate 5e-6',
    why: 'The other rate everyone uses. JS 0.000005, Python 5e-06.',
    json: '{"learning_rate":5e-6}',
  },
  {
    name: 'learning rate 1e-4 — the one that already agreed',
    why: 'Both languages say 0.0001. Included so the suite fails if a "fix" breaks the cases that were never broken.',
    json: '{"learning_rate":1e-4}',
  },
  {
    name: 'exponent padding at 1e-7',
    why: 'Both switch to exponential here, and STILL disagree: JS 1e-7, Python 1e-07. Two-digit exponent padding is a second, independent divergence from the fixed/exponential threshold.',
    json: '{"eps":1e-7}',
  },
  // ── the canvas path, not training ───────────────────────────────────
  {
    name: 'ComfyUI denoise 1.0 and cfg 8.0',
    why: 'The live cross-path case. A generation graph carries integral-valued floats; JS renders 1, Python renders 1.0. docs/provenance-bundles/bundle-29e9a40e1d43/iterations/video-1/workflow_api.json has cfg 3.0 today.',
    json: '{"cfg":8.0,"denoise":1.0,"seed":12345,"steps":20}',
  },
  {
    name: 'int and float spelled differently for the same number',
    why: 'JCS §3.2.2.3 makes every JSON number a double, so these MUST collapse. Python is the side that has to be told; JavaScript cannot do otherwise.',
    json: '{"a":1,"b":1.0,"c":1e0,"d":1.00}',
  },
  // ── magnitude thresholds ────────────────────────────────────────────
  {
    name: 'fixed/exponential threshold above',
    why: 'JS stays fixed until 1e21; Python switches at 1e16. Every value in this range diverged.',
    json: '{"a":1e15,"b":1e16,"c":1e20,"d":1e21,"e":1e22}',
  },
  {
    name: 'fixed/exponential threshold below',
    why: 'JS stays fixed down to 1e-6; Python switches at 1e-4.',
    json: '{"a":1e-3,"b":1e-4,"c":1e-5,"d":1e-6,"e":1e-7}',
  },
  {
    name: 'negative zero',
    why: 'JS renders 0, Python renders -0.0. ECMA-262 Number::toString drops the sign and JCS follows it, so the canonical form is 0 and the distinction is not committed to.',
    json: '{"a":-0.0,"b":0.0,"c":0,"d":-0}',
  },
  {
    name: 'double extremes',
    why: 'Largest finite, smallest subnormal, and the boundary either side of it. These agreed already; they are here so a hand-rolled formatter cannot pass by handling only the easy range.',
    json: '{"a":1.7976931348623157e308,"b":5e-324,"c":1e-323,"d":2.2250738585072014e-308}',
  },
  {
    name: 'repeating fraction',
    why: 'Shortest round-trip digits. Both languages already agree; the ECMAScript formatter must not lengthen or shorten them.',
    json: '{"a":0.1,"b":0.3,"c":0.3333333333333333,"d":-1.5,"e":100.5}',
  },
  {
    name: 'safe integer boundary',
    why: '2^53 is exactly representable and must pass. 2^53-1 is the last SAFE integer.',
    json: '{"a":9007199254740991,"b":9007199254740992,"c":-9007199254740992}',
  },
  // ── keys and strings ────────────────────────────────────────────────
  {
    name: 'astral-plane key ordering',
    why: 'JCS §3.2.3 sorts by UTF-16 CODE UNIT, so U+1F600 (surrogate pair, first unit 0xD83D) sorts BEFORE U+E000 and U+FFFD. Python sorted() is a code-point sort and puts it after. This is the H-4 §10 C-1 trap, arriving in a second preimage.',
    json: '{"\\ud83d\\ude00":1,"\\ue000":2,"\\ufffd":3,"a":4,"Z":5}',
  },
  {
    name: 'non-ASCII string values',
    why: 'JCS leaves them literal in UTF-8. Python json.dumps escapes by default (ensure_ascii=True) and would diverge on every accented prompt.',
    json: '{"prompt":"h\\u00e9llo \\u2603 \\ud834\\udd1e caf\\u00e9"}',
  },
  {
    name: 'control characters and structural escapes',
    why: 'JCS §3.2.2.2: five named escapes, lowercase \\u00hh below 0x20, and DEL left literal. The DEL is the one Python gets wrong under ensure_ascii=True.',
    json: '{"s":"a\\u0000b\\u0008c\\u0009d\\u000ae\\u000cf\\u000dg\\u001fh\\u007fi\\"j\\\\k/l"}',
  },
  {
    name: 'key sort is not insertion order',
    why: 'The property the original implementation did get right, pinned so the RFC adoption cannot lose it.',
    json: '{"z":1,"a":2,"M":3,"_":4,"0":5,"":6}',
  },
  {
    name: 'nested and array order preserved',
    why: 'ComfyUI wiring tuples are positional. Arrays must NOT be sorted; objects inside them must be.',
    json: '{"3":{"inputs":{"model":["4",0],"seed":1000,"cfg":7.0},"class_type":"KSampler"},"4":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"v1-5.safetensors"}}}',
  },
  {
    name: 'empty containers and null',
    why: 'Degenerate shapes. sha256 of {} is the value four real leaf rows carry.',
    json: '{"a":{},"b":[],"c":null,"d":[[],{}],"e":""}',
  },
  {
    name: 'the empty object',
    why: 'Whole-document degenerate case.',
    json: '{}',
  },
  {
    name: 'a bare scalar document',
    why: 'canonicalize() takes any JSON value, not only an object.',
    json: '1e-5',
  },
  // ── refusals ────────────────────────────────────────────────────────
  {
    name: 'integer beyond the double range',
    why: 'THE ONE CASE WHERE AGREEMENT IS IMPOSSIBLE. Python parses 9007199254740993 exactly; JavaScript parses it to ...992 and its canonicalizer cannot know. Python refuses; JavaScript answers for a document it no longer holds. Recorded as an asymmetry rather than smoothed over.',
    json: '{"n":9007199254740993}',
    python_refuses: 'integer_out_of_double_range',
  },
  {
    name: 'huge integer literal',
    why: 'Same class, far past the boundary, where the JS answer is visibly not the document.',
    json: '{"n":123456789012345678901234567890}',
    python_refuses: 'integer_out_of_double_range',
  },
];

// Cases that cannot be written as JSON text at all — NaN, Infinity,
// undefined, a Date — because they are not JSON. They are supplied as a
// builder so the TypeScript suite can still assert the refusal, and are
// described here so the Python suite can assert the same reason codes from
// its own equivalents.
const NON_JSON_REFUSALS = [
  { name: 'NaN', reason: 'non_finite_number', legacy: '{"lr":null}' },
  { name: 'Infinity', reason: 'non_finite_number', legacy: '{"lr":null}' },
  { name: 'undefined value', reason: 'undefined_value', legacy: '{"a":undefined,"b":1}' },
  { name: 'sparse array hole', reason: 'sparse_array', legacy: '{"a":[1,,2]}' },
  { name: 'Date instance', reason: 'not_a_plain_object', legacy: '{"t":{}}' },
];

// ── Backward compatibility: leaves that already exist ──────────────────
//
// A hash frozen here was produced by the PRE-WO-21 implementation
// (`git show 257b942:lib/scruple/canonicalWorkflow.ts`), not by the code
// under test. That is the whole point: if the RFC 8785 adoption had changed
// one byte of output for a real document, this list would stop matching and
// the "no leaf scheme bump was needed" claim would be false.
//
// Two provenances, deliberately:
//   * `db_leaf` — the workflow_api_json out of a row in data/scruple.db that
//     carries a witnessed `workflow_hash`. An actual shipped leaf.
//   * `bundle` — the graphs in docs/provenance-bundles/bundle-29e9a40e1d43,
//     including video-1, which is the file that PROVES the bug is on the
//     canvas path: it carries `"cfg": 3.0` and its Python and JavaScript
//     hashes differed before this change.
const LEGACY_LEAVES = [
  {
    name: 'iterations.id=171 — witnessed canvas leaf, SD1.5 txt2img',
    provenance: 'db_leaf',
    note: 'workflow_hash as stored in data/scruple.db. Reproduced by the shipped TypeScript before WO-21 and required to reproduce after it.',
    json: '{"3":{"class_type":"KSampler","inputs":{"seed":1000,"steps":20,"cfg":7,"sampler_name":"euler","scheduler":"normal","denoise":1,"model":["4",0],"positive":["6",0],"negative":["7",0],"latent_image":["5",0]}},"4":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"v1-5-pruned-emaonly.safetensors"}},"5":{"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512,"batch_size":1}},"6":{"class_type":"CLIPTextEncode","inputs":{"text":"a photo of a cat on a sailboat","clip":["4",1]}},"7":{"class_type":"CLIPTextEncode","inputs":{"text":"blurry, low quality","clip":["4",1]}},"8":{"class_type":"VAEDecode","inputs":{"samples":["3",0],"vae":["4",2]}},"9":{"class_type":"SaveImage","inputs":{"filename_prefix":"iter1","images":["8",0]}}}',
    legacy_sha256: '1945bf77e10ed6d03f794a35612a5df896ceecaa1d47d01434294535a741c986',
  },
  {
    name: 'iterations.id=165 — the empty graph',
    provenance: 'db_leaf',
    note: 'sha256("{}"). Four real rows carry it. Degenerate and still a commitment.',
    json: '{}',
    legacy_sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  },
  ...[
    ['1', 'ff07cc3797616c0b2494d40fdae28bfaea2087bfc8b8b909a4cfabcfdaf8b94f'],
    ['2', '9edc0743bc0da81cb28994771965054c3a770320b5cbf61a54b4fab8fa2d3b0c'],
    ['3', 'a35bdc3abff64a1edfd0a870a38d99e72e80a93543d4e0577c93aa8d60571123'],
    ['4', 'b950f4e281beaaf8095faff254b8c2618c0906c38878007fff40bfeec68920cc'],
    ['5', 'f9d4b0764eca6794b581083dde6e7e569c904f53c7a7b875ad1c5fce46a353bd'],
    ['video-1', 'd39a015eb81b7af7a29f9e266dcbcbd4604df1cb6baab79e3e0ed756e72c0ee3'],
  ].map(([it, h]) => ({
    name: `provenance bundle 29e9a40e1d43, iteration ${it}`,
    provenance: 'bundle',
    note:
      it === 'video-1'
        ? 'THE ONE THAT PROVES THE BUG IS NOT TRAINING-SPECIFIC. Carries "cfg": 3.0. Before WO-21 JavaScript hashed it to d39a015e… and Python to 40fbeb04…, for the same file, with nothing anywhere to say so.'
        : 'Shipped ComfyUI graph. Integers and strings only, which is why the canvas path mostly got away with it.',
    file: `docs/provenance-bundles/bundle-29e9a40e1d43/iterations/${it}/workflow_api.json`,
    legacy_sha256: h,
  })),
  // ── The older break, found while looking for this one ──────────────
  // Four rows whose workflow_hash predates ec188d6 (2026-07-13, "WO-A2
  // canonical workflow_hash"). They are replayable ONLY under
  // insertion-order-1, and their leaf_scheme does not say so. Carried
  // here so the whole corpus stays reproducible and so the next person
  // to change a preimage rule sees what an unversioned change costs.

    {
      "name": "iterations.id=166 — pre-WO-A2 canvas leaf (2026-07-05)",
      "provenance": "db_leaf",
      "profile": "insertion-order-1",
      "note": "PRE-WO-A2. Written 2026-07-05, eight days before ec188d6 made workflow_hash canonical. Its input_hash reproduces exactly from the same stored spec, which proves the document is intact and the FORMULA changed. leaf_scheme says v2.2, identical to the rows written after the change, so nothing in the record says which rule to replay.",
      "json": "{\"6\":{\"class_type\":\"CLIPTextEncode\",\"inputs\":{\"text\":\"Stay Puft Marshmallow Man walking through Burning Man, cyberpunk aesthetic, neon lights, holographic advertising above the desert playa, dust storm at sunset\",\"clip\":[\"11\",0]}},\"8\":{\"class_type\":\"VAEDecode\",\"inputs\":{\"samples\":[\"13\",0],\"vae\":[\"10\",0]}},\"9\":{\"class_type\":\"SaveImage\",\"inputs\":{\"images\":[\"8\",0],\"filename_prefix\":\"staypuft-2\"}},\"10\":{\"class_type\":\"VAELoader\",\"inputs\":{\"vae_name\":\"ae.safetensors\"}},\"11\":{\"class_type\":\"DualCLIPLoader\",\"inputs\":{\"clip_name1\":\"t5xxl_fp8_e4m3fn.safetensors\",\"clip_name2\":\"clip_l.safetensors\",\"type\":\"flux\"}},\"12\":{\"class_type\":\"UNETLoader\",\"inputs\":{\"unet_name\":\"flux1-dev-fp8.safetensors\",\"weight_dtype\":\"fp8_e4m3fn\"}},\"13\":{\"class_type\":\"SamplerCustomAdvanced\",\"inputs\":{\"noise\":[\"25\",0],\"guider\":[\"22\",0],\"sampler\":[\"16\",0],\"sigmas\":[\"17\",0],\"latent_image\":[\"27\",0]}},\"16\":{\"class_type\":\"KSamplerSelect\",\"inputs\":{\"sampler_name\":\"euler\"}},\"17\":{\"class_type\":\"BasicScheduler\",\"inputs\":{\"scheduler\":\"simple\",\"steps\":20,\"denoise\":1,\"model\":[\"12\",0]}},\"22\":{\"class_type\":\"BasicGuider\",\"inputs\":{\"model\":[\"12\",0],\"conditioning\":[\"26\",0]}},\"25\":{\"class_type\":\"RandomNoise\",\"inputs\":{\"noise_seed\":43}},\"26\":{\"class_type\":\"FluxGuidance\",\"inputs\":{\"guidance\":3.5,\"conditioning\":[\"6\",0]}},\"27\":{\"class_type\":\"EmptySD3LatentImage\",\"inputs\":{\"width\":1024,\"height\":1024,\"batch_size\":1}}}",
      "legacy_sha256": "32214ac0875334797e1eddc6ec10b7d650e44c7c445c57cc6610ace9d0c613c6"
    },
    {
      "name": "iterations.id=167 — pre-WO-A2 canvas leaf (2026-07-05)",
      "provenance": "db_leaf",
      "profile": "insertion-order-1",
      "note": "Same run, same profile. All four are one sequence.",
      "json": "{\"6\":{\"class_type\":\"CLIPTextEncode\",\"inputs\":{\"text\":\"Stay Puft Marshmallow Man walking through Burning Man, cyberpunk aesthetic, neon lights, holographic advertising above the desert playa, dust storm at sunset, giant metal art installations with LED strips glowing purple and cyan\",\"clip\":[\"11\",0]}},\"8\":{\"class_type\":\"VAEDecode\",\"inputs\":{\"samples\":[\"13\",0],\"vae\":[\"10\",0]}},\"9\":{\"class_type\":\"SaveImage\",\"inputs\":{\"images\":[\"8\",0],\"filename_prefix\":\"staypuft-3\"}},\"10\":{\"class_type\":\"VAELoader\",\"inputs\":{\"vae_name\":\"ae.safetensors\"}},\"11\":{\"class_type\":\"DualCLIPLoader\",\"inputs\":{\"clip_name1\":\"t5xxl_fp8_e4m3fn.safetensors\",\"clip_name2\":\"clip_l.safetensors\",\"type\":\"flux\"}},\"12\":{\"class_type\":\"UNETLoader\",\"inputs\":{\"unet_name\":\"flux1-dev-fp8.safetensors\",\"weight_dtype\":\"fp8_e4m3fn\"}},\"13\":{\"class_type\":\"SamplerCustomAdvanced\",\"inputs\":{\"noise\":[\"25\",0],\"guider\":[\"22\",0],\"sampler\":[\"16\",0],\"sigmas\":[\"17\",0],\"latent_image\":[\"27\",0]}},\"16\":{\"class_type\":\"KSamplerSelect\",\"inputs\":{\"sampler_name\":\"euler\"}},\"17\":{\"class_type\":\"BasicScheduler\",\"inputs\":{\"scheduler\":\"simple\",\"steps\":20,\"denoise\":1,\"model\":[\"12\",0]}},\"22\":{\"class_type\":\"BasicGuider\",\"inputs\":{\"model\":[\"12\",0],\"conditioning\":[\"26\",0]}},\"25\":{\"class_type\":\"RandomNoise\",\"inputs\":{\"noise_seed\":44}},\"26\":{\"class_type\":\"FluxGuidance\",\"inputs\":{\"guidance\":3.5,\"conditioning\":[\"6\",0]}},\"27\":{\"class_type\":\"EmptySD3LatentImage\",\"inputs\":{\"width\":1024,\"height\":1024,\"batch_size\":1}}}",
      "legacy_sha256": "4adf01b691680028ec90f808842ae34d81acf244f17edfce6922844a2ec3e671"
    },
    {
      "name": "iterations.id=168 — pre-WO-A2 canvas leaf (2026-07-05)",
      "provenance": "db_leaf",
      "profile": "insertion-order-1",
      "note": "Same run, same profile. All four are one sequence.",
      "json": "{\"6\":{\"class_type\":\"CLIPTextEncode\",\"inputs\":{\"text\":\"Stay Puft Marshmallow Man walking through Burning Man, cyberpunk aesthetic, neon lights, holographic advertising above the desert playa, dust storm at sunset, giant metal art installations with LED strips glowing purple and cyan, thousands of costumed festival attendees in silhouette\",\"clip\":[\"11\",0]}},\"8\":{\"class_type\":\"VAEDecode\",\"inputs\":{\"samples\":[\"13\",0],\"vae\":[\"10\",0]}},\"9\":{\"class_type\":\"SaveImage\",\"inputs\":{\"images\":[\"8\",0],\"filename_prefix\":\"staypuft-4\"}},\"10\":{\"class_type\":\"VAELoader\",\"inputs\":{\"vae_name\":\"ae.safetensors\"}},\"11\":{\"class_type\":\"DualCLIPLoader\",\"inputs\":{\"clip_name1\":\"t5xxl_fp8_e4m3fn.safetensors\",\"clip_name2\":\"clip_l.safetensors\",\"type\":\"flux\"}},\"12\":{\"class_type\":\"UNETLoader\",\"inputs\":{\"unet_name\":\"flux1-dev-fp8.safetensors\",\"weight_dtype\":\"fp8_e4m3fn\"}},\"13\":{\"class_type\":\"SamplerCustomAdvanced\",\"inputs\":{\"noise\":[\"25\",0],\"guider\":[\"22\",0],\"sampler\":[\"16\",0],\"sigmas\":[\"17\",0],\"latent_image\":[\"27\",0]}},\"16\":{\"class_type\":\"KSamplerSelect\",\"inputs\":{\"sampler_name\":\"euler\"}},\"17\":{\"class_type\":\"BasicScheduler\",\"inputs\":{\"scheduler\":\"simple\",\"steps\":20,\"denoise\":1,\"model\":[\"12\",0]}},\"22\":{\"class_type\":\"BasicGuider\",\"inputs\":{\"model\":[\"12\",0],\"conditioning\":[\"26\",0]}},\"25\":{\"class_type\":\"RandomNoise\",\"inputs\":{\"noise_seed\":45}},\"26\":{\"class_type\":\"FluxGuidance\",\"inputs\":{\"guidance\":3.5,\"conditioning\":[\"6\",0]}},\"27\":{\"class_type\":\"EmptySD3LatentImage\",\"inputs\":{\"width\":1024,\"height\":1024,\"batch_size\":1}}}",
      "legacy_sha256": "8263819a1d835543b3f3e77e8b5a770de776beea7d982f8bf2af0b0765d65256"
    },
    {
      "name": "iterations.id=169 — pre-WO-A2 canvas leaf (2026-07-05)",
      "provenance": "db_leaf",
      "profile": "insertion-order-1",
      "note": "Same run, same profile. All four are one sequence.",
      "json": "{\"6\":{\"class_type\":\"CLIPTextEncode\",\"inputs\":{\"text\":\"Stay Puft Marshmallow Man walking through Burning Man, cyberpunk aesthetic, neon lights, holographic advertising above the desert playa, dust storm at sunset, giant metal art installations with LED strips glowing purple and cyan, thousands of costumed festival attendees in silhouette, cinematic wide-angle shot with volumetric lighting and film grain\",\"clip\":[\"11\",0]}},\"8\":{\"class_type\":\"VAEDecode\",\"inputs\":{\"samples\":[\"13\",0],\"vae\":[\"10\",0]}},\"9\":{\"class_type\":\"SaveImage\",\"inputs\":{\"images\":[\"8\",0],\"filename_prefix\":\"staypuft-5\"}},\"10\":{\"class_type\":\"VAELoader\",\"inputs\":{\"vae_name\":\"ae.safetensors\"}},\"11\":{\"class_type\":\"DualCLIPLoader\",\"inputs\":{\"clip_name1\":\"t5xxl_fp8_e4m3fn.safetensors\",\"clip_name2\":\"clip_l.safetensors\",\"type\":\"flux\"}},\"12\":{\"class_type\":\"UNETLoader\",\"inputs\":{\"unet_name\":\"flux1-dev-fp8.safetensors\",\"weight_dtype\":\"fp8_e4m3fn\"}},\"13\":{\"class_type\":\"SamplerCustomAdvanced\",\"inputs\":{\"noise\":[\"25\",0],\"guider\":[\"22\",0],\"sampler\":[\"16\",0],\"sigmas\":[\"17\",0],\"latent_image\":[\"27\",0]}},\"16\":{\"class_type\":\"KSamplerSelect\",\"inputs\":{\"sampler_name\":\"euler\"}},\"17\":{\"class_type\":\"BasicScheduler\",\"inputs\":{\"scheduler\":\"simple\",\"steps\":20,\"denoise\":1,\"model\":[\"12\",0]}},\"22\":{\"class_type\":\"BasicGuider\",\"inputs\":{\"model\":[\"12\",0],\"conditioning\":[\"26\",0]}},\"25\":{\"class_type\":\"RandomNoise\",\"inputs\":{\"noise_seed\":46}},\"26\":{\"class_type\":\"FluxGuidance\",\"inputs\":{\"guidance\":3.5,\"conditioning\":[\"6\",0]}},\"27\":{\"class_type\":\"EmptySD3LatentImage\",\"inputs\":{\"width\":1024,\"height\":1024,\"batch_size\":1}}}",
      "legacy_sha256": "c41d99c21e711847e3f2d9a98685573a11647b7b8681a8a500122913bd2ed506"
    },
];

const cases = [];
for (const c of CASES) {
  const doc = JSON.parse(c.json);
  const entry = { name: c.name, why: c.why, json: c.json };
  if (c.python_refuses) entry.python_refuses = c.python_refuses;
  try {
    entry.canonical = canonicalize(doc);
    entry.sha256 = hashWorkflow(doc);
  } catch (e) {
    if (!(e instanceof CanonicalizationError)) throw e;
    entry.js_refuses = e.reason;
  }
  cases.push(entry);
}

// The generator itself refuses to emit a vector file that would quietly
// invalidate history. Asserting here as well as in the test suites is
// deliberate: a regenerate is exactly when someone is least likely to read
// the diff.
const legacy = [];
for (const l of LEGACY_LEAVES) {
  const doc = JSON.parse(l.json ?? fs.readFileSync(path.join(process.cwd(), l.file), 'utf8'));
  const now =
    l.profile === 'insertion-order-1' ? hashWorkflowInsertionOrder(doc) : hashWorkflow(doc);
  if (now !== l.legacy_sha256) {
    throw new Error(
      `REFUSING TO WRITE VECTORS. "${l.name}" hashed ${l.legacy_sha256} under the ` +
        `pre-WO-21 implementation and hashes ${now} now. That is a leaf-scheme ` +
        `bump, not an edit: every leaf carrying the old value stops verifying. ` +
        `See docs/canon/CANONICALIZATION.md §4.`,
    );
  }
  legacy.push(l);
}

const out = {
  $schema_note:
    'Shared cross-language vectors for the workflow_hash canonicalization (RFC 8785). Inputs are raw JSON DOCUMENT TEXT, parsed by each language with its own parser, because the failure being guarded against is two languages holding one document. Generated from lib/leaf/canonicalJson.ts; consumed by test/v2/canonicalization.test.ts and packages/scruple-host-sdk/tests/test_canonicalization.py. Regenerate with `node --import tsx scripts/gen-canonicalization-vectors.mjs`.',
  spec: 'RFC 8785 §3.2.2.2, §3.2.2.3, §3.2.3; docs/canon/CANONICALIZATION.md',
  profile: 'jcs-1',
  generated_by: 'scripts/gen-canonicalization-vectors.mjs',
  cases,
  non_json_refusals: NON_JSON_REFUSALS,
  legacy_leaves: legacy,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(
  `wrote ${OUT}: ${cases.length} document cases, ${NON_JSON_REFUSALS.length} non-JSON refusals, ` +
    `${legacy.length} pre-WO-21 leaves reproduced unchanged`,
);
console.log('sha256 of the file:', createHash('sha256').update(fs.readFileSync(OUT)).digest('hex'));
