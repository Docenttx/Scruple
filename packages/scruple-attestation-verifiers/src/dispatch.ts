// Dispatch layer: routes an incoming AttestationEnvelope to the right
// verifier plugin by `attestation_type`. Unknown types with a valid
// `verifier_reference` are handled as passthrough (stored, not verified).
//
// Plugins register themselves via `registerPlugin(plugin)`. Per WO-01,
// this file ships with an empty registry; verifier plugins land in
// subsequent WOs (WO-04 SEV-SNP first).

import type { AttestationEnvelope } from './envelope.js';
import { isBuiltInType, isPassthroughType, NONE_ATTESTATION_TYPE } from './envelope.js';
import type { VerifierPlugin, VerifyResult } from './verifier.js';
import { verifyFailure } from './verifier.js';

const registry = new Map<string, VerifierPlugin>();

export function registerPlugin(plugin: VerifierPlugin): void {
  if (registry.has(plugin.attestation_type)) {
    throw new Error(
      `verifier plugin for '${plugin.attestation_type}' already registered`,
    );
  }
  registry.set(plugin.attestation_type, plugin);
}

export function getRegisteredTypes(): string[] {
  return Array.from(registry.keys()).sort();
}

/**
 * Dispatch the envelope to the correct plugin (or passthrough handler).
 *
 * Returns a VerifyResult. NEVER throws for expected verification failures
 * (returns ok: false instead). Throws only on programmer errors.
 */
export async function dispatch(
  env: AttestationEnvelope,
  expected_nonce_hex: string,
  freshness_max_seconds: number,
): Promise<VerifyResult> {
  if (env.attestation_type === NONE_ATTESTATION_TYPE) {
    return verifyFailure(
      NONE_ATTESTATION_TYPE,
      "attestation_type='none' MUST NOT appear on a leaf envelope",
    );
  }

  if (env.nonce !== expected_nonce_hex) {
    return verifyFailure(
      env.attestation_type,
      `nonce mismatch: envelope=${env.nonce} expected=${expected_nonce_hex}`,
    );
  }

  if (isPassthroughType(env.attestation_type)) {
    if (!env.verifier_reference) {
      return verifyFailure(
        env.attestation_type,
        'passthrough attestation MUST supply verifier_reference',
      );
    }
    return {
      ok: true,
      status: 'passthrough',
      provider: env.attestation_type,
      passthrough: true,
      verifier_reference: env.verifier_reference,
    };
  }

  if (isBuiltInType(env.attestation_type)) {
    const plugin = registry.get(env.attestation_type);
    if (!plugin) {
      return verifyFailure(
        env.attestation_type,
        `built-in verifier for '${env.attestation_type}' is not registered in this build`,
      );
    }
    return plugin.verify(env, expected_nonce_hex, freshness_max_seconds);
  }

  // Should be unreachable given the classifier above.
  return verifyFailure(env.attestation_type, `unclassifiable attestation_type '${env.attestation_type}'`);
}

/** Test hook — clear the plugin registry. Do not call from production code. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
