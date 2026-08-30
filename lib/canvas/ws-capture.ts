// The WebSocket half of canvas's gate — H-4 §2, path 2.
//
// THIS IS THE HALF CANVAS DID NOT HAVE. `scripts/canvas-ws-proxy.mjs` said
// so in its own header: "WS frames here are pass-through with optional debug
// logging." The grade turned that into condition 1 on canvas's P1 PASS —
// true of the ComfyUI version pinned today, a property of the upstream
// application rather than of our code, and needing "an assertion in the
// baseline, not a comment in a file."
//
// It is now neither. ComfyUI ships a client example whose first line states
// the bypass outright (script_examples/websockets_api_example_ws_images.py:
// "get images directly without them being saved to disk"), and a filesystem
// watcher cannot cover it because there is no file. Canvas has no filesystem
// watcher AT ALL — the Modal container's volume is not mounted into
// scruple-web — so for canvas this is not the second of two surfaces, it is
// the second half of the only one.
//
// FRAME DECODING IS THE COMPONENT'S, IMPORTED, NOT COPIED.
// `decodeBinaryFrame` is `services/scruple-capture/src/surfaces/ws-gate.ts`'s
// exported function, and it reads the framing out of ComfyUI's server.py
// rather than assuming it. The artifact is the image bytes with the framing
// removed — what ComfyUI's own example client keeps as `out[8:]` — so a
// tenant holding the PNG can re-derive the content hash.
//
// ── WHAT IS WITNESSED AND WHAT IS ONLY COUNTED ────────────────────────
//
// Not every binary frame is an artifact. `PreviewImage` streams progress
// previews over the same channel, and a long generation produces hundreds.
// Ingesting each as an iteration would make the gallery unusable and the
// evidence meaningless.
//
// The graph is what separates them, and it is a DECLARATION rather than a
// guess: a prompt whose writing nodes include `SaveImageWebsocket` returns
// its output over WS, and its binary frames are artifacts. Any other prompt's
// binary frames are previews.
//
// THE HOLE THIS LEAVES, NAMED RATHER THAN PAPERED OVER: a custom node that
// returns artifact bytes over WS without being one of the declared WS
// writers is COUNTED and LOGGED, not witnessed. That is C-7's lesson applied
// to the WS surface — the writer list is a denylist that will rot with every
// ComfyUI release — and it is why `wsFrameTally()` exists and why the tally
// is logged on socket close instead of being discarded.

import {
  decodeBinaryFrame,
  PREVIEW_IMAGE,
  PREVIEW_IMAGE_WITH_METADATA,
} from '../../services/scruple-capture/src/surfaces/ws-gate';
import { attributeFrame, noteExecuting, noteExecutionSuccess, writersOf } from './correlate';
import { captureBytes, type CaptureOutcome, type IngestFn } from './witness';

export { decodeBinaryFrame, PREVIEW_IMAGE, PREVIEW_IMAGE_WITH_METADATA };

/**
 * ComfyUI node classes that return retrievable artifact bytes over the
 * WebSocket instead of writing a file. Read out of ComfyUI's own source:
 * `SaveImageWebsocket` in `comfy_extras/nodes_images.py`, the node the
 * shipped example client exists to drive.
 *
 * An enumeration, and therefore a denylist. See the header.
 */
export const WS_ARTIFACT_WRITERS = ['SaveImageWebsocket'] as const;

export interface WsCaptureContext {
  sessionId: string;
  userId: string;
  machineId: string;
  ingest?: IngestFn;
  log?: (line: string) => void;
}

export interface WsFrameTally {
  binaryFrames: number;
  artifacts: number;
  previews: number;
  undecodable: number;
}

const tallies = new Map<string, WsFrameTally>();

export function wsFrameTally(sessionId: string): WsFrameTally {
  let t = tallies.get(sessionId);
  if (!t) {
    t = { binaryFrames: 0, artifacts: 0, previews: 0, undecodable: 0 };
    tallies.set(sessionId, t);
  }
  return t;
}

export function clearWsFrameTally(sessionId: string): WsFrameTally {
  const t = wsFrameTally(sessionId);
  tallies.delete(sessionId);
  return t;
}

/**
 * A text frame from upstream. This is the CORRELATION SOURCE and the only
 * reason the WS leg has to exist at all for provenance: `executing` and
 * `execution_success` are what say which prompt is live, and ComfyUI routes
 * them with broadcast=False to one clientId.
 *
 * Returns true when the frame changed correlation state, which is what the
 * sidecar's debug counter reports.
 */
export function observeUpstreamText(sessionId: string, text: string): boolean {
  let msg: { type?: string; data?: { prompt_id?: string | null } };
  try {
    msg = JSON.parse(text) as typeof msg;
  } catch {
    return false; // not JSON; nothing to correlate
  }
  if (msg.type === 'executing') {
    noteExecuting(sessionId, msg.data?.prompt_id ?? null);
    return true;
  }
  if (msg.type === 'execution_success') {
    noteExecutionSuccess(sessionId, msg.data?.prompt_id ?? null);
    return true;
  }
  return false;
}

export type WsFrameDisposition =
  | { kind: 'forward'; reason: 'not-an-artifact-frame' | 'preview' }
  | { kind: 'forward'; reason: 'captured'; outcome: CaptureOutcome }
  | { kind: 'refuse'; reason: string };

/**
 * A binary frame from upstream.
 *
 * `refuse` means the capture ROW could not be written — the local, cheap
 * half — and the sidecar closes the socket rather than forwarding bytes it
 * cannot admit to having seen. It does NOT mean ingest failed; an ingest
 * failure settles the row as 'failed', is logged at error level, and the
 * frame still goes out. That split is argued at length in
 * lib/canvas/witness.ts's header and is the same split in both legs.
 */
export async function observeUpstreamBinary(
  ctx: WsCaptureContext,
  frame: Buffer,
): Promise<WsFrameDisposition> {
  const log = ctx.log ?? ((l: string) => console.log(l));
  const tally = wsFrameTally(ctx.sessionId);
  tally.binaryFrames++;

  const decoded = decodeBinaryFrame(frame);
  if (!decoded || decoded.payload.length === 0) {
    tally.undecodable++;
    return { kind: 'forward', reason: 'not-an-artifact-frame' };
  }

  const att = attributeFrame(ctx.sessionId);
  const declaresWsWriter =
    att.prompt !== null &&
    writersOf(att.prompt).some((w) =>
      (WS_ARTIFACT_WRITERS as readonly string[]).includes(w.classType),
    );

  if (!declaresWsWriter) {
    tally.previews++;
    return { kind: 'forward', reason: 'preview' };
  }

  tally.artifacts++;
  try {
    const outcome = await captureBytes({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      machineId: ctx.machineId,
      egress: `ws:binary:${decoded.eventType}`,
      surface: 'network-gate-ws',
      // WS artifacts have no filename; attribution is by executing prompt
      // and is labelled 'ws-executing' on the row for exactly that reason.
      filename: '',
      bytes: decoded.payload,
      // Declared in band by the producer: PREVIEW_IMAGE's 4-byte image-type
      // field or PREVIEW_IMAGE_WITH_METADATA's metadata.image_type, which
      // ComfyUI writes itself as a MIME string. Nothing here reads magic
      // bytes.
      mime: decoded.mime,
      ingest: ctx.ingest,
    });
    return { kind: 'forward', reason: 'captured', outcome };
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    log(
      `[canvas-ws-proxy] REFUSING frame session=${ctx.sessionId}: the capture row could not ` +
        `be written (${message}). Closing rather than forwarding bytes nothing recorded.`,
    );
    return { kind: 'refuse', reason: message };
  }
}
