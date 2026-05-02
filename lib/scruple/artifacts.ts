// Content-addressed artifact store. Mirrors ai-council/artifacts/canvas/
// layout: <ARTIFACTS_DIR>/<hash[:2]>/<hash> with the hash being the
// SHA-256 of the bytes inside.

import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS_DIR = path.join(process.cwd(), 'artifacts');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function artifactPath(hash: string): string {
  return path.join(ARTIFACTS_DIR, hash.slice(0, 2), hash);
}

export function storeArtifact(hash: string, bytes: Buffer): string {
  const dir = path.join(ARTIFACTS_DIR, hash.slice(0, 2));
  ensureDir(dir);
  const out = path.join(dir, hash);
  if (!fs.existsSync(out)) fs.writeFileSync(out, bytes);
  return out;
}

export function readArtifact(hash: string): Buffer | null {
  const p = artifactPath(hash);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

export function artifactExists(hash: string): boolean {
  return fs.existsSync(artifactPath(hash));
}
