#!/usr/bin/env python3
"""Full-spectrum provenance audit across all 5 workflow modes.

For each project: re-derive every hash and the Merkle root from raw data
(no trust in the recorded fields), then cross-check against:
  (DB)      iterations row
  (WIT)     witness server row  (/opt/scruple-witness/witness.db)
  (HTML)    rendered /receipt/[scrId] page
  (LOG)     scruple-web + witness-server audit logs

Each check is independent: a pass means the corresponding step in the
process accurately reflects what we can reconstruct from first principles.
"""

import hashlib, json, sqlite3, sys, urllib.request, re, os, subprocess
from typing import Optional

WEB_DB  = '/data/scruple-web/data/scruple.db'
WIT_DB  = '/opt/scruple-witness/witness.db'
WEB_URL = 'http://127.0.0.1:3001'
DEV_LOG = '/tmp/scruple-dev.log'

def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

# Replicate JS JSON.stringify (compact, insertion order, raw UTF-8 — NOT
# \uXXXX-escaped). Python's default ensure_ascii=True diverges from Node
# on non-ASCII characters; ensure_ascii=False makes them byte-identical.
def canonical(obj) -> str:
    return json.dumps(obj, separators=(',', ':'), ensure_ascii=False)

# Replicate /data/scruple-web/lib/scruple/merkle.ts
def build_merkle(leaves):
    if not leaves: return None
    if len(leaves) == 1: return leaves[0]
    current = list(leaves)
    while len(current) > 1:
        if len(current) % 2 == 1:
            current.append(current[-1])
        nxt = []
        for i in range(0, len(current), 2):
            a, b = current[i], current[i+1]
            combined = a + b if a < b else b + a
            nxt.append(sha256_hex(combined.encode()))
        current = nxt
    return current[0]

# v2 canonical records (must match canonicalRecord*() in witness server).
# Three forms covering the migration history:
#   v2.0 — pre-017, no model_fingerprints_hash
#   v2.1 — adds model_fingerprints_hash between workflow_hash and server_timestamp
#   v2.2 — adds machine_manifest_hash between model_fingerprints_hash and server_timestamp
#          (Canvas v2 WO-8, 2026-06-22)
# Audit tries v2.2 → v2.1 → v2.0 in that order so any leaf reproduces.

def record_hash_v22(rec) -> str:
    """v2.2 — Canvas v2 adds machine_manifest_hash slot."""
    ordered = {
        'run_sequence':     rec['run_sequence'],
        'output_hash':      rec.get('output_hash') or '',
        'input_hash':       rec.get('input_hash')  or '',
        'workflow_hash':    rec.get('workflow_hash') or '',
        'model_fingerprints_hash': rec.get('model_fingerprints_hash') or '',
        'machine_manifest_hash':   rec.get('machine_manifest_hash') or '',
        'server_timestamp': rec['server_timestamp'],
        'prev_record_hash': rec.get('prev_record_hash') or '',
    }
    return sha256_hex(canonical(ordered).encode())

def record_hash_v21(rec) -> str:
    """v2.1 — model_fingerprints_hash sits between workflow_hash and server_timestamp."""
    ordered = {
        'run_sequence':     rec['run_sequence'],
        'output_hash':      rec.get('output_hash') or '',
        'input_hash':       rec.get('input_hash')  or '',
        'workflow_hash':    rec.get('workflow_hash') or '',
        'model_fingerprints_hash': rec.get('model_fingerprints_hash') or '',
        'server_timestamp': rec['server_timestamp'],
        'prev_record_hash': rec.get('prev_record_hash') or '',
    }
    return sha256_hex(canonical(ordered).encode())

def record_hash_v20(rec) -> str:
    """v2.0 — pre-migration-017 leaves had no model_fingerprints_hash field."""
    ordered = {
        'run_sequence':     rec['run_sequence'],
        'output_hash':      rec.get('output_hash') or '',
        'input_hash':       rec.get('input_hash')  or '',
        'workflow_hash':    rec.get('workflow_hash') or '',
        'server_timestamp': rec['server_timestamp'],
        'prev_record_hash': rec.get('prev_record_hash') or '',
    }
    return sha256_hex(canonical(ordered).encode())

def record_hash(rec):
    """Compatibility-trying entrypoint: returns (hash, protocol_version).
    Dispatches by stored leaf_scheme when available, else tries newest first."""
    scheme = rec.get('leaf_scheme')
    expected = rec.get('_expected')
    if scheme == 'v2.2':
        return record_hash_v22(rec), 'v2.2'
    if scheme == 'v2':
        # Stored as 'v2' but content may be v2.1 (with mf_hash) or v2.0 (without).
        h21 = record_hash_v21(rec)
        if expected and h21 == expected:
            return h21, 'v2.1'
        return record_hash_v20(rec), 'v2.0'
    # No stored scheme — fall back to "try newest first" heuristic.
    if rec.get('machine_manifest_hash'):
        h22 = record_hash_v22(rec)
        if expected and h22 == expected:
            return h22, 'v2.2'
    h21 = record_hash_v21(rec)
    if expected and h21 == expected:
        return h21, 'v2.1'
    return record_hash_v20(rec), 'v2.0'

def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return r.read()
    except Exception as e:
        return b''

# ── projects to audit ─────────────────────────────────────────────────────
# Each tuple: (label, project_id, expected_status). Statuses:
#   local_locked      → no on-chain anchors expected
#   persistent_locked → rvn + ipfs + arweave anchors all expected
MODE_PROJECTS = [
    ('LoRA training  [local]', 13, 'local_locked'),
    ('img2img        [local]', 14, 'local_locked'),
    ('txt2vid        [local]', 15, 'local_locked'),
    ('txt2img        [local]', 17, 'local_locked'),
    ('img2vid        [local]', 18, 'local_locked'),
    ('img2img        [chain]', 19, 'persistent_locked'),
    ('txt2img        [chain]', 20, 'persistent_locked'),
    ('txt2vid        [chain]', 21, 'persistent_locked'),
    ('img2vid        [chain]', 22, 'persistent_locked'),
    ('LoRA training  [chain]', 23, 'persistent_locked'),
    ('txt2img model-fp [LOCAL]', 24, 'local_locked'),  # smoke for M-3/M-4 (M-5)
    ('paid checkpoint+local [LOCAL]', 25, 'local_locked'),  # smoke for L-1..L-6
]

# Projects whose CI lock skipped the explicit /api/lock/checkpoint call
# (went straight from capture → local lock) so the [CHECKPOINT] log check
# should be relaxed. M-5 smoke fell into this.
SKIP_CHECKPOINT_LOG_FOR = {24}

webdb = sqlite3.connect(WEB_DB)
witdb = sqlite3.connect(WIT_DB)
webdb.row_factory = sqlite3.Row
witdb.row_factory = sqlite3.Row

# Load full dev-log + witness journal for log audit
try:
    devlog = open(DEV_LOG).read()
except Exception:
    devlog = ''
try:
    witlog = subprocess.run(
        ['journalctl', '-u', 'scruple-witness', '--since', '6 hours ago', '--no-pager'],
        capture_output=True, text=True, timeout=10).stdout
except Exception:
    witlog = ''

results = []  # (mode, check, ok, detail)

def check(mode, name, ok, detail=''):
    results.append((mode, name, ok, detail))
    mark = '✓' if ok else '✗'
    color = '\033[32m' if ok else '\033[31m'
    print(f"  {color}{mark}\033[0m {name:42s} {detail}")

for mode, pid, expected_status in MODE_PROJECTS:
    print(f"\n━━━ {mode} (project {pid}) ━━━")

    proj = webdb.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if not proj:
        check(mode, 'project exists', False, f'no project {pid}'); continue
    scr = proj['scr_id'] or proj['pre_scr_id']
    print(f"  scr_id={scr}  status={proj['status']}  type={proj['type']}  merkle_root={proj['merkle_root'][:16]}…")
    check(mode, f'project.status == {expected_status}', proj['status'] == expected_status, proj['status'])

    iters = webdb.execute("SELECT * FROM iterations WHERE project_id=? ORDER BY run_sequence", (pid,)).fetchall()
    check(mode, f'iteration count > 0',           len(iters) > 0, f'n={len(iters)}')

    # ── per-iteration audit ─────────────────────────────────────────────
    leaves = []
    for it in iters:
        seq = it['run_sequence']
        scheme = it['leaf_scheme']

        # 1) DB iteration ↔ witness server row (matched by project_id + run_sequence)
        wrow = witdb.execute(
            "SELECT * FROM witnesses WHERE project_id=? AND run_sequence=?",
            (str(pid), seq)).fetchone()
        check(mode, f'#{seq} witness server row exists',
              wrow is not None,
              f'witness_id={wrow["witness_id"] if wrow else "(none)"}')
        if wrow:
            check(mode, f'#{seq} witness.content_hash == iter.output_hash',
                  wrow['content_hash'] == it['output_hash'])
            check(mode, f'#{seq} witness.input_hash == iter.input_hash',
                  (wrow['input_hash'] or None) == (it['input_hash'] or None) or
                  # v1 rows may have iter.input_hash but witness.input_hash NULL
                  scheme == 'v1')
            if scheme == 'v2':
                check(mode, f'#{seq} witness.workflow_hash == iter.workflow_hash',
                      wrow['workflow_hash'] == it['workflow_hash'])
                check(mode, f'#{seq} witness.leaf_hash == iter.leaf_hash',
                      wrow['leaf_hash'] == it['leaf_hash'])

        # 2) workflow_hash recompute (v2 only)
        if scheme == 'v2' and it['workflow_hash']:
            meta = json.loads(it['metadata'])
            wf = meta['generationSpec']['providerExtras']['workflowApiJson']
            recomputed = sha256_hex(canonical(wf).encode())
            check(mode, f'#{seq} workflow_hash reproducible from metadata',
                  recomputed == it['workflow_hash'])

        # 3) input_hash recompute
        meta = json.loads(it['metadata'])
        spec = meta['generationSpec']
        manifest = json.loads(it['input_artifacts'] or '[]')
        canon_in = {
            'provider': it['provider'],
            'prompt': it['prompt'],
            'spec': spec,
            'inputs': [{'kind': a['kind'], 'hash': a['hash']} for a in manifest],
        }
        recomputed_in = sha256_hex(canonical(canon_in).encode())
        check(mode, f'#{seq} input_hash reproducible from raw fields',
              recomputed_in == it['input_hash'])

        # 4) input artifact bytes match their hash (sample first 1)
        if manifest:
            a = manifest[0]
            bytes_ = fetch(f'{WEB_URL}/api/artifact/{a["hash"]}')
            check(mode, f'#{seq} input "{a["filename"]}" bytes match recorded hash',
                  sha256_hex(bytes_) == a['hash'] and len(bytes_) == a['bytes'],
                  f'{len(bytes_)} B')

        # 5) model_fingerprints_hash recompute + manifest sanity (v2 only)
        mf_json = it['model_fingerprints'] if 'model_fingerprints' in it.keys() else None
        mfh_stored = it['model_fingerprints_hash'] if 'model_fingerprints_hash' in it.keys() else None
        if scheme == 'v2' and mf_json:
            manifest = json.loads(mf_json)
            canon_mf = {k: manifest[k] for k in sorted(manifest.keys())}
            recomputed_mfh = sha256_hex(canonical(canon_mf).encode())
            check(mode, f'#{seq} model_fingerprints_hash reproducible from manifest',
                  recomputed_mfh == mfh_stored,
                  f'{len(manifest)} model file(s)')

        # 6) leaf_hash recompute (try v2.1 first, then v2.0 for pre-017 leaves)
        if scheme == 'v2' and wrow:
            rec = {
                'run_sequence': seq,
                'output_hash':  it['output_hash'],
                'input_hash':   it['input_hash'],
                'workflow_hash':it['workflow_hash'],
                'model_fingerprints_hash': mfh_stored or '',
                'server_timestamp': wrow['server_timestamp'],
                'prev_record_hash': wrow['prev_record_hash'] or '',
                '_expected': it['leaf_hash'],
            }
            leaf_v21 = record_hash_v21(rec)
            leaf_v20 = record_hash_v20(rec)
            if leaf_v21 == it['leaf_hash']:
                proto = 'v2.1'; ok = True
            elif leaf_v20 == it['leaf_hash']:
                proto = 'v2.0'; ok = True
            else:
                proto = 'mismatch'; ok = False
            check(mode, f'#{seq} v2 leaf_hash reproducible (sha256 of canonical record)',
                  ok, f'protocol={proto}')
        elif scheme == 'v1':
            check(mode, f'#{seq} v1 leaf_hash == output_hash',
                  it['leaf_hash'] == it['output_hash'])

        # 6) witnessed flag & signature presence
        check(mode, f'#{seq} witnessed == 1', it['witnessed'] == 1,
              f'sig={it["witness_signature"][:12]}…' if it['witness_signature'] else '')

        leaves.append(it['leaf_hash'])

    # 7) Merkle root reproducible from leaves
    recomputed_root = build_merkle(leaves)
    check(mode, 'Merkle root reproducible from leaves',
          recomputed_root == proj['merkle_root'],
          f'recomputed={recomputed_root[:16] if recomputed_root else "(none)"}…')

    # 8) Receipt HTML contains every full hash + scrId
    html = fetch(f'{WEB_URL}/receipt/{scr}').decode('utf-8', 'replace')
    check(mode, f'receipt /receipt/{scr} returns HTML',
          len(html) > 1000 and 'Provenance receipt generated' in html)
    for it in iters:
        check(mode, f'#{it["run_sequence"]} leaf_hash full in receipt',
              it['leaf_hash'] in html)
        check(mode, f'#{it["run_sequence"]} output_hash full in receipt',
              it['output_hash'] in html)
        check(mode, f'#{it["run_sequence"]} input_hash full in receipt',
              it['input_hash'] in html)
        if it['workflow_hash']:
            check(mode, f'#{it["run_sequence"]} workflow_hash full in receipt',
                  it['workflow_hash'] in html)
    check(mode, 'receipt shows verification recipe', 'Verification recipe' in html)

    # 9) audit log entries
    pname = proj['name']
    wit_hits = witlog.count(f'[WITNESS] {pname} #')
    check(mode, f'witness log has [WITNESS] entries for project name "{pname}"',
          wit_hits >= len(iters),
          f'{wit_hits}/{len(iters)} entries')
    if expected_status == 'local_locked':
        if pid not in SKIP_CHECKPOINT_LOG_FOR:
            check(mode, f'dev log has [CHECKPOINT] for project {pid}',
                  f'[CHECKPOINT] user=' in devlog and f'project={pid} preScr=' in devlog)
        check(mode, f'dev log has [LOCAL_LOCK] for project {pid}',
              f'[LOCAL_LOCK] user=' in devlog and f'project={pid} scr=' in devlog)

    # 9b) Lock countersignature — post-L-series, every locked project must
    # carry the witness server's signature on the lock event itself.
    # Pre-L-series rows have NULL here; allow that legacy state to pass.
    lock_sig = proj['lock_server_signature'] if 'lock_server_signature' in proj.keys() else None
    if lock_sig is not None:
        check(mode, 'lock_server_signature persisted',
              len(lock_sig) >= 32,
              f'sig={lock_sig[:14]}…')
        check(mode, 'receipt renders lock_server_signature',
              lock_sig in html)

    # 10) chain-anchor checks (pinned tier = RVN + IPFS + Arweave)
    if expected_status in ('chain_locked', 'persistent_locked'):
        check(mode, 'project.rvn_txid populated', bool(proj['rvn_txid']),
              proj['rvn_txid'][:24] + '…' if proj['rvn_txid'] else '(missing)')
        if expected_status == 'persistent_locked':
            check(mode, 'project.ipfs_cid populated', bool(proj['ipfs_cid']),
                  proj['ipfs_cid'][:24] + '…' if proj['ipfs_cid'] else '(missing)')
            check(mode, 'project.arweave_uri populated', bool(proj['arweave_uri']),
                  proj['arweave_uri'][:24] + '…' if proj['arweave_uri'] else '(missing)')
        if proj['rvn_txid']:
            check(mode, 'receipt renders RVN tx', proj['rvn_txid'] in html)
        if proj['ipfs_cid']:
            check(mode, 'receipt renders IPFS CID', proj['ipfs_cid'] in html)
        if proj['arweave_uri']:
            check(mode, 'receipt renders Arweave URI', proj['arweave_uri'] in html)
        check(mode, f'witness log has Project {pid} LOCKED line',
              f'[WITNESS] Project {pid} LOCKED' in witlog)
        if proj['scr_id']:
            check(mode, f'witness log has mint success for {proj["scr_id"]}',
                  f'[WITNESS] {proj["scr_id"]} minted on testnet' in witlog)
            if expected_status == 'persistent_locked':
                check(mode, f'witness log has [ANCHOR] IPFS for {proj["scr_id"]}',
                      f'[ANCHOR] IPFS pinned {proj["scr_id"]}' in witlog)
                check(mode, f'witness log has [ANCHOR] Arweave for {proj["scr_id"]}',
                      f'[ANCHOR] Arweave record posted for {proj["scr_id"]}' in witlog)

# ── final summary ─────────────────────────────────────────────────────────
print('\n━━━ SUMMARY ━━━')
by_mode = {}
for mode, name, ok, _ in results:
    by_mode.setdefault(mode, [0, 0])
    by_mode[mode][1] += 1
    if ok: by_mode[mode][0] += 1
total_ok = sum(v[0] for v in by_mode.values())
total = sum(v[1] for v in by_mode.values())
for mode, (ok, n) in by_mode.items():
    color = '\033[32m' if ok == n else '\033[31m'
    print(f"  {color}{ok:3d}/{n:3d}\033[0m  {mode}")
print(f"  ─────────  ───────")
color = '\033[32m' if total_ok == total else '\033[31m'
print(f"  {color}{total_ok:3d}/{total:3d}\033[0m  total")
sys.exit(0 if total_ok == total else 1)
