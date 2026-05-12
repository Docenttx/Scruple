// Storage dispatcher (Pivot S6).
//
// Looks up the user's chosen provider in storage_providers and returns
// the appropriate StorageProvider instance. Same per-user-account model
// as Stooges D-053: one provider per user; all writes go through it.

import { conn } from '@/lib/db/sqlite';
import type { ProviderKind, StorageProvider } from './types';
import { gdriveProvider } from './gdrive';

const REGISTRY: Record<ProviderKind, StorageProvider | null> = {
  gdrive: gdriveProvider,
  onedrive: null,    // Pivot S4 — pending
  github: null,      // Pivot S5 — pending
  'local-dev': null, // local-fs fallback — pending
};

interface ProviderRow {
  provider: ProviderKind;
}

export function getActiveProviderKind(userId: string): ProviderKind | null {
  const row = conn()
    .prepare(`SELECT provider FROM storage_providers WHERE user_id = ?`)
    .get(userId) as ProviderRow | undefined;
  return row?.provider ?? null;
}

export function getActiveProvider(userId: string): StorageProvider | null {
  const kind = getActiveProviderKind(userId);
  if (!kind) return null;
  return REGISTRY[kind] ?? null;
}

/** Convenience: throw with a useful message if no provider is connected. */
export function requireProvider(userId: string): StorageProvider {
  const p = getActiveProvider(userId);
  if (!p) {
    throw new Error(
      'No storage provider connected. Visit /settings to connect Drive / OneDrive / GitHub.',
    );
  }
  return p;
}
