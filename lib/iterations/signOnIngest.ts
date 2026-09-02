// WO-27 §5 — THE C2PA SIGNER'S FIRST CALLER.
//
// THE FINDING THIS CLOSES. `docs/canon/demo-readiness/SYNTHESIS.md`:
// "Nothing signs. /api/scruple/c2pa/sign has ZERO in-repo callers and the
// button is hard-disabled." The capability is built, measured and correct —
// MP4 and MOV signing were exercised by hand — and no generation flow has
// ever invoked it. A signer with no caller is not a feature, it is a
// rehearsal.
//
// WHY A FLAG AND NOT A DEFAULT, stated plainly so nobody has to guess later.
//
// WO-26 is the sibling work order that makes the signer's entry point
// correct and documented, and it had not landed when this was written. Two
// things about signing are decided there and not here:
//
//   1. WHICH CERT SIGNS. `signAsset` falls back to the DEV cert committed
//      in services/c2pa-signer/keys/. A credential signed by the dev cert
//      reads `signingCredential.untrusted` — expected for a local
//      experiment, and NOT something to start emitting from every
//      production generation without the founder deciding it.
//   2. WHAT THE MANIFEST SAYS ABOUT THE TRAINER. SYNTHESIS.md's first two
//      founder items are both wrong statements already inside a signed
//      manifest. Signing more assets before those are corrected multiplies
//      the thing that has to be re-signed.
//
// So: ONE clearly-named flag, off by default, and NO second signing path.
// Everything below composes a `SignAssetInput` and hands it to the SAME
// `signAsset()` that `/api/scruple/c2pa/sign` uses. When WO-26 lands, the
// change here is the flag's default and nothing else.
//
// It is also non-blocking, for the reason ingest already gives about the
// witness call: a signing failure does not un-produce the artifact, and
// refusing the ingest would convert a flagged fact into a silence.

import { isModalityAvailable } from '@/lib/v2/capabilities';
import type { OutputKind } from '@/lib/iterations/ingest';

/** The env var. One name, and it appears exactly here. */
export const SIGN_ON_INGEST_FLAG = 'SCRUPLE_C2PA_SIGN_ON_INGEST';

export type C2paIngestStatus =
  /** The flag is off. Nothing was attempted and nothing is claimed. */
  | 'disabled'
  /** The flag is on but this media type is not one we sign. */
  | 'unsupported_media'
  /** Signed. `outputPath` holds the signed bytes. */
  | 'signed'
  /** Attempted and failed. `error` says how. Never silent. */
  | 'failed';

export interface C2paIngestOutcome {
  status: C2paIngestStatus;
  /** Why, in words, for every status including the successful one. */
  reason: string;
  outputPath?: string;
  /** IPTC digital source type actually declared, when we signed. */
  digitalSourceType?: string;
  error?: string;
}

export interface SignOnIngestParams {
  userId: string;
  projectId: number;
  iterationId: number;
  /** Local content-addressed path of the artifact ingest just stored. */
  assetPath: string;
  contentType: string;
  outputKind: OutputKind;
  leafHash: string;
  leafScheme: 'v1' | 'v2' | 'v2.2';
  witnessed: boolean;
  workflowHash: string | null;
  modelFingerprintsHash: string | null;
  machineManifestHash: string | null;
  /**
   * Whether an input image/frame/video fed this generation.
   *
   * This is the ONLY thing that decides digitalSourceType, and it decides a
   * claim rather than a label. `docs/canon/studio-l2/03-c2pa.md:244` — any
   * init_image / source_image / control_image present makes the asset
   * COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA. Signing an img2vid output as
   * TRAINED_ALGORITHMIC_MEDIA claims pure GenAI provenance for an asset
   * that is provably a composite, which is a false credential on exactly
   * the flow the survey is about.
   */
  hasGenerativeInputs: boolean;
}

/** The four values WorkflowAssertionData allows, chosen from what ran.
 *  There is no img2vid value in the contract; video is `txt2video` and the
 *  composite fact is carried by digitalSourceType, which is the field the
 *  C2PA spec actually reads for it. */
function generationTypeFor(
  kind: OutputKind,
  hasInputs: boolean,
): 'txt2img' | 'img2img' | 'txt2video' | 'lora_train' {
  if (kind === 'checkpoint') return 'lora_train';
  if (kind === 'video') return 'txt2video';
  return hasInputs ? 'img2img' : 'txt2img';
}

export function signOnIngestEnabled(): boolean {
  const v = (process.env[SIGN_ON_INGEST_FLAG] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export async function signIngestedArtifact(
  p: SignOnIngestParams,
): Promise<C2paIngestOutcome> {
  if (!signOnIngestEnabled()) {
    return {
      status: 'disabled',
      reason:
        `${SIGN_ON_INGEST_FLAG} is not set. The call site exists and is wired; ` +
        `signing is off until WO-26 settles which certificate signs and the two ` +
        `manifest corrections in SYNTHESIS.md land.`,
    };
  }

  // The server's own answer about this media type, not a second list.
  // `comfyui` is the host every path through ingestIteration is.
  const cap = isModalityAvailable('comfyui', p.contentType, 'c2pa');
  if (!cap.available) {
    return {
      status: 'unsupported_media',
      reason: cap.reason,
    };
  }

  const digitalSourceType = p.hasGenerativeInputs
    ? 'COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA'
    : 'TRAINED_ALGORITHMIC_MEDIA';

  // The tier the leaf ACTUALLY reached, not the best one available. An
  // unwitnessed leaf is `bare`, and `bare` omits the Scruple provenance
  // assertion entirely (buildManifest in signAsset.ts) rather than
  // asserting a witness that never happened.
  const tier = p.witnessed ? 'witnessed' : 'bare';

  try {
    const { signAsset } = await import('@/lib/c2pa/signAsset');
    const outputPath = `${p.assetPath}.c2pa`;
    const result = await signAsset({
      assetPath: p.assetPath,
      outputPath,
      product: 'studio',
      tier,
      format: p.contentType,
      digitalSourceType,
      intent: 'CREATE',
      title: `scruple-iteration-${p.iterationId}`,
      ...(p.witnessed
        ? {
            scruple: {
              lock_tier: tier,
              leaf_hash: p.leafHash,
              signed_at: new Date().toISOString(),
            },
          }
        : {}),
      workflow: {
        ...(p.workflowHash ? { workflow_hash: p.workflowHash } : {}),
        ...(p.modelFingerprintsHash
          ? { model_fingerprints_hash: p.modelFingerprintsHash }
          : {}),
        ...(p.machineManifestHash
          ? { machine_manifest_hash: p.machineManifestHash }
          : {}),
        generation_type: generationTypeFor(p.outputKind, p.hasGenerativeInputs),
      },
    });
    if (!result.ok) {
      return {
        status: 'failed',
        reason: 'signAsset() refused or the signer subprocess failed.',
        error: result.error,
        digitalSourceType,
      };
    }
    return {
      status: 'signed',
      reason: `Signed at ${tier} tier as ${digitalSourceType}.`,
      outputPath: result.outputPath,
      digitalSourceType,
    };
  } catch (e) {
    return {
      status: 'failed',
      reason: 'The signer threw rather than returning an error.',
      error: e instanceof Error ? e.message : String(e),
      digitalSourceType,
    };
  }
}
