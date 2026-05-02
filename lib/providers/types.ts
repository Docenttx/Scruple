// Generation provider interface. Each provider knows how to:
//   - submit a generation request and return a job id
//   - fetch the result given the job id (image bytes + opaque metadata)
//
// Adapters live in lib/providers/{fal,comfydeploy}.ts.

import type { GenerationSpec, GenerationResult, ProviderName } from '@/lib/types';

export interface SubmitResult {
  jobId: string;
  // Provider-specific status URL (passed back to the client for polling)
  statusUrl?: string;
  // If the provider is synchronous, we can short-circuit
  immediate?: GenerationResult;
}

export interface PollResult {
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  result?: GenerationResult;
  error?: string;
}

export interface GenerationProvider {
  readonly name: ProviderName;
  submit(spec: GenerationSpec, ctx: ProviderContext): Promise<SubmitResult>;
  poll(jobId: string, ctx: ProviderContext): Promise<PollResult>;
}

export interface ProviderContext {
  // Per-user API key (decrypted at the call site)
  apiKey?: string;
  // Optional workflow id for ComfyDeploy
  workflowId?: string;
  // Optional cookie/cf for nginx auth_request flow (future)
  scrupleSession?: string;
}

export class ProviderError extends Error {
  constructor(
    public readonly providerName: ProviderName,
    public readonly code: 'auth' | 'rate_limit' | 'invalid_input' | 'provider_failure' | 'timeout' | 'unknown',
    message: string,
  ) {
    super(`[${providerName}:${code}] ${message}`);
  }
}
