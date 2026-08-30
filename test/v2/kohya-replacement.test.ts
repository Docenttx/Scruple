// WO-11b + WO-12. Guards two claims that are easy to make and easy to lose:
//
//   1. RE-PLACEMENT. Capture for Kohya moves out of the pod, and the code that
//      would run outside it REFUSES to start on a topology that cannot support
//      the placement it declares — rather than starting, looking healthy, and
//      producing nothing. docs/canon/KOHYA_REPLACEMENT.md.
//
//   2. THE GLOBAL SECRET IS NOT DISTRIBUTED. lib/apps/backends/runpod-session.ts
//      put one HMAC key into every pod's environment, so any customer running
//      `env` held the credential authenticating every other customer's traffic
//      (docs/canon/STUDIO_P1-P8_GRADE.md, Path B, P3). The distribution site is
//      gone and this file fails if it returns.
//
// It does NOT re-test WO-11a's honesty properties; test/v2/kohya-honesty.test.ts
// owns those and both files must stay green together.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error(
    'Refusing to run: set SCRUPLE_DB_PATH to a throwaway path first. Use `npm run test:v2`.',
  );
}

// Own sqlite file, for the reason kohya-honesty.test.ts records: node runs test
// FILES concurrently and concurrent runMigrations() against one file races.
const PRIVATE_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kohya-replacement-'));
process.env.SCRUPLE_DB_PATH = path.join(PRIVATE_DB_DIR, 'kohya-replacement.db');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

// Set deliberately, so the deprecated-credential branch is EXERCISED rather
// than skipped. A test run that leaves it unset would pass whether or not the
// branch still behaved.
const GLOBAL_SECRET = 'test-global-secret-wo12';
process.env.SCRUPLE_APPS_WITNESS_SECRET = GLOBAL_SECRET;

import {
  KOHYA_DUTIES,
  NO_TOPOLOGY_ENFORCEMENT,
  RUNPOD_POD_TOPOLOGY,
  coverageCaveats,
  enforcementFor,
  resolveKohyaPlacement,
  type KohyaTopology,
} from '../../services/scruple-capture/kohya/profile';
import {
  CheckpointWatchSurface,
} from '../../services/scruple-capture/kohya/checkpoint-watch';
import { KohyaCapture, PlacementRefusal } from '../../services/scruple-capture/kohya';
import { podEnvFor } from '../../lib/apps/backends/runpod-session';
import type {
  CaptureObservation,
  ObservationSink,
} from '../../lib/capture/surface';
import type { CloseWriteSource } from '../../services/scruple-capture/src/surfaces/fs-watch';

const FULLY_ENFORCED: KohyaTopology = {
  workloadReachableOnlyThroughComponent: true,
  componentIsolatedFromTenant: true,
  allArtifactVolumesMountedAndWatched: true,
  workloadEgressDeniedExceptThroughComponent: true,
};

/* ══════════════════════════════════════════════════════════════════════
 * WO-11b — placement
 * ══════════════════════════════════════════════════════════════════════ */

describe('Kohya re-placed: the model refuses where the topology cannot hold', () => {
  test('a RunPod pod resolves to unattested-client and may not issue a leaf', () => {
    const a = resolveKohyaPlacement(RUNPOD_POD_TOPOLOGY);
    assert.equal(a.resolution.declared, 'sidecar-gate');
    assert.equal(a.resolution.effective, 'unattested-client');
    assert.equal(a.resolution.honoured, false);
    assert.equal(a.p1, 'fails');
    assert.equal(a.p3, 'fails');
    assert.equal(a.leaf, null, 'no leaf may be issued at unattested-client (§5.1 rule 1)');
    assert.equal(a.canClaim, false);
    assert.equal(a.mayIssueLeaf, false);
  });

  test('obligations 1 and 2 satisfied lifts it to sidecar-gate / passthrough', () => {
    const a = resolveKohyaPlacement(FULLY_ENFORCED);
    assert.equal(a.resolution.effective, 'sidecar-gate');
    assert.equal(a.p1, 'conditional', 'P1 at sidecar-gate is conditional on the §7 probes');
    assert.equal(a.leaf, 'passthrough', 'no attestable compute, so never `verified`');
    assert.equal(a.mayIssueLeaf, true);
    assert.ok(a.conditions.length > 0, 'a conditional disposition must name its conditions');
  });

  test('partial enforcement never lands on an intermediate tier', () => {
    // §4.2: "some enforcement, but not the one this tier needs" is a different
    // claim, not a partial one.
    const ingressOnly = { ...NO_TOPOLOGY_ENFORCEMENT, workloadReachableOnlyThroughComponent: true };
    const isolatedOnly = { ...NO_TOPOLOGY_ENFORCEMENT, componentIsolatedFromTenant: true };
    assert.equal(enforcementFor(ingressOnly), 'none');
    assert.equal(enforcementFor(isolatedOnly), 'none');
    assert.equal(resolveKohyaPlacement(ingressOnly).resolution.effective, 'unattested-client');
    assert.equal(resolveKohyaPlacement(isolatedOnly).resolution.effective, 'unattested-client');
  });

  test('coverage obligations are reported but do not move the tier', () => {
    // PLACEMENT_AND_SURFACES.md §2.2: surface affects coverage, not assurance.
    // An unwatched volume produces NO leaf for events that happened, which is a
    // different failure from a weaker leaf and must not be modelled as one.
    const enforcedButUncovered: KohyaTopology = {
      ...FULLY_ENFORCED,
      allArtifactVolumesMountedAndWatched: false,
      workloadEgressDeniedExceptThroughComponent: false,
    };
    const a = resolveKohyaPlacement(enforcedButUncovered);
    assert.equal(a.resolution.effective, 'sidecar-gate', 'coverage is not assurance');
    assert.equal(a.leaf, 'passthrough');
    assert.equal(coverageCaveats(enforcedButUncovered).length, 2);
    assert.equal(coverageCaveats(FULLY_ENFORCED).length, 0);
  });

  test('the three duties are ruled on, and the gate is only partial', () => {
    const by = Object.fromEntries(KOHYA_DUTIES.map((d) => [d.duty, d]));
    assert.equal(by.watch.disposition, 'applies');
    assert.equal(by.submit.disposition, 'applies');
    assert.equal(
      by.gate.disposition,
      'applies-in-part',
      'a checkpoint is collected off disk and traverses no gateable surface — fail-closed, ' +
        'which is the whole value of the ComfyUI gate, is not available here',
    );
  });
});

describe('the runner refuses before it acquires key material', () => {
  test('KohyaCapture.start throws PlacementRefusal on a RunPod topology', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kohya-refuse-'));
    await assert.rejects(
      () =>
        KohyaCapture.start(
          {
            checkpointVolume: dir,
            stateDir: path.join(dir, 'state'),
            apiBaseUrl: 'https://scruple.example',
            apiKey: 'k',
            // A token that WOULD be burned if the runner got as far as
            // provisioning. It must not.
            provisioningToken: 'spt_would-be-burned',
            baselineRef: null,
            declaredMime: null,
            settleMs: 10,
            topology: RUNPOD_POD_TOPOLOGY,
          },
          { log: () => undefined },
        ),
      (e: unknown) => {
        assert.ok(e instanceof PlacementRefusal, 'must refuse by placement, not by config');
        assert.equal(e.assurance.resolution.effective, 'unattested-client');
        assert.match(e.message, /no leaf may be issued/i);
        return true;
      },
    );
    assert.equal(
      fs.existsSync(path.join(dir, 'state')),
      false,
      'a refused deployment must not have created a state dir — refusing before ' +
        'Identity.open() is what keeps it from burning a token and sealing an IK ' +
        'somewhere the tenant can read it (H-4 §7 probe 3)',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * WO-11b — the watcher, which is the duty that carries the evidence
 * ══════════════════════════════════════════════════════════════════════ */

class ManualSource implements CloseWriteSource {
  readonly method = 'inotify-close-write' as const;
  private cb: ((p: string) => void) | null = null;
  start(_dir: string, onCloseWrite: (p: string) => void): void {
    this.cb = onCloseWrite;
  }
  stop(): void {
    this.cb = null;
  }
  fire(p: string): void {
    this.cb?.(p);
  }
}

class CollectingSink implements ObservationSink {
  readonly seen: CaptureObservation[] = [];
  async emit(o: CaptureObservation): Promise<void> {
    this.seen.push(o);
  }
}

/** A real safetensors file: u64 LE header length, JSON header, then data. */
function writeSafetensors(dir: string, name: string): { abs: string; headerHash: string } {
  const header = {
    'lora_unet_down.lora_down.weight': { dtype: 'F16', shape: [8, 320], data_offsets: [0, 8] },
    __metadata__: { ss_network_dim: '8' },
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(headerBytes.length));
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, Buffer.concat([len, headerBytes, Buffer.alloc(8, 7)]));
  return { abs, headerHash: crypto.createHash('sha256').update(headerBytes).digest('hex') };
}

describe('the checkpoint watcher observes from outside the pod', () => {
  test('a safetensors close produces a model_write with a header fingerprint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kohya-vol-'));
    const { abs, headerHash } = writeSafetensors(dir, 'last.safetensors');
    const sink = new CollectingSink();
    const source = new ManualSource();
    const w = new CheckpointWatchSurface({ volume: dir, source, log: () => undefined });

    await w.open({ sink, placement: 'sidecar-gate', config: {} });
    source.fire(abs);
    await w.settled();

    assert.equal(sink.seen.length, 1);
    const o = sink.seen[0];
    assert.equal(o.hook, 'model.write', 'the hook did not change when the placement did');
    assert.equal(o.surface, 'filesystem-watch');
    assert.equal(o.evidence?.kind, 'model_write');
    assert.equal(o.bytes?.fidelity, 'as-written');
    assert.equal(
      o.bytes?.contentHash,
      crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
    );
    assert.equal(
      o.evidence?.header_hash,
      headerHash,
      'the structural fingerprint the in-pod hook computed must survive the move out of ' +
        'the pod — losing it would make the re-placement a net evidence regression',
    );
    const summary = o.evidence?.structural_summary as Record<string, unknown>;
    assert.equal(summary.layer_count, 1, '__metadata__ is not a tensor');
    assert.deepEqual((summary.metadata as Record<string, unknown>).ss_network_dim, '8');

    assert.equal(
      o.bytes?.mime,
      undefined,
      'no vendor declaration was configured, so no MIME is declared — never guessed from ' +
        'the extension and never application/octet-stream (CANON_SKELETON §5 property 1)',
    );

    await w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a non-checkpoint file in the volume is still emitted, as an artifact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kohya-vol2-'));
    const abs = path.join(dir, 'sample-000.png');
    fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sink = new CollectingSink();
    const source = new ManualSource();
    const w = new CheckpointWatchSurface({ volume: dir, source, log: () => undefined });

    await w.open({ sink, placement: 'sidecar-gate', config: {} });
    source.fire(abs);
    await w.settled();

    assert.equal(sink.seen.length, 1, 'a file the watcher declines to emit is an invisible hole');
    assert.equal(sink.seen[0].hook, 'artifact.produced');
    assert.equal(sink.seen[0].evidence?.kind, 'artifact');
    assert.equal(sink.seen[0].evidence?.header_hash, null, 'absent, not guessed');

    await w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * WO-12 — the credential
 * ══════════════════════════════════════════════════════════════════════ */

describe('the global witness secret is not distributed', () => {
  test('podEnvFor puts no witness secret in the pod', () => {
    const env = podEnvFor({ userId: 'u1', machineId: 'm', appId: 'kohya', sessionId: 'as_1', sessionToken: 'tok-1' });
    for (const [k, v] of Object.entries(env)) {
      assert.notEqual(
        v,
        GLOBAL_SECRET,
        `${k} carries the global witness secret into a shell the customer controls — P3 ` +
          'names that verbatim as unacceptable, and it was GLOBAL: one value for every pod ' +
          'and every user',
      );
    }
    assert.equal(env.SCRUPLE_WITNESS_SECRET, undefined);
    assert.equal(env.SCRUPLE_SESSION_TOKEN, 'tok-1');
    assert.equal(
      env.SCRUPLE_PLACEMENT,
      'unattested-client',
      'the pod is told its own posture, because the pod is where it is least visible',
    );
    assert.equal(env.SCRUPLE_CAN_WITNESS, '0');
  });

  test('the RunPod backend source never reads SCRUPLE_APPS_WITNESS_SECRET', () => {
    // Comments stripped first: the file QUOTES the deleted line in its own
    // header so a reader knows what was removed and why, and a scan that
    // cannot tell a quotation from a call would force that history out.
    const src = fs
      .readFileSync(path.join(REPO_ROOT, 'lib/apps/backends/runpod-session.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    assert.ok(
      !/process\.env\.SCRUPLE_APPS_WITNESS_SECRET/.test(src),
      'lib/apps/backends/runpod-session.ts must not read the global witness secret. It is ' +
        'retired, not rotated (H-4 §8 step 6). If a per-pod credential is needed again it ' +
        'is the session token, or the component`s sealed IK — never one value shared by ' +
        'every tenant.',
    );
  });

  test('the pod hook signs with the session token, not a shared secret', () => {
    for (const rel of [
      'public/pod-hooks/kohya_safetensors_hook.py',
      'research/scruple-kohya-image/scruple_safetensors_hook.py',
    ]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.ok(
        /os\.environ\.get\("SCRUPLE_SESSION_TOKEN"/.test(src),
        `${rel} must take its HMAC key from SCRUPLE_SESSION_TOKEN`,
      );
      assert.ok(
        !/os\.environ\.get\("SCRUPLE_WITNESS_SECRET"/.test(src),
        `${rel} must not read the retired shared secret`,
      );
    }
  });
});

describe('the Kohya witness route is keyed per session', () => {
  let conn: typeof import('../../lib/db/sqlite').conn;
  let POST: typeof import('../../app/api/apps/kohya/witness/route').POST;
  let sessionId: string;
  let otherSessionId: string;
  const userId = 'kohya-replacement-user';
  const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
  const OTHER_TOKEN = crypto.randomBytes(32).toString('hex');

  before(async () => {
    const { runMigrations } = await import('../../lib/db/migrate');
    ({ conn } = await import('../../lib/db/sqlite'));
    ({ POST } = await import('../../app/api/apps/kohya/witness/route'));
    runMigrations(false);

    const now = new Date().toISOString();
    const proj = conn()
      .prepare(
        `INSERT INTO projects
           (user_id, name, type, status, created_at, iteration_count, is_active, witnessed_count, is_archived)
         VALUES (?, 'kohya-replacement-project', 'training', 'unlocked', ?, 0, 1, 0, 0)`,
      )
      .run(userId, now);

    const insert = conn().prepare(
      `INSERT INTO app_sessions
         (id, user_id, app_id, backend, machine_id, endpoint_id, endpoint_url,
          signed_token, expires_at, status)
       VALUES (?, ?, 'kohya', 'runpod', 'test-machine', ?, 'https://pod.example', ?,
               datetime('now', '+1 hour'), ?)`,
    );
    sessionId = crypto.randomUUID();
    otherSessionId = crypto.randomUUID();
    insert.run(sessionId, userId, String(proj.lastInsertRowid), SESSION_TOKEN, 'active');
    insert.run(otherSessionId, userId, String(proj.lastInsertRowid), OTHER_TOKEN, 'active');
  });

  after(() => {
    try {
      fs.rmSync(PRIVATE_DB_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function bodyFor(sid: string): string {
    return JSON.stringify({
      event: 'checkpoint_save',
      path: '/workspace/out/ckpt.safetensors',
      output_hash: crypto.randomBytes(32).toString('hex'),
      header_hash: crypto.randomBytes(32).toString('hex'),
      size_bytes: 1,
      structural_summary: { layer_count: 0, layers: [], metadata: {} },
      user_id: userId,
      app_id: 'kohya',
      session_id: sid,
      client_timestamp: Date.now() / 1000,
    });
  }

  function post(raw: string, key: string): Promise<Response> {
    const sig = crypto.createHmac('sha256', key).update(raw).digest('hex');
    return POST(
      new Request('https://scruple.ai/api/apps/kohya/witness', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-scruple-signature': sig },
        body: raw,
      }) as never,
    ) as unknown as Promise<Response>;
  }

  test('the session token authenticates, and the answer is still not witnessed', async () => {
    const res = await post(bodyFor(sessionId), SESSION_TOKEN);
    const b = await res.json();
    assert.equal(res.status, 200);
    assert.equal(b.credential, 'session');
    assert.equal(b.witnessed, false, 'a per-session key does not buy a leaf — placement does');
    assert.equal(b.placement, 'unattested-client');
  });

  test('another session`s token cannot write to this session', async () => {
    const res = await post(bodyFor(sessionId), OTHER_TOKEN);
    assert.equal(
      res.status,
      401,
      'the tenancy boundary docs/canon/studio-l2/04-PLAN.md said did not exist. Under the ' +
        'global secret this request succeeded: any pod could witness as any user.',
    );
  });

  test('an unknown session answers 401, not 404 — no enumeration oracle', async () => {
    const res = await post(bodyFor('as_does-not-exist'), SESSION_TOKEN);
    assert.equal(res.status, 401);
  });

  test('a revoked session is refused', async () => {
    conn().prepare(`UPDATE app_sessions SET status = 'revoked' WHERE id = ?`).run(otherSessionId);
    const res = await post(bodyFor(otherSessionId), OTHER_TOKEN);
    assert.equal(res.status, 403);
  });

  test('the deprecated global key still verifies, and SAYS SO', async () => {
    // The enumerated remainder. It is kept only because
    // test/v2/kohya-honesty.test.ts signs its fixtures with it and is out of
    // WO-12's scope to edit; nothing distributes the value any more. What this
    // test pins is that the path can never be taken SILENTLY — a fallback you
    // cannot see is the thing WO-12 forbids.
    const res = await post(bodyFor(sessionId), GLOBAL_SECRET);
    const b = await res.json();
    assert.equal(res.status, 200);
    assert.equal(
      b.credential,
      'global-deprecated',
      'a declaration accepted on the global key must be labelled as such in the response',
    );
    assert.equal(b.witnessed, false);
  });

  test('the route prefers the session key when both would verify', async () => {
    const res = await post(bodyFor(sessionId), SESSION_TOKEN);
    const b = await res.json();
    assert.equal(
      b.credential,
      'session',
      'order matters: a deployment that still has the variable set must not attribute ' +
        'session-keyed traffic to the deprecated path',
    );
  });
});
