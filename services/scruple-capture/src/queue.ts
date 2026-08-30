// The durable offline queue (§5).
//
// WHY THIS IS A PORT AND NOT A NEW DESIGN. packages/scruple-host-sdk/queue.py
// already implements the durable half — JSONL on disk, one line per queued
// request, survives process death because it is a file and not an in-memory
// list, with BACKOFF_SCHEDULE = [5, 30, 120, 600, 1800]. Its own docstring
// records that the identical file was ported into all six SDK forks and wired
// into the failure path in NONE of them. The port is not the fix; calling
// enqueue() unconditionally on submission failure is the fix. That call is in
// submitter.ts.
//
// The component is Node, so it cannot import queue.py. The on-disk FORMAT and
// the schedule are kept identical to the Python file, field for field, so an
// operator can read either queue with either tool and so a future consolidation
// is a deletion rather than a migration. If you change a field name here,
// change it there.
//
// ONE FIELD THE PYTHON QUEUE DOES NOT HAVE: `counter`. It is not decoration.
// §5 says a queued event KEEPS ITS COUNTER — the counter was spent when the
// MAC was computed, and the MAC only verifies against the key at that counter.
// A queue that re-derived or re-numbered on drain would invalidate every
// entry it held.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Identical to packages/scruple-host-sdk/scruple_host_sdk/queue.py. */
export const BACKOFF_SCHEDULE = [5, 30, 120, 600, 1800];

export interface QueueEntry {
  id: string;
  kind: string;
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  queued_at: number;
  attempts: number;
  last_attempt_at: number | null;
  /** The ratchet counter this entry's MAC was computed at. Never re-issued. */
  counter: number;
}

export class QueueStore {
  constructor(readonly file: string) {
    const d = path.dirname(file);
    if (d) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'w', 0o600));
  }

  enqueue(e: {
    kind: string;
    method: string;
    path: string;
    body?: Record<string, unknown> | null;
    counter: number;
  }): QueueEntry {
    const entry: QueueEntry = {
      id: crypto.randomBytes(16).toString('hex'),
      kind: e.kind,
      method: e.method,
      path: e.path,
      body: e.body ?? null,
      queued_at: Date.now() / 1000,
      attempts: 0,
      last_attempt_at: null,
      counter: e.counter,
    };
    // Append + fsync. An enqueue that is only in the page cache is not a
    // queue that "survives process death", which is the one property this
    // module exists for.
    const fd = fs.openSync(this.file, 'a', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return entry;
  }

  loadAll(): QueueEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: QueueEntry[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as QueueEntry);
      } catch {
        // A torn last line from a crash mid-append. Skipped, as queue.py
        // skips a JSONDecodeError, rather than discarding the whole file.
        continue;
      }
    }
    return out;
  }

  replaceAll(entries: QueueEntry[]): void {
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  count(): number {
    return this.loadAll().length;
  }
}

/** Seconds to wait after `attempts` failures. Saturates at the last step —
 *  a queue never gives up, because giving up is data loss dressed as
 *  cleanup. */
export function backoffSeconds(attempts: number): number {
  if (attempts <= 0) return 0;
  const i = Math.min(attempts, BACKOFF_SCHEDULE.length) - 1;
  return BACKOFF_SCHEDULE[i];
}

export function isDue(e: QueueEntry, nowMs = Date.now()): boolean {
  if (e.attempts === 0 || e.last_attempt_at === null) return true;
  return nowMs / 1000 - e.last_attempt_at >= backoffSeconds(e.attempts);
}
