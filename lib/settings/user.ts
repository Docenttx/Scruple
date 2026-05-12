// Per-user settings helpers (Pivot clone-3).
//
// Centralizes read/write to the user_settings.settings JSON blob so
// PaymentMode, IPFS config, Comfy machine id, and any future per-user
// preference share one storage location and one serialization shape.

import { conn } from '@/lib/db/sqlite';

export type PaymentMode = 'fiat' | 'blockchain';

export interface UserSettings {
  payment_mode?: PaymentMode;
  comfy_machine_id?: string;
  ipfs?: {
    gateway?: string;
    service?: 'none' | 'pinata';
    pinataKeyEnc?: string;
    pinataSecretEnc?: string;
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
