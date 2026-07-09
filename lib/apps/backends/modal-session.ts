// Modal session backend — wraps the existing canvas mint logic.
//
// For now, only the Canvas app uses Modal. When we let users pick the
// A10G/A100/H100 tiers for Kohya on Modal (fallback for users without a
// RunPod plan), this adapter handles that too.
//
// Terminate is a no-op: Modal's @web_server keeps the container alive
// per-request and scales down after `scaledown_window` (5 min for
// canvas). We don't need to explicitly kill it.

import {
  getMachineById,
  resolveEndpointForMachine,
  type Machine,
} from '@/lib/compute/machines';
import {
  registerSessionBackend,
  type SessionBackend,
  type SpawnRequest,
  type SpawnedEndpoint,
} from '../session-backends';

class ModalSessionBackend implements SessionBackend {
  readonly id = 'modal' as const;

  async spawnEndpoint(req: SpawnRequest): Promise<SpawnedEndpoint> {
    const machine = getMachineById(req.machineId);
    if (!machine) {
      throw new Error(`Unknown machine id '${req.machineId}' (Modal backend)`);
    }
    // Canvas has its own set of endpoint env vars (MODAL_CANVAS_APP_URL_*).
    // The general runner endpoint is MODAL_RUNNER_ENDPOINT_*. Pick based
    // on the app.
    let url: string | null;
    if (req.appId === 'canvas') {
      const canvasVar = machine.endpointEnvVar.replace(
        'MODAL_RUNNER_ENDPOINT_',
        'MODAL_CANVAS_APP_URL_',
      );
      url = process.env[canvasVar] ?? null;
      if (!url) throw new Error(`Canvas endpoint env var ${canvasVar} unset`);
    } else {
      // Non-canvas apps on Modal use the runner endpoints (Kohya fallback,
      // etc.). Later this branches per-app when Modal-hosted Kohya lands.
      const resolved = resolveEndpointForMachine(machine);
      if (!resolved.url) {
        throw new Error(
          `No Modal endpoint configured for machine '${machine.id}' + app '${req.appId}'`,
        );
      }
      url = resolved.url;
    }

    return {
      endpointId: url, // For Modal, the URL IS the id (no per-user pods)
      url,
      backend: 'modal',
    };
  }

  async terminateEndpoint(_endpointId: string): Promise<void> {
    // Modal's @web_server scales down on its own idle window. Nothing
    // to call explicitly.
    return;
  }

  pricePerHourCents(machineId: string): number {
    const m: Machine | null = getMachineById(machineId);
    return m?.hourlyRateCents ?? 0;
  }
}

registerSessionBackend(new ModalSessionBackend());
