"""Forward-secure per-event key ratchet -- the component side of H-4.

Specified in `docs/canon/H4-DUKPT-CAPTURE-COMPONENT.md` §4. This is the
component half; `lib/ratchet/` in scruple-web is the server half, and the
two are held together by `test/vectors/ratchet-vectors.json`, which this
module generates and both test suites consume. Two implementations that
each pass their own tests and disagree on the wire is the failure mode
that file exists to prevent.

NAMING. The spec is explicit and so is this docstring: do not call this
DUKPT in customer-facing material. It takes DUKPT's property set --
base key never present on the component, distinct key per event
destroyed after use, counter in the clear, one compromise is not
systemic -- via a hash ratchet. It is not ANSI X9.24-3.

    IK    = HKDF-SHA256(ikm=BDK, salt=component_id, info="scruple/ik/v1", L=32)
    K_0   = IK,  n = 0
    M_n   = HKDF-Expand(K_n, "scruple/mac/v1", 32)
    K_n+1 = HKDF-Expand(K_n, "scruple/ratchet/v1", 32)
    mac   = HMAC-SHA256(M_n, canonical_preimage)
    zeroize(K_n, M_n); n += 1

Note the asymmetry, which is deliberate and is what the spec says: the IK
derivation is a FULL HKDF (extract-then-expand, because the BDK is the
input keying material and `component_id` is the salt), while the two chain
steps are HKDF-Expand ONLY (no extract, because K_n is already a uniformly
random 32-byte PRK -- re-extracting it would buy nothing and would need a
salt the chain does not have).

Pure standard library: `hashlib` and `hmac`. `cryptography` is not a
dependency of this package (see pyproject.toml -- `dependencies = []`,
because these modules run inside embedded interpreters where pip cannot be
assumed) and this module does not make it one.


ON ZEROIZATION -- what is actually guaranteed, which is less than the word
suggests:

  GUARANTEED. The `bytearray` this class holds its chain key in is
  overwritten with zeros in place before the reference is dropped. That
  buffer, at that address, no longer contains the key.

  NOT GUARANTEED, and no pure-Python code can guarantee it:

  * `hmac.new()` / `hashlib` copy the key into an internal HMAC context
    (in CPython, into an OpenSSL structure). We cannot reach that copy.
    `hmac.HMAC` has no close/wipe API.
  * Every `bytes` object here -- the digest results, anything a caller
    passed in as `bytes` rather than `bytearray` -- is immutable. It
    cannot be overwritten. It survives until the garbage collector
    happens to reclaim it, and then only if nothing else holds a
    reference.
  * The interpreter may have copied any of it during a realloc, and the
    OS may have paged any of it to swap or captured it in a core dump.

  So: this reduces the window in which the key sits in a buffer we own.
  It does not make the key unrecoverable from a process image. An
  attacker with a core dump of a running component may well recover
  K_n. What they cannot recover is K_0..K_n-1, and that is the property
  the ratchet actually provides -- forward secrecy comes from the
  one-wayness of SHA-256, not from the memset. Do not sell the memset.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from typing import Any, Dict, Mapping, Optional, Tuple, Union

__all__ = [
    "HASH_LEN",
    "INFO_IK",
    "INFO_MAC",
    "INFO_RATCHET",
    "RatchetError",
    "CounterExhausted",
    "hkdf_extract",
    "hkdf_expand",
    "hkdf_sha256",
    "derive_ik",
    "canonical_preimage",
    "Ratchet",
]

HASH_LEN = 32

# Domain separation labels. These are wire format: changing any of them
# invalidates every component in the field. They are the reason M_n and
# K_n+1, both HKDF-Expand of the same K_n, are independent.
INFO_IK = b"scruple/ik/v1"
INFO_MAC = b"scruple/mac/v1"
INFO_RATCHET = b"scruple/ratchet/v1"


class RatchetError(Exception):
    """Base for ratchet misuse."""


class CounterExhausted(RatchetError):
    """The ratchet was used past its configured maximum counter."""


# --------------------------------------------------------------------------
# HKDF (RFC 5869), by hand.
#
# Written out rather than pulled from a library so that this file and
# lib/ratchet/ratchet.ts can be read side by side and seen to agree. The
# TypeScript side additionally asserts its full-HKDF against Node's
# built-in crypto.hkdfSync, which makes that an independent third
# implementation checking these two.
# --------------------------------------------------------------------------


def hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    """RFC 5869 §2.2. PRK = HMAC-SHA256(salt, ikm).

    An empty salt is replaced by HashLen zero bytes, per the RFC.
    """
    if not salt:
        salt = b"\x00" * HASH_LEN
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def hkdf_expand(prk: bytes, info: bytes, length: int = HASH_LEN) -> bytes:
    """RFC 5869 §2.3. Expand only -- no extract step.

    This is what the ratchet's chain steps use. `prk` must already be a
    uniformly random key; K_n always is.
    """
    if length < 1 or length > 255 * HASH_LEN:
        raise RatchetError(f"hkdf_expand: length {length} out of range")
    out = bytearray()
    t = b""
    counter = 1
    while len(out) < length:
        t = hmac.new(prk, t + info + bytes([counter]), hashlib.sha256).digest()
        out += t
        counter += 1
    return bytes(out[:length])


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = HASH_LEN) -> bytes:
    """Full HKDF-SHA256: extract, then expand. Used only for IK derivation."""
    return hkdf_expand(hkdf_extract(salt, ikm), info, length)


def derive_ik(bdk: bytes, component_id: str) -> bytearray:
    """IK = HKDF-SHA256(ikm=BDK, salt=component_id, info="scruple/ik/v1", L=32).

    Returned as a `bytearray` so the caller can overwrite it. `component_id`
    is salted as its UTF-8 bytes.

    The component never runs this: it receives the IK over TLS at
    provisioning (§4.4) and never holds the BDK. It lives here because the
    server and the component must agree on it byte for byte, and the test
    vectors are generated from this function.
    """
    if len(bdk) < 16:
        raise RatchetError("BDK must be at least 16 bytes")
    if not component_id:
        raise RatchetError("component_id must not be empty")
    return bytearray(
        hkdf_sha256(bdk, component_id.encode("utf-8"), INFO_IK, HASH_LEN)
    )


# --------------------------------------------------------------------------
# Canonical preimage
#
# SPEC GAP, recorded here rather than papered over: §4.1 says
# `mac = HMAC-SHA256(M_n, canonical_preimage)` and never defines
# canonical_preimage. Two implementations reading that sentence will not
# agree. This is the definition both sides of this WO use, and it is in
# the shared vectors so a disagreement is a test failure rather than a
# field incident.
#
#   canonical_preimage(fields) = UTF-8 of JSON with keys sorted by
#   Unicode code point, no insignificant whitespace, no trailing newline.
#
# Values are restricted to str | int | bool | None. FLOATS ARE REFUSED:
# Python's repr and JavaScript's Number#toString do not agree on every
# double, and a MAC that depends on float formatting fails intermittently
# and unreproducibly -- the worst failure mode available. Counters and
# sizes are ints; everything else is a string.
# --------------------------------------------------------------------------

PreimageValue = Union[str, int, bool, None]


def canonical_preimage(fields: Mapping[str, PreimageValue]) -> bytes:
    for k, v in fields.items():
        if not isinstance(k, str):
            raise RatchetError(f"canonical_preimage: non-string key {k!r}")
        if isinstance(v, float):
            raise RatchetError(
                f"canonical_preimage: float value for {k!r}. Floats do not "
                "serialise identically across languages; use a string or an int."
            )
        if not isinstance(v, (str, int, bool, type(None))):
            raise RatchetError(
                f"canonical_preimage: unsupported value type {type(v).__name__} for {k!r}"
            )
    return json.dumps(
        dict(fields),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


# --------------------------------------------------------------------------
# The ratchet itself
# --------------------------------------------------------------------------


def _wipe(buf: Optional[bytearray]) -> None:
    """Overwrite a mutable buffer in place. See the module docstring for
    exactly how much this is and is not worth."""
    if buf is None:
        return
    try:
        for i in range(len(buf)):
            buf[i] = 0
    except (TypeError, BufferError):  # not mutable after all
        pass


class Ratchet:
    """Component-side state: `(K_n, n)`.

    Single-threaded by contract. A counter must never be issued twice
    under one `component_id` (§4.4), and two threads sharing one Ratchet
    is the easiest way to do exactly that; give each thread its own
    component identity, or hold a lock outside this class.
    """

    def __init__(self, ik: Union[bytes, bytearray], counter: int = 0) -> None:
        if len(ik) != HASH_LEN:
            raise RatchetError(f"IK must be {HASH_LEN} bytes, got {len(ik)}")
        if counter < 0:
            raise RatchetError("counter must not be negative")
        self._k: Optional[bytearray] = bytearray(ik)
        self._n = int(counter)

    @property
    def counter(self) -> int:
        """The counter the NEXT event will carry."""
        return self._n

    @property
    def spent(self) -> bool:
        return self._k is None

    def chain_key(self) -> bytes:
        """K_n, for persisting sealed state. Not for MACing anything."""
        if self._k is None:
            raise RatchetError("ratchet has been destroyed")
        return bytes(self._k)

    def mac(self, preimage: Union[bytes, Mapping[str, PreimageValue]]) -> Tuple[int, str]:
        """Consume counter n: derive M_n, MAC, ratchet, zeroize.

        Returns `(n, mac_hex)` -- the counter this event carries and the
        hex MAC. Ordering is the spec's, §5: **derive, MAC, ratchet, then
        enqueue.** The counter is spent when the MAC is computed, not when
        the submission succeeds. A queued event keeps its counter and a
        retry re-sends the same bytes; the server drops the duplicate
        idempotently on `(component_id, counter)`.
        """
        if self._k is None:
            raise RatchetError("ratchet has been destroyed")
        if self._n >= 2**53:
            raise CounterExhausted("counter would exceed exact-integer range")

        blob = preimage if isinstance(preimage, (bytes, bytearray)) else canonical_preimage(preimage)

        k = self._k
        m = bytearray(hkdf_expand(bytes(k), INFO_MAC, HASH_LEN))
        nxt = bytearray(hkdf_expand(bytes(k), INFO_RATCHET, HASH_LEN))
        tag = hmac.new(bytes(m), bytes(blob), hashlib.sha256).hexdigest()

        used = self._n
        self._k = nxt
        self._n = used + 1
        _wipe(k)
        _wipe(m)
        return used, tag

    def destroy(self) -> None:
        """Best-effort wipe of the chain key. Idempotent."""
        _wipe(self._k)
        self._k = None

    # -- sealed state, §4.4 step 4 ----------------------------------------

    def seal_to_file(self, path: str, *, component_id: str) -> None:
        """Write `(component_id, K_n, n)` to a 0600 file.

        This is the fallback custody in §4.4 -- "a 0600 file owned by a
        user the tenant is not". It is software protection and nothing
        more: it stops a tenant reading the key with the tenant's own
        uid, and stops nothing at all if the tenant has root in the
        component's namespace, which §2 requirement 2 says they must not.
        Where attestable compute exists, seal to the TPM/SEV measurement
        instead and the leaf is `verified` rather than `passthrough`.
        """
        if self._k is None:
            raise RatchetError("ratchet has been destroyed")
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(
                fd,
                json.dumps(
                    {
                        "v": 1,
                        "component_id": component_id,
                        "counter": self._n,
                        "chain_key_hex": self.chain_key().hex(),
                    }
                ).encode("utf-8"),
            )
        finally:
            os.close(fd)
        os.chmod(path, 0o600)

    @classmethod
    def load_from_file(cls, path: str) -> Tuple[str, "Ratchet"]:
        """Restore sealed state. Returns `(component_id, ratchet)`.

        If this raises, the component MUST re-provision as a new
        `component_id` starting at n=0 (§4.4). It must never guess a
        counter under an existing id: a reused counter is indistinguishable
        from a replay and the server will reject it.
        """
        with open(path, "rb") as f:
            doc: Dict[str, Any] = json.loads(f.read().decode("utf-8"))
        if doc.get("v") != 1:
            raise RatchetError(f"unknown sealed-state version {doc.get('v')!r}")
        return str(doc["component_id"]), cls(
            bytes.fromhex(doc["chain_key_hex"]), int(doc["counter"])
        )
