// Canvas stub sync — extract of scripts/sync-canvas-stubs.mjs callable from
// /api/models routes. After a successful fetch_to_volume, the corresponding
// zero-byte placeholder must appear under the local canvas ComfyUI install
// so the workflow dropdowns pick the model up.
//
// We don't shell out to `modal run` here — we already have the listing
// (or can pull it cheaply via /api/models/list). The diff/apply logic
// is the same as the script's, kept consistent.

import fs from 'node:fs';
import path from 'node:path';
import type { VolumeListing } from './modal-admin';

const COMFY_MODELS_DIR =
  process.env.SCRUPLE_CANVAS_MODELS_DIR ||
  '/data/reference/ui-inspire/ComfyUI/models';

// Only manage files with ComfyUI-recognized model extensions. .yaml config
// files + put_X_here placeholders are ComfyUI's own — leave them.
const MANAGED_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i;

interface LocalEntry { rel: string; size: number; }

function walkLocal(root: string): LocalEntry[] {
  const out: LocalEntry[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push({ rel: path.relative(root, full), size: stat.size });
    }
  }
  walk(root);
  return out;
}

export interface StubSyncReport {
  added: string[];
  removed: string[];
  totalRemote: number;
  totalLocal: number;
}

export function syncCanvasStubs(listing: VolumeListing): StubSyncReport {
  const wanted = new Set<string>();
  for (const items of Object.values(listing.by_category)) {
    for (const it of items) {
      if (MANAGED_EXT.test(it.path)) wanted.add(it.path);
    }
  }
  const local = walkLocal(COMFY_MODELS_DIR);
  const have = new Set(local.filter(e => MANAGED_EXT.test(e.rel)).map(e => e.rel));

  const toAdd = [...wanted].filter(p => !have.has(p));
  const toRemove = [...have].filter(p => !wanted.has(p));

  for (const rel of toAdd) {
    const full = path.join(COMFY_MODELS_DIR, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  for (const rel of toRemove) {
    const full = path.join(COMFY_MODELS_DIR, rel);
    try { fs.unlinkSync(full); } catch { /* ignore */ }
  }

  return {
    added: toAdd,
    removed: toRemove,
    totalRemote: wanted.size,
    totalLocal: have.size,
  };
}
