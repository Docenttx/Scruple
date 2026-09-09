/**
 * ipc-capture.js — the second real IPC handler, and the first with a side
 * effect outside the process.
 *
 * `scruple:capture-file` is the single-file primitive: the main process reads a
 * file the renderer names, hashes it while counting the bytes it actually read,
 * and writes a content-addressed copy into the run store. It returns the digest
 * it computed and the path it wrote.
 *
 * WHY THIS HANDLER AND NOT A VAULT. WO-D3 rebuilds the vault — a directory
 * enumerated, typed by DECLARED MIME, bounded by a ceiling with a refusal
 * recorded as a fact. None of that policy is here, deliberately: this is the
 * one operation the driver needs in order to have something to assert about,
 * and inventing D3's policy early would mean writing it twice. What is here is
 * the part D3 keeps — a counted read and a digest of the bytes that were
 * actually read, not of the bytes the caller believed were there.
 *
 * The digest is a claim. `scripts/desktop-run.mjs` re-hashes the bytes on disk
 * from the host process and does not take this handler's word for it — see
 * docs/DESIGN.md, "bytes on disk that re-hash to the recorded content hash".
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Hash and count in one pass, from a stream. `readFileSync` would give the same
 * digest for a small file and no way to answer "how much did we read" for a
 * large one, which is the question a ceiling is an answer to.
 */
function digestAndCount(srcPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const rs = fs.createReadStream(srcPath);
    rs.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
    rs.on('error', reject);
    rs.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

function registerCaptureIpc() {
  ipcMain.handle('scruple:capture-file', async (event, req) => {
    const at = new Date().toISOString();
    const sender = BrowserWindow.fromWebContents(event.sender);
    const base = { ok: false, at, mainPid: process.pid, senderWindowId: sender ? sender.id : null };

    if (!req || typeof req.path !== 'string' || req.path === '') {
      return { ...base, outcome: 'refused', reason: 'no path given' };
    }

    // The store is configuration, not something a page may choose. A renderer
    // that could name the destination could write anywhere the app can.
    const storeDir = process.env.SCRUPLE_RUN_STORE;
    if (!storeDir) {
      return { ...base, outcome: 'refused', reason: 'SCRUPLE_RUN_STORE is not set' };
    }

    const sourcePath = path.resolve(req.path);
    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch (err) {
      return { ...base, outcome: 'refused', reason: `cannot stat: ${err.code || err.message}`, sourcePath };
    }
    if (!stat.isFile()) {
      return { ...base, outcome: 'refused', reason: 'not a regular file', sourcePath };
    }

    let measured;
    try {
      measured = await digestAndCount(sourcePath);
    } catch (err) {
      return { ...base, outcome: 'refused', reason: `read failed: ${err.code || err.message}`, sourcePath };
    }

    // Content-addressed, so the path itself carries the claim the driver checks.
    const storePath = path.join(storeDir, measured.sha256.slice(0, 2), measured.sha256);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.copyFileSync(sourcePath, storePath);

    return {
      ...base,
      ok: true,
      outcome: 'captured',
      sourcePath,
      storePath,
      sha256: measured.sha256,
      bytes: measured.bytes,
      // What the filesystem said before we read it. When this disagrees with
      // `bytes` the file changed under us, and that is worth being able to see.
      statSize: stat.size,
    };
  });
}

module.exports = { registerCaptureIpc };
