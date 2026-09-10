/**
 * lock/modalities.js — WO-G2. Put §9.1 and §9.2 on a project at lock time.
 *
 * The app's buttons do not change. What happens underneath them does: a
 * checkpoint, a local disc lock and a chain lock each now produce, for every
 * image iteration in the project, a WATERMARKED DERIVATIVE (Standard §9.2, or
 * §9.3 at the chain tiers) carrying a C2PA CONTENT CREDENTIAL (§9.1) signed by
 * a key this machine cannot reach.
 *
 * ⚑ The two modalities are PEERS. Both implement Section 1 mandatory marking
 * measures of the EU AI Act Article 50 Code of Practice; neither is part of the
 * other, and the watermark must never be described as a C2PA feature.
 *
 * 🔴 A PROJECT IS NOT ALL-OR-NOTHING, AND THIS SAYS SO PER ITERATION.
 * An iteration whose master is missing from disk, or whose credential the server
 * refused, is reported as itself — not folded into a project-level failure and
 * not quietly dropped. A lock that watermarked four of five images and said
 * "done" would be the worst possible outcome: the fifth is unmarked and nobody
 * knows which.
 *
 * DELIBERATELY NOT DECIDED HERE: `digitalSourceType`. It travels in from the
 * caller. Standard §9.1 puts it in the manifest, and it is the field that says
 * whether generative AI made these bytes — a lock action cannot know that, and a
 * default would be a lie in one direction or the other.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ctx = require('../context');

/** Map the app's action to the Standard's tier. */
const ACTION_FOR_LOCK = Object.freeze({
  checkpoint: 'checkpoint',
  local: 'local-lock',
  chain: 'chain-lock',
  'chain-pinned': 'chain-lock-pinned',
});

/**
 * @param {{projectId:number, lock:'checkpoint'|'local'|'chain'|'chain-pinned',
 *          digitalSourceType:string, scrId?:string, pinnedHint?:number}} input
 * @returns {Promise<{attempted:number, marked:number, signed:number,
 *                    results:Array<object>, skipped:Array<object>}>}
 */
async function applyToProject(input) {
  const action = ACTION_FOR_LOCK[input.lock];
  if (!action) throw new Error(`unknown lock action: ${input.lock}`);

  const databaseManager = ctx.get('databaseManager');
  const configManager = ctx.get('configManager');
  if (!databaseManager || !configManager) {
    return { attempted: 0, marked: 0, signed: 0, results: [], skipped: [{ reason: 'system_not_ready' }] };
  }

  const project = databaseManager.getProject(input.projectId);
  if (!project) {
    return { attempted: 0, marked: 0, signed: 0, results: [], skipped: [{ reason: 'project_not_found' }] };
  }

  const terminalPath = configManager.getTerminalProvenancePath();
  const iterations = databaseManager.getIterations(input.projectId) || [];

  // Required lazily. `app/` is a library to this directory, and requiring it at
  // module load would put the host seam on the path of every lock module that
  // merely imports the barrel.
  const { applyModalities } = require(path.join(__dirname, '..', '..', 'app', 'ipc-modalities'));

  const results = [];
  const skipped = [];
  let marked = 0;
  let signed = 0;

  for (const it of iterations) {
    const name = it.image_filename || it.source_file;
    if (!name) { skipped.push({ iteration: it.id, reason: 'no_source_file' }); continue; }
    const master = path.join(terminalPath || '', project.name, name);
    if (!fs.existsSync(master)) { skipped.push({ iteration: it.id, reason: 'master_not_on_disk', path: master }); continue; }
    // Video is Phase 2 — §9.2.2 names the technique and nothing implements it
    // yet. Skipped LOUDLY rather than silently: an unmarked video in a locked
    // project is a fact the caller has to be told.
    if (!/\.(png|jpe?g|webp|tiff?)$/i.test(name)) {
      skipped.push({ iteration: it.id, reason: 'unsupported_media_for_watermark', file: name });
      continue;
    }

    const r = await applyModalities({
      action,
      assetPath: master,
      outputPath: master.replace(/(\.[^.]+)$/, '.wm$1'),
      digitalSourceType: input.digitalSourceType,
      projectId: input.projectId,
      scrId: input.scrId,
      pinnedHint: input.pinnedHint,
      title: `${project.name} · ${name}`,
    });
    results.push({ iteration: it.id, file: name, ...r });
    // A derivative can exist without a credential — `credential_refused` says
    // exactly that and carries the derivative with it. Counting them separately
    // is what keeps "watermarked" and "signed" from being reported as one thing.
    if (r.ok || r.derivative) marked += 1;
    if (r.ok) signed += 1;
  }

  return { attempted: iterations.length, marked, signed, results, skipped };
}

module.exports = { applyToProject, ACTION_FOR_LOCK };
