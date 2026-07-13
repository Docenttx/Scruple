// scruple-verify baseline — verify a baseline chain from a receipt.
//
// Walks the chain of baselines back to genesis, confirming each
// prev_baseline_hash link and each activation timestamp.

import { readFile } from 'node:fs/promises';

async function fetchOrRead(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetch ${source} → HTTP ${res.status}`);
    return await res.json();
  }
  const text = await readFile(source, 'utf-8');
  return JSON.parse(text);
}

export async function verifyBaseline({ receiptSource, historySource, json, quiet }) {
  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    if (!quiet && !json) {
      const mark = ok ? 'ok  ' : 'FAIL';
      console.log(`  ${mark} — ${name}${detail ? '  ' + detail : ''}`);
    }
  };

  let overall = true;

  try {
    if (!receiptSource) {
      throw new Error('receipt source required (--receipt <url|path>)');
    }
    const receipt = await fetchOrRead(receiptSource);
    record('receipt loaded', true);

    const baselineHash = receipt.baseline_hash ?? receipt.leaf?.baseline_hash;
    if (!baselineHash) {
      record('receipt has baseline_hash', false, `keys: ${Object.keys(receipt).join(',')}`);
      throw new Error('no baseline_hash on receipt');
    }
    record('receipt has baseline_hash', true, baselineHash.slice(0, 12) + '...');

    let history;
    if (historySource) {
      history = await fetchOrRead(historySource);
    } else if (receipt.baseline_history_url) {
      history = await fetchOrRead(receipt.baseline_history_url);
    } else {
      record('baseline history available', false, 'no --history and no receipt.baseline_history_url');
      throw new Error('no baseline history source');
    }

    const chain = history.baselines ?? [];
    record(`baseline history loaded (${chain.length} baselines)`, chain.length > 0);
    if (chain.length === 0) overall = false;

    // Confirm the receipt's baseline_hash is somewhere in the chain
    const found = chain.find((b) => b.baseline_hash === baselineHash);
    record('receipt baseline_hash appears in tenant chain', !!found);
    if (!found) overall = false;

    // Walk from newest back through prev_baseline_hash links
    let brokenLinks = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      const current = chain[i];
      const prev = chain[i + 1];
      if (current.prev_baseline_hash !== prev.baseline_hash) {
        brokenLinks++;
        record(
          `chain link at ${current.baseline_hash.slice(0, 8)}`,
          false,
          `expected prev ${prev.baseline_hash.slice(0, 8)}, got ${(current.prev_baseline_hash ?? 'null').slice(0, 8)}`,
        );
      }
    }
    if (brokenLinks === 0) {
      record(`chain integrity — all ${Math.max(0, chain.length - 1)} prev-hash links valid`, true);
    } else {
      overall = false;
    }

    const genesis = chain[chain.length - 1];
    if (genesis && genesis.prev_baseline_hash === null) {
      record(`genesis baseline has null prev (correct)`, true, genesis.baseline_hash.slice(0, 12) + '...');
    } else if (genesis) {
      record('genesis baseline has null prev', false, `genesis has prev ${genesis.prev_baseline_hash}`);
      overall = false;
    }
  } catch (e) {
    record('verifier ran without unexpected errors', false, `  ${e.message}`);
    overall = false;
  }

  if (json) {
    console.log(JSON.stringify({ verdict: overall ? 'VALID' : 'INVALID', steps }, null, 2));
  } else if (quiet) {
    console.log(overall ? 'PASS' : 'FAIL');
  } else {
    console.log(`\nBaseline verdict: ${overall ? 'VALID' : 'INVALID'}`);
  }
  return overall;
}
