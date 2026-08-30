// DSSE Pre-Authentication Encoding — the bytes that actually get signed.
//
// SPEC: https://github.com/secure-systems-lab/dsse/blob/master/protocol.md
//
//   PAE(type, body) = "DSSEv1" + SP + LEN(type) + SP + type
//                              + SP + LEN(body) + SP + body
//
//   SP       = ASCII space, a single 0x20 byte
//   "DSSEv1" = ASCII [0x44 0x53 0x53 0x45 0x76 0x31]
//   LEN(s)   = ASCII decimal encoding of the BYTE length of s,
//              with no leading zeros
//
// THIS IS A FORMAT WE IMPLEMENT, NOT A LIBRARY WE VENDOR.
// docs/canon/oss-study/SYNTHESIS.md §5: every DSSE/in-toto implementation
// in the study set is Apache-2.0 with an explicit patent grant and a
// termination-on-litigation clause. Studying and reimplementing a format
// carries no obligation; vendoring the code does, and that has to be
// weighed against Docent's own patent work BEFORE any line is copied
// rather than after. Nothing here is derived from anyone's source.
//
// WHY THIS EXISTS AT ALL, RATHER THAN `type + " " + body`
//
// A wrong PAE is a signature that verifies nothing, and the failure is
// silent — the envelope still parses, the signature still checks out
// against whatever the producer happened to hash, and only an attacker
// who noticed the ambiguity ever finds out. Length-prefixing is the whole
// defence: without it, PAE("a", "b c") and PAE("a b", "c") produce the
// same bytes, so a signature over one is a signature over the other.
// `test/v2/envelope.test.ts` pins exactly that pair.
//
// THE FOUR WAYS TO GET THIS WRONG, all of which parse and none of which
// verify against a conforming counterpart:
//
//   1. LEN counted in UTF-16 code units (JS `String.length`) rather than
//      UTF-8 bytes. Latin-1 payloads look fine forever; the first
//      non-ASCII payloadType breaks every signature. We measure Buffers.
//   2. LEN zero-padded or otherwise not the shortest decimal form.
//      `String(n)` gives the shortest form for every non-negative integer,
//      including "0" for the empty string.
//   3. Encoding the body as text before length-prefixing it. The body is
//      arbitrary BYTES; encoding it first would make LEN describe a
//      different string than the one appended.
//   4. A separator between the last LEN and the body that is anything but
//      one 0x20, or a trailing byte after the body.

const SP = Buffer.from([0x20]);

/** ASCII "DSSEv1". Exported so a test can pin the literal bytes. */
export const DSSE_VERSION = 'DSSEv1';

/**
 * Pre-Authentication Encoding of (payloadType, payload).
 *
 * `payloadType` is a string and is measured after UTF-8 encoding.
 * `payload` is bytes; a string is accepted and UTF-8 encoded first, which
 * is a convenience for callers holding JSON and never a re-encoding of
 * bytes that were already bytes.
 *
 * Returns the exact byte sequence a signer signs and a verifier verifies.
 * Nothing else may be signed — in particular, not the envelope JSON, and
 * not the payload alone.
 */
export function pae(payloadType: string, payload: Uint8Array | string): Buffer {
  const type = Buffer.from(payloadType, 'utf8');
  const body =
    typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);

  return Buffer.concat([
    Buffer.from(DSSE_VERSION, 'ascii'),
    SP,
    Buffer.from(String(type.length), 'ascii'),
    SP,
    type,
    SP,
    Buffer.from(String(body.length), 'ascii'),
    SP,
    body,
  ]);
}
