# Provenance bundle — iteration 176

Generated 2026-09-02T06:21:06.920Z by `scripts/build-demo-bundle.mjs`.
Every hash in this file was computed from the bytes shipped beside it.

| | |
|---|---|
| Asset | `artifact.mp4` — video/mp4, 109,027 bytes |
| SHA-256 | `f3c02a206dae45fb83795c459e3c1b9bbd0f5677380bdcd585a902e0f020b7f0` |
| Leaf | `a9d926c47c60f35204101a8d12f23da16dcbbf0afeedb3342b43094fd34b54a4` (v2.2, kind `workflow`) |
| Witness | `wit_c994deef93726fb9` at 2026-09-02T05:43:29.098Z |
| Credential | `artifact.mp4.c2pa`, SHA-256 `4731822d43ca686a7ecfb91b03118442e75fdb11b393a5545b5e79c091b16787` |

## What this proves, and what it does not

The leaf binds five hashes: the content, the inputs, the workflow, the model
fingerprints, and the machine manifest. `machine_manifest_hash` is the
container's own measurement of its toolchain, taken BEFORE the application
booted, so it is reproducible by anyone who pulls the same image.

The credential is signed by the DEVELOPMENT certificate. It validates to
`Valid` with the single code `signingCredential.untrusted` — expected, because
the dev CA is deliberately not in c2pa's trust list. That is a statement about
the CA, not about the signature.

This bundle is a receipt for ONE run. It does not assert anything about the
model's training data beyond the fingerprints recorded here.

## How to verify — every command runs from THIS directory

```bash
# 0. you are here. No cd is needed and none is given: an instruction naming a
#    directory that does not exist is where a reviewer stops.

# 1. re-hash every shipped file against the manifest
sha256sum -c MANIFEST.sha256          # expect: every line OK

# 2. confirm the asset is the artifact the leaf commits to.
#    THIS IS THE ARTIFACT'S OWN HASH, not the base model's.
sha256sum artifact.mp4
#    expect: f3c02a206dae45fb83795c459e3c1b9bbd0f5677380bdcd585a902e0f020b7f0
python3 -c "import json;print(json.load(open('leaf.json'))['content_hash'])"
#    the two must match

# 3. validate the content credential
python3 verify-c2pa-reader.py artifact.mp4.c2pa
#    expect: "validation_state": "Valid", codes ["signingCredential.untrusted"]

# 4. confirm the credential points AT this leaf rather than merely
#    accompanying it
python3 - <<'EOF'
import c2pa, json
with open("artifact.mp4.c2pa", "rb") as f:
    with c2pa.Reader("video/mp4", f) as r:
        d = json.loads(r.json())
am = d["manifests"][d["active_manifest"]]
prov = [a for a in am["assertions"] if a["label"] == "ai.scruple.provenance"][0]
leaf = json.load(open("leaf.json"))
assert prov["data"]["leaf_hash"] == leaf["leaf_hash"], "credential names a different leaf"
print("credential binds leaf", prov["data"]["leaf_hash"])
EOF

# 5. re-derive the machine manifest hash from the manifest shipped here
python3 -c "
import json, hashlib
m = json.load(open('container_machine_manifest.json'))
c = json.dumps(m, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
print('recomputed:', hashlib.sha256(c.encode()).hexdigest())
print('recorded  :', json.load(open('leaf.json'))['machine_manifest_hash'])
"
#    the two must match

# 6. re-derive the workflow hash (RFC 8785 / JCS, profile jcs-1)
python3 -c "
import json, hashlib
w = json.load(open('workflow_api.json'))
c = json.dumps(w, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
print('recomputed:', hashlib.sha256(c.encode()).hexdigest())
print('recorded  :', json.load(open('leaf.json'))['workflow_hash'])
"
#    the two must match
```

## Files

- `artifact.mp4`
- `artifact.mp4.c2pa`
- `container_machine_manifest.json`
- `inputs/puff-input.png`
- `leaf.json`
- `model_fingerprints.json`
- `verify-c2pa-reader.py`
- `witness-record.json`
- `workflow_api.json`
- `MANIFEST.sha256` — sha256 of every file above
- `README.md` — this file
