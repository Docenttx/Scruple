// Civitai URL normalization.
//
// Users typically paste a page URL like:
//   https://civitai.com/models/773439/body-flux-fix
//   https://civitai.com/models/773439?modelVersionId=865550
// What fetch_to_volume needs is the actual download URL:
//   https://civitai.com/api/download/models/{versionId}?token={apiKey}
//
// resolveCivitaiUrl() walks Civitai's public API to find the latest
// version of the model and returns the canonical download URL.

interface ModelVersion {
  id: number;
  name: string;
  files: Array<{
    name: string;
    sizeKB: number;
    type: string;
    downloadUrl: string;
  }>;
}

interface ModelMeta {
  id: number;
  name: string;
  type: string;
  modelVersions: ModelVersion[];
}

export interface ResolvedCivitai {
  downloadUrl: string;       // ready-to-fetch URL (no token attached yet)
  filename: string;
  versionId: number;
  modelName: string;
  modelType: string;          // LORA / Checkpoint / etc.
  sizeKB: number;
}

function parseCivitaiUrl(url: string): { modelId: number; versionId?: number } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('civitai.com')) return null;
    const m = u.pathname.match(/^\/models\/(\d+)/);
    if (!m) return null;
    const modelId = Number(m[1]);
    const versionParam = u.searchParams.get('modelVersionId');
    const versionId = versionParam ? Number(versionParam) : undefined;
    return { modelId, versionId };
  } catch {
    return null;
  }
}

export async function resolveCivitaiUrl(
  pageUrl: string,
  apiToken?: string,
): Promise<ResolvedCivitai> {
  const parsed = parseCivitaiUrl(pageUrl);
  if (!parsed) throw new Error(`Not a Civitai model URL: ${pageUrl}`);

  const headers: Record<string, string> = { 'User-Agent': 'scruple-web/1.0' };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;

  const res = await fetch(`https://civitai.com/api/v1/models/${parsed.modelId}`, { headers });
  if (!res.ok) {
    throw new Error(`Civitai API ${res.status} for model ${parsed.modelId}`);
  }
  const meta = (await res.json()) as ModelMeta;
  if (!Array.isArray(meta.modelVersions) || meta.modelVersions.length === 0) {
    throw new Error(`Civitai model ${parsed.modelId} has no versions`);
  }

  const version =
    (parsed.versionId && meta.modelVersions.find(v => v.id === parsed.versionId)) ||
    meta.modelVersions[0];
  if (!version) throw new Error(`Civitai version not found for model ${parsed.modelId}`);

  const file = version.files?.find(f => f.type === 'Model') ?? version.files?.[0];
  if (!file) throw new Error(`Civitai version ${version.id} has no files`);

  return {
    downloadUrl: file.downloadUrl,
    filename: file.name,
    versionId: version.id,
    modelName: meta.name,
    modelType: meta.type,
    sizeKB: file.sizeKB,
  };
}

// Build the canonical "fetchable" URL with token attached for fetch_to_volume.
// Civitai accepts the token as a query string parameter.
export function withToken(downloadUrl: string, token: string): string {
  const u = new URL(downloadUrl);
  u.searchParams.set('token', token);
  return u.toString();
}

// Civitai LoRAs land under loras/. Checkpoints under checkpoints/.
// VAEs under vae/. Map Civitai modelType → ComfyUI subdir.
export function targetSubpathForCivitai(
  modelType: string,
  filename: string,
): string {
  const dir = (() => {
    const t = modelType.toUpperCase();
    if (t.includes('LORA')) return 'loras';
    if (t.includes('CHECKPOINT')) return 'checkpoints';
    if (t.includes('VAE')) return 'vae';
    if (t.includes('CONTROLNET')) return 'controlnet';
    if (t.includes('UPSCALER')) return 'upscale_models';
    if (t.includes('EMBEDDING')) return 'embeddings';
    return 'loras'; // sensible default
  })();
  return `${dir}/${filename}`;
}
