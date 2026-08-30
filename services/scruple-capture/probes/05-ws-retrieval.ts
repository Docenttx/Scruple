// Probe 5 — retrieve output over the WebSocket and observe no leaf.
//
// The other half of §2's finding, and the half a filesystem watcher
// structurally cannot see: `server.py:1115-1204` sends binary frames
// (`send_bytes`, `PREVIEW_IMAGE`, `PREVIEW_IMAGE_WITH_METADATA`) and those
// bytes never become a file. ComfyUI ships a client example whose first line
// states the bypass outright — `websockets_api_example_ws_images.py`, "get
// images directly without them being saved to disk".
//
// This probe does what that example does: connect through the gate, queue a
// graph whose writer is `SaveImageWebsocket`, take the binary frame, hash its
// payload, and ask whether a leaf covers it.
//
// THE FRAME HEADER IS NOT PART OF THE ARTIFACT. server.py's `encode_bytes`
// (:1126) prefixes `>I event_type`, and `send_image` (:1136) adds `>I
// image_type` (1 JPEG, 2 PNG). The bytes a consumer keeps are what follows
// those eight. Hashing the whole frame would produce a hash nobody can
// re-derive from the image they hold, which is the `induced`-fidelity trap
// lib/capture/surface.ts names — a leaf only Scruple can read.

import crypto from 'node:crypto';

import { WebSocket, type RawData } from 'ws';

import type { Probe, ProbeContext, ProbeObservation } from '../../../packages/scruple-conformance/src/types';

const WS_ONLY_GRAPH = {
  '1': { class_type: 'KSampler', inputs: { seed: 20260830 } },
  '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['1', 0] } },
};

/** ws-gate.ts's decode, restated from server.py so the probe does not depend
 *  on the component it is probing to tell it what a frame is. */
function payloadOf(frame: Buffer): Buffer | null {
  if (frame.length < 8) return null;
  const eventType = frame.readUInt32BE(0);
  if (eventType !== 1) return null; // BinaryEventTypes.PREVIEW_IMAGE
  return frame.subarray(8);
}

export const probeWebsocketRetrieval: Probe = {
  id: 'P-05',
  spec: 'H-4 §7 probe 5 (§2 path 2)',
  title: 'retrieve output over WS and observe no corresponding leaf',
  attempt:
    'connect to /ws through the gate, queue a SaveImageWebsocket graph, keep the binary ' +
    'frame payload',
  requirement:
    'the bytes delivered over the WebSocket must be covered by a leaf — the attack SUCCEEDS ' +
    'when they are not',
  evidenceFor: ['P1', 'P2'],
  topological: false,

  async run(ctx: ProbeContext): Promise<ProbeObservation> {
    const gate = new URL(ctx.deployment.gateUrl);
    const wsUrl = `ws://${gate.host}/ws?clientId=scruple-probe-05`;

    const frames: Buffer[] = [];
    const ws = new WebSocket(wsUrl);

    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(true);
      });
      ws.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (!opened) {
      ws.terminate();
      return {
        outcome: 'not-attempted',
        detail:
          `Could not open ${wsUrl}. The gate must proxy /ws — a component that gates HTTP and ` +
          'hands WS to a pass-through sidecar has an uncaptured egress path, which is exactly ' +
          "STUDIO_P1-P8_GRADE.md's first condition on the canvas P1 pass.",
        evidence: { ws_url: wsUrl, connected: false },
      };
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      // `ws` hands back Buffer | ArrayBuffer | Buffer[] depending on how the
      // frame arrived. All three are the same bytes; only one of them is
      // something crypto.update() will hash correctly.
      frames.push(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer));
    });

    const res = await ctx.vantage.request(`${ctx.deployment.gateUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(WS_ONLY_GRAPH),
    });
    const promptStatus = res.status;
    await res.text();

    const deadline = Date.now() + ctx.deployment.drainWindowMs;
    while (Date.now() < deadline && frames.length === 0) {
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    ws.close();

    const payloads = frames.map(payloadOf).filter((b): b is Buffer => b !== null && b.length > 0);

    if (payloads.length === 0) {
      return {
        outcome: 'not-attempted',
        detail:
          `POST /prompt returned ${promptStatus} but no PREVIEW_IMAGE frame arrived within ` +
          `${ctx.deployment.drainWindowMs} ms. Nothing was retrieved, so nothing can be said ` +
          'about whether retrieval is witnessed. Inconclusive, which is not a pass.',
        evidence: { ws_url: wsUrl, connected: true, prompt_status: promptStatus, binary_frames: frames.length },
      };
    }

    // A LEAF FROM THE FILESYSTEM WATCHER DOES NOT COUNT, and the distinction
    // is the whole probe. These bytes never became a file. If an identical
    // image was also saved to disk by some other prompt, the watcher's leaf
    // covers THAT file — it does not witness this retrieval, and treating a
    // content-hash collision as coverage would report a gated WS path where
    // there is none.
    const unwitnessed: string[] = [];
    let onlyDiskLeaf = 0;
    for (const p of payloads) {
      const h = crypto.createHash('sha256').update(p).digest('hex');
      const found = await ctx.leaves.leafFor(h, ctx.deployment.drainWindowMs);
      const byGate = found.found && found.surfaces.some((s) => s !== 'filesystem-watch');
      if (found.found && !byGate) onlyDiskLeaf++;
      if (!byGate) unwitnessed.push(h);
    }

    const evidence = {
      ws_url: wsUrl,
      connected: true,
      prompt_status: promptStatus,
      binary_frames: frames.length,
      preview_payloads: payloads.length,
      unwitnessed_payloads: unwitnessed.length,
      covered_only_by_a_disk_leaf: onlyDiskLeaf,
      first_unwitnessed_hash: unwitnessed[0] ?? null,
      oracle: ctx.leaves.describe,
    };

    if (unwitnessed.length > 0) {
      return {
        outcome: 'succeeded',
        detail:
          `${unwitnessed.length} of ${payloads.length} PREVIEW_IMAGE payloads reached the tenant ` +
          'with no leaf from a non-filesystem surface' +
          (onlyDiskLeaf
            ? ` (${onlyDiskLeaf} had a filesystem-watch leaf for identical bytes, which covers a ` +
              'FILE and not this retrieval)'
            : '') +
          '. These bytes never became a file, so no filesystem watcher will ever find them — ' +
          'this is the path §2 says a watcher-only deployment misses entirely.',
        evidence,
      };
    }

    return {
      outcome: 'blocked',
      detail: `All ${payloads.length} PREVIEW_IMAGE payloads are covered by a leaf.`,
      evidence,
    };
  },
};
