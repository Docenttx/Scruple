// Duty 1b — the WebSocket half of the gate. Surface `network-gate`, fidelity
// `as-delivered`.
//
// THIS IS THE HALF TODAY'S CANVAS PROXY DOES NOT HAVE. scripts/canvas-ws-proxy.mjs
// says so in its own header: "WS frames here are pass-through with optional
// debug logging." Which means the path ComfyUI ships an example client FOR —
//
//   script_examples/websockets_api_example_ws_images.py:1-2
//   "an example that uses the websockets api and the SaveImageWebsocket node
//    to get images directly without them being saved to disk"
//
// — produces bytes that reach the tenant, never become a file, and are seen by
// nothing. A filesystem watcher cannot cover it because there is no file. That
// is H-4 §2's second path, and this file is it.
//
// FRAME FORMAT, read out of server.py rather than assumed (server.py:1126
// encode_bytes, :1136 send_image, :1160 send_image_with_metadata, and
// protocol.py:2 BinaryEventTypes):
//
//   every binary frame:  >I event_type            (4 bytes, big-endian)
//   PREVIEW_IMAGE (1):   >I image_type            (1 = JPEG, 2 = PNG)
//                        then the encoded image bytes
//   PREVIEW_IMAGE_WITH_METADATA (4):
//                        >I metadata_length, metadata JSON, then image bytes.
//                        The metadata carries "image_type" as a MIME string,
//                        which ComfyUI writes itself.
//
// The artifact is the image bytes, not the framing — ComfyUI's own example
// client keeps `out[8:]`. That is what gets hashed, so a tenant holding the
// PNG can re-derive the content_hash. MIME comes from the frame's own
// declaration in both cases; nothing here reads magic bytes.
//
// AND THE SAME FAIL-CLOSED RULE AS THE HTTP HALF: the frame is not forwarded
// until the counter is spent.

import type http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

import type {
  CaptureHook,
  CaptureSurface,
  CaptureSurfaceContext,
  CaptureSurfaceKind,
  ObservationFidelity,
  Placement,
  PlacementEnforcement,
} from '../../../../lib/capture/surface';
import type { Correlator } from '../correlation';
import { mimeForFrameImageType, type DeclaredMime } from '../mime';

export const PREVIEW_IMAGE = 1;
export const UNENCODED_PREVIEW_IMAGE = 2;
export const TEXT = 3;
export const PREVIEW_IMAGE_WITH_METADATA = 4;

export interface DecodedFrame {
  eventType: number;
  /** The artifact bytes, framing removed. */
  payload: Buffer;
  mime: DeclaredMime | null;
}

/**
 * Split a ComfyUI binary frame into its event type and the bytes a client
 * would keep. Returns null for a frame carrying no artifact.
 */
export function decodeBinaryFrame(frame: Buffer): DecodedFrame | null {
  if (frame.length < 8) return null;
  const eventType = frame.readUInt32BE(0);

  if (eventType === PREVIEW_IMAGE) {
    const imageType = frame.readUInt32BE(4);
    return { eventType, payload: frame.subarray(8), mime: mimeForFrameImageType(imageType) };
  }

  if (eventType === PREVIEW_IMAGE_WITH_METADATA) {
    const metaLen = frame.readUInt32BE(4);
    if (8 + metaLen > frame.length) return null;
    const metaRaw = frame.subarray(8, 8 + metaLen).toString('utf8');
    let mime: DeclaredMime | null = null;
    try {
      const meta = JSON.parse(metaRaw) as { image_type?: string };
      // ComfyUI writes metadata["image_type"] as "image/png" | "image/jpeg"
      // (server.py:1170). The producer declaring its own type in band is the
      // strongest form of "declared, never guessed" available on this surface.
      if (typeof meta.image_type === 'string') {
        mime = { mime: meta.image_type, source: 'frame', declaredBy: 'PREVIEW_IMAGE_WITH_METADATA.image_type' };
      }
    } catch {
      /* unparseable metadata leaves the bytes undeclared, never defaulted */
    }
    return { eventType, payload: frame.subarray(8 + metaLen), mime };
  }

  // UNENCODED_PREVIEW_IMAGE never reaches the wire — server.send() converts
  // it to PREVIEW_IMAGE first (server.py:1115). TEXT is control plane.
  return null;
}

export interface WsGateOptions {
  upstreamUrl: string;
  correlator: Correlator;
  log?: (line: string) => void;
  /**
   * Bidirectional keepalive interval, ms. 0 disables.
   *
   * NOT optional in practice. Cloudflare and Modal close an idle tunnel at
   * roughly 100-125s, and a ComfyUI generation is routinely quieter than that
   * between progress frames. Without a ping the socket dies mid-run, the
   * tenant sees a failed generation, and the artifact that was about to be
   * captured never arrives -- so the shape of the bug is a MISSING LEAF, and
   * it reads as a provenance defect rather than as the timeout it is.
   *
   * Found by the canvas retrofit: its WS sidecar has carried a 30s ping since
   * canvas v2 and this gate had none, so adopting the gate verbatim would have
   * silently broken every long generation.
   */
  keepaliveMs?: number;
}

/** Default keepalive: comfortably inside the ~100-125s idle close. */
export const DEFAULT_KEEPALIVE_MS = 30_000;

export class WsGate implements CaptureSurface {
  private ctx: CaptureSurfaceContext | null = null;
  private wss: WebSocketServer | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: WsGateOptions) {
    this.log = opts.log ?? ((l) => console.log(`[ws-gate] ${l}`));
  }

  name(): string {
    return 'comfyui-ws-gate';
  }
  evidenceType(): string {
    return 'scruple.dev/evidence/comfyui-ws-frame/v1';
  }
  surface(): CaptureSurfaceKind {
    return 'network-gate';
  }
  fidelity(): ObservationFidelity {
    return 'as-delivered';
  }
  hooks(): readonly CaptureHook[] {
    return ['artifact.produced'];
  }
  placement(): Placement {
    return 'sidecar-gate';
  }
  enforcement(): PlacementEnforcement {
    return 'isolated-namespace';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        egress: { type: 'string' },
        correlation_method: { type: ['string', 'null'] },
        mime_source: { type: ['string', 'null'] },
      },
    };
  }

  async open(ctx: CaptureSurfaceContext): Promise<void> {
    this.ctx = ctx;
    const server = ctx.config.server as http.Server | undefined;
    if (!server) {
      // §5's rule for surfaces: open() MUST throw if the observation position
      // cannot be acquired. "A surface that silently fails to open is the
      // ComfyUI WS gap by another name" — lib/capture/surface.ts.
      throw new Error('ws-gate: no http server to attach to; refusing to open half-bound');
    }
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (client, req) => this.bridge(client, req));
  }

  async observe(): Promise<void> {}

  async close(): Promise<void> {
    this.wss?.close();
    this.wss = null;
    this.ctx = null;
  }

  private bridge(client: WebSocket, req: http.IncomingMessage): void {
    const ctx = this.ctx;
    if (!ctx) {
      client.close(1011, 'capture surface not open');
      return;
    }

    const inUrl = new URL(req.url ?? '/ws', 'http://gate.invalid');
    const up = new URL(this.opts.upstreamUrl);
    const wsUrl = new URL(
      inUrl.pathname,
      `${up.protocol === 'https:' ? 'wss:' : 'ws:'}//${up.host}`,
    );
    // clientId is load-bearing: ComfyUI keys its socket map by it and routes
    // executing/executed/execution_success with broadcast=False. Drop it and
    // the correlation messages silently stop arriving — the same trap
    // scripts/canvas-ws-proxy.mjs documents.
    inUrl.searchParams.forEach((v, k) => wsUrl.searchParams.set(k, v));

    const upstream = new WebSocket(wsUrl.toString());
    const pendingDown: Array<{ data: RawData; binary: boolean }> = [];
    let upstreamOpen = false;

    upstream.on('open', () => {
      upstreamOpen = true;
      for (const m of pendingDown) upstream.send(m.data as Buffer, { binary: m.binary });
      pendingDown.length = 0;
    });

    // Bidirectional keepalive. Both legs, because either can be the idle one:
    // the tenant's browser may sit silent while ComfyUI works, and ComfyUI may
    // sit silent while the tenant reads. A ping on one leg does not hold the
    // other open.
    const keepaliveMs = this.opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    const keepalive =
      keepaliveMs > 0
        ? setInterval(() => {
            if (upstream.readyState === WebSocket.OPEN) upstream.ping();
            if (client.readyState === WebSocket.OPEN) client.ping();
          }, keepaliveMs)
        : null;
    // unref so a live keepalive cannot hold the process open at shutdown.
    keepalive?.unref?.();
    const stopKeepalive = () => {
      if (keepalive) clearInterval(keepalive);
    };

    // Downstream: upstream → tenant. This is the direction artifacts travel.
    //
    // SERIALISED, one frame at a time. Capturing a binary frame awaits the
    // ratchet, so two frames arriving together would otherwise race and could
    // reach the tenant in the opposite order to the one ComfyUI sent them in.
    // A preview arriving before the `executing` that scopes it would also
    // correlate to the wrong prompt.
    let tail: Promise<void> = Promise.resolve();
    upstream.on('message', (data: RawData, isBinary: boolean) => {
      tail = tail.then(() => this.onUpstreamMessage(client, data, isBinary)).catch((e) => {
        this.log(`downstream frame failed: ${String(e)}`);
      });
    });
    upstream.on('close', () => {
      stopKeepalive();
      if (client.readyState === WebSocket.OPEN) client.close();
    });
    upstream.on('error', (e) => this.log(`upstream error: ${e.message}`));

    client.on('message', (data: RawData, isBinary: boolean) => {
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data as Buffer, { binary: isBinary });
      } else {
        pendingDown.push({ data, binary: isBinary });
      }
    });
    client.on('close', () => {
      stopKeepalive();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });
    client.on('error', (e) => this.log(`client error: ${e.message}`));
  }

  private async onUpstreamMessage(
    client: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    if (!isBinary) {
      // Control plane — and the correlation source (§3, row 4).
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      try {
        const msg = JSON.parse(text) as { type?: string; data?: { prompt_id?: string | null } };
        if (msg.type === 'executing') this.opts.correlator.noteExecuting(msg.data?.prompt_id ?? null);
        if (msg.type === 'execution_success') {
          this.opts.correlator.noteExecutionSuccess(msg.data?.prompt_id ?? null);
        }
      } catch {
        /* not JSON; nothing to correlate */
      }
      if (client.readyState === WebSocket.OPEN) client.send(text);
      return;
    }

    const frame = toBuffer(data);
    const decoded = decodeBinaryFrame(frame);
    if (!decoded || decoded.payload.length === 0) {
      if (client.readyState === WebSocket.OPEN) client.send(frame, { binary: true });
      return;
    }

    const att = this.opts.correlator.attributeFrame();
    try {
      await ctx.sink.emit({
        hook: 'artifact.produced',
        surface: 'network-gate',
        correlationId: att.prompt?.promptId,
        bytes: {
          fidelity: 'as-delivered',
          contentHash: crypto.createHash('sha256').update(decoded.payload).digest('hex'),
          sizeBytes: decoded.payload.length,
          ...(decoded.mime ? { mime: decoded.mime.mime } : {}),
        },
        evidence: {
          egress: `ws:binary:${decoded.eventType}`,
          workflow_hash: att.prompt?.workflowHash ?? null,
          input_hash: att.prompt?.inputHash ?? null,
          correlation_method: att.method,
          mime_source: decoded.mime?.source ?? null,
          kind: 'artifact',
          graph: att.prompt?.graph ?? undefined,
        },
        observedAt: new Date().toISOString(),
      });
    } catch (e) {
      // FAIL CLOSED, same rule as the HTTP half. The frame is the artifact;
      // forwarding it after a failed MAC hands the tenant bytes no leaf
      // covers. Closing the socket is visible to the tenant, which is the
      // point — a capture failure must not be quieter than a capture.
      this.log(`REFUSING ws frame: capture failed (${String(e)})`);
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, 'scruple-capture: could not witness this frame');
      }
      return;
    }

    if (client.readyState === WebSocket.OPEN) client.send(frame, { binary: true });
  }
}

function toBuffer(d: RawData): Buffer {
  if (Buffer.isBuffer(d)) return d;
  if (Array.isArray(d)) return Buffer.concat(d);
  return Buffer.from(d as ArrayBuffer);
}
