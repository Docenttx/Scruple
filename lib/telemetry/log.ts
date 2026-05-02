// Telemetry insertion. Called from /api/iterations after a successful
// (or failed) generation. Cost estimates are best-effort; the providers
// don't always tell us exact billing.

import { conn } from '@/lib/db/sqlite';
import type { ProviderName } from '@/lib/types';

export interface TelemetryRecord {
  userId: string;
  projectId?: number;
  iterationId?: number;
  provider: ProviderName;
  providerJobId?: string;
  prompt?: string;
  spec: Record<string, unknown>;
  costCents?: number;
  durationMs?: number;
  success: boolean;
  error?: string;
}

export function logTelemetry(rec: TelemetryRecord): void {
  conn()
    .prepare(
      `INSERT INTO telemetry
         (user_id, project_id, iteration_id, provider, provider_job_id, prompt, spec, cost_cents, duration_ms, success, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.userId,
      rec.projectId ?? null,
      rec.iterationId ?? null,
      rec.provider,
      rec.providerJobId ?? null,
      rec.prompt ?? null,
      JSON.stringify(rec.spec),
      rec.costCents ?? 0,
      rec.durationMs ?? 0,
      rec.success ? 1 : 0,
      rec.error ?? null,
    );
}

// Estimate cost in cents per provider. v1 uses crude flat rates; we can
// refine when we have billing data.
export function estimateCostCents(provider: ProviderName): number {
  // fal.ai fast-sdxl ≈ $0.005/image; ComfyDeploy variable so 0 (user pays them)
  if (provider === 'fal') return 1;
  return 0;
}

export interface MonthlySpend {
  month: string;
  totalCents: number;
  count: number;
  byProvider: Record<string, { count: number; cents: number }>;
}

export function spendForMonth(userId: string, monthIsoPrefix: string): MonthlySpend {
  const rows = conn()
    .prepare(
      `SELECT provider, COUNT(*) AS n, COALESCE(SUM(cost_cents), 0) AS cents
       FROM telemetry WHERE user_id = ? AND substr(ts, 1, 7) = ?
       GROUP BY provider`,
    )
    .all(userId, monthIsoPrefix) as Array<{ provider: string; n: number; cents: number }>;

  const byProvider: Record<string, { count: number; cents: number }> = {};
  let totalCents = 0;
  let count = 0;
  for (const r of rows) {
    byProvider[r.provider] = { count: r.n, cents: r.cents };
    totalCents += r.cents;
    count += r.n;
  }
  return { month: monthIsoPrefix, totalCents, count, byProvider };
}
