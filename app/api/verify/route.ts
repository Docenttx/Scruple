// POST /api/verify
//
// Two modes — discriminated by request body shape:
//
//   Mode A (default): Lock-package manifest. Recomputes Merkle root
//   from leaf hashes and checks against the manifest's claimed root +
//   SCR-ID. No network calls.
//
//   Mode B: External-bytes hash check. Body: { contentHash, fetchUrl }.
//   Server fetches the URL, computes SHA-256, compares to contentHash.
//   Useful for third-party verifiers who want to check that a file
//   sitting on the user's storage still matches a hash recorded in
//   a published receipt. The fetchUrl is hit directly server-side;
//   no auth state is forwarded (use Drive's public-share URLs or
//   signed URLs).

import { NextRequest, NextResponse } from 'next/server';
import { computeRootFromLeaves } from '@/lib/scruple/merkle';
import { deriveScrId, sha256Hex } from '@/lib/scruple/hash';
import type { LockPackageManifest } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_FETCH_BYTES = 200 * 1024 * 1024; // 200 MB cap to avoid abuse
const FETCH_TIMEOUT_MS = 30_000;

interface ExternalBytesRequest {
  contentHash: string;
  fetchUrl: string;
}

function isExternalBytesRequest(b: unknown): b is ExternalBytesRequest {
  return (
    typeof b === 'object' &&
    b !== null &&
    typeof (b as Record<string, unknown>).contentHash === 'string' &&
    typeof (b as Record<string, unknown>).fetchUrl === 'string'
  );
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Mode B — external-bytes hash check
  if (isExternalBytesRequest(body)) {
    return verifyExternalBytes(body);
  }

  // Mode A — lock-package manifest
  return verifyManifest(body as LockPackageManifest);
}

async function verifyExternalBytes(body: ExternalBytesRequest) {
  // Basic URL sanity — must be http(s); reject obvious local-host
  // exfiltration attempts.
  let url: URL;
  try {
    url = new URL(body.fetchUrl);
  } catch {
    return NextResponse.json({ valid: false, error: 'invalid_url' }, { status: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return NextResponse.json({ valid: false, error: 'protocol_not_allowed' }, { status: 400 });
  }
  // Refuse common internal hostnames to avoid SSRF.
  const host = url.hostname.toLowerCase();
  const internal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '169.254.169.254' || // AWS/Azure/GCP metadata endpoint
    host.endsWith('.internal') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
  if (internal) {
    return NextResponse.json({ valid: false, error: 'internal_host_blocked' }, { status: 403 });
  }

  // Normalize the expected hash — strip 0x prefix, lowercase.
  const expected = body.contentHash.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return NextResponse.json({ valid: false, error: 'contentHash must be 64 hex chars (SHA-256)' }, { status: 400 });
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) {
      return NextResponse.json({
        valid: false,
        error: 'fetch_failed',
        status: res.status,
      });
    }
    const ct = res.headers.get('content-length');
    if (ct && Number(ct) > MAX_FETCH_BYTES) {
      return NextResponse.json({ valid: false, error: 'content_too_large', size: Number(ct) }, { status: 413 });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES) {
      return NextResponse.json({ valid: false, error: 'content_too_large', size: buf.length }, { status: 413 });
    }
    const computed = sha256Hex(buf);
    return NextResponse.json({
      mode: 'external-bytes',
      valid: computed === expected,
      expectedHash: expected,
      computedHash: computed,
      sizeBytes: buf.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({
      valid: false,
      error: 'fetch_error',
      detail: e instanceof Error ? e.message : String(e),
    }, { status: 502 });
  } finally {
    clearTimeout(t);
  }
}

function verifyManifest(manifest: LockPackageManifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.iterations)) {
    return NextResponse.json({ error: 'Not a Scruple lock package (v1)' }, { status: 400 });
  }

  const mismatches: string[] = [];

  // Verify ordering invariant
  for (let i = 0; i < manifest.iterations.length; i++) {
    if (manifest.iterations[i].runSequence !== i + 1) {
      mismatches.push(`run_sequence gap at index ${i} (expected ${i + 1}, got ${manifest.iterations[i].runSequence})`);
    }
  }

  // Recompute Merkle root from leaf hashes
  const leaves = manifest.iterations.map((it) => it.leafHash);
  const computedRoot = computeRootFromLeaves(leaves);
  if (!computedRoot) {
    return NextResponse.json({ error: 'Empty manifest' }, { status: 400 });
  }

  if (computedRoot !== manifest.merkleRoot) {
    mismatches.push(`Merkle root mismatch: computed=${computedRoot} expected=${manifest.merkleRoot}`);
  }

  const computedScr = deriveScrId(computedRoot, manifest.scrId.startsWith('SCRB_'));
  if (computedScr !== manifest.scrId) {
    mismatches.push(`SCR-ID mismatch: computed=${computedScr} expected=${manifest.scrId}`);
  }

  return NextResponse.json({
    mode: 'manifest',
    valid: mismatches.length === 0,
    computedRoot,
    expectedRoot: manifest.merkleRoot,
    scrId: manifest.scrId,
    computedScrId: computedScr,
    leafCount: leaves.length,
    mismatches: mismatches.length > 0 ? mismatches : undefined,
  });
}
