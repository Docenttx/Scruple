// A COUNTED READ WITH A CEILING, replacing an unbounded readFileSync.
//
// The legacy vault did this, for every .toml and every .json in the folder:
//
//     const contents = fs.readFileSync(filePath);
//     fileHash = crypto.createHash('sha256').update(contents).digest('hex');
//
// docs/DESIGN.md replaces it with "a ceiling with a refusal outcome". Two
// separate defects are being closed and only one of them is about memory:
//
//   1. `readFileSync` on a vault holding a 6 GB checkpoint takes the process
//      down. The vault is the ONE place the desktop meets files it did not
//      produce and cannot bound.
//   2. `readFileSync` reports the bytes it got and never the bytes it
//      expected, so a file that shrank, grew or vanished mid-read is
//      indistinguishable from a file that was always that size. The digest is
//      of what was read. The record has to say how much that was.
//
// SO THE CEILING IS COUNTED, NOT STATTED. `fs.statSync(p).size > ceiling` is
// one syscall and would be cheaper, and it decides the question from metadata
// the file's owner controls and which can change between the stat and the
// read. This reads, counts what actually arrives, and stops the stream the
// moment the count passes the ceiling. `statSize` is recorded beside
// `bytesCounted` as a HINT, and the two disagreeing is itself a fact worth
// having — it is the same distinction WO-D2's `scruple:capture-file` already
// draws between `bytes` and `statSize`.
//
// The refusal is a RETURN VALUE, not a throw and not a skip. WO-D3: refused
// "as a recorded outcome, not silently skipped".

import crypto from 'node:crypto';
import fs from 'node:fs';

export type CountedReadOutcome = 'read' | 'over_ceiling' | 'unreadable';

export interface CountedRead {
  outcome: CountedReadOutcome;
  /** Hex sha256 of the bytes ACTUALLY READ. Null unless outcome is 'read' —
   *  a digest of a prefix is not a digest of the file and must not be stored
   *  where one is expected. */
  contentHash: string | null;
  /** How many bytes this process actually received. Always meaningful: on
   *  'over_ceiling' it is how far the read got before it was stopped, which
   *  is at least `ceiling` and is NOT the file's size. */
  bytesCounted: number;
  /** What stat(2) claimed before the read. A hint from the file's owner. */
  statSize: number | null;
  ceiling: number;
  /** Set when statSize and bytesCounted disagree on a completed read — the
   *  file changed under us, or stat lied. */
  sizeDisagreement: string | null;
  reason: string | null;
}

/**
 * Hash `p`, counting, and stop at `ceiling`.
 *
 * The stream is destroyed on the chunk that crosses the ceiling, so the
 * process never holds more than one chunk past it. The hash is abandoned with
 * it: there is no partial digest in the return value, because a partial digest
 * in a `contentHash` field is a wrong answer wearing the right shape.
 */
export function countedHash(p: string, ceiling: number): Promise<CountedRead> {
  return new Promise((resolve) => {
    let statSize: number | null = null;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) {
        resolve({
          outcome: 'unreadable', contentHash: null, bytesCounted: 0, statSize: null,
          ceiling, sizeDisagreement: null, reason: 'not a regular file',
        });
        return;
      }
      statSize = st.size;
    } catch (e) {
      resolve({
        outcome: 'unreadable', contentHash: null, bytesCounted: 0, statSize: null,
        ceiling, sizeDisagreement: null,
        reason: `cannot stat: ${String((e as NodeJS.ErrnoException).code ?? e)}`,
      });
      return;
    }

    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let stopped = false;
    const rs = fs.createReadStream(p);

    rs.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > ceiling) {
        stopped = true;
        rs.destroy();
        resolve({
          outcome: 'over_ceiling',
          contentHash: null,
          bytesCounted: bytes,
          statSize,
          ceiling,
          sizeDisagreement: null,
          reason:
            `read passed the ${ceiling}-byte ceiling after ${bytes} bytes were counted. ` +
            'The digest was abandoned rather than truncated: a hash of a prefix is not a ' +
            'hash of the file.',
        });
        return;
      }
      hash.update(chunk);
    });

    rs.on('error', (e) => {
      if (stopped) return;
      stopped = true;
      resolve({
        outcome: 'unreadable', contentHash: null, bytesCounted: bytes, statSize, ceiling,
        sizeDisagreement: null,
        reason: `read failed after ${bytes} bytes: ${String((e as NodeJS.ErrnoException).code ?? e)}`,
      });
    });

    rs.on('end', () => {
      if (stopped) return;
      resolve({
        outcome: 'read',
        contentHash: hash.digest('hex'),
        bytesCounted: bytes,
        statSize,
        ceiling,
        sizeDisagreement:
          statSize !== null && statSize !== bytes
            ? `stat said ${statSize} bytes; ${bytes} were read. The file changed under the ` +
              'read, or stat was wrong. The digest is of what was read.'
            : null,
        reason: null,
      });
    });
  });
}
