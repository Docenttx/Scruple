#!/usr/bin/env python3
"""
patch-server-ipfs.py
Adds pinned tier kubo IPFS upload to /opt/scruple-witness/server.js
Run on Oracle VM: python3 patch-server-ipfs.py
"""

import sys

SERVER_PATH = '/opt/scruple-witness/server.js'

# ── Patch 1 ──────────────────────────────────────────────────────────────────
# Replace the issueAsset call + add kubo upload block + rename Step 2 comment

OLD_1 = """    const rvnResult = await locker.issueAsset(scr_id, null);
    rvn_txid = rvnResult.txid;

    // Step 2: Post Arweave token record"""

NEW_1 = """    const rvnResult = await locker.issueAsset(scr_id, null);
    rvn_txid = rvnResult.txid;
    // Step 2: Upload provenance package to kubo IPFS (pinned tier only)
    if (lock_tier === 'pinned') {
      try {
        const provenanceData = JSON.stringify({
          version: '2.0',
          scr_id,
          pre_scr_id: pre_scr_id || null,
          installation_id: installation_id || null,
          project_name: project_name || project_id,
          merkle_root,
          rvn_txid,
          locked_at: new Date().toISOString()
        });
        const boundary = '----SCRUPLEBoundary' + Date.now();
        const filename = scr_id + '_provenance.json';
        const fileContent = Buffer.from(provenanceData);
        const bodyParts = [
          Buffer.from('--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="' + filename + '"\\r\\nContent-Type: application/json\\r\\n\\r\\n'),
          fileContent,
          Buffer.from('\\r\\n--' + boundary + '--\\r\\n')
        ];
        const kuboBody = Buffer.concat(bodyParts);
        const kuboRes = await fetch('http://127.0.0.1:5001/api/v0/add?pin=true', {
          method: 'POST',
          body: kuboBody,
          headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary }
        });
        const kuboJson = await kuboRes.json();
        ipfs_cid = kuboJson.Hash || null;
        console.log('[LOCKER] Pinned to kubo. CID: ' + ipfs_cid);
      } catch (e) {
        console.warn('[LOCKER] kubo upload failed (non-fatal):', e.message);
      }
    }
    // Step 3: Post Arweave token record"""

# ── Patch 2 ──────────────────────────────────────────────────────────────────
# Fix ipfs_cid: null in postTokenRecord call

OLD_2 = """      ipfs_cid: null
    });"""

NEW_2 = """      ipfs_cid: ipfs_cid || null
    });"""

# ── Patch 3 ──────────────────────────────────────────────────────────────────
# Fix ipfs_cid: null in updateLockProof

OLD_3 = "    stmts.updateLockProof.run({ project_id, rvn_txid, arweave_txid, ipfs_cid: null });"

NEW_3 = "    stmts.updateLockProof.run({ project_id, rvn_txid, arweave_txid, ipfs_cid });"

# ── Patch 4 ──────────────────────────────────────────────────────────────────
# Fix ipfs_cid: null in send() response

OLD_4 = "    send(res, 200, { success: true, rvn_txid, arweave_txid, ipfs_cid: null, scr_id });"

NEW_4 = "    send(res, 200, { success: true, rvn_txid, arweave_txid, ipfs_cid, scr_id });"

# ─────────────────────────────────────────────────────────────────────────────

def apply_patch(content, old, new, name):
    if old not in content:
        print(f'ERROR: Could not find patch target for {name}')
        print(f'  Looking for: {repr(old[:80])}...')
        sys.exit(1)
    count = content.count(old)
    if count > 1:
        print(f'WARNING: {name} target found {count} times — replacing first occurrence only')
    patched = content.replace(old, new, 1)
    print(f'OK: {name} applied')
    return patched

def main():
    print(f'Reading {SERVER_PATH}...')
    with open(SERVER_PATH, 'r', encoding='utf-8') as f:
        content = f.read()

    print(f'File size: {len(content)} bytes')

    content = apply_patch(content, OLD_1, NEW_1, 'Patch 1 — kubo upload block')
    content = apply_patch(content, OLD_2, NEW_2, 'Patch 2 — ipfs_cid in postTokenRecord')
    content = apply_patch(content, OLD_3, NEW_3, 'Patch 3 — ipfs_cid in updateLockProof')
    content = apply_patch(content, OLD_4, NEW_4, 'Patch 4 — ipfs_cid in send response')

    backup_path = SERVER_PATH + '.bak'
    with open(SERVER_PATH, 'r', encoding='utf-8') as f:
        original = f.read()
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(original)
    print(f'Backup written to {backup_path}')

    with open(SERVER_PATH, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'Patched file written to {SERVER_PATH}')
    print('Done. Restart the witness server:')
    print('  sudo systemctl restart scruple-witness')

if __name__ == '__main__':
    main()
