#!/usr/bin/env node
// Pass-1B · Canvas model stub sync.
//
// Mirrors filenames on the Modal `scruple-models` Volume into the
// local canvas.stooges.ai ComfyUI install at
// /data/reference/ui-inspire/ComfyUI/models/. ComfyUI's dropdowns
// scan this filesystem on startup (and on workflow load), so any
// filename present here shows up in the picker. The local files are
// zero bytes — actual model weights live only on the Modal Volume.
//
// Run periodically (cron / systemd timer) or after any /api/library
// mutation. The script is idempotent:
//   - missing stub → create empty file
//   - missing from Modal → remove local stub
//   - already in sync → no-op
//
// Usage:
//   node scripts/sync-canvas-stubs.mjs          # dry-run / actual sync
//   SYNC_DRY=1 node scripts/sync-canvas-stubs.mjs   # report only

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const COMFY_MODELS_DIR =
  process.env.SCRUPLE_CANVAS_MODELS_DIR ||
  '/data/reference/ui-inspire/ComfyUI/models';
const DRY_RUN = process.env.SYNC_DRY === '1';
const MODAL_BIN = process.env.MODAL_BIN || '/home/ubuntu/.local/bin/modal';

// ── 1. Ask Modal for the current volume listing ───────────────────────────
function fetchVolumeListing() {
  // We call `modal run modal/scruple_runner.py::ls` which invokes the
  // `ls` local_entrypoint, which calls `list_volume.remote()` and
  // prints JSON. We capture stdout and parse the JSON body.
  const out = execFileSync(
    MODAL_BIN,
    ['run', '/data/scruple-web/modal/scruple_runner.py::ls'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 },
  );
  // Modal prefixes some progress lines; isolate the JSON object.
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error(`No JSON in modal output:\n${out}`);
  }
  return JSON.parse(out.slice(start, end + 1));
}

// ── 2. Walk local canvas stubs ────────────────────────────────────────────
function walkLocal(root) {
  const entries = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else entries.push({ rel: path.relative(root, full), size: stat.size });
    }
  }
  walk(root);
  return entries;
}

// ── 3. Diff + apply ───────────────────────────────────────────────────────
// Only manage real model files (these extensions are what ComfyUI loads).
// ComfyUI's bundled `put_X_here` placeholder + .yaml config files have
// no extension we recognize, so they're left alone.
const MANAGED_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i;

function diff(volumeListing, localEntries) {
  const wanted = new Set();
  for (const [_category, items] of Object.entries(volumeListing.by_category ?? {})) {
    for (const it of items) {
      if (MANAGED_EXT.test(it.path)) wanted.add(it.path);
    }
  }
  // Only consider local files we'd actually have created (managed
  // extensions only). Anything else — README, put_X_here placeholders,
  // config yamls — is ComfyUI's business, leave it.
  const have = new Set(localEntries.filter(e => MANAGED_EXT.test(e.rel)).map(e => e.rel));

  const toAdd = [...wanted].filter(p => !have.has(p));
  const toRemove = [...have].filter(p => !wanted.has(p));
  return { toAdd, toRemove };
}

function apply(toAdd, toRemove) {
  let added = 0;
  let removed = 0;
  for (const rel of toAdd) {
    const full = path.join(COMFY_MODELS_DIR, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!DRY_RUN) fs.writeFileSync(full, '');
    added++;
  }
  for (const rel of toRemove) {
    const full = path.join(COMFY_MODELS_DIR, rel);
    if (!DRY_RUN) {
      try { fs.unlinkSync(full); } catch { /* ignore */ }
    }
    removed++;
  }
  return { added, removed };
}

// ── main ──────────────────────────────────────────────────────────────────
function main() {
  console.log(`[sync-stubs] canvas dir: ${COMFY_MODELS_DIR}`);
  console.log(`[sync-stubs] dry run: ${DRY_RUN ? 'YES' : 'no'}`);

  const listing = fetchVolumeListing();
  const totalRemote = Object.values(listing.by_category ?? {}).reduce((n, arr) => n + arr.length, 0);
  console.log(`[sync-stubs] modal volume: ${totalRemote} files across ${Object.keys(listing.by_category ?? {}).length} categories`);

  const local = walkLocal(COMFY_MODELS_DIR);
  console.log(`[sync-stubs] local canvas: ${local.length} existing files`);

  const { toAdd, toRemove } = diff(listing, local);
  if (toAdd.length === 0 && toRemove.length === 0) {
    console.log('[sync-stubs] already in sync.');
    return;
  }

  if (toAdd.length > 0) {
    console.log(`\n[sync-stubs] adding ${toAdd.length}:`);
    for (const p of toAdd.slice(0, 50)) console.log(`  + ${p}`);
    if (toAdd.length > 50) console.log(`  + ... and ${toAdd.length - 50} more`);
  }
  if (toRemove.length > 0) {
    console.log(`\n[sync-stubs] removing ${toRemove.length}:`);
    for (const p of toRemove.slice(0, 50)) console.log(`  - ${p}`);
    if (toRemove.length > 50) console.log(`  - ... and ${toRemove.length - 50} more`);
  }

  const result = apply(toAdd, toRemove);
  console.log(`\n[sync-stubs] applied: +${result.added} −${result.removed} ${DRY_RUN ? '(dry-run)' : ''}`);
}

main();
