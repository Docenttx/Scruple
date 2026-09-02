#!/usr/bin/env node
// build-demo-bundle.mjs — WO-36.
//
// Assembles one artifact a stranger can verify: the asset, its leaf, its
// witness record, its C2PA credential, and a README whose commands RUN.
//
// The bundle is built from the database and the artifact store, never from
// prose. Every hash printed in the README is computed here from the bytes
// being shipped, so the README cannot drift from the files beside it — which
// is exactly how F-01 happened (three documents printed the base model's hash
// as the artifact's, inside the `sha256sum` step a reviewer is told to run).
//
//   node scripts/build-demo-bundle.mjs <iterationId> [outDir]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const iterationId = Number(process.argv[2]);
if (!iterationId) { console.error('usage: build-demo-bundle.mjs <iterationId> [outDir]'); process.exit(2); }
const REPO = process.cwd();
const outDir = process.argv[3] ?? path.join(REPO, 'docs/provenance-bundles', `bundle-iter${iterationId}`);

const db = new Database(path.join(REPO, 'data/scruple.db'), { readonly: true });
const it = db.prepare('SELECT * FROM iterations WHERE id = ?').get(iterationId);
if (!it) { console.error(`no iteration ${iterationId}`); process.exit(1); }
const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(it.project_id);

let wit = null;
try {
  const wdb = new Database('/opt/scruple-witness/witness.db', { readonly: true });
  wit = wdb.prepare('SELECT * FROM witnesses WHERE leaf_hash = ?').get(it.leaf_hash) ?? null;
  wdb.close();
} catch { /* witness DB not readable here; the bundle says so rather than pretending */ }

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const artifactPath = (h) => path.join(REPO, 'artifacts', h.slice(0, 2), h);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ── the asset, named by what it IS, not by its hash ───────────────────────
const ext = path.extname(it.image_filename ?? '') || '.bin';
const assetName = `artifact${ext}`;
const assetBytes = fs.readFileSync(artifactPath(it.output_hash));
fs.writeFileSync(path.join(outDir, assetName), assetBytes);

// ── the credential, if one was produced ───────────────────────────────────
let credName = null;
const credSrc = `${artifactPath(it.output_hash)}.c2pa`;
if (fs.existsSync(credSrc)) {
  credName = `${assetName}.c2pa`;
  fs.writeFileSync(path.join(outDir, credName), fs.readFileSync(credSrc));
}

// ── the inputs it was bound to ────────────────────────────────────────────
const inputs = JSON.parse(it.input_artifacts || '[]');
if (inputs.length) fs.mkdirSync(path.join(outDir, 'inputs'), { recursive: true });
for (const a of inputs) {
  const p = artifactPath(a.hash);
  if (fs.existsSync(p)) fs.writeFileSync(path.join(outDir, 'inputs', a.filename ?? a.hash), fs.readFileSync(p));
}

// ── the leaf: exactly the fields a verifier re-derives ────────────────────
const meta = JSON.parse(it.metadata || '{}');
const workflow = meta?.generationSpec?.providerExtras?.workflowApiJson ?? null;
if (workflow) fs.writeFileSync(path.join(outDir, 'workflow_api.json'), JSON.stringify(workflow, null, 1));
if (it.container_machine_manifest) {
  fs.writeFileSync(path.join(outDir, 'container_machine_manifest.json'), it.container_machine_manifest);
}
if (it.model_fingerprints) {
  fs.writeFileSync(path.join(outDir, 'model_fingerprints.json'), it.model_fingerprints);
}

const leaf = {
  iteration_id: it.id,
  project: { id: proj?.id ?? null, name: proj?.name ?? null },
  run_sequence: it.run_sequence,
  timestamp: it.timestamp,
  leaf_scheme: it.leaf_scheme,
  leaf_kind: it.leaf_kind,
  leaf_hash: it.leaf_hash,
  previous_hash: it.previous_hash || null,
  content_hash: it.output_hash,
  input_hash: it.input_hash,
  workflow_hash: it.workflow_hash,
  model_fingerprints_hash: it.model_fingerprints_hash,
  machine_manifest_hash: it.machine_manifest_hash,
  output_kind: it.output_kind,
  output_content_type: it.output_content_type,
  output_bytes: it.output_bytes,
  input_artifacts: inputs,
  execution_backend: it.execution_backend,
  witnessed: !!it.witnessed,
  witness_id: it.witness_id,
  witness_timestamp: it.witness_timestamp,
};
fs.writeFileSync(path.join(outDir, 'leaf.json'), JSON.stringify(leaf, null, 2));
fs.writeFileSync(
  path.join(outDir, 'witness-record.json'),
  JSON.stringify(wit ?? { note: 'witness database not readable from the build host; verify against the witness service instead' }, null, 2),
);

// ── the verifier itself ───────────────────────────────────────────────────
//
// The old bundle's step 2 read `python3 /path/to/scripts/verify-c2pa-reader.py`
// — the same class of defect as its `cd puffjuly12-…` into a directory that
// does not exist. A reviewer holding only the bundle has neither. Ship it.
const verifierSrc = path.join(REPO, 'scripts/verify-c2pa-reader.py');
if (fs.existsSync(verifierSrc)) {
  fs.writeFileSync(path.join(outDir, 'verify-c2pa-reader.py'), fs.readFileSync(verifierSrc));
}

// ── MANIFEST.sha256, over every file actually shipped ─────────────────────
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name !== 'MANIFEST.sha256' && e.name !== 'README.md') files.push(full);
  }
})(outDir);
const manifest = files
  .map((f) => `${sha(fs.readFileSync(f))}  ${path.relative(outDir, f)}`)
  .join('\n') + '\n';
fs.writeFileSync(path.join(outDir, 'MANIFEST.sha256'), manifest);

// ── README, GENERATED — every hash below is computed from the bytes above ──
//
// F-01 is the reason this is generated and not written. Three published
// documents printed the BASE MODEL's SHA-256 as the trained artifact's, and
// the worst instance was inside the `sha256sum` step a reviewer is explicitly
// told to run: following our own instructions produced a mismatch, which is
// the exact signature of tampering. Prose cannot drift from the artifact if
// prose is not where the number lives.
const assetSha = sha(assetBytes);
const credSha = credName ? sha(fs.readFileSync(path.join(outDir, credName))) : null;
const readme = `# Provenance bundle — iteration ${it.id}

Generated ${new Date().toISOString()} by \`scripts/build-demo-bundle.mjs\`.
Every hash in this file was computed from the bytes shipped beside it.

| | |
|---|---|
| Asset | \`${assetName}\` — ${it.output_content_type}, ${it.output_bytes.toLocaleString()} bytes |
| SHA-256 | \`${assetSha}\` |
| Leaf | \`${it.leaf_hash}\` (${it.leaf_scheme}, kind \`${it.leaf_kind}\`) |
| Witness | ${it.witnessed ? `\`${it.witness_id}\` at ${it.witness_timestamp}` : 'NOT witnessed'} |
| Credential | ${credName ? `\`${credName}\`, SHA-256 \`${credSha}\`` : 'none — this media type is not one Scruple signs'} |

## What this proves, and what it does not

The leaf binds five hashes: the content, the inputs, the workflow, the model
fingerprints, and the machine manifest. \`machine_manifest_hash\` is the
container's own measurement of its toolchain, taken BEFORE the application
booted, so it is reproducible by anyone who pulls the same image.

${credName ? `The credential is signed by the DEVELOPMENT certificate. It validates to
\`Valid\` with the single code \`signingCredential.untrusted\` — expected, because
the dev CA is deliberately not in c2pa's trust list. That is a statement about
the CA, not about the signature.` : ''}

This bundle is a receipt for ONE run. It does not assert anything about the
model's training data beyond the fingerprints recorded here.

## How to verify — every command runs from THIS directory

\`\`\`bash
# 0. you are here. No cd is needed and none is given: an instruction naming a
#    directory that does not exist is where a reviewer stops.

# 1. re-hash every shipped file against the manifest
sha256sum -c MANIFEST.sha256          # expect: every line OK

# 2. confirm the asset is the artifact the leaf commits to.
#    THIS IS THE ARTIFACT'S OWN HASH, not the base model's.
sha256sum ${assetName}
#    expect: ${assetSha}
python3 -c "import json;print(json.load(open('leaf.json'))['content_hash'])"
#    the two must match${credName ? `

# 3. validate the content credential
python3 verify-c2pa-reader.py ${credName}
#    expect: "validation_state": "Valid", codes ["signingCredential.untrusted"]

# 4. confirm the credential points AT this leaf rather than merely
#    accompanying it
python3 - <<'EOF'
import c2pa, json
with open("${credName}", "rb") as f:
    with c2pa.Reader("${it.output_content_type}", f) as r:
        d = json.loads(r.json())
am = d["manifests"][d["active_manifest"]]
prov = [a for a in am["assertions"] if a["label"] == "ai.scruple.provenance"][0]
leaf = json.load(open("leaf.json"))
assert prov["data"]["leaf_hash"] == leaf["leaf_hash"], "credential names a different leaf"
print("credential binds leaf", prov["data"]["leaf_hash"])
EOF` : ''}

# ${credName ? '5' : '3'}. re-derive the machine manifest hash from the manifest shipped here
python3 -c "
import json, hashlib
m = json.load(open('container_machine_manifest.json'))
c = json.dumps(m, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
print('recomputed:', hashlib.sha256(c.encode()).hexdigest())
print('recorded  :', json.load(open('leaf.json'))['machine_manifest_hash'])
"
#    the two must match

# ${credName ? '6' : '4'}. re-derive the workflow hash (RFC 8785 / JCS, profile jcs-1)
python3 -c "
import json, hashlib
w = json.load(open('workflow_api.json'))
c = json.dumps(w, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
print('recomputed:', hashlib.sha256(c.encode()).hexdigest())
print('recorded  :', json.load(open('leaf.json'))['workflow_hash'])
"
#    the two must match
\`\`\`

## Files

${files.map((f) => `- \`${path.relative(outDir, f)}\``).join('\n')}
- \`MANIFEST.sha256\` — sha256 of every file above
- \`README.md\` — this file
`;
fs.writeFileSync(path.join(outDir, 'README.md'), readme);

console.log(JSON.stringify({
  outDir,
  asset: assetName,
  assetSha256: sha(assetBytes),
  credential: credName,
  leafHash: it.leaf_hash,
  witnessed: !!it.witnessed,
  files: files.length,
}, null, 2));
