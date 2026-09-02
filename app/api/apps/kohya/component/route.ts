// GET /api/apps/kohya/component — the capture component, as a tarball.
//
// WO-35 option 2. The proven Docker-free pattern (public image +
// dockerStartCmd) already exists for the Kohya GUI hook, which is ONE python
// file served from `public/pod-hooks/`. The job-API component is fifty-odd
// TypeScript files, so it is streamed from here instead of committed as a
// build artifact.
//
// AUTHENTICATED, unlike `public/pod-hooks/`. The pod is handed
// SCRUPLE_API_KEY before it fetches anything, so it can present one, and a
// public endpoint would be a strictly weaker default for no gain. Nothing
// here is secret — it is the same source the repository holds — but "not
// secret" is not a reason to serve it to the internet.
//
// WHAT THIS DOES NOT DO, said plainly because the whole placement argument
// turns on it: a tarball fetched at boot is NOT an image digest. Option 1
// pins the toolchain with something a registry can attest to; this pins it
// with a hash the component computes about a payload it just downloaded. The
// difference is recorded in the seal manifest as `declared` rather than
// `content`, and in docs/canon/demo-readiness/training-founder-checklist.md.

import { NextResponse, type NextRequest } from 'next/server';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { requireUser } from '@/lib/auth/apiKey';
import { COMPONENT_PAYLOAD } from '@/lib/apps/kohya/component-files';

export const dynamic = 'force-dynamic';

function tarball(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `--sort=name` and a fixed mtime: two fetches of an unchanged tree must
    // produce identical bytes, or the digest the boot script prints means
    // nothing and a pod cannot be compared to another pod.
    const proc = spawn(
      'tar',
      [
        '-czf', '-',
        '--sort=name',
        '--mtime=UTC 2020-01-01',
        '--owner=0', '--group=0', '--numeric-owner',
        ...COMPONENT_PAYLOAD,
      ],
      { cwd: process.cwd() },
    );
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => errs.push(c));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`tar exited ${code}: ${Buffer.concat(errs).toString().slice(0, 400)}`)),
    );
  });
}

export async function GET(req: NextRequest) {
  const me = await requireUser(req);
  if (!me) {
    return NextResponse.json(
      { error: 'Unauthorized. Present a Scruple API key as `Authorization: Bearer sk_…`.' },
      { status: 401 },
    );
  }

  let bytes: Buffer;
  try {
    bytes = await tarball();
  } catch (e) {
    return NextResponse.json(
      { error: 'component_pack_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/gzip',
      'content-length': String(bytes.length),
      // The boot script echoes this and the component records it. It is the
      // closest thing option 2 has to an image digest, and it is deliberately
      // named so nobody mistakes it for one.
      'x-scruple-component-sha256': createHash('sha256').update(bytes).digest('hex'),
      'x-scruple-component-files': String(COMPONENT_PAYLOAD.length),
      'cache-control': 'no-store',
    },
  });
}
