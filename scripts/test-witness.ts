// Smoke test for witness server connectivity. Runs against live :5799.
// Uses a unique project id per run to avoid colliding with prior tests.

import { witness } from '../lib/scruple/witness';

(async () => {
  console.log('[test] health check…');
  const ok = await witness.health();
  console.log(`  health: ${ok ? 'OK' : 'DOWN'}`);
  if (!ok) process.exit(1);

  const projectId = `scruple-web-test-${Date.now()}`;
  console.log(`[test] witnessing 3 iterations for project ${projectId}…`);
  const ids: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const contentHash = require('crypto').createHash('sha256').update(`leaf-${i}`).digest('hex');
    const r = await witness.witnessIteration({
      projectId,
      projectName: 'scruple-web smoke test',
      runSequence: i,
      contentHash,
    });
    console.log(`  #${i}: ${r.witness_id} @ ${r.server_timestamp}`);
    ids.push(r.witness_id);
  }

  console.log('[test] listing…');
  const list = await witness.listIterations(projectId);
  console.log(`  ${list.count} iterations returned`);

  console.log('[test] locking…');
  const lock = await witness.lockProject(projectId);
  console.log(`  merkle_root = ${lock.merkle_root.slice(0, 16)}…`);
  console.log(`  server_signature = ${lock.server_signature.slice(0, 24)}…`);

  console.log('OK');
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
