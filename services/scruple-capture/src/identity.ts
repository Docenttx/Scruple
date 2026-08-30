// Component identity: provisioning, the sealed IK, and the ratchet state.
//
// §4.4 injection, from the component's side:
//   1. the vendor mints a one-time token in their Scruple console;
//   2. this process POSTs it with its build_measurement (and a quote if it
//      has one) to /api/v2/components/provision;
//   3. the server derives IK = HKDF(BDK, component_id) and returns it once;
//   4. we seal it — to the TPM/SEV measurement where available, else a 0600
//      file owned by a user the tenant is not.
//
// STEP 4 HERE IS THE 0600 FILE, and it is worth being blunt about which of
// the two §4.3 postures that buys. Sealing to a measurement makes a modified
// build unable to unseal the key, and the leaf is `verified`. A 0600 file
// makes the binding an ASSERTION, and the leaf is `passthrough` and says so.
// This component ships the second. `sealToMeasurement` is the seam where the
// first goes; it is not stubbed with something that pretends.
//
// THE RATCHET IS lib/ratchet/ratchet.ts. Not a copy of it. That module is
// pure node:crypto and reaches no database, so a Node sidecar can import it
// directly and stay byte-identical with the Python half through the shared
// vectors in test/vectors/ratchet-vectors.json. NOTE THE IMPORT PATH: the
// leaf module, never `lib/ratchet/index.ts` — the barrel re-exports bdk.ts,
// verify.ts and provisioning.ts, which pull in @/lib/db/sqlite and a bdk()
// that calls process.exit(1) when SCRUPLE_BDK_HEX is unset. A component must
// never hold the BDK; importing the barrel would put it one line from doing so.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ratchet, zeroize, type PreimageFields } from '../../../lib/ratchet/ratchet';
import { buildMeasurement } from './build-measurement';
import type { CaptureConfig } from './config';

export interface SealedState {
  component_id: string;
  /** K_n, hex. See the zeroization note at the head of lib/ratchet/ratchet.ts
   *  for what "sealed" does and does not achieve once it is a JS string. */
  chain_key_hex: string;
  /** n — the counter the NEXT event will carry. */
  counter: number;
  build_measurement: string;
  attestation_status: 'verified' | 'passthrough' | null;
  provisioned_at: string;
}

export class ProvisioningError extends Error {}

const STATE_FILE = 'identity.json';

export class Identity {
  private ratchet: Ratchet;
  readonly componentId: string;
  readonly buildMeasurement: string;
  readonly attestationStatus: 'verified' | 'passthrough' | null;
  private readonly statePath: string;

  private constructor(stateDir: string, s: SealedState) {
    this.statePath = path.join(stateDir, STATE_FILE);
    this.componentId = s.component_id;
    this.buildMeasurement = s.build_measurement;
    this.attestationStatus = s.attestation_status;
    this.ratchet = new Ratchet(Buffer.from(s.chain_key_hex, 'hex'), s.counter);
  }

  /** The counter the NEXT event will carry. */
  get counter(): number {
    return this.ratchet.counter;
  }

  /**
   * Consume one counter. THE ORDER IS THE SPEC'S (§5) AND IT IS THE EASY
   * THING TO GET WRONG:
   *
   *     derive, MAC, ratchet, PERSIST, then enqueue.
   *
   * The counter is spent when the MAC is computed, not when the submission
   * succeeds. Persisting between the ratchet and the enqueue is deliberate
   * and the direction matters: a crash after persist and before enqueue
   * loses ONE EVENT and leaves a gap, which §4.2 records as a first-class
   * fact. A crash the other way round would re-use a counter under an
   * existing component_id, which §4.4 says never to do and which the server
   * rejects as a replay — turning a lost event into a lost component.
   *
   * So: lose the event, never the counter.
   */
  macAndAdvance(fields: PreimageFields): { counter: number; mac: string } {
    const out = this.ratchet.mac(fields);
    this.persist();
    return out;
  }

  private persist(): void {
    const key = this.ratchet.chainKey();
    const state: SealedState = {
      component_id: this.componentId,
      chain_key_hex: key.toString('hex'),
      counter: this.ratchet.counter,
      build_measurement: this.buildMeasurement,
      attestation_status: this.attestationStatus,
      provisioned_at: this.provisionedAt,
    };
    zeroize(key);
    writeSealed(this.statePath, state);
  }

  private provisionedAt = new Date().toISOString();

  destroy(): void {
    this.ratchet.destroy();
  }

  /**
   * Restore the sealed identity, or provision a new one.
   *
   * §4.4, last paragraph, implemented literally: "If the seal cannot be
   * restored on restart, the component re-provisions as a NEW component_id
   * starting at n=0. Never reuse a counter under an existing id." A corrupt
   * or missing state file is therefore not something to repair by guessing a
   * counter — it is a new component, and the old one goes silent, which is
   * exactly the signal an operator should get.
   */
  static async open(cfg: CaptureConfig, fetchImpl: typeof fetch = fetch): Promise<Identity> {
    const statePath = path.join(cfg.stateDir, STATE_FILE);
    const existing = readSealed(statePath);
    if (existing) return new Identity(cfg.stateDir, existing);

    if (!cfg.provisioningToken) {
      throw new ProvisioningError(
        'No sealed identity and no SCRUPLE_CAPTURE_PROVISIONING_TOKEN. A component ' +
          'without an IK cannot MAC anything, and a component that captures without ' +
          'MACing is a log file. Mint a token in the vendor console (§4.4 step 1).',
      );
    }

    const measurement = buildMeasurement();
    const res = await fetchImpl(`${cfg.apiBaseUrl}/api/v2/components/provision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // §10 C-5: the one-time token says WHICH component; the bearer key
        // says WHO is calling. The token alone cannot enforce "this token
        // belongs to another tenant".
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        token: cfg.provisioningToken,
        build_measurement: measurement,
        // No attestation envelope: this component has no attestable compute
        // to quote. Sending one we could not obtain would be the §12.4
        // failure — "Stored" reading as "verified".
      }),
    });

    if (!res.ok) {
      throw new ProvisioningError(
        `Provisioning refused (${res.status}): ${await res.text()}. Tokens are ` +
          'single-use and short-lived; a redeemed one needs a NEW component_id.',
      );
    }
    const body = (await res.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    const ikHex = String(data.ik_hex ?? '');
    if (!/^[0-9a-f]{64}$/.test(ikHex)) {
      throw new ProvisioningError('Provisioning response carried no usable ik_hex.');
    }

    const state: SealedState = {
      component_id: String(data.component_id),
      chain_key_hex: ikHex, // K_0 = IK, n = 0
      counter: 0,
      build_measurement: String(data.build_measurement ?? measurement),
      attestation_status:
        (data.attestation as { status?: 'verified' | 'passthrough' } | null)?.status ?? null,
      provisioned_at: String(data.provisioned_at ?? new Date().toISOString()),
    };
    writeSealed(statePath, state);
    return new Identity(cfg.stateDir, state);
  }

  /** Construct from an already-held IK. Used by tests and by an operator
   *  re-sealing a component out of band; never on the normal path. */
  static fromSealed(stateDir: string, state: SealedState): Identity {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeSealed(path.join(stateDir, STATE_FILE), state);
    return new Identity(stateDir, state);
  }
}

/**
 * The seam where hardware sealing goes. Deliberately unimplemented rather
 * than faked: a function that returned the plaintext key and called itself
 * "sealed" would make `verified` claimable by a component that earned
 * `passthrough`.
 */
export function sealToMeasurement(): never {
  throw new Error(
    'Measurement-sealed key custody is not implemented in this component. The IK is ' +
      'protected by file permissions only, so the binding between build and key is an ' +
      'ASSERTION and every leaf this component produces is `passthrough` (§4.3).',
  );
}

function writeSealed(p: string, s: SealedState): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  // 0600 before any bytes are in it. Writing then chmod-ing leaves a window
  // in which the tenant's uid could read the IK, and the whole file is one
  // secret.
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(s));
    // The counter must survive process death, not merely reach the page
    // cache. Without the fsync a power loss can resurrect an older counter,
    // and a re-used counter is refused by the server as a replay.
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  const dir = fs.openSync(path.dirname(p), 'r');
  try {
    fs.fsyncSync(dir);
  } catch {
    /* directory fsync is not available everywhere; the rename is still atomic */
  } finally {
    fs.closeSync(dir);
  }
}

function readSealed(p: string): SealedState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  try {
    const s = JSON.parse(raw) as SealedState;
    if (
      typeof s.component_id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(s.chain_key_hex) ||
      !Number.isInteger(s.counter) ||
      s.counter < 0
    ) {
      return null;
    }
    return s;
  } catch {
    // Corrupt seal. Not repaired, not guessed at: §4.4 says re-provision as
    // a new component_id at n=0.
    return null;
  }
}
