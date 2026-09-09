// A stub ComfyUI. Enough of server.py to exercise both output surfaces, and
// nothing that needs a GPU.
//
// WHY A STUB AND NOT THE REAL THING. Acceptance is about the component's
// coverage of ComfyUI's egress SHAPES, not about ComfyUI. Every behaviour
// below is transcribed from /data/reference/ui-inspire/ComfyUI with the line
// it came from, so the stub can be checked against the original rather than
// believed:
//
//   POST /prompt                server.py:915 — returns {prompt_id, number,
//                               node_errors}, and records the queue tuple in
//                               `history` exactly as task_done does
//   GET  /system_stats          server.py:646 — ⚑ NO boot id, NO pid, NO
//                               start time. Byte-identical across a restart,
//                               which is why WO-C5 derives the epoch from
//                               `/history` instead.
//   GET  /history               server.py:888 → execution.py:1282, with
//                               max_items/offset walking the dict from the
//                               front. In memory, bounded, LOST ON RESTART.
//   GET  /view                  server.py:501 — serves output/input/temp by
//                               filename + type
//   POST /upload/image          server.py:449 — multipart, returns
//                               {name, subfolder, type}
//   GET  /userdata/{file}       app/user_manager.py:334 — web.FileResponse
//                               over the user directory. THE THIRD BYTE PATH.
//   WS   /ws                    server.py:256, and the binary framing at
//                               :1126/:1136 — >I event_type, then for
//                               PREVIEW_IMAGE >I image_type (1 JPEG, 2 PNG).
//   `executing` / `execution_success`
//                               execution.py's status messages, which are the
//                               only correlation ComfyUI offers.
//
// The stub writes a file for a SaveImage node and pushes a WS frame for a
// SaveImageWebsocket node, which is exactly what ComfyUI does — see
// script_examples/websockets_api_example_ws_images.py, whose whole purpose is
// getting images "without them being saved to disk".

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

export const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export interface StubDirs {
  output: string;
  input: string;
  user: string;
  web: string;
}

export interface StubComfyUI {
  url: string;
  port: number;
  dirs: StubDirs;
  /** Every prompt the stub accepted, newest last. */
  prompts: Array<{ promptId: string; graph: unknown }>;
  /**
   * WO-C5. WHAT `systemctl restart comfyui` LOOKS LIKE FROM OUTSIDE. The same
   * address answers, `/system_stats` is byte-identical for every field that
   * identifies the install, and `PromptQueue` is a NEW object —
   * `self.number` back to 0 (server.py:217), `self.history` back to `{}`
   * (execution.py:1197). Nothing in the wire protocol announces it, which is
   * the entire reason the council put restart detection in the component.
   */
  restart(): Promise<void>;
  /** The current `PromptServer.number`. Diagnostics only. */
  readonly promptNumber: number;
  close(): Promise<void>;
}

function contentTypeFor(p: string): string {
  // The STUB may map extensions; the COMPONENT may not. ComfyUI does this
  // itself in server.py's /view (it sets image/png for .png), which is why
  // the component is entitled to treat the upstream content-type as a
  // declaration by the producing host rather than as a guess of its own.
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

export async function startStubComfyUI(root: string): Promise<StubComfyUI> {
  const dirs: StubDirs = {
    output: path.join(root, 'output'),
    input: path.join(root, 'input'),
    user: path.join(root, 'user'),
    web: path.join(root, 'web'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.web, 'index.html'), '<html>stub</html>');
  fs.writeFileSync(path.join(dirs.web, 'logo.png'), PNG_1x1);

  const prompts: StubComfyUI['prompts'] = [];
  const sockets = new Set<WebSocket>();
  let promptSeq = 0;
  // WO-C5. `PromptQueue.history` (execution.py:1197) — insertion-ordered, in
  // memory, evicted from the front past MAXIMUM_HISTORY_SIZE, and lost on
  // restart. A plain object is insertion-ordered for string keys, which is
  // what a Python dict is here.
  let history: Record<string, unknown> = {};

  /** server.py:646-685. ⚑ NO BOOT ID, NO PID, NO START TIME. */
  const systemStats = () => ({
    system: {
      os: 'linux',
      ram_total: 67_000_000_000,
      // Moves on every call, restart or not — which is why the identity
      // digest in lib/capture/upstreamEpoch.ts excludes it.
      ram_free: 41_000_000_000 - Math.floor(Math.random() * 1_000_000),
      comfyui_version: '0.3.44',
      required_frontend_version: '1.24.4',
      installed_templates_version: '0.1.41',
      required_templates_version: '0.1.41',
      python_version: '3.11.9',
      pytorch_version: '2.5.1+cu124',
      embedded_python: false,
      argv: ['main.py', '--listen', '127.0.0.1'],
    },
    devices: [
      {
        name: 'cuda:0 NVIDIA L4',
        type: 'cuda',
        index: 0,
        vram_total: 23_000_000_000,
        vram_free: 21_000_000_000 - Math.floor(Math.random() * 1_000_000),
        torch_vram_total: 0,
        torch_vram_free: 0,
      },
    ],
  });

  /** execution.py:1282 get_history(max_items, offset). */
  const getHistory = (maxItemsRaw: string | null, offsetRaw: string | null) => {
    const maxItems = maxItemsRaw === null ? null : Number(maxItemsRaw);
    let offset = offsetRaw === null ? -1 : Number(offsetRaw);
    const keys = Object.keys(history);
    if (offset < 0 && maxItems !== null) offset = keys.length - maxItems;
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const k of keys) {
      if (i >= offset) {
        out[k] = history[k];
        if (maxItems !== null && Object.keys(out).length >= maxItems) break;
      }
      i++;
    }
    return out;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub.invalid');
    const p = url.pathname.replace(/^\/api/, '');
    const body = await readBody(req);

    // ---- GET /system_stats (server.py:646) -------------------------
    if (req.method === 'GET' && p === '/system_stats') {
      json(res, 200, systemStats());
      return;
    }

    // ---- GET /history (server.py:888) ------------------------------
    if (req.method === 'GET' && p === '/history') {
      json(res, 200, getHistory(url.searchParams.get('max_items'), url.searchParams.get('offset')));
      return;
    }

    // ---- POST /prompt (server.py:915) ------------------------------
    if (req.method === 'POST' && p === '/prompt') {
      const graph = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
      // ⚑ The id is a fresh uuid PER RUN, exactly as ComfyUI's
      // `str(uuid.uuid4())` is (server.py:933). A per-process counter would
      // hand the tests a stub in which a restart reuses ids, and the prompt-id
      // overlap rule — the one that catches the restart both watermarks agree
      // about — would then be testing something ComfyUI never does.
      const promptId = crypto.randomUUID();
      const n = promptSeq++;
      prompts.push({ promptId, graph });
      // task_done (execution.py:1237-1242) stores the queue tuple verbatim at
      // history[prompt[1]]["prompt"], so prompt[0] is the number.
      history[promptId] = {
        prompt: [n, promptId, graph, {}, []],
        outputs: {},
        status: { status_str: 'success', completed: true, messages: [] },
      };
      json(res, 200, { prompt_id: promptId, number: n, node_errors: {} });
      // Execution happens after the response, as it does upstream.
      setTimeout(() => void execute(promptId, graph), 5);
      return;
    }

    // ---- POST /upload/image (server.py:449) ------------------------
    if (req.method === 'POST' && (p === '/upload/image' || p === '/upload/mask')) {
      const file = firstMultipartFile(req.headers['content-type'], body);
      const name = 'uploaded.png';
      if (file) fs.writeFileSync(path.join(dirs.input, name), file);
      json(res, 200, { name, subfolder: '', type: 'input' });
      return;
    }

    // ---- GET /view (server.py:501) ---------------------------------
    if (req.method === 'GET' && p === '/view') {
      const filename = url.searchParams.get('filename') ?? '';
      const type = url.searchParams.get('type') ?? 'output';
      const base = type === 'input' ? dirs.input : dirs.output;
      const abs = path.join(base, filename);
      if (!fs.existsSync(abs)) {
        res.writeHead(404).end('not found');
        return;
      }
      const buf = fs.readFileSync(abs);
      res.writeHead(200, { 'content-type': contentTypeFor(abs), 'content-length': String(buf.length) });
      res.end(buf);
      return;
    }

    // ---- GET /userdata/{file} (app/user_manager.py:334) ------------
    // The third byte path. Not in H-4 §3's table.
    if (req.method === 'GET' && p.startsWith('/userdata/')) {
      const abs = path.join(dirs.user, p.slice('/userdata/'.length));
      if (!fs.existsSync(abs)) {
        res.writeHead(404).end('not found');
        return;
      }
      const buf = fs.readFileSync(abs);
      res.writeHead(200, { 'content-type': contentTypeFor(abs), 'content-length': String(buf.length) });
      res.end(buf);
      return;
    }

    // ---- POST /userdata/{file} (app/user_manager.py:342) -----------
    if (req.method === 'POST' && p.startsWith('/userdata/')) {
      const abs = path.join(dirs.user, p.slice('/userdata/'.length));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
      json(res, 200, path.relative(dirs.user, abs));
      return;
    }

    // ---- web.static('/', web_root) (server.py:1104) -----------------
    const staticPath = path.join(dirs.web, p === '/' ? 'index.html' : p.replace(/^\//, ''));
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const buf = fs.readFileSync(staticPath);
      res.writeHead(200, {
        'content-type': staticPath.endsWith('.html') ? 'text/html' : contentTypeFor(staticPath),
        'content-length': String(buf.length),
      });
      res.end(buf);
      return;
    }

    res.writeHead(404).end('not found');
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } }));
  });

  function broadcastJson(type: string, data: unknown): void {
    const msg = JSON.stringify({ type, data });
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }

  /** server.py encode_bytes (:1126) + send_image (:1136). */
  function previewImageFrame(image: Buffer, imageType = 2): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(1, 0); // BinaryEventTypes.PREVIEW_IMAGE
    head.writeUInt32BE(imageType, 4); // 1 = JPEG, 2 = PNG
    return Buffer.concat([head, image]);
  }

  function broadcastBinary(frame: Buffer): void {
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
  }

  async function execute(promptId: string, graph: Record<string, unknown>): Promise<void> {
    broadcastJson('executing', { prompt_id: promptId, node: '1' });
    await tick(5);

    for (const node of Object.values(graph)) {
      if (typeof node !== 'object' || node === null) continue;
      const n = node as { class_type?: string; inputs?: Record<string, unknown> };

      if (n.class_type === 'SaveImage') {
        // nodes.py:483 → folder_paths.get_save_image_path, then
        // `{filename}_{counter:05}_.png` (nodes.py:1673).
        const prefix = typeof n.inputs?.filename_prefix === 'string' ? n.inputs.filename_prefix : 'ComfyUI';
        const file = `${path.basename(prefix)}_00001_.png`;
        fs.writeFileSync(path.join(dirs.output, file), PNG_1x1);
      }

      if (n.class_type === 'SaveImageWebsocket') {
        // The path that never becomes a file.
        broadcastBinary(previewImageFrame(PNG_1x1, 2));
      }
    }

    await tick(5);
    broadcastJson('execution_success', { prompt_id: promptId });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    dirs,
    prompts,
    get promptNumber() {
      return promptSeq;
    },
    async restart() {
      // The socket is NOT closed and reopened: what matters is that the
      // process state behind it is new, and a test that also moved the port
      // would be testing a reconfiguration rather than a restart. The
      // component sees the same address answering, with the same
      // /system_stats, and a history ring that no longer knows anything.
      promptSeq = 0;
      history = {};
      prompts.length = 0;
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(buf.length) });
  res.end(buf);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tick(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function firstMultipartFile(contentType: string | undefined, body: Buffer): Buffer | null {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = (m?.[1] ?? m?.[2] ?? '').trim();
  if (!boundary) return null;
  const sep = Buffer.from(`--${boundary}`);
  let idx = body.indexOf(sep);
  while (idx !== -1) {
    const start = idx + sep.length;
    const next = body.indexOf(sep, start);
    if (next === -1) return null;
    const part = body.subarray(start, next);
    const he = part.indexOf('\r\n\r\n');
    if (he !== -1 && /filename="/i.test(part.subarray(0, he).toString('utf8'))) {
      return body.subarray(start + he + 4, next - 2);
    }
    idx = next;
  }
  return null;
}
