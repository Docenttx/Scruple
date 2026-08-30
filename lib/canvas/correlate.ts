// Canvas's correlator — the component's, persisted, because canvas is two
// processes.
//
// `services/scruple-capture/src/correlation.ts` holds pending prompts, the
// currently-executing prompt id and the input hashes in three in-memory
// Maps. It can, because the component is ONE process that owns both the
// HTTP gate and the WS gate.
//
// Canvas is not. The Next.js route handler owns HTTP; `scripts/
// canvas-ws-proxy.mjs` owns WS, in a separate Node process behind its own
// Cloudflare hostname, because Next route handlers cannot upgrade to a
// WebSocket. And the WS half is precisely the half that sees `executing` and
// `execution_success` — the only messages that say which prompt is live.
// An in-memory correlator would have the correlation source in one process
// and the correlation consumer in the other.
//
// So the state moves to SQLite, on the row that already exists for it.
// Migration 044 adds `writers_json`, `executing_at` and `finished_at` to
// `canvas_pending_iterations`. The DECISION LOGIC is imported from the
// component unchanged — `writingNodesOf` and `referencedInputNames` are the
// component's exported functions, called here, not copied — so canvas and
// the sidecar agree on what a writing node is by construction rather than
// by review.
//
// WHAT THIS FIXES ABOUT THE OLD CODE. lib/canvas/witness.ts paired /view
// bytes with "the most recent pending row for this session", and the
// component's own header calls that out by name: "lib/canvas/witness.ts
// pairs /view with 'the most recent pending row' and has the same exposure;
// stating it is the difference." It is now stated. `correlation_method` on
// every capture row records whether the link was 'filename-prefix' (the
// writing node's declared prefix matched, a real link) or 'ws-executing'
// (a timing guess, correct under ComfyUI's one-prompt-at-a-time execution
// and wrong under a second worker) or 'none'.

import { conn } from '@/lib/db/sqlite';
import {
  writingNodesOf,
  referencedInputNames,
  type CorrelationMethod,
} from '../../services/scruple-capture/src/correlation';
import { mimeForNodeClass, type DeclaredMime } from '../../services/scruple-capture/src/mime';

/**
 * The component's three values, plus the one canvas's two-process shape
 * creates and the component's own header called canvas out for:
 *
 *   'filename-prefix'      the writing node declared this prefix. A real link.
 *   'ws-executing'         the WS leg said this prompt was executing when the
 *                          bytes went past. A timing link — right under
 *                          ComfyUI's one-prompt-at-a-time execution, wrong
 *                          under a second worker sharing the volume.
 *   'most-recent-pending'  NOBODY said anything was executing. The WS sidecar
 *                          is not connected, so the only ordering available
 *                          is insertion order on the pending table. This is
 *                          the pairing the OLD lib/canvas/witness.ts used for
 *                          everything and did not label; correlation.ts's
 *                          header names it and says "stating it is the
 *                          difference". It is stated.
 *   'none'                 no pending workflow at all.
 *
 * An extension of the component's vocabulary, not a fork of it: the three
 * imported values keep their exact meanings and canvas adds the state the
 * component cannot be in.
 */
export type CanvasCorrelationMethod = CorrelationMethod | 'most-recent-pending';

export type { CorrelationMethod };

export interface PendingRow {
  prompt_id: string;
  session_id: string;
  user_id: string;
  project_id: number;
  workflow_api_json: string;
  writers_json: string | null;
  executing_at: string | null;
  finished_at: string | null;
  status: 'pending' | 'done' | 'lost';
}

export interface Writer {
  nodeId: string;
  classType: string;
  filenamePrefix: string | null;
}

/**
 * POST /prompt came back with a prompt_id. Opens the pending record and
 * pins the graph's writing nodes onto it, which is what makes
 * filename-prefix attribution possible later, in the other process.
 */
export function openPrompt(opts: {
  sessionId: string;
  userId: string;
  promptId: string;
  projectId: number;
  workflowApiJson: Record<string, unknown>;
}): Writer[] {
  const writers = writingNodesOf(opts.workflowApiJson);
  conn()
    .prepare(
      `INSERT OR REPLACE INTO canvas_pending_iterations
         (prompt_id, session_id, user_id, project_id, workflow_api_json, writers_json, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      opts.promptId,
      opts.sessionId,
      opts.userId,
      opts.projectId,
      JSON.stringify(opts.workflowApiJson),
      JSON.stringify(writers),
    );
  return writers;
}

/** The input artifact names a graph refers to. Re-exported so the proxy can
 *  say, on the capture row, that a workflow read inputs the gate never saw —
 *  which is why input_hash is null rather than the hash of `[]`. */
export { referencedInputNames };

/** WS `executing` — {prompt_id, node}. A null prompt_id is ComfyUI's idle
 *  message and must not clear a live prompt (correlation.ts noteExecuting). */
export function noteExecuting(sessionId: string, promptId: string | null): void {
  if (!promptId) return;
  conn()
    .prepare(
      `UPDATE canvas_pending_iterations
          SET executing_at = COALESCE(executing_at, datetime('now'))
        WHERE session_id = ? AND prompt_id = ?`,
    )
    .run(sessionId, promptId);
}

/** WS `execution_success` — {prompt_id}. Deliberately does NOT end the
 *  correlation: a SaveImage node's file can close after execution_success
 *  has gone past, and clearing here would drop the correlation for exactly
 *  the files that matter most. Same reasoning, same comment, as the
 *  component's noteExecutionSuccess. */
export function noteExecutionSuccess(sessionId: string, promptId: string | null): void {
  if (!promptId) return;
  conn()
    .prepare(
      `UPDATE canvas_pending_iterations
          SET finished_at = datetime('now')
        WHERE session_id = ? AND prompt_id = ?`,
    )
    .run(sessionId, promptId);
}

export interface Attribution {
  prompt: PendingRow | null;
  method: CanvasCorrelationMethod;
  mime: DeclaredMime | null;
}

/**
 * Which prompt a set of bytes belongs to, and how confidently.
 *
 * Filename first — ComfyUI writes `{filename_prefix}_{counter:05}_.ext`
 * (folder_paths.get_save_image_path), so a basename starting with a
 * declared writer prefix is a real link and not a timing guess.
 *
 * Then the most recently started live prompt, labelled 'ws-executing' — a
 * timing link, and the label says so.
 *
 * Then, only when nothing is marked executing at all (the WS sidecar is not
 * connected, so no correlation source exists), insertion order on the
 * pending table, labelled 'most-recent-pending'. That last one is exactly
 * what the pre-WO-10 code did for EVERYTHING, unlabelled.
 */
export function attribute(sessionId: string, basename: string): Attribution {
  const rows = conn()
    .prepare(
      `SELECT * FROM canvas_pending_iterations
        WHERE session_id = ? AND status = 'pending'
        ORDER BY ROWID DESC`,
    )
    .all(sessionId) as PendingRow[];

  const base = basename.split('/').pop() ?? basename;

  for (const row of rows) {
    for (const w of writersOf(row)) {
      const prefix = w.filenamePrefix ? lastSegment(w.filenamePrefix) : null;
      if (prefix && base.startsWith(prefix)) {
        return { prompt: row, method: 'filename-prefix', mime: mimeForNodeClass(w.classType) };
      }
    }
  }

  // Whatever is executing. The WS half is what sets executing_at, so a
  // session whose sidecar never connected has NOTHING marked executing and
  // falls through to the newest pending row — which is a weaker link again,
  // and gets its own name rather than borrowing 'ws-executing'.
  const live =
    rows.find((r) => r.executing_at !== null && r.finished_at === null) ??
    rows.find((r) => r.executing_at !== null) ??
    rows[0] ??
    null;
  if (!live) return { prompt: null, method: 'none', mime: null };
  const method: CanvasCorrelationMethod =
    live.executing_at !== null ? 'ws-executing' : 'most-recent-pending';

  // Only declare a type when the graph leaves no ambiguity about which class
  // wrote it. Two writing classes of different types in one graph plus a
  // timing-based link is not a declaration, it is a coin toss.
  const classes = new Set(writersOf(live).map((w) => w.classType));
  const mime = classes.size === 1 ? mimeForNodeClass([...classes][0]) : null;
  return { prompt: live, method, mime };
}

/** The live prompt for a WS binary frame, which arrived inside it. */
export function attributeFrame(sessionId: string): Attribution {
  const row =
    (conn()
      .prepare(
        `SELECT * FROM canvas_pending_iterations
          WHERE session_id = ? AND status = 'pending' AND executing_at IS NOT NULL
          ORDER BY finished_at IS NULL DESC, ROWID DESC LIMIT 1`,
      )
      .get(sessionId) as PendingRow | undefined) ?? null;
  return row ? { prompt: row, method: 'ws-executing', mime: null } : { prompt: null, method: 'none', mime: null };
}

export function writersOf(row: PendingRow): Writer[] {
  if (!row.writers_json) {
    // Rows written before migration 044 carry no writers. Re-derive from the
    // stored graph rather than treating the workflow as having none — an
    // empty writer list would silently disable filename-prefix attribution
    // and downgrade every legacy row to a timing guess.
    try {
      return writingNodesOf(JSON.parse(row.workflow_api_json));
    } catch {
      return [];
    }
  }
  try {
    return JSON.parse(row.writers_json) as Writer[];
  } catch {
    return [];
  }
}

export function graphOf(row: PendingRow): Record<string, unknown> {
  try {
    const g = JSON.parse(row.workflow_api_json);
    return g && typeof g === 'object' && !Array.isArray(g) ? (g as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function lastSegment(prefix: string): string {
  const parts = prefix.split('/');
  return parts[parts.length - 1] ?? prefix;
}
