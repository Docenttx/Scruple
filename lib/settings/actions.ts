'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { encryptSecret, decryptSecret } from '@/lib/auth/encryption';
import type { ProviderKeys, UserRow } from '@/lib/types';

async function userId(): Promise<string> {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (!id) throw new Error('Unauthorized');
  return id;
}

// Returns a redacted view (key presence + last 4 chars only) so the
// settings page can confirm a key is set without exposing it.
export async function getProviderKeyStatus(): Promise<{
  fal: { present: boolean; tail?: string };
  comfydeploy: { present: boolean; tail?: string };
}> {
  const uid = await userId();
  const row = conn().prepare(`SELECT provider_keys FROM users WHERE id = ?`).get(uid) as
    { provider_keys: string } | undefined;
  const enc: Record<string, string> = row?.provider_keys ? JSON.parse(row.provider_keys) : {};

  function status(name: keyof ProviderKeys): { present: boolean; tail?: string } {
    if (!enc[name]) return { present: false };
    try {
      const plain = decryptSecret(enc[name]);
      return { present: true, tail: plain.slice(-4) };
    } catch {
      return { present: true, tail: '????' };
    }
  }

  return { fal: status('fal'), comfydeploy: status('comfydeploy') };
}

// Internal — used by provider call sites.
export async function getDecryptedProviderKey(name: keyof ProviderKeys): Promise<string | null> {
  const uid = await userId();
  const row = conn().prepare(`SELECT provider_keys FROM users WHERE id = ?`).get(uid) as
    { provider_keys: string } | undefined;
  if (!row?.provider_keys) return null;
  const enc: Record<string, string> = JSON.parse(row.provider_keys);
  if (!enc[name]) return null;
  try {
    return decryptSecret(enc[name]);
  } catch {
    return null;
  }
}

const SetKeySchema = z.object({
  provider: z.enum(['fal', 'comfydeploy']),
  // Empty string clears the key
  value: z.string(),
});

export async function setProviderKey(input: z.infer<typeof SetKeySchema>): Promise<void> {
  const uid = await userId();
  const parsed = SetKeySchema.parse(input);

  const row = conn().prepare(`SELECT provider_keys FROM users WHERE id = ?`).get(uid) as
    { provider_keys: string } | undefined;
  const enc: Record<string, string> = row?.provider_keys ? JSON.parse(row.provider_keys) : {};

  if (parsed.value.trim() === '') {
    delete enc[parsed.provider];
  } else {
    enc[parsed.provider] = encryptSecret(parsed.value.trim());
  }

  conn().prepare(`UPDATE users SET provider_keys = ? WHERE id = ?`).run(JSON.stringify(enc), uid);
  revalidatePath('/settings');
}
