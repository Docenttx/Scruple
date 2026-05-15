// Web → Modal admin client. Proxies to the admin_* HTTP endpoints
// deployed by modal/scruple_runner.py. All calls authed via the
// shared secret SCRUPLE_MODAL_ADMIN_TOKEN (same value on both sides).
//
// Endpoint pattern (configurable via env):
//   https://aquanomous--admin-list.modal.run/
//   https://aquanomous--admin-fetch.modal.run/
//   https://aquanomous--admin-delete.modal.run/
//   https://aquanomous--admin-job-status.modal.run/?call_id=…

const MODAL_WORKSPACE = process.env.MODAL_WORKSPACE ?? 'aquanomous';
const ADMIN_TOKEN = process.env.SCRUPLE_MODAL_ADMIN_TOKEN ?? '';

function adminUrl(label: string): string {
  return `https://${MODAL_WORKSPACE}--${label}.modal.run/`;
}

export interface VolumeFile {
  path: string;          // e.g. "checkpoints/v1-5-pruned-emaonly.safetensors"
  size: number;          // bytes
  mtime: number;         // unix epoch seconds
}

export interface VolumeListing {
  by_category: Record<string, VolumeFile[]>;
}

export interface FetchResult {
  ok: boolean;
  function_call_id?: string;
  target_subpath?: string;
  error?: string;
}

export interface DeleteResult {
  ok: boolean;
  removed?: string;
  error?: string;
}

export interface JobStatus {
  ok: boolean;
  pending?: boolean;
  result?: {
    ok: boolean;
    skipped?: boolean;
    target: string;
    size: number;
    sha256?: string;
    duration_seconds?: number;
  };
  error?: string;
}

export class ModalAdminError extends Error {
  constructor(public status: number, msg: string) { super(msg); this.name = 'ModalAdminError'; }
}

function assertConfigured() {
  if (!ADMIN_TOKEN) {
    throw new ModalAdminError(500, 'SCRUPLE_MODAL_ADMIN_TOKEN not set in scruple-web .env.local');
  }
}

async function adminPost(label: string, body: object): Promise<unknown> {
  assertConfigured();
  const res = await fetch(adminUrl(label), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ModalAdminError(res.status, `HTTP ${res.status} from ${label}`);
  }
  return res.json();
}

async function adminGet(label: string, query?: Record<string, string>): Promise<unknown> {
  assertConfigured();
  const url = new URL(adminUrl(label));
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { 'X-Admin-Token': ADMIN_TOKEN },
  });
  if (!res.ok) {
    throw new ModalAdminError(res.status, `HTTP ${res.status} from ${label}`);
  }
  return res.json();
}

// ── public API ───────────────────────────────────────────────────────────

export async function listVolume(): Promise<VolumeListing> {
  const data = (await adminGet('admin-list')) as { ok: boolean; by_category?: VolumeListing['by_category']; error?: string };
  if (!data.ok) throw new ModalAdminError(500, data.error ?? 'admin-list failed');
  return { by_category: data.by_category ?? {} };
}

export async function fetchToVolume(opts: {
  sourceUrl: string;
  targetSubpath: string;
  hfToken?: string;
}): Promise<FetchResult> {
  const data = (await adminPost('admin-fetch', {
    source_url: opts.sourceUrl,
    target_subpath: opts.targetSubpath,
    hf_token: opts.hfToken,
  })) as FetchResult;
  return data;
}

export async function deleteFromVolume(targetSubpath: string): Promise<DeleteResult> {
  return (await adminPost('admin-delete', { target_subpath: targetSubpath })) as DeleteResult;
}

export async function jobStatus(callId: string): Promise<JobStatus> {
  return (await adminGet('admin-job-status', { call_id: callId })) as JobStatus;
}
