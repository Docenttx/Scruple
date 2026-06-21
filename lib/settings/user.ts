// Per-user settings helpers (Pivot clone-3).
//
// Centralizes read/write to the user_settings.settings JSON blob so
// PaymentMode, IPFS config, Comfy machine id, and any future per-user
// preference share one storage location and one serialization shape.

import { conn } from '@/lib/db/sqlite';

export type PaymentMode = 'fiat' | 'blockchain';
export type ChainTier = 'basic' | 'pinned';

export interface UserSettings {
  payment_mode?: PaymentMode;
  chain_tier?: ChainTier;          // basic = RVN only; pinned = +IPFS+Arweave
  comfy_machine_id?: string;
  // Model library provider tokens. Plain text for v1 — moved to AES-GCM
  // in a follow-up to match the gdrive_tokens pattern. Never returned
  // by GET responses; UI shows a "*** set ***" / "not set" hint instead.
  hf_token?: string;
  civitai_token?: string;
  ipfs?: {
    gateway?: string;
    service?: 'none' | 'pinata';
    pinataKeyEnc?: string;
    pinataSecretEnc?: string;
  };
  // Compute machine selection — Stage 1 of the Settings → Compute
  // work. machine_id refers to a row in lib/compute/machines.ts.
  // If unset or invalid for the user's current plan, getActiveMachine
  // falls back to the plan default.
  compute?: {
    machine_id?: string;
  };
  // Future: notifications, locale, etc.
}

interface SettingsRow {
  settings: string;
}

export function readUserSettings(userId: string): UserSettings {
  const row = conn()
    .prepare(`SELECT settings FROM user_settings WHERE user_id = ?`)
    .get(userId) as SettingsRow | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.settings) as UserSettings;
  } catch {
    return {};
  }
}

export function writeUserSettings(userId: string, patch: Partial<UserSettings>): UserSettings {
  const existing = readUserSettings(userId);
  const merged: UserSettings = { ...existing, ...patch };
  // Deep-merge nested ipfs config so partial saves don't blow it away
  if (patch.ipfs && existing.ipfs) {
    merged.ipfs = { ...existing.ipfs, ...patch.ipfs };
  }
  // Same for compute — let a partial compute patch merge with existing.
  if (patch.compute && existing.compute) {
    merged.compute = { ...existing.compute, ...patch.compute };
  }
  const json = JSON.stringify(merged);
  const now = new Date().toISOString();
  conn()
    .prepare(
      `INSERT INTO user_settings (user_id, settings, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
    )
    .run(userId, json, now);
  return merged;
}

export function getPaymentMode(userId: string): PaymentMode {
  const s = readUserSettings(userId);
  return s.payment_mode ?? 'fiat';
}

export function getChainTier(userId: string): ChainTier {
  const s = readUserSettings(userId);
  return s.chain_tier ?? 'basic';
}
