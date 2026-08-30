// The TENANT half — H-4 §7's "run from inside the tenant container", built out
// of namespaces because this host has no Docker.
//
// This process runs inside:
//
//   * its own NETWORK namespace, joined to the deployment by two veth pairs and
//     holding no default route. The gate and the ingest are reachable; the
//     upstream's loopback and the egress target are not, and neither is a
//     resolver.
//   * its own MOUNT namespace, in which the directory holding the component's
//     state has been replaced by an empty tmpfs — the mount topology a vendor
//     gets by not mounting it into the workload container.
//   * its own PID namespace with a private /proc, EXCEPT under the
//     `p3-shared-pid` profile, which is the audit case for what a mount
//     boundary is worth without one.
//
// It runs the SHIPPED probes against the SHIPPED component. Nothing here is a
// re-implementation: `COMFYUI_PROBES`, `OsVantage`, `httpLeafOracle` and
// `runProbes` are the same code a vendor would `npx scruple-conformance run`.
//
// WHAT IT RECORDS ABOUT ITS OWN POSITION, AND WHY THAT IS NOT DECORATION.
// §10 C-11: "the run must record which position it occupied". A run that merely
// asserted it was in the tenant's namespace would be the paperwork this whole
// exercise exists to replace, so the namespace INODES of this process are read
// out of /proc/self/ns and written into the result, next to the deployment's.
// Two different inode numbers is a fact a reader can check; "we ran it in a
// container, honest" is not.

import fs from 'node:fs';
import path from 'node:path';

import { COMFYUI_PROBES } from '../../services/scruple-capture/probes/index';
import { httpLeafOracle } from '../../packages/scruple-conformance/src/oracle';
import { renderProbeLog, runProbes } from '../../packages/scruple-conformance/src/runner';
import type { DeploymentUnderTest } from '../../packages/scruple-conformance/src/types';
import { OsVantage } from '../../packages/scruple-conformance/src/vantage';

interface Descriptor {
  profile: string;
  deploymentNamespaces: Record<string, string>;
  gateUrl: string;
  apiBaseUrl: string;
  declaredUpstream: { host: string; port: number };
  volumes: { output: string; temp: string; input: string };
  stateDir: string;
  componentId: string;
  componentPid: number;
  egressTarget: { host: string; port: number };
  egressControl: { host: string; port: number };
  drainWindowMs: number;
}

/** The namespace this process is actually in, as the kernel reports it. */
function namespaces(pid: number | 'self'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ns of ['net', 'mnt', 'pid', 'user', 'ipc', 'uts']) {
    try {
      out[ns] = fs.readlinkSync(`/proc/${pid}/ns/${ns}`);
    } catch {
      // Not readable is itself the finding: under PID isolation the component's
      // /proc entry does not exist here at all.
      out[ns] = 'unreadable-from-this-position';
    }
  }
  return out;
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) throw new Error('usage: tenant.ts <harness root>');
  const d = JSON.parse(fs.readFileSync(path.join(root, 'deployment.json'), 'utf8')) as Descriptor;

  const deployment: DeploymentUnderTest = {
    // What this run is a run OF. `grade.ts` refuses to let it satisfy any other
    // integration's P2 — see DeploymentUnderTest.integration.
    integration: 'scruple-capture / ComfyUI (namespace probe harness)',
    gateUrl: d.gateUrl,
    declaredUpstream: d.declaredUpstream,
    volumes: d.volumes,
    stateDir: d.stateDir,
    componentPid: d.componentPid,
    apiBaseUrl: d.apiBaseUrl,
    // A credential the TENANT holds. The harness's ingest does not resolve API
    // keys (see deployment.ts's stated limit), so this value proves nothing
    // about authentication and is carried because probe 2 and probe 6 send it.
    tenantApiKey: 'sk_harness_tenant',
    componentId: d.componentId,
    drainWindowMs: d.drainWindowMs,
    egressTarget: d.egressTarget,
    egressControl: d.egressControl,
  };

  const vantage = new OsVantage(
    `tenant network+mount${process.env.HARNESS_TENANT_PID_NS === '1' ? '+pid' : ''} namespace, ` +
      `pid ${process.pid}`,
  );
  const run = await runProbes(COMFYUI_PROBES, {
    vantage,
    deployment,
    leaves: httpLeafOracle({
      apiBaseUrl: d.apiBaseUrl,
      apiKey: 'sk_harness_tenant',
      componentId: d.componentId,
    }),
    log: (l) => process.stderr.write(`${l}\n`),
  });

  const position = {
    // C-11's `probe_vantage`, and the machine-checkable version of it.
    probe_vantage: vantage.kind,
    describe: vantage.describe,
    tenant_namespaces: namespaces('self'),
    // Read on the deployment side and carried in the descriptor, because under
    // PID isolation /proc/<component pid> does not exist here — the tenant not
    // being able to see it is the finding, not a gap in the record.
    deployment_namespaces: d.deploymentNamespaces,
    component_namespaces_as_seen_from_here: namespaces(d.componentPid),
    network_namespace_differs:
      namespaces('self').net !== d.deploymentNamespaces.net,
    mount_namespace_differs:
      namespaces('self').mnt !== d.deploymentNamespaces.mnt,
    tenant_has_own_pid_namespace: process.env.HARNESS_TENANT_PID_NS === '1',
    isolation_mechanism:
      'unshare(2) user+network+mount(+pid) namespaces joined by veth pairs. NOT a container: ' +
      'no image, no cgroup, no seccomp/LSM profile, and the uid the tenant runs as is the ' +
      'same uid that owns the component state on disk (see CONFORMANCE.md §1.1).',
  };

  fs.writeFileSync(
    path.join(root, 'probes.json'),
    JSON.stringify({ profile: d.profile, position, run }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'probes.log'), renderProbeLog(run));
  vantage.close();

  process.stdout.write(
    `${d.profile}\t${run.summary.line}\t${run.results.map((r) => `${r.id}:${r.verdict}`).join(' ')}\n`,
  );
}

void main().catch((e) => {
  process.stderr.write(`tenant run failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
