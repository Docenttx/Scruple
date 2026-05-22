// POST /api/models/fetch
//
// Body:
//   { catalogId: string }                         // one-click install
//   { sourceUrl: string, targetSubpath: string }  // arbitrary HF / direct URL
//   { civitaiUrl: string, targetSubpath?: string }// Civitai page URL — resolves via API
//
// All three forms end up calling the Modal admin_fetch endpoint with a
// concrete (sourceUrl, targetSubpath) pair. Provider tokens are pulled
// from the user's settings on the server side — never sent through the
// browser.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { fetchToVolume, ModalAdminError } from '@/lib/modelLibrary/modal-admin';
import { findById as findCatalogById } from '@/lib/modelLibrary/catalog';
import {
  resolveCivitaiUrl,
  withToken as withCivitaiToken,
  targetSubpathForCivitai,
} from '@/lib/modelLibrary/civitai';
import { readUserSettings } from '@/lib/settings/user';

export const dynamic = 'force-dynamic';

const Body = z.union([
  z.object({ catalogId: z.string().min(1) }),
  z.object({ sourceUrl: z.string().url(), targetSubpath: z.string().min(1) }),
  z.object({ civitaiUrl: z.string().url(), targetSubpath: z.string().optional() }),
]);

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  // User's tokens (encrypted in user_settings; readUserSettings handles
  // decrypt). hf_token only applies to gated HF files; civitai_token is
  // required for the Civitai path.
  const settings = readUserSettings(userId);
  const hfToken = settings.hf_token;
  const civitaiToken = settings.civitai_token;

  let sourceUrl: string;
  let targetSubpath: string;

  try {
    if ('catalogId' in body) {
      const item = findCatalogById(body.catalogId);
      if (!item) {
        return NextResponse.json({ error: 'unknown_catalog_id' }, { status: 404 });
      }
      targetSubpath = item.target_subpath;
      if (item.source === 'civitai') {
        // Civitai download URLs require the API token as a query param —
        // the HF token branch below only covers huggingface.co hosts.
        if (!civitaiToken) {
          return NextResponse.json(
            {
              error: 'civitai_token_required',
              detail: 'This catalog model is hosted on Civitai. Add a Civitai API token in Settings → Provider Tokens.',
            },
            { status: 400 },
          );
        }
        sourceUrl = withCivitaiToken(item.url, civitaiToken);
      } else {
        sourceUrl = item.url;
      }
    } else if ('civitaiUrl' in body) {
      if (!civitaiToken) {
        return NextResponse.json(
          {
            error: 'civitai_token_required',
            detail: 'Add a Civitai API token in Settings → Provider Tokens before pulling Civitai models.',
          },
          { status: 400 },
        );
      }
      const resolved = await resolveCivitaiUrl(body.civitaiUrl, civitaiToken);
      sourceUrl = withCivitaiToken(resolved.downloadUrl, civitaiToken);
      targetSubpath = body.targetSubpath
        ?? targetSubpathForCivitai(resolved.modelType, resolved.filename);
    } else {
      sourceUrl = body.sourceUrl;
      targetSubpath = body.targetSubpath;
    }
  } catch (e) {
    return NextResponse.json(
      { error: 'resolve_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  try {
    const result = await fetchToVolume({
      sourceUrl,
      targetSubpath,
      hfToken: sourceUrl.includes('huggingface.co') ? hfToken : undefined,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: 'fetch_failed', detail: result.error ?? 'unknown' },
        { status: 502 },
      );
    }
    return NextResponse.json({
      ok: true,
      function_call_id: result.function_call_id,
      target_subpath: result.target_subpath,
    });
  } catch (e) {
    const status = e instanceof ModalAdminError ? e.status : 500;
    return NextResponse.json(
      { error: 'fetch_dispatch_failed', detail: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
