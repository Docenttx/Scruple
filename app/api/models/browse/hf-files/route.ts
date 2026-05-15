// GET /api/models/browse/hf-files?repo=<owner/name>
//
// Lists the downloadable model files in an HF repo. Filters to
// safetensors/ckpt/pt/pth/bin/gguf since those are the only files
// ComfyUI actually loads. Skips lfs pointers and json/text files.
//
// Returns: { ok, files: [{ path, size }], modelType, recommendedSubdir }
//
// The UI uses recommendedSubdir to prefill the target_subpath input.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { readUserSettings } from '@/lib/settings/user';

export const dynamic = 'force-dynamic';

interface TreeEntry {
  type: 'file' | 'directory';
  path: string;
  size?: number;
  oid?: string;
}

const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i;

// Heuristic: guess subdir from filename + repo tags.
function guessSubdir(repo: string, filename: string): string {
  const lower = (repo + '/' + filename).toLowerCase();
  if (lower.includes('lora')) return 'loras';
  if (lower.includes('vae') || lower.endsWith('ae.safetensors')) return 'vae';
  if (lower.includes('controlnet') || lower.includes('control-')) return 'controlnet';
  if (lower.includes('upscale') || lower.includes('esrgan')) return 'upscale_models';
  if (lower.includes('t5xxl') || lower.includes('clip_l') || lower.includes('clip_g') || lower.includes('text_encoder')) {
    return 'text_encoders';
  }
  if (lower.includes('flux1-') || lower.includes('flux-dev') || lower.includes('flux-schnell')) {
    return 'diffusion_models';
  }
  // Default: checkpoint
  return 'checkpoints';
}

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const repo = req.nextUrl.searchParams.get('repo');
  if (!repo) return NextResponse.json({ error: 'repo required' }, { status: 400 });

  const url = `https://huggingface.co/api/models/${repo}/tree/main?recursive=true`;
  const token = readUserSettings(userId).hf_token;
  const headers: Record<string, string> = { 'User-Agent': 'scruple-web/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return NextResponse.json(
        { error: `hf_${res.status}`, detail: await res.text() },
        { status: res.status },
      );
    }
    const tree = (await res.json()) as TreeEntry[];
    const files = tree
      .filter(e => e.type === 'file' && MODEL_EXT.test(e.path))
      .map(e => ({
        path: e.path,
        size: e.size ?? 0,
        downloadUrl: `https://huggingface.co/${repo}/resolve/main/${e.path}`,
        suggestedSubpath: `${guessSubdir(repo, e.path)}/${e.path.split('/').pop()}`,
      }));
    return NextResponse.json({ ok: true, repo, files });
  } catch (e) {
    return NextResponse.json(
      { error: 'hf_tree_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
