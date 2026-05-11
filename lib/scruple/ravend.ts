// WO-42 · Ravencoin RPC client.
//
// Talks JSON-RPC to a local ravend daemon. Two networks supported —
// mainnet + testnet — chosen per call. Auth comes from raven.conf
// (rpcuser/rpcpassword); we read it at module load.
//
// Per WO_LOG.md observations on this box:
//   mainnet  → /home/ubuntu/.raven-mainnet/raven.conf, RPC :8766
//   testnet  → /home/ubuntu/.raven/raven.conf,         RPC :18766
//
// Overridable via env: RAVEND_MAINNET_RPC, RAVEND_TESTNET_RPC,
// RAVEND_MAINNET_USER, RAVEND_MAINNET_PASS, etc.

import fs from 'node:fs';

export type RavenNetwork = 'mainnet' | 'testnet';

interface RpcEndpoint {
  url: string;
  user: string;
  password: string;
}

function parseConf(path: string): Partial<RpcEndpoint> & { port?: number } {
  try {
    const txt = fs.readFileSync(path, 'utf8');
    const grab = (k: string) => {
      const m = txt.match(new RegExp(`^${k}=(.+)$`, 'm'));
      return m ? m[1].trim() : undefined;
    };
    const user = grab('rpcuser');
    const password = grab('rpcpassword');
    const port = grab('rpcport');
    return {
      user,
      password,
      port: port ? Number(port) : undefined,
    };
  } catch {
    return {};
  }
}

const MAINNET_CONF = '/home/ubuntu/.raven-mainnet/raven.conf';
const TESTNET_CONF = '/home/ubuntu/.raven/raven.conf';

const mainnetConf = parseConf(MAINNET_CONF);
const testnetConf = parseConf(TESTNET_CONF);

function endpoint(net: RavenNetwork): RpcEndpoint | null {
  if (net === 'mainnet') {
    const url =
      process.env.RAVEND_MAINNET_RPC ||
      (mainnetConf.port ? `http://127.0.0.1:${mainnetConf.port}/` : 'http://127.0.0.1:8766/');
    const user = process.env.RAVEND_MAINNET_USER || mainnetConf.user || '';
    const password = process.env.RAVEND_MAINNET_PASS || mainnetConf.password || '';
    if (!user || !password) return null;
    return { url, user, password };
  }
  const url =
    process.env.RAVEND_TESTNET_RPC ||
    (testnetConf.port ? `http://127.0.0.1:${testnetConf.port}/` : 'http://127.0.0.1:18766/');
  const user = process.env.RAVEND_TESTNET_USER || testnetConf.user || '';
  const password = process.env.RAVEND_TESTNET_PASS || testnetConf.password || '';
  if (!user || !password) return null;
  return { url, user, password };
}

const TIMEOUT_MS = 5000;

export class RavendError extends Error {
  constructor(public readonly code: number, message: string) {
    super(`[ravend ${code}] ${message}`);
  }
}

async function rpc<T = unknown>(
  net: RavenNetwork,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const ep = endpoint(net);
  if (!ep) throw new RavendError(-1, `ravend ${net} not configured`);

  const auth = Buffer.from(`${ep.user}:${ep.password}`).toString('base64');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: `web-${Date.now()}`, method, params }),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new RavendError(res.status, `HTTP ${res.status}`);
    }
    const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (json.error) throw new RavendError(json.error.code, json.error.message);
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

// Public surface — typed methods we actually use.

export const ravend = {
  /** Quick health probe — block count + chain. */
  async health(net: RavenNetwork): Promise<{ ok: boolean; height?: number; chain?: string; detail?: string }> {
    try {
      const info = await rpc<{ blocks: number; chain: string }>(net, 'getblockchaininfo');
      return { ok: true, height: info.blocks, chain: info.chain };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },

  getBlockCount(net: RavenNetwork) {
    return rpc<number>(net, 'getblockcount');
  },

  getNewAddress(net: RavenNetwork, label = '') {
    return rpc<string>(net, 'getnewaddress', [label]);
  },

  getBalance(net: RavenNetwork) {
    return rpc<number>(net, 'getbalance');
  },

  /** List Scruple assets owned by this wallet (asset names start with SCR_). */
  async listMyAssets(net: RavenNetwork, filter = '*'): Promise<Record<string, { balance: number }>> {
    return rpc<Record<string, { balance: number }>>(net, 'listmyassets', [filter, true]);
  },

  /** List wallet labels (rough check that ravend has any wallet loaded). */
  listWallets(net: RavenNetwork) {
    return rpc<string[]>(net, 'listwallets');
  },

  /** Generic escape hatch for methods we haven't typed yet. */
  raw<T = unknown>(net: RavenNetwork, method: string, params: unknown[] = []) {
    return rpc<T>(net, method, params);
  },

  isConfigured(net: RavenNetwork): boolean {
    return endpoint(net) !== null;
  },
};
