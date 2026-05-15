// GET /api/models/browse/hf
//
// Query params:
//   q          search text
//   pipeline_tag  e.g. "text-to-image"
//   tags       filter, e.g. "lora"
//   sort       "downloads" | "likes" | "trending"
//   limit      1..100, default 20
//
// Returns normalized {items}. Each item has the repo id, downloads,
// pipeline_tag, library_name. Files are NOT included — caller picks the
// repo and calls /api/models/browse/hf-files to enumerate downloadable
// files (most repos have many, only some are model weights).

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { readUserSettings } from '@/lib/settings/user';

export const dynamic = 'force-dynamic';

interface HfApiItem {
  id: string;
  modelId?: string;
  author?: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  library_name?: string;
  tags?: string[];
  createdAt?: string;
}

interface BrowseHfItem {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  pipelineTag: string | null;
  libraryName: string | null;
  tags: string[];
  pageUrl: string;
}

function normalize(item: HfApiItem): BrowseHfItem {
  const id = item.id ?? item.modelId ?? '';
  const author = item.author ?? id.split('/')[0] ?? '?';
  return {
    id,
    author,
    downloads: item.downloads ?? 0,
    likes: item.likes ?? 0,
    pipelineTag: item.pipeline_tag ?? null,
    libraryName: item.library_name ?? null,
    tags: item.tags ?? [],
    pageUrl: `https://huggingface.co/${id}`,
  };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const url = new URL('https://huggingface.co/api/models');
  // HF API supports `search` for general text match
  if (sp.get('q')) url.searchParams.set('search', sp.get('q')!);
  if (sp.get('pipeline_tag')) url.searchParams.set('pipeline_tag', sp.get('pipeline_tag')!);
  if (sp.get('tags')) url.searchParams.set('filter', sp.get('tags')!);
  url.searchParams.set('sort', sp.get('sort') ?? 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', sp.get('limit') ?? '20');
  url.searchParams.set('full', 'true');

  // HF token is optional. If set, allows gated repos to surface.
  const token = readUserSettings(userId).hf_token;
  const headers: Record<string, string> = { 'User-Agent': 'scruple-web/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      return NextResponse.json(
        { error: `hf_${res.status}`, detail: await res.text() },
        { status: res.status },
      );
    }
    const items = ((await res.json()) as HfApiItem[]).map(normalize);
    return NextResponse.json({ ok: true, items });
  } catch (e) {
    return NextResponse.json(
      { error: 'hf_fetch_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
