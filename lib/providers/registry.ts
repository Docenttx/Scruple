import type { GenerationProvider } from './types';
import { falProvider } from './fal';
import { comfyDeployProvider } from './comfydeploy';
import type { ProviderName } from '@/lib/types';

export const providers: Record<Exclude<ProviderName, 'manual'>, GenerationProvider> = {
  fal: falProvider,
  comfydeploy: comfyDeployProvider,
};

export function getProvider(name: ProviderName): GenerationProvider | null {
  if (name === 'manual') return null;
  return providers[name] ?? null;
}
