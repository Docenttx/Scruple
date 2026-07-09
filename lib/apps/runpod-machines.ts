// RunPod machine catalog — parallels lib/compute/machines.ts but for
// pods on RunPod's community/secure cloud. Used by RunPod-backed apps
// (Kohya today, Forge later).
//
// Pricing is community-cloud spot rates as of 2026-07 per
// https://runpod.io/pricing (verify quarterly; RunPod shifts often).
//
// Adding a machine:
//   1) Add a row to RUNPOD_MACHINES below.
//   2) Confirm gpuTypeId matches RunPod's catalog (see
//      https://docs.runpod.io/references/gpu-types).

export const RUNPOD_KOHYA_GRADIO_PORT = 3001;

export interface RunpodMachine {
  id: string;
  name: string;
  description: string;
  /** RunPod-native GPU catalog id, e.g. 'NVIDIA GeForce RTX 4090'. */
  gpuTypeId: string;
  vramGb: number;
  hourlyRateCents: number;
  monthlyEstimateUsd8hPerDay: number;
  coldStartSeconds: number;
  /** Community | Secure. Community is spot, cheapest; Secure is on-demand,
   *  pricier + preemption-free. */
  cloud: 'community' | 'secure';
}

export const RUNPOD_MACHINES: readonly RunpodMachine[] = [
  {
    id: 'rp-4090-community',
    name: 'RTX 4090',
    description: 'Consumer flagship. 24 GB VRAM. Best price/perf for SDXL LoRA training.',
    gpuTypeId: 'NVIDIA GeForce RTX 4090',
    vramGb: 24,
    hourlyRateCents: 34,
    monthlyEstimateUsd8hPerDay: 82,
    coldStartSeconds: 45,
    cloud: 'community',
  },
  {
    id: 'rp-a6000-community',
    name: 'RTX 6000 Ada',
    description: 'Workstation card. 48 GB VRAM. Larger batches, longer training runs.',
    gpuTypeId: 'NVIDIA RTX 6000 Ada Generation',
    vramGb: 48,
    hourlyRateCents: 79,
    monthlyEstimateUsd8hPerDay: 190,
    coldStartSeconds: 45,
    cloud: 'community',
  },
  {
    id: 'rp-a100-secure',
    name: 'A100 80GB',
    description: 'Data-center card. 80 GB VRAM. FLUX LoRA training, large SDXL LoRAs.',
    gpuTypeId: 'NVIDIA A100 80GB PCIe',
    vramGb: 80,
    hourlyRateCents: 189,
    monthlyEstimateUsd8hPerDay: 454,
    coldStartSeconds: 60,
    cloud: 'secure',
  },
  {
    id: 'rp-h100-community',
    name: 'H100 80GB',
    description: 'Latest gen. 80 GB VRAM. Fastest FLUX / SD3 / HunyuanVideo training.',
    gpuTypeId: 'NVIDIA H100 80GB HBM3',
    vramGb: 80,
    hourlyRateCents: 249,
    monthlyEstimateUsd8hPerDay: 598,
    coldStartSeconds: 60,
    cloud: 'community',
  },
] as const;

export const RUNPOD_DEFAULT_MACHINE_ID = 'rp-4090-community';

export function getRunpodMachineById(id: string): RunpodMachine | null {
  return RUNPOD_MACHINES.find((m) => m.id === id) ?? null;
}

export function getRunpodDefaultMachine(): RunpodMachine {
  const m = getRunpodMachineById(RUNPOD_DEFAULT_MACHINE_ID);
  if (!m) throw new Error(`RUNPOD_DEFAULT_MACHINE_ID ${RUNPOD_DEFAULT_MACHINE_ID} not in catalog`);
  return m;
}
