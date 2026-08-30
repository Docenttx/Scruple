// Duty 1a — the HTTP half of the gate. Surface `network-gate`, fidelity
// `as-delivered` (lib/capture/surface.ts): the bytes hashed are the exact
// bytes the consumer received, so a third party holding the artifact can
// re-hash it and match the leaf.
//
// THE ONE ROUTE TO THE TENANT. §2 obligation 1. The tenant never learns the
// upstream URL; it is never echoed into a header, a redirect or an error body.
//
// ---------------------------------------------------------------------------
// WHAT §3'S ROUTE TABLE MISSES, and why this file does not simply implement it
// ---------------------------------------------------------------------------
//
// §3 enumerates two gate triggers: POST /prompt and GET /view. Reading the
// ComfyUI at /data/reference/ui-inspire/ComfyUI, that enumeration is
// incomplete. Every one of these returns retrievable artifact bytes through
// the same gate:
//
//   GET /view                                  server.py:501    — §3 has this
//   GET /userdata/{file}                       app/user_manager.py:334
//        web.FileResponse over the user directory. POST /userdata/{file}
//        (:342) writes arbitrary bytes there first, so it is a complete
//        store-and-retrieve path that touches neither `output/` nor /view.
//   GET /api/assets/{id}/content               app/assets/api/routes.py:269
//        Live only with --enable-assets, and the tenant chooses the flag in
//        a bring-your-own-container configuration.
//   GET /experiment/models/preview/{folder}/{path_index}/{filename}
//                                              app/model_manager.py:52
//   GET /internal/files/{directory_type}       api_server/routes/internal/
//        internal_routes.py:54 — listing, not content, but it enumerates
//        output/input/temp for a tenant deciding what to fetch.
//
// An enumeration is a denylist wearing an allowlist's clothes, so the list
// below is paired with a TRIPWIRE: any other 2xx response carrying a
// non-control-plane content type is counted and logged as `unenumerated`,
// so the next ComfyUI release that adds a route surfaces as a log line rather
// than as a silence. The tripwire does not capture, because ComfyUI serves
// its own frontend (web.static('/', web_root), server.py:1104) and every UI
// icon would otherwise spend a ratchet counter.
//
// ---------------------------------------------------------------------------
// WHAT NEITHER SURFACE COVERS AT ALL — say it here, in the code
// ---------------------------------------------------------------------------
//
// This is an INGRESS gate. ComfyUI's own OUTBOUND network is not on it.
// comfy_api_nodes/ ships ~25 node packs that open aiohttp sessions to
// external services from inside the ComfyUI process (e.g.
// comfy_api_nodes/nodes_topaz.py:421), and a custom node can POST an image
// anywhere. Those bytes leave through neither the gate nor the output volume.
// §2's topology requirements constrain what can reach ComfyUI; they say
// nothing about what ComfyUI can reach. A vendor must deny egress from the
// workload container, and that obligation belongs in §2 as a fourth item.

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';

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
import { mimeFromVendorConfig, type DeclaredMime } from '../mime';

/** Routes known to return artifact bytes. Suffix-matched so the `/api/`
 *  prefix modern ComfyUI adds to both spellings is covered once. */
const BYTE_EGRESS = [
  /^\/(api\/)?view$/,
  /^\/(api\/)?userdata\/.+$/,
  /^\/api\/assets\/[0-9a-fA-F-]{36}\/content$/,
  /^\/(api\/)?experiment\/models\/preview\/.+$/,
];

/** Content types that are control plane, not artifact. Everything else on a
 *  2xx is either captured (on an egress route) or tripped (anywhere else). */
const CONTROL_PLANE = [
  'application/json',
  'text/html',
  'text/css',
  'text/plain',
  'text/javascript',
  'application/javascript',
  'application/manifest+json',
];

export interface HttpGateOptions {
  upstreamUrl: string;
  correlator: Correlator;
  outputVolumeDeclaredMime: string | null;
  log?: (line: string) => void;
}

export class HttpGate implements CaptureSurface {
  private ctx: CaptureSurfaceContext | null = null;
  private readonly log: (line: string) => void;
  /** Responses that left with binary bytes on a route nobody enumerated. */
  readonly unenumeratedEgress: Array<{ path: string; contentType: string }> = [];

  constructor(private readonly opts: HttpGateOptions) {
    this.log = opts.log ?? ((l) => console.log(`[http-gate] ${l}`));
  }

  name(): string {
    return 'comfyui-http-gate';
  }
  evidenceType(): string {
    return 'scruple.dev/evidence/comfyui-http-gate/v1';
  }
  surface(): CaptureSurfaceKind {
    return 'network-gate';
  }
  fidelity(): ObservationFidelity {
    return 'as-delivered';
  }
  hooks(): readonly CaptureHook[] {
    return ['graph.execute', 'artifact.produced'];
  }
  placement(): Placement {
    return 'sidecar-gate';
  }
  enforcement(): PlacementEnforcement {
    // DECLARED, and resolvePlacement() is what decides whether the
    // declaration survives. The component cannot verify its own namespace
    // isolation from inside it; H-4 §7 probes 1 and 2 are what check it.
    return 'isolated-namespace';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        egress: { type: 'string' },
        workflow_hash: { type: ['string', 'null'] },
        input_hash: { type: ['string', 'null'] },
        correlation_method: { type: ['string', 'null'] },
        mime_source: { type: ['string', 'null'] },
      },
    };
  }

  async open(ctx: CaptureSurfaceContext): Promise<void> {
    this.ctx = ctx;
  }
  async observe(): Promise<void> {
    // Driven by handle(); there is nothing to pump.
  }
  async close(): Promise<void> {
    this.ctx = null;
  }

  /** Wire into a node http server's 'request' event. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) {
      res.writeHead(503).end('capture surface not open');
      return;
    }

    const reqUrl = new URL(req.url ?? '/', 'http://gate.invalid');
    const routePath = reqUrl.pathname;
    const upstream = new URL(this.opts.upstreamUrl);
    const target = new URL(routePath + reqUrl.search, upstream.origin);

    const body = await readBody(req);

    // ---- tee: input bytes -------------------------------------------
    // The only moment the gate holds an input artifact. POST /upload/image
    // (server.py:449) and /upload/mask (:455).
    const isUpload = /^\/(api\/)?upload\/(image|mask)$/.test(routePath) && req.method === 'POST';

    // ---- tee: the workflow ------------------------------------------
    const isPrompt = /^\/(api\/)?prompt$/.test(routePath) && req.method === 'POST';

    const captureBytes = req.method === 'GET' && BYTE_EGRESS.some((r) => r.test(routePath));

    let upstreamRes: { status: number; headers: http.IncomingHttpHeaders; body: Buffer } | null =
      null;

    // A captured route is BUFFERED, never streamed. The client must not hold
    // a byte before the counter is spent; streaming and hashing in flight
    // would deliver the artifact and the leaf concurrently, and a crash
    // between them leaves an artifact with no leaf.
    if (captureBytes || isPrompt || isUpload) {
      upstreamRes = await proxyBuffered(target, req, body);
    } else {
      await proxyStreamed(target, req, body, res, (status, headers) => {
        this.tripwire(routePath, status, headers);
      });
      return;
    }

    // ---- POST /prompt: open the pending record ----------------------
    if (isPrompt && upstreamRes.status < 400) {
      try {
        const graph = JSON.parse(body.toString('utf8')) as unknown;
        const out = JSON.parse(upstreamRes.body.toString('utf8')) as { prompt_id?: string };
        if (out.prompt_id) {
          const rec = this.opts.correlator.openPrompt(out.prompt_id, graph);
          this.log(
            `prompt ${out.prompt_id} workflow_hash=${rec.workflowHash?.slice(0, 12)} ` +
              `writers=${rec.writers.map((w) => w.classType).join(',') || '(none)'}`,
          );
        }
      } catch (e) {
        // A prompt whose graph we could not read is a prompt whose outputs
        // will correlate by timing only. Logged, not fatal: refusing the
        // prompt would make a parse bug into an outage.
        this.log(`POST /prompt tee failed: ${String(e)}`);
      }
    }

    // ---- POST /upload/image: register the input bytes ---------------
    if (isUpload && upstreamRes.status < 400) {
      const part = extractUploadedFile(req.headers['content-type'], body);
      if (part) {
        try {
          const out = JSON.parse(upstreamRes.body.toString('utf8')) as {
            name?: string;
            subfolder?: string;
          };
          const name = out.subfolder ? `${out.subfolder}/${out.name}` : out.name;
          if (name) {
            this.opts.correlator.recordInputBytes(name, sha256(part));
            this.log(`input ${name} sha256=${sha256(part).slice(0, 12)}`);
          }
        } catch {
          /* upload response was not the JSON we expected; input stays unknown */
        }
      }
    }

    // ---- GET on an egress route: hash, MAC, THEN deliver ------------
    if (captureBytes && upstreamRes.status === 200 && upstreamRes.body.length > 0) {
      const declared = this.declaredMimeFor(routePath, upstreamRes.headers);
      const contentHash = sha256(upstreamRes.body);
      const filename = reqUrl.searchParams.get('filename') ?? routePath.split('/').pop() ?? '';
      const att = this.opts.correlator.attribute(filename);

      try {
        await ctx.sink.emit({
          hook: 'artifact.produced',
          surface: 'network-gate',
          correlationId: att.prompt?.promptId,
          bytes: {
            fidelity: 'as-delivered',
            contentHash,
            sizeBytes: upstreamRes.body.length,
            ...(declared ? { mime: declared.mime } : {}),
          },
          evidence: {
            egress: routePath,
            workflow_hash: att.prompt?.workflowHash ?? null,
            input_hash: att.prompt?.inputHash ?? null,
            correlation_method: att.method,
            mime_source: declared?.source ?? null,
            kind: 'artifact',
            graph: att.prompt?.graph ?? undefined,
          },
          observedAt: new Date().toISOString(),
        });
      } catch (e) {
        // FAIL CLOSED. The counter could not be spent, so no leaf covers
        // these bytes, so the bytes do not leave. This is the only place the
        // component is allowed to break the tenant's workflow, and it is the
        // place where not breaking it would mean shipping an unwitnessed
        // artifact.
        this.log(`REFUSING ${routePath}: capture failed (${String(e)})`);
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('scruple-capture: refusing to deliver bytes it could not witness\n');
        return;
      }
    }

    this.tripwire(routePath, upstreamRes.status, upstreamRes.headers, captureBytes);
    writeUpstream(res, upstreamRes);
  }

  /**
   * MIME, declared. On /view ComfyUI sets the response content type from the
   * file it is serving, which is a declaration by the producing host and not
   * a sniff by us. Where it does not, the vendor's blanket declaration for
   * the output volume applies, and where there is none the bytes stay
   * undeclared.
   */
  private declaredMimeFor(
    routePath: string,
    headers: http.IncomingHttpHeaders,
  ): DeclaredMime | null {
    const ct = String(headers['content-type'] ?? '').split(';')[0].trim();
    if (ct && !CONTROL_PLANE.includes(ct)) {
      return { mime: ct, source: 'node', declaredBy: `upstream content-type on ${routePath}` };
    }
    return mimeFromVendorConfig(this.opts.outputVolumeDeclaredMime);
  }

  private tripwire(
    routePath: string,
    status: number,
    headers: http.IncomingHttpHeaders,
    captured = false,
  ): void {
    if (captured || status !== 200) return;
    const ct = String(headers['content-type'] ?? '').split(';')[0].trim();
    if (!ct || CONTROL_PLANE.includes(ct)) return;
    if (BYTE_EGRESS.some((r) => r.test(routePath))) return;
    this.unenumeratedEgress.push({ path: routePath, contentType: ct });
    this.log(
      `UNENUMERATED BINARY EGRESS ${routePath} (${ct}). Not captured — ComfyUI serves its ` +
        'own frontend on / and every icon would burn a counter. If this is an artifact ' +
        'route, it belongs in BYTE_EGRESS and in H-4 §3.',
    );
  }
}

// ---------------------------------------------------------------------------
// Proxy plumbing
// ---------------------------------------------------------------------------

function outboundHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const h: http.OutgoingHttpHeaders = { ...req.headers };
  delete h.host;
  delete h.connection;
  // Identity encoding upstream: a gzipped body would hash to something no
  // holder of the artifact could reproduce, and `as-delivered` fidelity means
  // the bytes the consumer keeps.
  h['accept-encoding'] = 'identity';
  return h;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Pick the right request implementation for the upstream scheme.
 *
 * `http.request({protocol: 'https:'})` does not fall back to TLS -- it throws
 * ERR_INVALID_PROTOCOL. The component therefore could not proxy to any https
 * upstream at all, which is every hosted ComfyUI that is not a bare container
 * on the same host. Found by the canvas retrofit trying to point this gate at
 * Modal (https) and getting a throw rather than a connection.
 *
 * Kept as one function so both proxy paths cannot drift on this.
 */
function requesterFor(target: URL): typeof http.request {
  if (target.protocol === 'https:') return https.request as typeof http.request;
  if (target.protocol === 'http:') return http.request;
  // Refuse rather than guess. An upstream we cannot name a transport for is a
  // configuration error, and defaulting to cleartext would be the wrong guess.
  throw new Error(
    `scruple-capture: unsupported upstream protocol '${target.protocol}' ` +
      `(expected http: or https:)`,
  );
}

function proxyBuffered(
  target: URL,
  req: http.IncomingMessage,
  body: Buffer,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const up = requesterFor(target)(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: outboundHeaders(req),
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () =>
          resolve({ status: r.statusCode ?? 502, headers: r.headers, body: Buffer.concat(chunks) }),
        );
        r.on('error', reject);
      },
    );
    up.on('error', reject);
    if (body.length) up.write(body);
    up.end();
  });
}

function proxyStreamed(
  target: URL,
  req: http.IncomingMessage,
  body: Buffer,
  res: http.ServerResponse,
  onHead: (status: number, headers: http.IncomingHttpHeaders) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const up = requesterFor(target)(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: outboundHeaders(req),
      },
      (r) => {
        onHead(r.statusCode ?? 502, r.headers);
        res.writeHead(r.statusCode ?? 502, stripHopByHop(r.headers));
        r.pipe(res);
        r.on('end', resolve);
      },
    );
    up.on('error', (e) => {
      // The upstream URL never appears in what the tenant sees.
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('scruple-capture: upstream unavailable\n');
      resolve();
    });
    if (body.length) up.write(body);
    up.end();
  });
}

function writeUpstream(
  res: http.ServerResponse,
  r: { status: number; headers: http.IncomingHttpHeaders; body: Buffer },
): void {
  const h = stripHopByHop(r.headers);
  h['content-length'] = String(r.body.length);
  res.writeHead(r.status, h);
  res.end(r.body);
}

function stripHopByHop(h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...h };
  for (const k of ['connection', 'transfer-encoding', 'keep-alive', 'content-length']) delete out[k];
  return out;
}

export function sha256(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}

/**
 * The file part of a multipart/form-data upload.
 *
 * Minimal on purpose: ComfyUI's /upload/image takes one file field, and a
 * general multipart parser is a dependency and an attack surface for one
 * field. Returns null rather than guessing when the body is not the shape
 * this expects — an input we could not hash makes input_hash null, which is
 * the honest outcome (see Correlator.inputHashFor).
 */
export function extractUploadedFile(contentType: string | undefined, body: Buffer): Buffer | null {
  if (!contentType || !/^multipart\/form-data/.test(contentType)) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = (m?.[1] ?? m?.[2] ?? '').trim();
  if (!boundary) return null;

  const sep = Buffer.from(`--${boundary}`);
  let idx = body.indexOf(sep);
  while (idx !== -1) {
    const partStart = idx + sep.length;
    const next = body.indexOf(sep, partStart);
    if (next === -1) break;
    const part = body.subarray(partStart, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      if (/filename="[^"]+"/i.test(headers)) {
        // Trailing CRLF belongs to the boundary, not to the file.
        let end = next - 2;
        if (end < partStart) end = next;
        return body.subarray(partStart + headerEnd + 4, end);
      }
    }
    idx = next;
  }
  return null;
}
