// The leaf oracle — the one party in a probe run that the tenant does not
// control.
//
// Probes 4, 5 and 7 all ask the same question ("did these bytes leave without a
// leaf?") and none of them can ask the component, because the component's
// coverage is the thing in question. A component that answered honestly would
// prove nothing about a component that did not.
//
// So the oracle queries scruple-web. In a vendor's real run that is an HTTP
// call to an endpoint keyed by content hash; in the acceptance tests it is the
// in-memory record of a stub ingest, which is the same fact reached without a
// network. Both implementations poll rather than sample once, because §5's
// queue means a leaf can be MACed now and accepted later, and a probe that
// checked once would report a queued event as an uncaptured one — turning the
// component's correct offline behaviour into a conformance failure.

import type { LeafOracle } from './types';

export interface HttpOracleOptions {
  apiBaseUrl: string;
  apiKey: string;
  componentId?: string | null;
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

/** Queries scruple-web. The endpoint is keyed by content hash. */
export function httpLeafOracle(opts: HttpOracleOptions): LeafOracle {
  const f = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? 100;

  return {
    describe: `scruple-web at ${opts.apiBaseUrl}`,

    async leafFor(contentHash: string, windowMs: number) {
      const deadline = Date.now() + windowMs;
      for (;;) {
        try {
          const res = await f(
            `${opts.apiBaseUrl}/api/v2/verify?content_hash=${encodeURIComponent(contentHash)}`,
            { headers: { authorization: `Bearer ${opts.apiKey}` } },
          );
          if (res.ok) {
            const body = (await res.json()) as {
              found?: boolean;
              counter?: number | null;
              surfaces?: string[];
              egresses?: string[];
            };
            if (body.found) {
              return {
                found: true,
                counter: body.counter ?? null,
                surfaces: body.surfaces ?? [],
                egresses: body.egresses ?? [],
              };
            }
          }
        } catch {
          /* the oracle being briefly unreachable is not the same as no leaf */
        }
        if (Date.now() >= deadline) {
          return { found: false, counter: null, surfaces: [], egresses: [] };
        }
        await sleep(pollMs);
      }
    },

    async highWaterCounter() {
      if (!opts.componentId) return null;
      try {
        const res = await f(
          `${opts.apiBaseUrl}/api/v2/components/status?component_id=${encodeURIComponent(opts.componentId)}`,
          { headers: { authorization: `Bearer ${opts.apiKey}` } },
        );
        if (!res.ok) return null;
        const body = (await res.json()) as { high_water_counter?: number };
        return typeof body.high_water_counter === 'number' ? body.high_water_counter : null;
      } catch {
        return null;
      }
    },
  };
}

/** An oracle over an in-memory list of accepted submissions. */
export function recordedLeafOracle(
  received: () => ReadonlyArray<Record<string, unknown>>,
  describe = 'in-memory ingest record',
  pollMs = 25,
): LeafOracle {
  const findAll = (contentHash: string) =>
    received().filter((s) => s.content_hash === contentHash);

  return {
    describe,
    async leafFor(contentHash: string, windowMs: number) {
      const deadline = Date.now() + windowMs;
      for (;;) {
        const hits = findAll(contentHash);
        if (hits.length) {
          const c = (hits[0].component as { counter?: number } | undefined)?.counter;
          const distinct = (key: 'surface' | 'egress') => [
            ...new Set(
              hits
                .map((h) => (h.capture as Record<string, unknown> | undefined)?.[key])
                .filter((x): x is string => typeof x === 'string'),
            ),
          ];
          return {
            found: true,
            counter: typeof c === 'number' ? c : null,
            surfaces: distinct('surface'),
            egresses: distinct('egress'),
          };
        }
        if (Date.now() >= deadline) return { found: false, counter: null, surfaces: [], egresses: [] };
        await sleep(pollMs);
      }
    },
    async highWaterCounter() {
      const counters = received()
        .map((s) => (s.component as { counter?: number } | undefined)?.counter)
        .filter((c): c is number => typeof c === 'number');
      return counters.length ? Math.max(...counters) : null;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
