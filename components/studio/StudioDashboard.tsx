// The dashboard shell — the canon workspace layout, filled from capabilities.
//
// WO-D5. Web Studio serves this route directly; Desktop Studio hosts the same
// route in a BrowserWindow (scruple-desktop/docs/DESIGN.md, "One UI, served").
// The only thing that differs between the two is the answer this component is
// handed.
//
// ⚑ The absent regions are absent. `applicableRegions()` returns the ones that
// apply and this maps over that list, so there is no branch here that could
// render an inapplicable region in a disabled state — the code to do it does
// not exist rather than being guarded by a flag.

// Explicit, though Next injects it: the node:test runner compiles this file
// with the classic JSX transform (the root tsconfig says `jsx: preserve`,
// which Next's compiler handles and esbuild does not), and
// test/v2/deployment-shape.test.ts renders these components for real.
import React from 'react';
import {
  applicableRegions,
  type DeploymentCapabilities,
} from '@/lib/v2/deployment';
import { RENDERERS } from './regions';

export default function StudioDashboard({ caps }: { caps: DeploymentCapabilities }) {
  const regions = applicableRegions(caps);
  const sidebar = regions.filter((r) => SIDEBAR.has(r.region));
  const main = regions.filter((r) => !SIDEBAR.has(r.region));

  return (
    // Two classes, both load-bearing: `.scruple-canon` scopes the canon
    // stylesheet and `.workspace` selects the workspace half of it (the wallet
    // half is `.scruple-canon.wallet`). Outside this subtree the canon rules do
    // not apply, which is what lets one app hold the canon design and the
    // existing Tailwind pages at the same time.
    <div className="scruple-canon workspace" data-profile={caps.profile}>
      <div className="app-container">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="logo">
              <span className="logo-text">SCRUPLE</span>
              <span className="logo-version">{caps.profile}</span>
            </div>
          </div>
          {sidebar.map((r) => (
            <div key={r.region}>{RENDERERS[r.region](caps)}</div>
          ))}
          <div className="sidebar-footer">
            <div className="footer-row">
              <span className="session-info">
                <span>profile</span>
                <span className="value" data-fact="profile">
                  {caps.profile}
                </span>
              </span>
            </div>
            <div className="status-line" data-fact="region-count">
              {regions.length} of {caps.regions.length} regions apply here
            </div>
          </div>
        </aside>

        <main className="main-content">
          <div className="active-project">
            {main.map((r) => (
              <div key={r.region}>{RENDERERS[r.region](caps)}</div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

/** Which regions live in the canon's left rail. Purely layout — a region moving
 *  between rail and body changes where it draws, never whether it draws. */
const SIDEBAR = new Set(['projects', 'local-apps', 'cloud-compute', 'machine-tiers']);
