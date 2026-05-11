// GET  /api/settings/ipfs  → per-user IPFS config (key tails only)
// POST /api/settings/ipfs  { gateway, service, pinataKey?, pinataSecret? }
//
// Persists to user_settings.settings JSON column. Pinata credentials
// are AES-256-GCM encrypted before storage (lib/auth/encryption.ts).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { encryptSecret, decryptSecret } from '@/lib/auth/encryption';

export const dynamic = 'force-dynamic';

interface Settings {
  ipfs?: {
    gateway?: string;
    service?: 'none' | 'pinata';
    pinataKeyEnc?: string;
    pinataSecretEnc?: string;
  };
}

const Body = z.object({
  gateway: z.string().url().optional(),
  service: z.enum(['none', 'pinata']).optional(),
  pinataKey: z.string().optional(),
  pinataSecret: z.string().optional(),
});

function readSettings(userId: string): Settings {
  const row = conn()
    .prepare(`SELECT settings FROM user_settings WHERE user_id = ?`)
    .get(userId) as { settings: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.settings) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(userId: string, s: Settings) {
  const now = new Date().toISOString();
  const json = JSON.stringify(s);
  conn()
    .prepare(
      `INSERT INTO user_settings (user_id, settings, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
    )
    .run(userId, json, now);
}

function tailOnly(s: string | undefined): string {
  if (!s) return '';
  return s.length <= 6 ? '••' : `••• ${s.slice(-4)}`;
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const s = readSettings(userId);
  const ipfs = s.ipfs ?? {};
  return NextResponse.json({
    gateway: ipfs.gateway ?? 'https://ipfs.io',
    service: ipfs.service ?? 'none',
    pinataKeyTail: ipfs.pinataKeyEnc ? tailOnly(decryptSafe(ipfs.pinataKeyEnc)) : '',
    pinataSecretTail: ipfs.pinataSecretEnc ? tailOnly(decryptSafe(ipfs.pinataSecretEnc)) : '',
  });
}

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

  const existing = readSettings(userId);
  const next: Settings = {
    ...existing,
    ipfs: {
      ...(existing.ipfs ?? {}),
      gateway: body.gateway ?? existing.ipfs?.gateway,
      service: body.service ?? existing.ipfs?.service ?? 'none',
      pinataKeyEnc: body.pinataKey
        ? encryptSecret(body.pinataKey)
        : existing.ipfs?.pinataKeyEnc,
      pinataSecretEnc: body.pinataSecret
        ? encryptSecret(body.pinataSecret)
        : existing.ipfs?.pinataSecretEnc,
    },
  };
  writeSettings(userId, next);
  return NextResponse.json({ ok: true });
}

function decryptSafe(enc: string): string | undefined {
  try {
    return decryptSecret(enc);
  } catch {
    return undefined;
  }
}
