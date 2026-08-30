// scruple-capture — configuration, and what it refuses to start without.
//
// THE COMPONENT (docs/canon/H4-DUKPT-CAPTURE-COMPONENT.md §2). A sidecar the
// vendor DEPLOYS and does not AUTHOR, sitting on the only route between the
// tenant and ComfyUI, holding the ratchet key, owning both of ComfyUI's
// output surfaces:
//
//   tenant ──TLS──▶ scruple-capture ──loopback──▶ ComfyUI
//                          ▲                         │ writes
//                          └────── inotify ──── [shared output volume]
//
// FAIL CLOSED, and the shape is lib/ratchet/bdk.ts's. A capture component
// that starts with a missing upstream, a missing output volume, or a missing
// identity is a component that produces no leaves while looking healthy, and
// silence is the specific thing this design exists to make visible (§4.2).
// So: no defaults for anything load-bearing, and the process exits rather
// than degrading.

import fs from 'node:fs';
import path from 'node:path';

export interface CaptureConfig {
  /** Where ComfyUI listens. Loopback or a private namespace (§2 obligation 1).
   *  The tenant never learns this value — that is the whole gate. */
  upstreamUrl: string;
  /** Where the component listens for the tenant. */
  listenHost: string;
  listenPort: number;
  /** The output volume mounted into both containers (§2 obligation 3). */
  outputVolume: string;
  /** Sealed IK, ratchet counter, and the durable queue live here. 0700. */
  stateDir: string;

  /** scruple-web base URL — provisioning and submission. */
  apiBaseUrl: string;
  /** Bearer key. §10 C-5: the token alone cannot say WHICH tenant is calling. */
  apiKey: string;
  /** One-time provisioning token (§4.4 step 1). Consumed at first start. */
  provisioningToken: string | null;

  /** D-3: /api/v2/witness refuses a leaf with no baseline_ref. */
  baselineRef: string | null;

  /**
   * OPTIONAL VENDOR DECLARATION for bytes that appear in the output volume
   * with no producing node to declare their type — a tenant's shell write,
   * H-4 §7 probe 4.
   *
   * This is NOT a guess and it is not `mimetypes.guess_type()`. It is the
   * vendor, an accountable party (§1), declaring what their own output volume
   * holds. The leaf records WHO declared it (see DeclaredMime.source), so a
   * verifier can tell a node's declaration from a vendor's blanket one.
   * Leave it unset and undeclared bytes stay undeclared.
   */
  outputVolumeDeclaredMime: string | null;

  /** How long a path must be quiet before the watcher treats the write as
   *  closed. See surfaces/fs-watch.ts — Node cannot see IN_CLOSE_WRITE. */
  settleMs: number;
  /** How long a pending prompt stays available for correlation. */
  correlationTtlMs: number;
  /** §4.2/§9 — no leaf for longer than this and the component is silent. */
  heartbeatWindowSeconds: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new ConfigError(
      `${name} is not set. scruple-capture refuses to start without it: a component ` +
        'that starts half-configured produces no leaves and looks healthy, and a ' +
        'silent component is the failure this design exists to make visible (§4.2).',
    );
  }
  return v;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CaptureConfig {
  const stateDir = env.SCRUPLE_CAPTURE_STATE_DIR ?? path.resolve('.scruple-capture');
  const outputVolume = req('SCRUPLE_CAPTURE_OUTPUT_VOLUME');

  if (!fs.existsSync(outputVolume)) {
    throw new ConfigError(
      `SCRUPLE_CAPTURE_OUTPUT_VOLUME=${outputVolume} does not exist. The watcher would ` +
        'bind nothing and every disk-path artifact would be invisible (§2 path 1).',
    );
  }

  const cfg: CaptureConfig = {
    upstreamUrl: req('SCRUPLE_CAPTURE_UPSTREAM_URL').replace(/\/+$/, ''),
    listenHost: env.SCRUPLE_CAPTURE_LISTEN_HOST ?? '0.0.0.0',
    listenPort: Number(env.SCRUPLE_CAPTURE_LISTEN_PORT ?? 8188),
    outputVolume: path.resolve(outputVolume),
    stateDir: path.resolve(stateDir),
    apiBaseUrl: req('SCRUPLE_API_URL').replace(/\/+$/, ''),
    apiKey: req('SCRUPLE_API_KEY'),
    provisioningToken: env.SCRUPLE_CAPTURE_PROVISIONING_TOKEN || null,
    baselineRef: env.SCRUPLE_CAPTURE_BASELINE_REF || null,
    outputVolumeDeclaredMime: env.SCRUPLE_CAPTURE_OUTPUT_VOLUME_MIME || null,
    settleMs: Number(env.SCRUPLE_CAPTURE_SETTLE_MS ?? 250),
    correlationTtlMs: Number(env.SCRUPLE_CAPTURE_CORRELATION_TTL_MS ?? 30 * 60 * 1000),
    heartbeatWindowSeconds: Number(env.SCRUPLE_CAPTURE_HEARTBEAT_SECONDS ?? 900),
  };

  if (!Number.isInteger(cfg.listenPort) || cfg.listenPort < 0 || cfg.listenPort > 65535) {
    throw new ConfigError(`SCRUPLE_CAPTURE_LISTEN_PORT=${env.SCRUPLE_CAPTURE_LISTEN_PORT} is not a port.`);
  }

  // The one topology check the component can make about itself. It cannot
  // prove obligation 1 — that is H-4 §7 probe 1, run from inside the tenant
  // container — but a gate configured to proxy to ITSELF is a loop, and a
  // gate whose upstream is a public hostname is very likely one the tenant
  // can reach directly.
  const up = new URL(cfg.upstreamUrl);
  if (up.port !== '' && Number(up.port) === cfg.listenPort && isLoopback(up.hostname)) {
    throw new ConfigError('Upstream is this component. Refusing to proxy to myself.');
  }

  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  return cfg;
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * An advisory, not a check. §2 obligation 1 says ComfyUI must bind loopback
 * or a private namespace; this component sees only the URL it was given and
 * cannot see the workload's bind address, its network policy, or whether the
 * tenant has a second route. Saying so at startup is worth more than a check
 * that would imply we verified something we did not.
 */
export function topologyAdvisory(cfg: CaptureConfig): string[] {
  const notes: string[] = [];
  const up = new URL(cfg.upstreamUrl);
  if (!isLoopback(up.hostname)) {
    notes.push(
      `upstream ${up.hostname} is not loopback — §2 obligation 1 requires ComfyUI be ` +
        'unreachable except through this component. Unverifiable from here; run §7 probe 1.',
    );
  }
  notes.push(
    'This component gates INGRESS only. ComfyUI\'s own OUTBOUND network is not on any ' +
      'surface it owns — see surfaces/README-egress note in http-gate.ts. Deny egress ' +
      'from the workload container or the two-surface claim has a hole.',
  );
  return notes;
}
