/**
 * ipfs-pinner.js - SCRUPLE Witness IPFS Pinner
 *
 * Pins a JSON proof record to the local Kubo daemon (/api/v0/add) and
 * returns the CID. Mirrors the Electron Studio wallet/ipfs _pinToLocal
 * path, pointed at the witness host's local Kubo node.
 *
 * SCRUPLE Witness Server V2 - Patent Pending
 */

const http = require('http');

const IPFS_API = process.env.IPFS_API_URL || 'http://127.0.0.1:5001';
const IPFS_GATEWAY = process.env.IPFS_GATEWAY_URL || 'http://127.0.0.1:8080/ipfs/';

/**
 * Pin a JSON object to the local Kubo node via multipart /api/v0/add.
 * @param {object} data    JSON-serializable proof record
 * @param {string} name    filename label inside the add
 * @returns {Promise<{cid:string,size:number,gatewayUrl:string}>}
 */
function pinJSON(data, name) {
  const payload = Buffer.from(JSON.stringify(data, null, 2));
  const boundary = '----ScrupleKubo' + Math.random().toString(36).slice(2);
  const filename = (name || 'proof') + '.json';

  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/json\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, payload, tail]);

  const api = new URL(IPFS_API);

  return new Promise((resolve, reject) => {
    // cid-version=1 + pin=true so the record is content-addressed and retained.
    const req = http.request(
      {
        hostname: api.hostname,
        port: api.port || 5001,
        path: '/api/v0/add?cid-version=1&pin=true',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('Kubo /add HTTP ' + res.statusCode + ': ' + buf.slice(0, 200)));
            return;
          }
          try {
            // Kubo streams one JSON object per added entry (NDJSON); take the last.
            const last = buf.trim().split('\n').filter(Boolean).pop();
            const r = JSON.parse(last);
            if (!r.Hash) {
              reject(new Error('Kubo /add returned no Hash: ' + buf.slice(0, 200)));
              return;
            }
            resolve({
              cid: r.Hash,
              size: parseInt(r.Size || 0, 10),
              gatewayUrl: IPFS_GATEWAY + r.Hash,
            });
          } catch (e) {
            reject(new Error('Kubo /add bad response: ' + buf.slice(0, 200)));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Kubo /add timeout'));
    });
    req.write(body);
    req.end();
  });
}

module.exports = { pinJSON, IPFS_API, IPFS_GATEWAY };
