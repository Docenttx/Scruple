// Canonical hash routines for Scruple Web. MUST match desktop SCRUPLE
// Studio v3 byte-for-byte:
//
//   leaf_hash      = SHA-256 of raw output image bytes (hex lowercase)
//   merkle pair    = SHA-256 of (smaller || larger) hex concat
//   SCR-ID         = 'SCR_'  + first 6 hex chars uppercased
//   SCRB-ID        = 'SCRB_' + first 6 hex chars uppercased  (persistent)
//
// Source: research/electron-source/lock/merkle.js,
//         research/electron-source/nodes/studio_terminal.py._hash_image_file()

import { createHash } from 'node:crypto';

export function sha256Hex(input: Buffer | string): string {
  const h = createHash('sha256');
  h.update(input);
  return h.digest('hex');
}

export function deriveScrId(merkleRoot: string, persistent = false): string {
  const prefix = persistent ? 'SCRB_' : 'SCR_';
  return prefix + merkleRoot.slice(0, 6).toUpperCase();
}
