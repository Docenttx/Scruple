// Manual checkpoint-tick runner — the outer loop lands as a systemd unit
// (WO-07 future work), but this script is what CI and dev use to advance
// the checkpoint chain by hand.
//
// Usage:
//   npx tsx scripts/run-checkpoint-tick.ts           # tick every stream once
//   npx tsx scripts/run-checkpoint-tick.ts --stream STR_xxx
//
// Exits 0 always (individual stream failures logged, non-fatal).

import { tickAll, tickOne } from '../lib/witness/checkpointScheduler';
import { conn } from '../lib/db/sqlite';

const args = process.argv.slice(2);
const streamIdx = args.indexOf('--stream');
const streamId = streamIdx >= 0 ? args[streamIdx + 1] : null;

if (streamId) {
  const s = conn()
    .prepare(`SELECT stream_id, name, tenant_id, checkpoint_secs FROM streams WHERE stream_id = ?`)
    .get(streamId) as { stream_id: string; name: string; tenant_id: string; checkpoint_secs: number } | undefined;
  if (!s) {
    console.error(`stream ${streamId} not found`);
    process.exit(1);
  }
  const r = tickOne(s);
  console.log(JSON.stringify(r, null, 2));
} else {
  const results = tickAll();
  console.log(JSON.stringify(results, null, 2));
}
