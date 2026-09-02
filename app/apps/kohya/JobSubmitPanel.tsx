'use client';

// The caller the job API did not have — WO-30.
//
// ---------------------------------------------------------------------------
// WHAT THIS REPLACES
// ---------------------------------------------------------------------------
//
// In `gui` mode this page iframes Kohya's Gradio launcher. Gradio is not a
// form: it builds an `accelerate launch …` argv and runs it through
// `subprocess.Popen`, and its `additional_parameters` box appends whatever the
// tenant typed. That is code execution in the container, which is why the
// placement is `unattested-client` and why nothing observed in there may ever
// be witnessed.
//
// This panel is the other surface. Every control below is generated from
// `PARAMETER_WHITELIST` (`lib/apps/kohya/form.ts`), so there is no field here
// in which a command can be written — not because it is validated away, but
// because the form has no such control to render. `docs/canon/
// demo-readiness/training.md` §6 item 2 calls this "the single smallest missing
// piece of product on the only path that reaches `server-library`".
//
// ---------------------------------------------------------------------------
// THE CREDENTIAL, AND WHY IT IS IN THE BROWSER
// ---------------------------------------------------------------------------
//
// `POST /api/apps/kohya/jobs` authenticates with an HMAC over the raw body
// keyed by `app_sessions.signed_token` — the per-session capability WO-12
// minted to replace the global `SCRUPLE_APPS_WITNESS_SECRET`. The route's own
// header says it is "already held by this user's browser"; this component is
// where that becomes true. It is 256 bits of CSPRNG, scoped to one session,
// expiring and revocable with it, and it authenticates WHOSE session is
// submitting and nothing else. It is not custody and it is not what makes the
// placement hold — the placement holds because of what the schema cannot
// express (`lib/apps/kohya/job-spec.ts`).
//
// The MAC is computed with WebCrypto over the exact bytes that are sent. It has
// to be the same string: `JSON.stringify` is called once, its result is both
// MACed and posted, and the two cannot drift.
//
// ---------------------------------------------------------------------------
// AND THE RECEIPT IS RENDERED HONESTLY
// ---------------------------------------------------------------------------
//
// The response carries `witnessed: false` with a reason, a DERIVED tier, and
// `needs_probe` — the two obligations no code in that process can check. All of
// it is shown. A client that rendered `ok: true` as "witnessed" would be making
// a claim the server did not make (D-8), and that is the precise failure
// `test/v2/kohya-honesty.test.ts` exists to catch on the other route.

import { useMemo, useState } from 'react';

import type { JobFieldDescriptor } from '@/lib/apps/kohya/form';

export interface JobSubmitPanelProps {
  sessionId: string;
  /** `app_sessions.signed_token`. See the header. */
  sessionToken: string;
  fields: JobFieldDescriptor[];
  defaults: Record<string, string | number | boolean>;
  machineName: string;
  /** What the deployment resolved, so the panel states the tier rather than
   *  assuming the one this surface is designed for. */
  surface: 'gui' | 'job-api';
}

type Value = string | number | boolean;

interface JobResponse {
  ok?: boolean;
  job_id?: string;
  run_id?: number | null;
  spec_hash?: string;
  placement?: string;
  leaf?: string;
  witnessed?: boolean;
  reason?: string;
  needs_probe?: string[];
  surface?: string;
  dispatch?: { attempted: boolean; ok: boolean; status: number | null; reason: string };
  error?: string;
  refusals?: { field: string; code: string; message: string }[];
}

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    // The route does `createHmac('sha256', signed_token)` on the same string,
    // and Node keys an HMAC from a string by its UTF-8 bytes. Matching that is
    // the whole compatibility requirement.
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default function JobSubmitPanel(props: JobSubmitPanelProps) {
  const { sessionId, sessionToken, fields, defaults, machineName, surface } = props;
  const [values, setValues] = useState<Record<string, Value>>({ ...defaults });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<JobResponse | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);

  const required = useMemo(() => fields.filter((f) => f.required), [fields]);
  const advanced = useMemo(() => fields.filter((f) => !f.required), [fields]);
  const missing = required.filter((f) => values[f.name] === undefined || values[f.name] === '');

  const set = (name: string, v: Value | undefined) =>
    setValues((prev) => {
      const next = { ...prev };
      if (v === undefined || v === '') delete next[name];
      else next[name] = v;
      return next;
    });

  async function submit() {
    setBusy(true);
    setResult(null);
    setTransportError(null);
    try {
      // ONE serialisation. The bytes that are MACed are the bytes that are
      // sent; recomputing the JSON for the request would let a key-order
      // difference produce a signature over a document nobody posted.
      const raw = JSON.stringify({ session_id: sessionId, spec: values });
      const res = await fetch('/api/apps/kohya/jobs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-scruple-signature': await hmacHex(sessionToken, raw),
        },
        body: raw,
      });
      setResult((await res.json()) as JobResponse);
    } catch (e) {
      setTransportError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-scruple-bg p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-lg font-medium text-white/90">Train a LoRA — {machineName}</h1>
          <p className="text-xs text-white/50">
            Data and hyperparameters only. This form is generated from the parameter whitelist,
            so there is no field in it that can carry a command, a path, or an argument string.
          </p>
          {surface !== 'job-api' && (
            <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-200">
              SCRUPLE_KOHYA_SURFACE is <code>{surface}</code>. This pod runs Kohya&apos;s Gradio
              launcher and has no capture component in it, so a job submitted here is{' '}
              <strong>recorded only</strong> and nothing it produces can be witnessed.
            </p>
          )}
        </header>

        <section className="space-y-4 rounded-md border border-white/10 bg-white/[0.02] p-4">
          <h2 className="text-xs uppercase tracking-wider text-white/40">Required</h2>
          {required.map((f) => (
            <Field key={f.name} f={f} value={values[f.name]} onChange={(v) => set(f.name, v)} />
          ))}
        </section>

        <section className="rounded-md border border-white/10 bg-white/[0.02]">
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="flex w-full items-center justify-between p-4 text-xs uppercase tracking-wider text-white/40 hover:text-white/70"
          >
            <span>Hyperparameters ({advanced.length})</span>
            <span>{showAdvanced ? '−' : '+'}</span>
          </button>
          {showAdvanced && (
            <div className="space-y-4 border-t border-white/10 p-4">
              {advanced.map((f) => (
                <Field key={f.name} f={f} value={values[f.name]} onChange={(v) => set(f.name, v)} />
              ))}
            </div>
          )}
        </section>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy || missing.length > 0}
            onClick={() => void submit()}
            className="rounded bg-white/10 px-4 py-2 text-sm text-white/90 hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Submitting…' : 'Submit training job'}
          </button>
          {missing.length > 0 && (
            <span className="text-[11px] text-white/40">
              still required: {missing.map((f) => f.name).join(', ')}
            </span>
          )}
        </div>

        {transportError && (
          <p className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            {transportError}
          </p>
        )}

        {result && <Receipt r={result} />}
      </div>
    </div>
  );
}

function Field({
  f,
  value,
  onChange,
}: {
  f: JobFieldDescriptor;
  value: Value | undefined;
  onChange: (v: Value | undefined) => void;
}) {
  const label = (
    <label htmlFor={`kohya-${f.name}`} className="block text-xs font-medium text-white/80">
      {f.name}
      {f.required && <span className="ml-1 text-amber-300/80">*</span>}
    </label>
  );
  const help = <p className="mt-1 text-[10px] leading-relaxed text-white/35">{f.why}</p>;
  const cls =
    'mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-xs text-white/90 outline-none focus:border-white/40';

  // NOTE WHAT IS NOT HERE: no `case 'string'`. `ParameterKind` has no such
  // member, so there is no branch to fall through into and no free-text
  // control this component is capable of rendering.
  let control: React.ReactNode;
  if (f.kind === 'boolean') {
    control = (
      <input
        id={`kohya-${f.name}`}
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked ? true : undefined)}
        className="mt-1 h-4 w-4 accent-white/70"
      />
    );
  } else if (f.kind === 'enum' && f.choices) {
    control = (
      <select
        id={`kohya-${f.name}`}
        className={cls}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange(undefined);
          const choice = f.choices?.find((c) => String(c) === raw);
          onChange(choice);
        }}
      >
        <option value="">— not set —</option>
        {f.choices.map((c) => (
          <option key={String(c)} value={String(c)}>
            {String(c)}
          </option>
        ))}
      </select>
    );
  } else if (f.kind === 'integer' || f.kind === 'number') {
    control = (
      <input
        id={`kohya-${f.name}`}
        type="number"
        className={cls}
        step={f.kind === 'integer' ? 1 : 'any'}
        min={f.min}
        max={f.max}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange(undefined);
          const n = Number(raw);
          // Sent as a NUMBER, never a string: `validateJobSpec` refuses a
          // string here and does not coerce one, deliberately.
          onChange(Number.isFinite(n) ? n : undefined);
        }}
      />
    );
  } else {
    control = (
      <input
        id={`kohya-${f.name}`}
        type="text"
        className={cls}
        maxLength={f.maxLength}
        pattern={f.pattern}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div>
      {label}
      {control}
      {help}
      {(f.min !== undefined || f.max !== undefined || f.pattern) && (
        <p className="mt-0.5 text-[10px] text-white/25">
          {f.min !== undefined && `min ${f.min} `}
          {f.max !== undefined && `max ${f.max} `}
          {f.pattern && <code>{f.pattern}</code>}
        </p>
      )}
    </div>
  );
}

/** The response, rendered without softening any of it. */
function Receipt({ r }: { r: JobResponse }) {
  if (r.error) {
    return (
      <section className="space-y-2 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-xs text-red-100">
        <h2 className="font-medium">{r.error}</h2>
        {r.reason && <p className="text-red-200/80">{r.reason}</p>}
        {r.refusals?.map((x) => (
          <p key={x.field} className="text-[11px] text-red-200/70">
            <code>{x.field}</code> · {x.code} — {x.message}
          </p>
        ))}
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-md border border-white/15 bg-white/[0.03] p-4 text-xs text-white/70">
      <h2 className="text-xs uppercase tracking-wider text-white/40">Receipt</h2>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-white/40">job_id</dt>
        <dd className="font-mono text-[11px]">{r.job_id}</dd>
        <dt className="text-white/40">run_id</dt>
        <dd className="font-mono text-[11px]">{r.run_id ?? '— (no training project bound)'}</dd>
        <dt className="text-white/40">spec_hash</dt>
        <dd className="break-all font-mono text-[11px]">{r.spec_hash}</dd>
        <dt className="text-white/40">placement</dt>
        <dd className="font-mono text-[11px]">{r.placement}</dd>
        <dt className="text-white/40">leaf</dt>
        <dd className="font-mono text-[11px]">{r.leaf}</dd>
        <dt className="text-white/40">witnessed</dt>
        <dd className="font-mono text-[11px]">{String(r.witnessed)}</dd>
      </dl>
      {r.reason && <p className="text-[11px] leading-relaxed text-white/50">{r.reason}</p>}
      {r.dispatch && (
        <p
          className={`rounded border p-2 text-[11px] leading-relaxed ${
            r.dispatch.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100/80'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-100/80'
          }`}
        >
          <strong>{r.dispatch.ok ? 'started' : 'not started'}</strong>
          {r.dispatch.status !== null && ` (${r.dispatch.status})`} — {r.dispatch.reason}
        </p>
      )}
      {r.needs_probe && r.needs_probe.length > 0 && (
        <div className="rounded border border-white/10 p-2">
          <p className="text-[10px] uppercase tracking-wider text-white/35">
            claims still awaiting a probe
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] text-white/45">
            {r.needs_probe.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
