// Canvas proxy → witness pipeline, re-platformed onto the capture component.
//
// scruple-web's HTTP proxy (app/canvas-proxy/[sessionId]/[[...path]]/route.ts)
// and its WS sidecar (scripts/canvas-ws-proxy.mjs) observe every byte going
// to and from the user's Modal-hosted ComfyUI container. Those observations
// land here and route into `ingestIteration`, which is still where a canvas
// leaf is built. (Canvas does NOT implement `ObservationSink` — see the note
// further down for why that is a finding about the interface rather than a
// shortcut taken here.)
//
// ═══════════════════════════════════════════════════════════════════════
// WHAT CHANGED IN WO-10, AND WHY THE OLD SHAPE WAS WORSE THAN IT LOOKED
// ═══════════════════════════════════════════════════════════════════════
//
// This file used to end an 80-line capture path with:
//
//     } catch (e) { console.error('[canvas/witness] ingest failed', e); }
//
// The user received their image. No leaf was written. Nothing outside a log
// line knew. `STUDIO_P1-P8_GRADE.md` grades that a Standard §7 violation —
// Phase-3 failures are never silently dropped — and rates it above most of
// the P-item failures it sits beside: "a hole you can see is evidence, a
// hole you cannot see is a lie of omission."
//
// ── FAIL, OR QUEUE AND SURFACE? The argument, not the answer. ──────────
//
// The component's rule (services/scruple-capture/src/submitter.ts) is a
// SPLIT, and it is the split rather than either half that transfers:
//
//     BLOCKING     — the MAC. The gate does not forward a byte until the
//                    ratchet counter is spent and the entry is on disk.
//     NOT BLOCKING — the witness. Capture must not depend on
//                    witness-server health; a failed submission is a queued
//                    submission, and the queue is a file.
//
// That works because the blocking half is LOCAL AND CHEAP: spending a
// counter is an HMAC and an fsync, so failing closed on it is both reliable
// and nearly free. Canvas has no ratchet, so the naive transfer — "fail
// closed on ingest" — copies the wrong half. `ingestIteration` uploads to a
// storage provider and calls the witness server; failing the user's image
// because Drive rate-limited us converts an evidence gap into data loss, on
// an artifact that is the customer's own work rather than an adversary's.
//
// The opposite naive transfer is worse. "Never block, log and move on" is
// exactly the line above, and it is what let canvas hand out unwitnessed
// artifacts for months while every reader of the source believed otherwise.
//
// So canvas splits in the same PLACE the component splits, at the local /
// remote seam it actually has:
//
//   BLOCKING     — the capture ROW. `canvas_capture_log` is written before
//                  the bytes are delivered. It is one local SQLite insert;
//                  if that cannot be written we have no record of any kind,
//                  and delivering bytes we cannot even admit to observing is
//                  the failure mode this work order exists to remove. The
//                  proxy returns 502 and the tenant sees it.
//   NOT BLOCKING — `ingestIteration`. On failure the row settles as
//                  'failed', the bytes are put in the content-addressed
//                  store so a retry has them, the response carries
//                  `X-Scruple-Capture: failed`, and `retryFailedCaptures()`
//                  drains. The bytes go out.
//
// Note that `ingestIteration` ALREADY makes the second choice internally for
// the witness server alone: an unreachable witness lands the row with
// `witnessed=0, leaf_scheme='v1'`. What the old catch swallowed was
// everything OUTSIDE that — the storage throw, the DB error, the missing
// project. The queue is now in the failure path by construction, which is
// the canon's answer for the SDK, applied at the seam canvas has rather
// than the seam the component has.
//
// The one thing that is NOT a decision: silence. Every outcome writes a row,
// every failure logs at error level, and `openCaptureFailures()` exposes the
// backlog so a surface can show it. A hole you can see is evidence.

import { conn } from '@/lib/db/sqlite';
import { ingestIteration, type OutputKind } from '@/lib/iterations/ingest';
import { readArtifact, storeArtifact } from '@/lib/scruple/artifacts';
import { sha256Hex } from '@/lib/scruple/hash';
import {
  assuranceForHost,
  type HostAssurance,
  type HostCaptureProfile,
} from '@/lib/capture/surface';
import type { DeclaredMime } from '../../services/scruple-capture/src/mime';
import { isControlPlane } from './egress';
import {
  attribute,
  graphOf,
  openPrompt,
  referencedInputNames,
  type CanvasCorrelationMethod,
  type PendingRow,
} from './correlate';

export type CaptureStatus = 'witnessed' | 'failed' | 'unwitnessed' | 'refetch';

export interface CaptureOutcome {
  captureLogId: number;
  status: CaptureStatus;
  contentHash: string;
  correlationMethod: CanvasCorrelationMethod;
  promptId: string | null;
  iterationId: number | null;
  leafHash: string | null;
  witnessed: boolean;
  /** Response header value. Never absent — a capture that produced nothing
   *  worth saying is still a capture the caller should be able to see. */
  header: string;
  error: string | null;
}

/**
 * WHAT CANVAS CAN CLAIM, declared rather than inferred, and logged where an
 * operator reads it.
 *
 * `attestation: 'none'` is the whole of P7. Modal offers no hardware
 * attestation, `provider: none` is the correct declaration, and P7
 * explicitly permits it — canvas failed P7 only because there was no
 * manifest to declare it in. `lib/canvas/baseline.ts` is that manifest.
 *
 * `surfaces` names ONE, and that is the honest difference between canvas and
 * the sidecar: canvas is a network gate with no filesystem watcher, because
 * the Modal container's `output/`, `temp/` and `input/` are not mounted into
 * scruple-web and cannot be. See CANVAS_BASELINE.md §3 for what that costs.
 */
export function canvasCaptureProfile(): HostCaptureProfile {
  return {
    host: 'comfyui',
    hooks: ['graph.execute', 'artifact.produced'],
    surfaces: ['network-gate'],
    fidelity: 'as-delivered',
    declaredPlacement: 'sidecar-gate',
    enforcement: 'isolated-namespace',
    attestation: 'none',
  };
}

export function canvasAssurance(): HostAssurance {
  return assuranceForHost(canvasCaptureProfile());
}

/**
 * Record that a workflow has been queued. Called the moment the proxy sees a
 * POST /prompt come back with a prompt_id.
 */
export function startWorkflow(opts: {
  sessionId: string;
  userId: string;
  promptId: string;
  projectId: number;
  workflowApiJson: Record<string, unknown>;
}): void {
  const writers = openPrompt(opts);
  console.log(
    `[canvas/witness] prompt ${opts.promptId} writers=` +
      `${writers.map((w) => w.classType).join(',') || '(none)'}`,
  );
}

export type IngestFn = typeof ingestIteration;

/**
 * THE PRODUCTION SINK, named so that the call site is greppable.
 *
 * `captureBytes` takes an optional `ingest` so a test can drive the failure
 * path without a storage provider and a witness server. That injection point
 * would otherwise hide the one line that says what canvas actually does with
 * a captured artifact — and `packages/scruple-conformance` grades canvas's P5
 * by looking for exactly this call. A seam that makes the real behaviour
 * unreadable is a seam in the wrong place, so the default is a named function
 * rather than an inline `?? ingestIteration`.
 */
async function ingestDefault(p: Parameters<IngestFn>[0]): ReturnType<IngestFn> {
  return await ingestIteration(p);
}

export interface CaptureBytesOptions {
  sessionId: string;
  userId: string;
  machineId: string;
  /** The route the bytes left on, or `ws:binary:<eventType>`. */
  egress: string;
  surface: 'network-gate-http' | 'network-gate-ws';
  filename: string;
  bytes: Buffer;
  /** DECLARED, NEVER GUESSED. null means undeclared, and undeclared is a
   *  state the row records rather than a gap it fills. */
  mime: DeclaredMime | null;
  /** Injection seam for tests. Production always uses ingestIteration. */
  ingest?: IngestFn;
}

/**
 * The one capture entry point. Both legs of the gate call this.
 *
 * Throws ONLY when the capture row cannot be written. The proxy treats that
 * as fail-closed and refuses to deliver the bytes; see the header of this
 * file for why that is the line and `ingestIteration` failing is not.
 */
export async function captureBytes(opts: CaptureBytesOptions): Promise<CaptureOutcome> {
  const ingest = opts.ingest ?? ingestDefault;
  const contentHash = sha256Hex(opts.bytes);
  const att = attribute(opts.sessionId, opts.filename);
  // MIME PRECEDENCE, per surface, and it matches the component's rather
  // than improving on it.
  //
  // `opts.mime` is the TRANSPORT's declaration about THESE bytes: on the
  // HTTP leg ComfyUI's response content-type, which it sets from the file it
  // is serving; on the WS leg the frame's own `image_type` field, which
  // ComfyUI writes itself (server.py send_image / send_image_with_metadata).
  // The component uses exactly these two, one per gate half.
  //
  // `att.mime` is the WRITING NODE's class declaration, read out of the graph
  // the tenant submitted — "SaveImage writes PNG because SaveImage writes
  // PNG" — and it is the FALLBACK, used when the transport declared nothing
  // (an `application/octet-stream` response is the shape of "we did not
  // know", and mimeFromUpstream returns null for it rather than passing a
  // non-declaration through as a declaration).
  //
  // Neither is a sniff, neither is an extension lookup, and null stays null:
  // CANON_SKELETON §5 property 1, and migration 043's mime_declared is where
  // the null lands.
  const mime = opts.mime ?? att.mime ?? null;

  // ── The blocking half. One local insert, before any byte is delivered. ──
  const logId = insertCaptureRow({
    sessionId: opts.sessionId,
    userId: opts.userId,
    promptId: att.prompt?.prompt_id ?? null,
    surface: opts.surface,
    egress: opts.egress,
    contentHash,
    sizeBytes: opts.bytes.length,
    mime,
    correlationMethod: att.method,
    // Provisional. Settled below, in every branch, including the throwing one.
    status: 'unwitnessed',
  });

  if (!att.prompt) {
    // No workflow to attribute these bytes to. Two very different things
    // wear that shape, and conflating them is what made the old `return`
    // look harmless: a thumbnail reload of an artifact we already witnessed,
    // and a NEW artifact leaving through a route nothing watched.
    const known = priorIteration(opts.userId, contentHash);
    const status: CaptureStatus = known ? 'refetch' : 'unwitnessed';
    settle(logId, { status, iterationId: known, error: null });
    if (status === 'unwitnessed') {
      console.error(
        `[canvas/witness] UNWITNESSED EGRESS session=${opts.sessionId} ${opts.egress} ` +
          `sha256=${contentHash.slice(0, 12)} bytes=${opts.bytes.length} — bytes left the gate ` +
          'with no pending workflow to attribute them to and no prior iteration carrying this ' +
          'content hash. Recorded as a hole rather than dropped (Standard §7).',
      );
    }
    return outcome(logId, status, contentHash, att, null, null, false, null);
  }

  const pending = att.prompt;
  const outputKind = outputKindFor(opts.filename, mime?.mime ?? null);
  const machineManifestHash = manifestHashFor(opts.userId);

  try {
    const result = await ingest({
      userId: opts.userId,
      projectId: pending.project_id,
      provider: 'comfydeploy',
      providerJobId: pending.prompt_id,
      prompt: '(canvas workflow / modal)',
      spec: {
        prompt: '(canvas workflow)',
        providerExtras: { workflowApiJson: graphOf(pending) },
      },
      imageBytes: opts.bytes,
      // ingestIteration's contract still wants a content-type string. An
      // undeclared MIME reaches it as application/octet-stream and the ROW
      // says mime IS NULL, which is the distinction migration 043 made for
      // the component and the one that must not be lost here: "no modality
      // is applicable, and here is why" rather than known-to-be-bytes.
      imageContentType: mime?.mime ?? 'application/octet-stream',
      imageFilename: opts.filename,
      outputKind,
      executionBackend: 'modal-test',
      // P7. No hardware attestation on Modal; `none` declared in
      // lib/canvas/baseline.ts rather than asserted as null here.
      executionAttestation: null,
      computeMachineId: opts.machineId,
      machineManifestHash,
    });

    conn()
      .prepare(
        `UPDATE canvas_pending_iterations SET status = 'done'
          WHERE session_id = ? AND prompt_id = ?`,
      )
      .run(opts.sessionId, pending.prompt_id);

    settle(logId, {
      status: 'witnessed',
      iterationId: result.iteration.id,
      leafHash: result.leafHash,
      witnessed: result.witnessed,
      leafScheme: result.leafScheme,
      error: null,
    });

    console.log(
      `[canvas/witness] iter=${result.iteration.id} run=${result.runSequence} ` +
        `leaf=${result.leafHash.slice(0, 12)}… witnessed=${result.witnessed} ` +
        `scheme=${result.leafScheme} correlation=${att.method}`,
    );
    return outcome(
      logId,
      'witnessed',
      contentHash,
      att,
      result.iteration.id,
      result.leafHash,
      result.witnessed,
      null,
    );
  } catch (e) {
    // ── The non-blocking half, and it is LOUD. ────────────────────────
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);

    // Keep the bytes so the retry has something to retry WITH. Without this
    // the queue would hold a promise it cannot keep — the failure would be
    // visible and permanently unfixable, which is only half of the point.
    let retained = true;
    try {
      storeArtifact(contentHash, opts.bytes);
    } catch (storeErr) {
      retained = false;
      console.error(
        `[canvas/witness] could not retain bytes for retry sha256=${contentHash.slice(0, 12)}:`,
        storeErr,
      );
    }

    settle(logId, { status: 'failed', error: message, attempts: 1 });

    console.error(
      `[canvas/witness] INGEST FAILED capture_log=${logId} session=${opts.sessionId} ` +
        `prompt=${pending.prompt_id} sha256=${contentHash.slice(0, 12)} ` +
        `retained=${retained} — the artifact WILL be delivered and NO leaf exists for it. ` +
        'Row canvas_capture_log.status=failed is the record; retryFailedCaptures() drains it. ' +
        `Cause: ${message}`,
    );

    return outcome(logId, 'failed', contentHash, att, null, null, false, message);
  }
}

/**
 * MIME as ComfyUI declared it on the response.
 *
 * On /view ComfyUI sets the content type from the file it is serving, which
 * is a declaration by the producing host and not a sniff by us. A
 * control-plane type is not a declaration ABOUT AN ARTIFACT and returns
 * null; nothing here reads an extension or magic bytes.
 */
export function mimeFromUpstream(contentType: string | null, egress: string): DeclaredMime | null {
  const ct = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!ct) return null;
  // `application/octet-stream` is the SHAPE of "we did not know", not a
  // declaration that these are opaque bytes. Migration 043 made exactly this
  // distinction for the component: five of the six shells sent
  // octet-stream and the ingest contract could not tell that apart from a
  // real type. Returning null lets the writing node's class declare instead,
  // and leaves it undeclared if nothing can.
  if (ct === 'application/octet-stream') return null;
  // The control-plane list is egress.ts's, imported rather than copied — a
  // second list would be a second answer to "is this an artifact".
  if (isControlPlane(ct)) return null;
  return { mime: ct, source: 'node', declaredBy: `upstream content-type on ${egress}` };
}

export interface OpenCaptureFailure {
  id: number;
  session_id: string;
  prompt_id: string | null;
  egress: string;
  content_hash: string;
  attempts: number;
  error: string | null;
  observed_at: string;
}

/** Open capture failures for a user — the surface that makes the hole
 *  visible to something other than a log file. */
export function openCaptureFailures(userId: string, limit = 50): OpenCaptureFailure[] {
  return conn()
    .prepare(
      `SELECT id, session_id, prompt_id, egress, content_hash, attempts, error, observed_at
         FROM canvas_capture_log
        WHERE user_id = ? AND status = 'failed'
        ORDER BY observed_at DESC LIMIT ?`,
    )
    .all(userId, limit) as OpenCaptureFailure[];
}

/**
 * Drain the failure queue. Reads the retained bytes back out of the
 * content-addressed store and re-runs ingest, preserving the original
 * content hash — a retry that re-hashed would be a different artifact.
 */
export async function retryFailedCaptures(opts: {
  limit?: number;
  ingest?: IngestFn;
  readBytes?: (hash: string) => Buffer | null;
} = {}): Promise<{ retried: number; recovered: number; stillFailed: number }> {
  const ingest = opts.ingest ?? ingestDefault;
  const readBytes = opts.readBytes ?? readArtifact;

  const rows = conn()
    .prepare(
      `SELECT * FROM canvas_capture_log
        WHERE status = 'failed'
        ORDER BY observed_at ASC LIMIT ?`,
    )
    .all(opts.limit ?? 25) as Array<{
    id: number;
    session_id: string;
    user_id: string;
    prompt_id: string | null;
    egress: string;
    content_hash: string;
    mime: string | null;
    attempts: number;
  }>;

  let recovered = 0;
  let stillFailed = 0;

  for (const row of rows) {
    const bytes = readBytes(row.content_hash);
    if (!bytes) {
      bumpAttempt(row.id, 'bytes were not retained; this capture cannot be recovered');
      stillFailed++;
      continue;
    }
    const pending = conn()
      .prepare(
        `SELECT * FROM canvas_pending_iterations WHERE session_id = ? AND prompt_id = ?`,
      )
      .get(row.session_id, row.prompt_id) as PendingRow | undefined;
    if (!pending) {
      bumpAttempt(row.id, 'pending workflow row is gone; cannot re-attribute');
      stillFailed++;
      continue;
    }
    try {
      const result = await ingest({
        userId: row.user_id,
        projectId: pending.project_id,
        provider: 'comfydeploy',
        providerJobId: pending.prompt_id,
        prompt: '(canvas workflow / modal)',
        spec: {
          prompt: '(canvas workflow)',
          providerExtras: { workflowApiJson: graphOf(pending) },
        },
        imageBytes: bytes,
        imageContentType: row.mime ?? 'application/octet-stream',
        imageFilename: null,
        outputKind: outputKindFor('', row.mime),
        executionBackend: 'modal-test',
        executionAttestation: null,
        computeMachineId: null,
        machineManifestHash: manifestHashFor(row.user_id),
      });
      conn()
        .prepare(
          `UPDATE canvas_pending_iterations SET status = 'done'
            WHERE session_id = ? AND prompt_id = ?`,
        )
        .run(row.session_id, pending.prompt_id);
      settle(row.id, {
        status: 'witnessed',
        iterationId: result.iteration.id,
        leafHash: result.leafHash,
        witnessed: result.witnessed,
        leafScheme: result.leafScheme,
        error: null,
        attempts: row.attempts + 1,
      });
      recovered++;
    } catch (e) {
      bumpAttempt(row.id, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      stillFailed++;
    }
  }

  return { retried: rows.length, recovered, stillFailed };
}

/** Resolve the active project for a user (matches getActiveProject() but
 *  callable from the proxy without the AsyncLocalStorage userId() wrap). */
export function resolveActiveProjectId(userId: string): number | null {
  const row = conn()
    .prepare(`SELECT id FROM projects WHERE user_id = ? AND is_active = 1 LIMIT 1`)
    .get(userId) as { id: number } | undefined;
  return row?.id ?? null;
}

/*
 * WHY THERE IS NO `ObservationSink` IMPLEMENTATION HERE, and it is a finding
 * rather than an omission.
 *
 * `lib/capture/surface.ts`'s `ObservationSink.emit(o: CaptureObservation)` is
 * ZERO-CONTENT BY DESIGN — `ObservedBytes` carries a `contentHash`, a size
 * and a declared MIME, and no payload. That is P6, and it is correct for the
 * component, whose sink builds a leaf out of hashes and posts it.
 *
 * Canvas's sink is `ingestIteration`, which STORES THE ARTIFACT: it writes
 * the bytes to the user's connected storage provider and to the
 * content-addressed store, because canvas is the user's gallery as well as
 * their provenance. A sink that receives only a hash cannot do that.
 *
 * So canvas consumes the component's OBSERVATION side — its route table, its
 * frame decoder, its MIME declarations, its correlator — and cannot consume
 * its SINK side, and the reason is a genuine difference in what the two
 * products are for rather than a shortcut. Forcing `captureBytes` through
 * `emit()` would mean either smuggling bytes through `evidence` (which
 * violates the zero-content property the interface exists to hold) or
 * fetching the artifact back from storage that has not been written yet.
 *
 * If a future canon wants one interface for both, the seam is a
 * `ByteRetainingSink` alongside `ObservationSink`, declared in
 * lib/capture/surface.ts, which is not this work order's file to change.
 */

// ───────────────────────────────────────────────────────────────────────
// Rows
// ───────────────────────────────────────────────────────────────────────

function insertCaptureRow(r: {
  sessionId: string;
  userId: string;
  promptId: string | null;
  surface: string;
  egress: string;
  contentHash: string;
  sizeBytes: number;
  mime: DeclaredMime | null;
  correlationMethod: CanvasCorrelationMethod;
  status: CaptureStatus;
}): number {
  const info = conn()
    .prepare(
      `INSERT INTO canvas_capture_log
         (session_id, user_id, prompt_id, surface, egress, content_hash, size_bytes,
          mime, mime_source, correlation_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.sessionId,
      r.userId,
      r.promptId,
      r.surface,
      r.egress,
      r.contentHash,
      r.sizeBytes,
      r.mime?.mime ?? null,
      r.mime?.source ?? null,
      r.correlationMethod,
      r.status,
    );
  return Number(info.lastInsertRowid);
}

function settle(
  id: number,
  s: {
    status: CaptureStatus;
    iterationId?: number | null;
    leafHash?: string | null;
    witnessed?: boolean;
    leafScheme?: string | null;
    error: string | null;
    attempts?: number;
  },
): void {
  conn()
    .prepare(
      `UPDATE canvas_capture_log
          SET status = ?, iteration_id = ?, leaf_hash = ?, witnessed = ?, leaf_scheme = ?,
              error = ?, attempts = COALESCE(?, attempts), settled_at = datetime('now')
        WHERE id = ?`,
    )
    .run(
      s.status,
      s.iterationId ?? null,
      s.leafHash ?? null,
      s.witnessed ? 1 : 0,
      s.leafScheme ?? null,
      s.error,
      s.attempts ?? null,
      id,
    );
}

function bumpAttempt(id: number, error: string): void {
  conn()
    .prepare(
      `UPDATE canvas_capture_log SET attempts = attempts + 1, error = ?,
              settled_at = datetime('now')
        WHERE id = ?`,
    )
    .run(error, id);
}

function priorIteration(userId: string, contentHash: string): number | null {
  const row = conn()
    .prepare(
      `SELECT i.id FROM iterations i
         JOIN projects p ON p.id = i.project_id
        WHERE i.output_hash = ? AND p.user_id = ?
        LIMIT 1`,
    )
    .get(contentHash, userId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Machine manifest hash for the v2.2 leaf preimage.
 *
 * The `user_id IS NULL` fallback is condition 3 on canvas's P1 PASS in the
 * grade: only the default machine's manifest is pinned, and a null hash
 * degrades the leaf to v2 SILENTLY. It still degrades — changing that is
 * WO-7's decision to take, not this one's — but it no longer does so
 * silently.
 */
function manifestHashFor(userId: string): string | null {
  const row = conn()
    .prepare(
      `SELECT manifest_hash FROM machines
        WHERE (user_id = ? OR user_id IS NULL)
          AND archived_at IS NULL
        ORDER BY user_id IS NULL ASC, created_at DESC LIMIT 1`,
    )
    .get(userId) as { manifest_hash: string } | undefined;
  if (!row?.manifest_hash) {
    console.warn(
      `[canvas/witness] no machine manifest for ${userId} — the leaf will carry no ` +
        'machine_manifest_hash and degrade below v2.2. Grade condition 3 on canvas P1.',
    );
    return null;
  }
  return row.manifest_hash;
}

/**
 * Output kind, from the DECLARED mime first and the filename only as a last
 * resort. The old code read the extension exclusively, which is the one
 * inference CANON_SKELETON §5 property 1 forbids for MIME — `outputKind` is
 * a storage-layout choice rather than a provenance claim, so an extension is
 * admissible here, but the declaration wins when there is one.
 */
export function outputKindFor(filename: string, mime: string | null): OutputKind {
  if (mime) {
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/octet-stream') {
      /* undeclared-shaped; fall through to the filename */
    } else if (mime.startsWith('image/') || mime.startsWith('audio/')) {
      return 'image';
    }
  }
  if (/\.(mp4|webm|mov)$/i.test(filename)) return 'video';
  if (/\.(safetensors|ckpt)$/i.test(filename)) return 'checkpoint';
  return 'image';
}

function outcome(
  captureLogId: number,
  status: CaptureStatus,
  contentHash: string,
  att: { prompt: PendingRow | null; method: CanvasCorrelationMethod },
  iterationId: number | null,
  leafHash: string | null,
  witnessed: boolean,
  error: string | null,
): CaptureOutcome {
  return {
    captureLogId,
    status,
    contentHash,
    correlationMethod: att.method,
    promptId: att.prompt?.prompt_id ?? null,
    iterationId,
    leafHash,
    witnessed,
    error,
    header: `${status}; id=${captureLogId}; sha256=${contentHash.slice(0, 16)}`,
  };
}

export { referencedInputNames };
