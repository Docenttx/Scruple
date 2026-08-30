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

/**
 * The three directories §10 C-8 names, plus the honest label for a root whose
 * type nobody declared. `unspecified` is not a fourth kind of directory: it is
 * the absence of a declaration, and it is recorded rather than guessed for the
 * same reason mime.ts refuses `mimetypes.guess_type()` — a value nobody was
 * entitled to declare is not evidence.
 */
export type WatchedVolumeType = 'output' | 'temp' | 'input' | 'unspecified';

/** C-8's three, in the order the spec names them. */
export const C8_VOLUME_TYPES = ['output', 'temp', 'input'] as const;

export interface WatchedVolume {
  readonly type: WatchedVolumeType;
  /** Absolute. Resolved at load, so the leaf's relative path is stable. */
  readonly path: string;
}

/**
 * Normalise the two accepted forms into the one the watcher uses, and refuse
 * every shape whose meaning would have to be guessed.
 *
 * NESTED ROOTS ARE REFUSED, and that is the point rather than tidiness. If
 * `temp/` sits inside the `output/` root, one write fires two watchers and the
 * question C-8 exists to answer — WHICH volume did these bytes land in — has
 * two answers. The pre-C-8 shape (all three under one recursive root) is
 * exactly that configuration, which is why it could satisfy the obligation and
 * still not evidence it.
 */
export function resolveWatchedVolumes(
  src: { watchedVolumes?: readonly WatchedVolume[]; outputVolume?: string },
  where = 'CaptureConfig',
): WatchedVolume[] {
  const hasMany = src.watchedVolumes !== undefined;
  const hasOne = src.outputVolume !== undefined;
  if (hasMany && hasOne) {
    throw new ConfigError(
      `${where}: watchedVolumes and outputVolume are both set. They mean different things ` +
        '(typed roots vs one untyped root) and a component that silently preferred one would ' +
        'watch a set of directories nobody wrote down.',
    );
  }
  if (!hasMany && !hasOne) {
    throw new ConfigError(
      `${where}: no watched volume. A capture component with no filesystem surface produces ` +
        'no leaves for §2 path 1 and looks healthy doing it (§4.2).',
    );
  }

  const vols: WatchedVolume[] = hasMany
    ? src.watchedVolumes!.map((v) => ({ type: v.type, path: path.resolve(v.path) }))
    : [{ type: 'unspecified' as const, path: path.resolve(src.outputVolume!) }];

  if (vols.length === 0) {
    throw new ConfigError(`${where}: watchedVolumes is empty.`);
  }

  const seenType = new Set<string>();
  for (const v of vols) {
    if (v.type !== 'unspecified' && seenType.has(v.type)) {
      throw new ConfigError(
        `${where}: two roots both declared '${v.type}'. The type is what the leaf reports; ` +
          'two roots claiming it makes the report ambiguous.',
      );
    }
    seenType.add(v.type);
  }

  for (const a of vols) {
    for (const b of vols) {
      if (a === b) continue;
      if (a.path === b.path || b.path.startsWith(`${a.path}/`)) {
        throw new ConfigError(
          `${where}: ${b.path} ('${b.type}') is inside ${a.path} ('${a.type}'). Nested watched ` +
            'roots make one write two observations with two volume types. Mount the three C-8 ' +
            'directories as siblings, or as separate mounts, and declare each.',
        );
      }
    }
  }

  return vols;
}

/** True when this configuration expresses all three of C-8's directories. */
export function satisfiesC8(vols: readonly WatchedVolume[]): boolean {
  return C8_VOLUME_TYPES.every((t) => vols.some((v) => v.type === t));
}

export interface CaptureConfig {
  /** Where ComfyUI listens. Loopback or a private namespace (§2 obligation 1).
   *  The tenant never learns this value — that is the whole gate. */
  upstreamUrl: string;
  /** Where the component listens for the tenant. */
  listenHost: string;
  listenPort: number;
  /**
   * THE WATCHED VOLUMES — §2 obligation 3 as amended by §10 C-8.
   *
   * C-8 corrected obligation 3 from "the output volume" to `output/`, `temp/`
   * AND `input/`, because `PreviewImage` (nodes.py:1684-1690) is a `SaveImage`
   * subclass whose `output_dir` is `folder_paths.get_temp_directory()` — it
   * writes FULL IMAGES to `temp/`, not `output/` — and `LoadImage` inputs live
   * in `input/`.
   *
   * C-8's closing sentence was that this had no configuration to express it:
   * `outputVolume` was singular, so the three were satisfiable only by mounting
   * them under one root and relying on `fs.watch`'s recursive flag. That worked
   * BY ACCIDENT OF THE FLAG, and it cost the leaf the one fact the amendment is
   * about — a `temp/` write and an `output/` write produced indistinguishable
   * records, so "PreviewImage output is witnessed" could not be read off the
   * evidence, only assumed from the mount layout.
   *
   * So the roots are declared, and each carries its TYPE. The type reaches the
   * leaf through `capture.egress` as `file:<type>:<path within that root>`,
   * which is inside the MAC preimage (leaf.ts `preimageOf`) and therefore
   * authenticated rather than annotated.
   */
  watchedVolumes?: readonly WatchedVolume[];
  /**
   * @deprecated The singular pre-C-8 form. Still accepted, because two callers
   * this change does not own construct a config with it (`kohya/index.ts`,
   * whose volume is checkpoints rather than any of C-8's three, and
   * `test/v2/capture-component.test.ts`). A config in this form watches ONE
   * root whose type is `unspecified`, and `topologyAdvisory` says out loud
   * that C-8 is unmet — a deployment in this shape has `temp/` and `input/`
   * unwatched unless they happen to sit under the root.
   *
   * Exactly one of `watchedVolumes` and `outputVolume` may be set.
   */
  outputVolume?: string;
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

/**
 * The three C-8 environment variables, and the pre-C-8 one.
 *
 * FAIL CLOSED ON A PARTIAL DECLARATION. Setting only `_OUTPUT` is the exact
 * deployment C-8 was written about — a watcher on `output/` alone that misses
 * every `PreviewImage` — and a component that accepted it would start healthy
 * and capture two thirds of nothing. So one of the three set means all three
 * required. Declaring the legacy singular variable instead is still permitted
 * and still says so in the advisory, because a deployment predating C-8 must
 * not be silently reinterpreted as a conformant one.
 */
function volumesFromEnv(env: NodeJS.ProcessEnv): WatchedVolume[] {
  const named = C8_VOLUME_TYPES.map((t) => ({
    type: t,
    varName: `SCRUPLE_CAPTURE_VOLUME_${t.toUpperCase()}`,
    value: env[`SCRUPLE_CAPTURE_VOLUME_${t.toUpperCase()}`] || '',
  }));
  const set = named.filter((n) => n.value !== '');

  if (set.length === 0) {
    // Pre-C-8 form.
    const outputVolume = req('SCRUPLE_CAPTURE_OUTPUT_VOLUME');
    return resolveWatchedVolumes({ outputVolume }, 'SCRUPLE_CAPTURE_OUTPUT_VOLUME');
  }

  if (set.length !== named.length) {
    const missing = named.filter((n) => n.value === '').map((n) => n.varName);
    throw new ConfigError(
      `${missing.join(' and ')} not set. §10 C-8: output/, temp/ and input/ are ALL mounted ` +
        'and ALL watched — PreviewImage is a SaveImage subclass writing full images to temp/, ' +
        'and LoadImage inputs live in input/. A partially declared set is the configuration ' +
        'C-8 exists to name, and this component refuses to start in it rather than watch two ' +
        'thirds of the surface and look healthy.',
    );
  }

  return resolveWatchedVolumes(
    { watchedVolumes: set.map((n) => ({ type: n.type, path: n.value })) },
    'SCRUPLE_CAPTURE_VOLUME_*',
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CaptureConfig {
  const stateDir = env.SCRUPLE_CAPTURE_STATE_DIR ?? path.resolve('.scruple-capture');
  const watchedVolumes = volumesFromEnv(env);

  for (const v of watchedVolumes) {
    if (!fs.existsSync(v.path)) {
      throw new ConfigError(
        `watched volume '${v.type}' at ${v.path} does not exist. The watcher would ` +
          'bind nothing and every disk-path artifact would be invisible (§2 path 1).',
      );
    }
  }

  const cfg: CaptureConfig = {
    upstreamUrl: req('SCRUPLE_CAPTURE_UPSTREAM_URL').replace(/\/+$/, ''),
    listenHost: env.SCRUPLE_CAPTURE_LISTEN_HOST ?? '0.0.0.0',
    listenPort: Number(env.SCRUPLE_CAPTURE_LISTEN_PORT ?? 8188),
    watchedVolumes,
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
  const vols = resolveWatchedVolumes(cfg, 'topologyAdvisory');
  if (!satisfiesC8(vols)) {
    notes.push(
      `watched volumes are [${vols.map((v) => `${v.type}=${v.path}`).join(', ')}] — §10 C-8 ` +
        'requires output/, temp/ AND input/. Anything landing in an undeclared directory ' +
        'produces no leaf, and PreviewImage writes to temp/ by default.',
    );
  }
  notes.push(
    'This component gates INGRESS only. ComfyUI\'s own OUTBOUND network is not on any ' +
      'surface it owns — see surfaces/README-egress note in http-gate.ts. Deny egress ' +
      'from the workload container or the two-surface claim has a hole.',
  );
  return notes;
}
