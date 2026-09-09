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

type Fact = 'apps' | 'gate' | 'vault' | 'modelStore';

interface HostProfile {
  ok?: boolean;
  host?: string;
  apps?: Array<{ id: string; name: string; available: boolean; detail: string }>;
  gate?: { url: string | null; upstream: string | null; adapter: string | null; running: boolean } | null;
  vault?: { dir: string | null; ceilingBytes: number | null; configured: boolean } | null;
  modelStore?: { root: string | null; files: number | null } | null;
  mainPid?: number;
}

declare global {
  interface Window {
    scruple?: {
      host?: string;
      profile?: () => Promise<HostProfile>;
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
    if (!bridge || typeof bridge.profile !== 'function') {
      setState('unavailable');
      return;
    }
    bridge
      .profile()
      .then((p) => {
        if (!live) return;
        setProfile(p);
        setState(p && p.ok === false ? 'refused' : 'measured');
      })
      .catch((e) => {
        if (!live) return;
        setError(String((e && (e as Error).message) || e));
        setState('refused');
      });
    return () => {
      live = false;
    };
  }, []);

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
