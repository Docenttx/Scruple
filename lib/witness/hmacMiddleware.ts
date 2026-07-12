// HMAC request signature verification for /v1/log/* endpoints.
//
// Every ingest request presents:
//   X-Scruple-Timestamp: <unix seconds>
//   X-Scruple-Signature: <hex hmac_sha256(hmac_secret, `${timestamp}\n${raw_body}`)>
//
// The signature covers the raw body — the same bytes the server hashes must
// be the same bytes the client hashed. Do NOT JSON.parse the body before
// verifying: parse+stringify is not idempotent (key order, whitespace).
//
// Clock skew tolerance: 5 minutes each side. Rejects replay across days.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const HMAC_SKEW_SECS = 300;

export type HmacVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing_timestamp' | 'missing_signature' | 'clock_skew' | 'invalid_signature' };

export function verifyHmac(
  headers: {
    'x-scruple-timestamp'?: string | null;
    'x-scruple-signature'?: string | null;
  },
  rawBody: string | Buffer,
  hmacSecret: string,
  now: number = Math.floor(Date.now() / 1000),
): HmacVerdict {
  const ts = headers['x-scruple-timestamp'];
  const sig = headers['x-scruple-signature'];
  if (!ts) return { ok: false, reason: 'missing_timestamp' };
  if (!sig) return { ok: false, reason: 'missing_signature' };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > HMAC_SKEW_SECS) {
    return { ok: false, reason: 'clock_skew' };
  }

  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody;
  const message = Buffer.concat([Buffer.from(`${ts}\n`, 'utf-8'), bodyBuf]);

  const expected = createHmac('sha256', hmacSecret).update(message).digest();
  const provided = Buffer.from(sig, 'hex');
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (!timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true };
}

/** Convenience: read the three headers from a Next.js Request. */
export function extractHmacHeaders(req: Request): {
  'x-scruple-timestamp': string | null;
  'x-scruple-signature': string | null;
} {
  return {
    'x-scruple-timestamp': req.headers.get('x-scruple-timestamp'),
    'x-scruple-signature': req.headers.get('x-scruple-signature'),
  };
}
