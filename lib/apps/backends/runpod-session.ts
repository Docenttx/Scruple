// RunPod session backend — WO-KOHYA (REST v1).
//
// Spawns a pod from a template with a specific GPU type. Waits for the
// pod to reach RUNNING with an exposed public port, then returns the
// auto-constructed proxy URL:
//   https://<podId>-<port>.proxy.runpod.net
//
// The service inside the pod MUST bind 0.0.0.0 (not 127.0.0.1) — this
// is baked into our custom Kohya image at
// `research/scruple-kohya-image/` (see WO-KOHYA Phase 4).
//
// Docs:
//   REST v1 overview: https://docs.runpod.io/api-reference/overview
//   POST /pods:       https://docs.runpod.io/api-reference/pods/POST/pods
//   GET /pods:        https://docs.runpod.io/api-reference/pods/GET/pods
//   DELETE /pods/:id: https://docs.runpod.io/api-reference/pods/DELETE/pods/podId
//   expose-ports:     https://docs.runpod.io/pods/configuration/expose-ports
//
// GraphQL note: RunPod's legacy GraphQL API still exists but REST v1 is
// the current recommendation. This adapter uses REST.

import {
  registerSessionBackend,
  type SessionBackend,
  type SpawnRequest,
  type SpawnedEndpoint,
} from '../session-backends';
import {
  getRunpodMachineById,
  RUNPOD_KOHYA_GRADIO_PORT,
} from '../runpod-machines';

const RUNPOD_REST_BASE = 'https://rest.runpod.io/v1';

interface RunpodPortMapping {
  privatePort: number;
  publicPort?: number;
  type: 'http' | 'tcp';
  ip?: string;
}

interface RunpodPod {
  id: string;
  desiredStatus: 'RUNNING' | 'EXITED' | 'PAUSED' | 'TERMINATED' | 'CREATING';
  publicIp?: string;
  portMappings?: RunpodPortMapping[];
}

async function runpodRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = process.env.RUNPOD_API_KEY;
  if (!key) {
    throw new Error(
      'RUNPOD_API_KEY not set. Add it to .env.local to enable RunPod-backed apps (Kohya, etc).',
    );
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${key}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${RUNPOD_REST_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`RunPod REST ${res.status} ${path}: ${text.slice(0, 400)}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

/** POST /v1/pods — deploy on demand from a template. */
async function podCreate(opts: {
  templateId: string;
  gpuTypeId: string;
  name: string;
  interruptible: boolean;
  containerDiskInGb: number;
  volumeInGb: number;
  cloudType: 'COMMUNITY' | 'SECURE' | 'ALL';
  env?: Record<string, string>;
}): Promise<{ podId: string }> {
  const body = {
    name: opts.name,
    templateId: opts.templateId,
    gpuTypeIds: [opts.gpuTypeId],
    gpuCount: 1,
    interruptible: opts.interruptible,
    containerDiskInGb: opts.containerDiskInGb,
    volumeInGb: opts.volumeInGb,
    cloudType: opts.cloudType,
    ports: [`${RUNPOD_KOHYA_GRADIO_PORT}/http`],
    env: opts.env ?? {},
  };
  const res = await runpodRest<{ id: string }>('/pods', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { podId: res.id };
}

async function podGet(podId: string): Promise<RunpodPod> {
  return runpodRest<RunpodPod>(`/pods/${podId}`);
}

async function podDelete(podId: string): Promise<void> {
  await runpodRest(`/pods/${podId}`, { method: 'DELETE' });
}

async function waitForPodPortHttp(
  podId: string,
  targetPort: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await podGet(podId);
    if (info.desiredStatus === 'RUNNING' && info.publicIp) {
      const p = info.portMappings?.find(
        (x) => x.privatePort === targetPort && x.publicPort,
      );
      if (p) {
        // Auto-generated proxy URL (Cloudflare-fronted, HTTPS terminated,
        // ~100s idle timeout — matches our canvas proxy's cold-start
        // shell pattern).
        return `https://${podId}-${targetPort}.proxy.runpod.net`;
      }
    }
    if (info.desiredStatus === 'TERMINATED' || info.desiredStatus === 'EXITED') {
      throw new Error(`Pod ${podId} entered ${info.desiredStatus} before exposing port`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`Pod ${podId} did not expose port ${targetPort} within ${timeoutMs}ms`);
}

class RunpodSessionBackend implements SessionBackend {
  readonly id = 'runpod' as const;

  async spawnEndpoint(req: SpawnRequest): Promise<SpawnedEndpoint> {
    const machine = getRunpodMachineById(req.machineId);
    if (!machine) throw new Error(`Unknown RunPod machine id '${req.machineId}'`);

    const templateId =
      req.appId === 'kohya'
        ? process.env.RUNPOD_KOHYA_TEMPLATE_ID
        : req.appId === 'forge'
          ? process.env.RUNPOD_FORGE_TEMPLATE_ID
          : undefined;
    if (!templateId) {
      throw new Error(
        `RUNPOD_${req.appId.toUpperCase()}_TEMPLATE_ID unset — cannot spawn '${req.appId}' pod.`,
      );
    }

    // Env passed into the pod: the monkey-patched safetensors.save_file
    // shim needs these to POST witnessed leaves back to us.
    const witnessSecret = process.env.SCRUPLE_APPS_WITNESS_SECRET ?? '';
    const witnessUrl =
      process.env.NEXT_PUBLIC_APP_BASE_URL ?? 'https://scruple.stooges.ai';
    const env: Record<string, string> = {
      SCRUPLE_USER_ID: req.userId,
      SCRUPLE_APP_ID: req.appId,
      SCRUPLE_WITNESS_URL: `${witnessUrl}/api/apps/${req.appId}/witness`,
      SCRUPLE_WITNESS_SECRET: witnessSecret,
    };
    if (req.sessionId) env.SCRUPLE_SESSION_ID = req.sessionId;

    const { podId } = await podCreate({
      templateId,
      gpuTypeId: machine.gpuTypeId,
      name: `scruple-${req.appId}-${req.userId.slice(0, 6)}`,
      interruptible: machine.cloud === 'community', // spot on community, on-demand on secure
      containerDiskInGb: 40,
      volumeInGb: 40,
      cloudType: machine.cloud === 'community' ? 'COMMUNITY' : 'SECURE',
      env,
    });

    const url = await waitForPodPortHttp(
      podId,
      RUNPOD_KOHYA_GRADIO_PORT,
      5 * 60 * 1000,
    );

    return {
      endpointId: podId,
      url,
      backend: 'runpod',
      message: `RunPod ${machine.name} pod ${podId.slice(0, 8)} ready`,
    };
  }

  async terminateEndpoint(endpointId: string): Promise<void> {
    try {
      await podDelete(endpointId);
    } catch (e) {
      console.warn('[runpod] terminate failed', endpointId, e);
    }
  }

  pricePerHourCents(machineId: string): number {
    const m = getRunpodMachineById(machineId);
    return m?.hourlyRateCents ?? 0;
  }
}

registerSessionBackend(new RunpodSessionBackend());
