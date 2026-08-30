// The component's build measurement (§4.3).
//
// "the analogue of a terminal's firmware version riding in the transaction."
// It goes in the provisioning request and on every event envelope.
//
// WHAT IT IS WORTH TODAY, stated here rather than discovered later. §10 C-4:
// the published-builds registry DOES NOT EXIST. So the server cannot check
// that a claimed measurement is one Scruple shipped; it records the value per
// event and flags `build_changed` against the value the component provisioned
// with (lib/ratchet/verify.ts). That is DRIFT DETECTION, NOT PROVENANCE, and
// §4.3's claim — "the first time P1 is checkable at ingest rather than
// attested" — cannot be made in customer material until the registry lands.
//
// AND THE HONEST LIMIT ABOVE THAT, which is the spec's own (§4.3): a modified
// build can claim any measurement string. What it cannot do is produce a valid
// MAC without the IK. Where the vendor has attestable compute the IK is sealed
// to the measurement and a modified build cannot unseal it (leaf `verified`);
// where they do not, the binding is assertion (leaf `passthrough`). This file
// computes the string. It does not, and cannot, bind it to anything.
//
// Computed over the component's own source rather than a container digest
// because the container digest is the vendor's to state and this is ours. A
// real deployment SHOULD prefer the image digest the registry publishes; this
// is what a component can measure about itself with no help.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(ts|mts|cts|js|mjs|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * sha256 over `relpath\0sha256(file)\n` for every source file, paths sorted.
 *
 * Sorted by BYTE ORDER of the relative path, so two machines with different
 * locales agree. Content hashed per file rather than concatenated, so a byte
 * moving across a file boundary changes the measurement.
 */
export function buildMeasurement(root: string = SRC_ROOT): string {
  const files = walk(root).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    h.update(rel, 'utf8');
    h.update('\0');
    h.update(fileHash, 'utf8');
    h.update('\n');
  }
  // The shape app/api/v2/components/provision/route.ts validates:
  // /^sha256:[0-9a-f]{64}$/.
  return 'sha256:' + h.digest('hex');
}

if (require.main === module) {
  process.stdout.write(buildMeasurement() + '\n');
}
