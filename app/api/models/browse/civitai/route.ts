// GET /api/models/browse/civitai
//
// Query params:
//   q          search text
//   types      Civitai type (LORA, Checkpoint, VAE, Controlnet, etc.)
//   baseModel  e.g. "Flux.1 D", "SDXL 1.0", "SD 1.5"
//   sort       "Highest Rated" | "Most Downloaded" | "Newest"
//   limit      1..100, default 20
//   cursor     pagination cursor returned by previous call
//
// Returns normalized {items, nextCursor}. Items shaped for the UI grid.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { readUserSettings } from '@/lib/settings/user';

export const dynamic = 'force-dynamic';

interface CivitaiSearchItem {
  id: number;
  name: string;
  type: string;
  description?: string;
  creator?: { username?: string };
  stats?: { downloadCount?: number; favoriteCount?: number; rating?: number };
  modelVersions?: Array<{
    id: number;
    name: string;
    baseModel?: string;
    images?: Array<{ url: string; nsfwLevel?: number }>;
    files?: Array<{ name: string; sizeKB: number; type: string }>;
  }>;
}

interface BrowseItem {
  id: number;
  name: string;
  type: string;
  creator: string;
  downloads: number;
  baseModel: string | null;
  thumbnail: string | null;
  pageUrl: string;            // ready for /api/models/fetch civitaiUrl
  primaryFile: string | null;
  sizeKB: number | null;
}

function normalize(item: CivitaiSearchItem): BrowseItem {
  const v0 = item.modelVersions?.[0];
  const file = v0?.files?.find(f => f.type === 'Model') ?? v0?.files?.[0];
  const thumb = v0?.images?.find(img => (img.nsfwLevel ?? 1) <= 1)?.url
    ?? v0?.images?.[0]?.url
    ?? null;
  const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    creator: item.creator?.username ?? '?',
    downloads: item.stats?.downloadCount ?? 0,
    baseModel: v0?.baseModel ?? null,
    thumbnail: thumb,
    pageUrl: `https://civitai.com/models/${item.id}/${slug}`,
    primaryFile: file?.name ?? null,
    sizeKB: file?.sizeKB ?? null,
  };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;

  // Direct model lookup mode — when the UI parses a pasted Civitai URL
  // it sends `modelId=<id>`. Skips search entirely and returns a single
  // normalized item.
  const modelId = sp.get('modelId');
  if (modelId) {
    const token = readUserSettings(userId).civitai_token;
    const headers: Record<string, string> = { 'User-Agent': 'scruple-web/1.0' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`https://civitai.com/api/v1/models/${modelId}`, { headers });
      if (!res.ok) {
        return NextResponse.json(
          { error: `civitai_${res.status}`, detail: await res.text() },
          { status: res.status },
        );
      }
      const item = (await res.json()) as CivitaiSearchItem;
      return NextResponse.json({ ok: true, items: [normalize(item)], nextCursor: null });
    } catch (e) {
      return NextResponse.json(
        { error: 'civitai_lookup_failed', detail: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      );
    }
  }

  // Civitai's /api/v1/models has a known quirk: combining `query` with
  // `types` + `baseModels` AND-filters wrong and returns 0 results even
  // when matches exist. When the user enters a query, drop the type/base
  // filters and let the query alone drive results.
  const q = sp.get('q');
  const url = new URL('https://civitai.com/api/v1/models');
  const params: Array<[string, string | null]> = q
    ? [
        ['query', q],
        ['sort', sp.get('sort') ?? 'Most Downloaded'],
        ['limit', sp.get('limit') ?? '20'],
        ['cursor', sp.get('cursor')],
        ['nsfw', 'false'],
      ]
    : [
        ['types', sp.get('types')],
        ['baseModels', sp.get('baseModel')],
        ['sort', sp.get('sort') ?? 'Most Downloaded'],
        ['limit', sp.get('limit') ?? '20'],
        ['cursor', sp.get('cursor')],
        ['nsfw', 'false'],
      ];
  for (const [k, v] of params) {
    if (v) url.searchParams.set(k, v);
  }

  // Civitai accepts the token but doesn't require it for search.
  // Including it gets per-user-tier rate limits + their saved NSFW prefs.
  const token = readUserSettings(userId).civitai_token;
  const headers: Record<string, string> = { 'User-Agent': 'scruple-web/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      return NextResponse.json(
        { error: `civitai_${res.status}`, detail: await res.text() },
        { status: res.status },
      );
    }
    const data = (await res.json()) as { items?: CivitaiSearchItem[]; metadata?: { nextCursor?: string } };
    const items = (data.items ?? []).map(normalize);
    return NextResponse.json({ ok: true, items, nextCursor: data.metadata?.nextCursor ?? null });
  } catch (e) {
    return NextResponse.json(
      { error: 'civitai_fetch_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
