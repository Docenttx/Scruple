// The dashboard's regions. One component tree, two shapes.
//
// WO-D5. Every region here is rendered ONLY when the deployment's answer says
// it applies. There is no `hidden`, no `opacity-40`, no "coming soon" card and
// no empty section with a heading: `applicableRegions()` filters the list and
// the renderer maps over what is left, so an inapplicable region has no node in
// the document at all. `data-region` is on each one so that claim is checkable
// from outside the process — see scruple-desktop/scenarios/dashboard-shape.json.
//
// The markup is the canon's. `.sidebar-section`, `.section-header`,
// `.active-project`, `.project-stats`, `.stat`, `.lock-controls`, `.lock-btn`,
// `.status-indicator` and the rest are the classes from
// app-legacy/renderer/styles/main.css, carried into app/theme/canon.css by
// scripts/port-canon-css.mjs and scoped under `.scruple-canon.workspace`.
// Nothing here restyles them; where the canon has no class for something, a
// Tailwind utility built on the SAME tokens fills the gap.

// Explicit, though Next injects it: the node:test runner compiles this file
// with the classic JSX transform (the root tsconfig says `jsx: preserve`,
// which Next's compiler handles and esbuild does not), and
// test/v2/deployment-shape.test.ts renders these components for real.
import React from 'react';
import type { ComputeEntry, DeploymentCapabilities, RegionId } from '@/lib/v2/deployment';
import HostFacts from './HostFacts';

export function Section({
  region,
  title,
  children,
}: {
  region: RegionId;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="sidebar-section" data-region={region}>
      <div className="section-header">
        <h3>{title}</h3>
      </div>
      {children}
    </section>
  );
}

function ComputeList({ compute }: { compute: ComputeEntry[] }) {
  return (
    <div className="project-list">
      {compute.map((c) => (
        <div className="project-item" key={c.id} data-compute={c.id} data-backend={c.backend}>
          <div className="project-main">
            <span className="project-name">{c.name}</span>
            {/* The canon's status-indicator, coloured by the canon's own accent
                tokens — available is accent-success, not "green". */}
            <span
              className="status-indicator"
              style={{
                background: c.available ? 'var(--accent-success)' : 'var(--text-muted)',
              }}
            >
              {c.available ? 'available' : 'unavailable'}
            </span>
          </div>
          <div className="project-meta">
            <span>{c.backend}</span>
            <span>{c.source === 'host' ? 'measured by the host' : 'declared by the deployment'}</span>
          </div>
          <div className="merkle-preview">{c.reason}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The region renderers, keyed by region id.
 *
 * A region with no entry here would render nothing, so the map is exhaustive by
 * type — `Record<RegionId, …>` refuses to compile if a region is added to
 * lib/v2/deployment.ts and forgotten here.
 */
export const RENDERERS: Record<
  RegionId,
  (caps: DeploymentCapabilities) => React.ReactNode
> = {
  'local-apps': (caps) => (
    <Section region="local-apps" title="Local apps">
      <p className="hint">
        Launched by this app, so the binary and the version are known rather than
        reported.
      </p>
      <ComputeList compute={caps.compute} />
      <HostFacts fact="apps" />
    </Section>
  ),

  'capture-gate': () => (
    <Section region="capture-gate" title="Capture gate">
      <p className="hint">
        In the path between the host and ComfyUI, and the only route to the
        tenant.
      </p>
      <HostFacts fact="gate" />
    </Section>
  ),

  vault: () => (
    <Section region="vault" title="Vault">
      <p className="hint">
        A directory of files at a moment, hashed as a unit. A gate observes a
        wire and never sees a directory.
      </p>
      <HostFacts fact="vault" />
    </Section>
  ),

  'model-store': () => (
    <Section region="model-store" title="Model store">
      <p className="hint">
        Fingerprints from the files, not from the workflow’s names.
      </p>
      <HostFacts fact="modelStore" />
    </Section>
  ),

  // ⚑ WO-E5. Drawn only when the host announced a Blender — `applicableRegions`
  // filters and this map is never reached otherwise, which is why there is no
  // "no Blender detected" branch anywhere below. The panel's three readings are
  // the host's; this component contributes no value of its own.
  blender: () => (
    <Section region="blender" title="Blender">
      <p className="hint">
        On this machine, read from the Blender that is on it: the version from
        the running binary, the addon’s state from the Blender that loaded it,
        and a bridge’s address from that bridge’s own preferences.
      </p>
      <HostFacts fact="blender" />
    </Section>
  ),

  'cloud-compute': (caps) => (
    <Section region="cloud-compute" title="Cloud compute">
      <p className="hint">Sessions spawn on someone else’s machine.</p>
      <ComputeList compute={caps.compute} />
    </Section>
  ),

  'machine-tiers': () => (
    <Section region="machine-tiers" title="Machine">
      <p className="hint">
        A tier decides what is spawned and what it costs per hour.
      </p>
      <div className="lock-buttons">
        <button className="lock-btn" type="button" disabled>
          <span className="icon">▣</span>
          <span className="label">Pick a tier</span>
        </button>
      </div>
    </Section>
  ),

  billing: () => (
    <Section region="billing" title="Billing">
      <p className="hint">
        Session compute is pre-authorised and captured per hour.
      </p>
    </Section>
  ),

  projects: () => (
    <Section region="projects" title="Projects">
      <p className="hint">
        A project is a server object; both shapes read the same rows.
      </p>
    </Section>
  ),

  attestation: (caps) => (
    <Section region="attestation" title="Attestation">
      <div className="merkle-info">
        <span className="label">capture profile</span>
        <span className="hash" data-fact="capture-profile">
          {caps.capture_profile}
        </span>
      </div>
      <div className="merkle-info">
        <span className="label">verified</span>
        <span className="hash" data-fact="verified-representable">
          {caps.attestation.verified_representable ? 'representable' : 'unrepresentable'}
        </span>
      </div>
      <div className="merkle-preview">{caps.attestation.reason}</div>
    </Section>
  ),
};
