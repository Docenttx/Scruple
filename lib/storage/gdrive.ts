// Google Drive storage provider (Pivot S3).
//
// Ported from ai-council/lib/gdrive/client.ts with two key changes:
//   1. Per-user tokens (gdrive_tokens keyed by user_id, encrypted at rest)
//   2. Implements the StorageProvider interface
//
// OAuth scope is `drive.file` — Scruple can only see/modify files it created.
// User's existing Drive content is invisible to us, which is the right
// privacy posture for BYOS (D-017).

import { conn } from '@/lib/db/sqlite';
import { encryptSecret, decryptSecret } from '@/lib/auth/encryption';
import {
  StorageError,
  type StorageProvider,
  type StoragePointer,
  type UploadResult,
  type FolderEntry,
} from './types';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const SCRUPLE_ROOT = 'Scruple Projects';

interface TokenRow {
  user_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: number;
  user_email: string | null;
  user_name: string | null;
}

function fetchTokenRow(userId: string): TokenRow | undefined {
  return conn()
    .prepare(`SELECT * FROM gdrive_tokens WHERE user_id = ?`)
    .get(userId) as TokenRow | undefined;
}

async function refreshAccessToken(userId: string, row: TokenRow): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new StorageError('gdrive', 'auth', 'GOOGLE_CLIENT_ID / SECRET missing');
  }
  const refreshToken = decryptSecret(row.refresh_token_enc);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new StorageError('gdrive', 'auth', `refresh failed: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  const newExpires = Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
  conn()
    .prepare(`UPDATE gdrive_tokens SET access_token_enc = ?, expires_at = ? WHERE user_id = ?`)
    .run(encryptSecret(data.access_token), newExpires, userId);
  return data.access_token;
}

async function getAccessToken(userId: string): Promise<string> {
  const row = fetchTokenRow(userId);
  if (!row) throw new StorageError('gdrive', 'not_connected', 'Drive not connected');
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now + 300) {
    return refreshAccessToken(userId, row);
  }
  return decryptSecret(row.access_token_enc);
}

// ── Folder ops (idempotent create-or-get) ─────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const q = [
    `name='${name.replace(/'/g, "\\'")}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
  ];
  if (parentId) q.push(`'${parentId}' in parents`);
  const url = `${DRIVE_BASE}/files?q=${encodeURIComponent(q.join(' and '))}&fields=files(id,name)&pageSize=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new StorageError('gdrive', 'transport', `findFolder HTTP ${res.status}`);
  const data = (await res.json()) as { files: DriveFile[] };
  return data.files[0]?.id ?? null;
}

async function createFolder(token: string, name: string, parentId?: string): Promise<string> {
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) body.parents = [parentId];
  const res = await fetch(`${DRIVE_BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new StorageError('gdrive', 'transport', `createFolder HTTP ${res.status}`);
  const data = (await res.json()) as DriveFile;
  return data.id;
}

async function ensureFolder(token: string, name: string, parentId?: string): Promise<string> {
  return (await findFolder(token, name, parentId)) ?? createFolder(token, name, parentId);
}

async function ensureFolderPath(token: string, rootId: string, segments: string[]): Promise<string> {
  let current = rootId;
  for (const seg of segments) {
    current = await ensureFolder(token, seg, current);
  }
  return current;
}

async function getRootId(token: string): Promise<string> {
  return ensureFolder(token, SCRUPLE_ROOT);
}

// ── File ops ───────────────────────────────────────────────────────────────

const MULTIPART_BOUNDARY = '-------scruple-boundary-' + Math.random().toString(36).slice(2);

async function uploadBytes(
  token: string,
  parentId: string,
  filename: string,
  bytes: Buffer,
  mimeType: string,
): Promise<DriveFile> {
  const metadata = { name: filename, parents: [parentId] };
  const delim = `--${MULTIPART_BOUNDARY}`;
  const head = Buffer.from(
    `${delim}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `${delim}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n${delim}--\r\n`, 'utf8');
  const body = Buffer.concat([head, bytes, tail]);

  const res = await fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,size,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new StorageError('gdrive', 'transport', `upload HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as DriveFile;
}

async function downloadBytes(token: string, fileId: string): Promise<Buffer> {
  const res = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new StorageError('gdrive', 'transport', `download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function deleteFile(token: string, fileId: string): Promise<void> {
  const res = await fetch(`${DRIVE_BASE}/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new StorageError('gdrive', 'transport', `delete HTTP ${res.status}`);
  }
}

// ── Audit logging ──────────────────────────────────────────────────────────

function logSync(
  userId: string,
  iterationId: number | null,
  operation: 'upload' | 'read' | 'delete',
  status: 'ok' | 'err',
  detail?: string,
  sizeBytes?: number,
) {
  try {
    conn()
      .prepare(
        `INSERT INTO storage_sync_log (user_id, iteration_id, operation, provider, status, detail, size_bytes)
         VALUES (?, ?, ?, 'gdrive', ?, ?, ?)`,
      )
      .run(userId, iterationId, operation, status, detail ?? null, sizeBytes ?? null);
  } catch (e) {
    console.error('[gdrive] logSync failed', e);
  }
}

// ── Public provider impl ───────────────────────────────────────────────────

export const gdriveProvider: StorageProvider = {
  kind: 'gdrive',

  async isConnected(userId) {
    return !!fetchTokenRow(userId);
  },

  async uploadFile(userId, path, bytes, contentType) {
    const token = await getAccessToken(userId);
    const segments = path.split('/').filter(Boolean);
    const filename = segments.pop();
    if (!filename) throw new StorageError('gdrive', 'unknown', 'empty path');
    const rootId = await getRootId(token);
    const targetFolderId = segments.length > 0 ? await ensureFolderPath(token, rootId, segments) : rootId;

    try {
      const result = await uploadBytes(token, targetFolderId, filename, bytes, contentType);
      logSync(userId, null, 'upload', 'ok', result.webViewLink, bytes.length);
      return {
        pointer: {
          provider: 'gdrive',
          fileId: result.id,
          path: `${SCRUPLE_ROOT}/${path}`,
          url: result.webViewLink,
          size: bytes.length,
        },
      };
    } catch (e) {
      logSync(userId, null, 'upload', 'err', e instanceof Error ? e.message : String(e));
      throw e;
    }
  },

  async readFile(userId, pointer) {
    const token = await getAccessToken(userId);
    try {
      const buf = await downloadBytes(token, pointer.fileId);
      logSync(userId, null, 'read', 'ok', undefined, buf.length);
      return buf;
    } catch (e) {
      logSync(userId, null, 'read', 'err', e instanceof Error ? e.message : String(e));
      throw e;
    }
  },

  async deleteFile(userId, pointer) {
    const token = await getAccessToken(userId);
    try {
      await deleteFile(token, pointer.fileId);
      logSync(userId, null, 'delete', 'ok');
    } catch (e) {
      logSync(userId, null, 'delete', 'err', e instanceof Error ? e.message : String(e));
      throw e;
    }
  },
};

// ── OAuth setup helpers (used by /api/auth/gdrive/callback) ───────────────

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new StorageError('gdrive', 'auth', 'GOOGLE_CLIENT_ID / SECRET missing');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new StorageError('gdrive', 'auth', `token exchange failed: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchUserProfile(accessToken: string): Promise<{ email: string; name?: string }> {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new StorageError('gdrive', 'auth', `userinfo HTTP ${res.status}`);
  return res.json();
}

export function persistGDriveTokens(
  userId: string,
  tokens: { access_token: string; refresh_token: string; expires_in: number; scope?: string },
  profile: { email: string; name?: string },
): void {
  const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
  conn()
    .prepare(
      `INSERT INTO gdrive_tokens (user_id, access_token_enc, refresh_token_enc, expires_at, user_email, user_name, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         expires_at = excluded.expires_at,
         user_email = excluded.user_email,
         user_name = excluded.user_name,
         scope = excluded.scope,
         connected_at = datetime('now')`,
    )
    .run(
      userId,
      encryptSecret(tokens.access_token),
      encryptSecret(tokens.refresh_token),
      expiresAt,
      profile.email,
      profile.name ?? null,
      tokens.scope ?? null,
    );

  // Set as the active provider in storage_providers
  conn()
    .prepare(
      `INSERT INTO storage_providers (user_id, provider, encrypted_creds, root_folder, metadata, updated_at)
       VALUES (?, 'gdrive', '{}', ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         provider = 'gdrive',
         root_folder = excluded.root_folder,
         metadata = excluded.metadata,
         updated_at = datetime('now')`,
    )
    .run(userId, SCRUPLE_ROOT, JSON.stringify({ email: profile.email, name: profile.name }));
}

export function disconnectGDrive(userId: string): void {
  conn().prepare(`DELETE FROM gdrive_tokens WHERE user_id = ?`).run(userId);
  conn().prepare(`DELETE FROM storage_providers WHERE user_id = ? AND provider = 'gdrive'`).run(userId);
}
