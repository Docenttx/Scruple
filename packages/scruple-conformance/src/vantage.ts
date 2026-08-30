// Two vantages, and the difference between them is the difference between
// evidence and a diagram.
//
// `OsVantage` OCCUPIES the tenant's position: real TCP connects, real fetch,
// real stat/read/write against the real filesystem the process can see. Run it
// inside the tenant container — a `docker exec`, a pod shell, the sidecarless
// half of the deployment — and its answers are facts about that deployment.
//
// `SimulatedVantage` MODELS the tenant's position from a policy. It exists for
// two honest reasons and no others:
//
//   1. Tests. A single Node process cannot create the network namespace whose
//      absence is the thing under test, so a conformant fixture has to be
//      declared rather than built. The probes' LOGIC is identical either way,
//      which is what the test is actually exercising.
//   2. Dry runs. A vendor wiring up the suite wants to see the shape of the
//      report before they have a container to run it in.
//
// EVERY RESULT FROM A SIMULATED VANTAGE IS INADMISSIBLE, and the runner —
// not the probe, not the vendor — is what enforces that. Look at
// sonobuoy-conformance.md §5.2 for why this matters more here than it does in
// Kubernetes: P1 and P3 are the two requirements a suite running inside the
// measured party's own boundary structurally cannot verify, so the one thing
// this package must never do is let a modelled answer to a topology question
// wear the same badge as an occupied one.

import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import type { TenantVantage } from './types';

export class OsVantage implements TenantVantage {
  readonly kind = 'os' as const;
  readonly describe: string;
  private readonly agent = new http.Agent({ keepAlive: false });

  constructor(where = `pid ${process.pid} on ${process.platform}`) {
    this.describe = `OS vantage — real sockets and real filesystem, from ${where}`;
  }

  tcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
      sock.connect(port, host);
    });
  }

  async dnsResolvable(name: string): Promise<boolean> {
    try {
      await dns.promises.resolve4(name);
      return true;
    } catch (e) {
      // NXDOMAIN / NODATA mean the query LEFT and a resolver answered. Only a
      // failure to reach a resolver at all is a closed channel.
      const code = (e as { code?: string }).code ?? '';
      return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN';
    }
  }

  /**
   * NOT global `fetch`.
   *
   * A vantage exists to model a network position, and undici's global
   * dispatcher is a process-wide connection pool shared with every other
   * caller — the opposite of a position. It also keep-alives by default, which
   * leaves idle sockets against whatever the probe touched: harmless in
   * production, and in a test suite the difference between a teardown that
   * takes 20 ms and one that takes five seconds per fixture.
   *
   * So the probes get their own agent, `keepAlive: false`, owned here and
   * destroyable here. Do not "simplify" this back to fetch().
   */
  async request(url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const body =
      init?.body === undefined || init.body === null
        ? null
        : Buffer.from(init.body as string);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    if (body) headers['content-length'] = String(body.length);

    return new Promise<Response>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: init?.method ?? 'GET',
          headers,
          agent: this.agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') h.set(k, v);
              else if (Array.isArray(v)) h.set(k, v.join(', '));
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 502,
                headers: h,
              }),
            );
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /** Drop anything this vantage still holds open. */
  close(): void {
    this.agent.destroy();
  }

  async pathReadable(abs: string): Promise<boolean> {
    try {
      await fs.promises.access(abs, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(abs: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(abs);
    } catch {
      return null;
    }
  }

  async writeFile(abs: string, bytes: Buffer): Promise<boolean> {
    try {
      await fs.promises.writeFile(abs, bytes);
      return true;
    } catch {
      return false;
    }
  }
}

export interface SimulatedPolicy {
  /** Endpoints reachable from the modelled position. Everything else refuses. */
  allowTcp: ReadonlyArray<{ host: string; port: number }>;
  /** Path prefixes visible from the modelled position. */
  visibleRoots: readonly string[];
  /** Path prefixes writable from the modelled position. */
  writableRoots: readonly string[];
  /** Whether a resolver answers from the modelled position. */
  dnsOpen: boolean;
  /** What this policy is modelling, in the operator's words. */
  describe: string;
}

/**
 * A modelled tenant position. Reads and writes that the policy permits are
 * performed FOR REAL against the filesystem — a simulated vantage that also
 * simulated the bytes would be testing nothing at all. What is modelled is
 * only the boundary: which endpoints answer, which paths exist.
 */
export class SimulatedVantage implements TenantVantage {
  readonly kind = 'simulated' as const;
  readonly describe: string;
  private readonly os = new OsVantage();

  constructor(private readonly policy: SimulatedPolicy) {
    this.describe = `SIMULATED vantage (INADMISSIBLE as conformance evidence) — ${policy.describe}`;
  }

  private tcpAllowed(host: string, port: number): boolean {
    return this.policy.allowTcp.some((e) => e.host === host && e.port === port);
  }

  private under(roots: readonly string[], abs: string): boolean {
    return roots.some((r) => abs === r || abs.startsWith(r.endsWith('/') ? r : `${r}/`));
  }

  async tcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
    if (!this.tcpAllowed(host, port)) return false;
    return this.os.tcpReachable(host, port, timeoutMs);
  }

  async dnsResolvable(name: string): Promise<boolean> {
    if (!this.policy.dnsOpen) return false;
    return this.os.dnsResolvable(name);
  }

  async request(url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!this.tcpAllowed(u.hostname, port)) {
      throw new Error(`SimulatedVantage: ${u.hostname}:${port} is not reachable from this position`);
    }
    return this.os.request(url, init);
  }

  async pathReadable(abs: string): Promise<boolean> {
    if (!this.under(this.policy.visibleRoots, abs)) return false;
    return this.os.pathReadable(abs);
  }

  async readFile(abs: string): Promise<Buffer | null> {
    if (!this.under(this.policy.visibleRoots, abs)) return null;
    return this.os.readFile(abs);
  }

  async writeFile(abs: string, bytes: Buffer): Promise<boolean> {
    if (!this.under(this.policy.writableRoots, abs)) return false;
    return this.os.writeFile(abs, bytes);
  }
}
