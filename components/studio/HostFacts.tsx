'use client';

// Facts only the host process has.
//
// The server answers WHICH REGIONS APPLY. It cannot answer what ComfyUI's
// version is on someone's laptop, where their models live, or whether the gate
// is holding its port — those are readings taken on that machine, and the only
// thing that has them is the desktop host, over the preload bridge described in
// scruple-desktop/app/preload.js.
//
// ⚑ THE THREE STATES ARE THE POINT, and they are the same three the vault
// surface uses: this component renders `measured` when the bridge answered,
// `unavailable` when there is no bridge, and `refused` when the bridge answered
// with an error. It never renders a plausible default. A dashboard that printed
// "ComfyUI 0.18.1" from a constant would be manufacturing a measurement, which
// is the failure the whole estate is arranged against.

// See the note in StudioDashboard.tsx: named + default, because the test
// runner's JSX transform needs `React` in scope.
import React, { useEffect, useState } from 'react';

type Fact = 'apps' | 'gate' | 'vault' | 'modelStore' | 'blender';

/** ⚑ WO-E5. Which bridge method answers each fact. `blender` is on a channel
 *  of its own because it is a different KIND of reading: the others are an
 *  `fs.existsSync` and a live session object, and this one starts a Blender and
 *  asks it. Putting it on `scruple:profile` would make every dashboard render
 *  wait for a headless Blender, and a bridge with no `blender` method — an
 *  older host, or one built without it — reads `unavailable` here instead of
 *  making the other four panels unreadable. */
const CHANNEL: Record<Fact, 'profile' | 'blender'> = {
  apps: 'profile',
  gate: 'profile',
  vault: 'profile',
  modelStore: 'profile',
  blender: 'blender',
};

interface HostProfile {
  ok?: boolean;
  host?: string;
  apps?: Array<{ id: string; name: string; available: boolean; detail: string }>;
  gate?: { url: string | null; upstream: string | null; adapter: string | null; running: boolean } | null;
  vault?: { dir: string | null; ceilingBytes: number | null; configured: boolean } | null;
  modelStore?: { root: string | null; files: number | null } | null;
  mainPid?: number;
  // WO-E5. Only on the `blender` channel's reply. Every sub-reading carries
  // its own state and its own reason, because "there is no addon" and "the
  // Blender that would have told us never answered" are different facts.
  binary?: { path: string | null; source: string; exists: boolean } | null;
  version?: { state: string; value: string | null; reason: string } | null;
  addon?: { state: string; module: string | null; enabled: boolean | null; reason: string } | null;
  bridge?: { state: string; address: string | null; gateUrl: string | null; reason: string } | null;
}

declare global {
  interface Window {
    scruple?: {
      host?: string;
      profile?: () => Promise<HostProfile>;
      blender?: () => Promise<HostProfile>;
      [k: string]: unknown;
    };
  }
}

export default function HostFacts({ fact }: { fact: Fact }) {
  const [state, setState] = useState<'reading' | 'measured' | 'unavailable' | 'refused'>('reading');
  const [profile, setProfile] = useState<HostProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const bridge = typeof window !== 'undefined' ? window.scruple : undefined;
    const method = CHANNEL[fact];
    const call = bridge ? (bridge as Record<string, unknown>)[method] : undefined;
    if (!bridge || typeof call !== 'function') {
      setState('unavailable');
      return;
    }
    // ⚑ A READING THAT IS NOT YET ANSWERABLE IS RE-ASKED, and only that one.
    // `bridge.state === 'unknown'` means "there is no gate running to compare
    // an address against" — not an answer, a not-yet. A panel that asked once
    // and froze on it would be showing a stale non-answer for the rest of the
    // session, which on a desktop is the whole session: the user launches
    // ComfyUI after opening the dashboard, not before. Nothing else here
    // re-polls, and a `none`/`elsewhere`/`at-the-gate` answer is final.
    const pending = (p: HostProfile) => fact === 'blender' && p && p.bridge && p.bridge.state === 'unknown';
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = () => {
      (call as () => Promise<HostProfile>)
        .call(bridge)
        .then((p) => {
          if (!live) return;
          setProfile(p);
          setState(p && p.ok === false ? 'refused' : 'measured');
          if (pending(p) && tries < 20) {
            tries += 1;
            timer = setTimeout(ask, 3000);
          }
        })
        .catch((e) => {
          if (!live) return;
          setError(String((e && (e as Error).message) || e));
          setState('refused');
        });
    };
    ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [fact]);

  if (state === 'reading') {
    return (
      <div className="host-facts" data-host-fact={fact} data-state="reading">
        <span className="status-line">reading the host…</span>
      </div>
    );
  }

  if (state !== 'measured') {
    return (
      <div className="host-facts" data-host-fact={fact} data-state={state}>
        <span className="status-line">
          {state === 'unavailable'
            ? 'no host bridge — this deployment reports the region, the host reports the values, and there is no host here.'
            : `the host refused: ${error ?? 'no reason given'}`}
        </span>
      </div>
    );
  }

  return (
    <div className="host-facts" data-host-fact={fact} data-state="measured">
      {rows(fact, profile).map(([label, value]) => (
        <div className="merkle-info" key={label}>
          <span className="label">{label}</span>
          <span className="hash" data-host-value={label}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function rows(fact: Fact, p: HostProfile | null): Array<[string, string]> {
  if (!p) return [];
  if (fact === 'apps') {
    return (p.apps ?? []).map((a) => [a.name, a.detail] as [string, string]);
  }
  if (fact === 'gate') {
    if (!p.gate) return [['gate', 'not started']];
    return [
      ['url', p.gate.url ?? '—'],
      ['upstream', p.gate.upstream ?? '—'],
      ['adapter', p.gate.adapter ?? '—'],
      ['running', String(p.gate.running)],
    ];
  }
  if (fact === 'blender') {
    // ⚑ THE THREE THINGS THE WORK ORDER ASKS THE REGION TO NAME, each with the
    // state of its own reading in front of it. A reading that did not happen
    // says so; none of these falls back to a plausible value.
    const out: Array<[string, string]> = [];
    out.push(['binary', p.binary && p.binary.path ? `${p.binary.path} (${p.binary.source})` : 'none found']);
    out.push([
      'version',
      p.version && p.version.state === 'measured' && p.version.value
        ? p.version.value
        : `unread — ${(p.version && p.version.reason) || 'no reason given'}`,
    ]);
    out.push([
      'addon',
      p.addon && p.addon.state === 'measured'
        ? p.addon.enabled
          ? `enabled — ${p.addon.module}`
          : `not enabled — ${p.addon.reason}`
        : `unread — ${(p.addon && p.addon.reason) || 'no reason given'}`,
    ]);
    out.push([
      'bridge',
      p.bridge
        ? p.bridge.state === 'at-the-gate'
          ? `pointed at the gate — ${p.bridge.address}`
          : p.bridge.state === 'elsewhere'
            ? `pointed elsewhere — ${p.bridge.address}`
            : `${p.bridge.state} — ${p.bridge.reason}`
        : 'unread — the host returned nothing for the bridge',
    ]);
    return out;
  }
  if (fact === 'vault') {
    if (!p.vault) return [['vault', 'not configured']];
    return [
      ['dir', p.vault.dir ?? '—'],
      ['ceiling', p.vault.ceilingBytes === null ? '—' : `${p.vault.ceilingBytes} bytes`],
    ];
  }
  if (!p.modelStore) return [['model store', 'not configured']];
  return [
    ['root', p.modelStore.root ?? '—'],
    ['files', p.modelStore.files === null ? '—' : String(p.modelStore.files)],
  ];
}
