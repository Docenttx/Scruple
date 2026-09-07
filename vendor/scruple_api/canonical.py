"""RFC 8785 (JSON Canonicalization Scheme) -- the Python half of ``workflow_hash``.

WHY THIS MODULE EXISTS
----------------------
``workflow_hash``'s preimage is ``sha256(canonicalize(doc))``. Until WO-21 the
only implementation was ``lib/scruple/canonicalWorkflow.ts``, whose rule was
"recursively sort keys, keep array order, no whitespace" and whose numbers were
whatever the host language's JSON formatter produced. The two languages that
have to agree do not::

    JSON text   JavaScript JSON.stringify   Python json.dumps
    1e-4        0.0001                      0.0001               agree
    1e-5        0.00001                     1e-05                DIFFER
    5e-6        0.000005                    5e-06                DIFFER
    1e-7        1e-7                        1e-07                DIFFER
    1.0         1                           1.0                  DIFFER
    1e16        10000000000000000           1e+16                DIFFER
    -0.0        0                           -0.0                 DIFFER

So a leaf written by the TypeScript server fails verification against a Python
verifier holding the identical document, and a hash mismatch is
indistinguishable from a tampered file. This is not a training curiosity: a
shipped ComfyUI graph in ``docs/provenance-bundles/`` carries ``"cfg": 3.0``
and diverges today.

WHY RFC 8785 RATHER THAN A RULE OF OUR OWN
------------------------------------------
Two homegrown rules already existed -- ``ratchet.canonical_preimage`` refuses
floats outright (H-4 §10 C-1), and WO-20's ``model_write.encode_number``
commits them as quoted decimal strings. Both work inside this repo and neither
is checkable against anything outside it. Worse, ``encode_number`` uses Python
``repr``, so a JavaScript component encoding the same float would write
``"0.00001"`` where Python writes ``"1e-05"`` -- the divergence moved into the
string rather than being removed.

RFC 8785 is a published rule with published test vectors, and it costs us
nothing on the TypeScript side, because JCS §3.2.2.3 mandates ECMA-262
§7.1.12.1 (ECMAScript's ``Number::toString``) and JCS §3.2.3 sorts property
names by UTF-16 code unit -- which is exactly what ``JSON.stringify`` and
``Array#sort`` were already doing. The cost lands HERE: Python has to
implement ECMAScript number formatting, which is ``_es_number_to_string``
below. That is the price and it is paid once.

THE TYPE COLLAPSE, WHICH IS THE PART THAT SURPRISES PEOPLE
----------------------------------------------------------
JCS defines JSON numbers as IEEE-754 doubles. JavaScript has no other numeric
type, so ``JSON.parse('1')`` and ``JSON.parse('1.0')`` are the same value and
canonicalize identically. Python distinguishes ``int`` from ``float`` and must
therefore DELIBERATELY collapse them: ``1``, ``1.0`` and ``1e0`` all
canonicalize to ``1``. A Python implementation that preserved the distinction
would be self-consistent and unable to verify a single leaf.

The one place the collapse cannot be silent is an integer that no double can
hold. ``json.loads('9007199254740993')`` gives Python the exact integer and
gives JavaScript 9007199254740992 -- two different documents that would
canonicalize to the same bytes. Python can see this and REFUSES; JavaScript
cannot see it at all, because the precision is gone before its canonicalizer
is called. The asymmetry is recorded rather than hidden behind a check that
could not work.

NO DEPENDENCIES
---------------
``decimal`` and ``math`` from the standard library. ``scruple-api`` is vendored
into embedded interpreters where pip cannot be assumed (see
``pyproject.toml``: ``dependencies = []``), so a PyPI JCS package was not an
option even where one would have been the obvious choice.
"""

from __future__ import annotations

import hashlib
import math
from decimal import Decimal
from typing import Any, List, Tuple

__all__ = [
    "CANONICALIZATION_PROFILE",
    "CanonicalizationError",
    "canonicalize",
    "canonicalize_bytes",
    "hash_workflow",
    "es_number_to_string",
]

#: The canonicalization rule this module implements. Registry-declared in
#: ``lib/leaf/registry.yaml`` under ``canonicalization_profiles``.
CANONICALIZATION_PROFILE = "jcs-1"

#: The largest magnitude at which EVERY integer is exactly representable as an
#: IEEE-754 double. Named because it is the number people reach for, and then
#: NOT used as the bound -- see ``_int_as_double`` for why the exactness test
#: is the right rule and this one is merely the conservative approximation of
#: it. ``ratchet.canonical_preimage`` uses the approximation, correctly: its
#: field set is a closed list of counters and byte sizes, where the extra
#: precision could only ever be spurious.
MAX_SAFE_INTEGER = 2**53 - 1


class CanonicalizationError(Exception):
    """Raised instead of hashing a document that has no canonical form.

    ``reason`` is a machine-readable code shared with the TypeScript
    implementation's ``CanonicalizationError.reason``, so the cross-language
    vectors can assert that both sides refuse the same document for the same
    stated reason rather than merely both failing.
    """

    def __init__(self, reason: str, path: str, detail: str) -> None:
        super().__init__(f"canonicalize: {detail} at {path or '<root>'} [{reason}]")
        self.reason = reason
        self.path = path


# ---------------------------------------------------------------------------
# ECMAScript Number::toString -- ECMA-262 §6.1.6.1.20, referenced by JCS
# §3.2.2.3 via §7.1.12.1.
#
# The spec says: let `s` be the shortest decimal digit string and `n` the
# position of the decimal point such that s x 10**(n-k) is the value, where
# k = len(s). Then:
#
#   k <= n <= 21    ->  s followed by (n - k) zeros
#   0 <  n <= 21    ->  s with a point inserted after n digits
#  -6 <  n <= 0     ->  "0." + (-n) zeros + s
#   k == 1          ->  s + "e" + sign + |n-1|
#   otherwise       ->  s[0] + "." + s[1:] + "e" + sign + |n-1|
#
# `repr(float)` already gives the shortest round-tripping decimal, which is the
# hard half (Python 3.1+ uses David Gay / Grisu-style shortest repr, the same
# property ECMAScript requires). What is left is layout: the thresholds at
# which ECMAScript switches between fixed and exponential notation differ from
# Python's, and its exponent has no zero padding. That is the entire divergence
# and it is what the rest of this function removes.
# ---------------------------------------------------------------------------


def _shortest_digits(x: float) -> Tuple[str, int]:
    """Return ``(digits, n)`` for a finite non-zero float.

    ``digits`` has no leading or trailing zeros; ``n`` is ECMAScript's decimal
    point position, i.e. ``value == 0.digits * 10**n``.
    """
    d = Decimal(repr(abs(x)))
    _sign, tup, exp = d.as_tuple()
    digits: List[int] = list(tup)
    # `repr` may leave trailing zeros ("100.0" -> digits (1,0,0,0), exp -1).
    # ECMAScript's `s` is the SHORTEST digit string, so strip them and carry
    # the loss into the exponent.
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exp += 1
    s = "".join(str(c) for c in digits)
    k = len(s)
    n = int(exp) + k
    return s, n


def _int_as_double(v: int, path: str) -> float:
    """Convert a Python ``int`` to the double JCS says every JSON number is.

    The test is EXACTNESS, not ``abs(v) <= MAX_SAFE_INTEGER``. 2**53 is one
    past the safe range and is nonetheless represented exactly; refusing it
    would refuse a document JavaScript handles perfectly, which is a
    cross-language failure introduced by the fix rather than removed by it.
    2**53 + 1 is not representable, JavaScript's parser has already rounded it
    to 2**53 by the time its canonicalizer runs, and the two languages are
    therefore holding different documents -- so this side refuses rather than
    producing bytes that assert they are the same one.

    Python's ``int``/``float`` comparison is exact (it does not coerce the int
    to a float first), which is what makes the test trustworthy.
    """
    try:
        d = float(v)
    except OverflowError:
        d = None
    if d is None or d != v:
        raise CanonicalizationError(
            "integer_out_of_double_range",
            path,
            f"the integer {v} is not exactly representable as an IEEE-754 double; "
            "a JavaScript parser has already rounded it, so the two sides are not "
            "holding the same document and no hash can honestly say they are",
        )
    return d


def es_number_to_string(x: float) -> str:
    """ECMA-262 ``Number::toString`` for a finite double, base 10.

    This is byte-for-byte what JavaScript's ``String(x)`` and
    ``JSON.stringify(x)`` produce, including ``-0.0 -> "0"``. It is checked
    against the TypeScript implementation by
    ``test/vectors/canonicalization-vectors.json``.
    """
    if math.isnan(x) or math.isinf(x):
        raise CanonicalizationError(
            "non_finite_number", "", "NaN and Infinity have no JSON spelling (JCS §3.2.2.3)"
        )
    if x == 0:
        # Covers -0.0. ECMAScript renders both as "0"; JCS's own test vectors
        # agree, and Python's repr(-0.0) == "-0.0" is the divergence being
        # removed here rather than a case being lost.
        return "0"

    sign = "-" if x < 0 else ""
    s, n = _shortest_digits(x)
    k = len(s)

    if k <= n <= 21:
        return sign + s + "0" * (n - k)
    if 0 < n <= 21:
        return sign + s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + s
    e = n - 1
    esign = "+" if e >= 0 else "-"
    mantissa = s if k == 1 else s[0] + "." + s[1:]
    return sign + mantissa + "e" + esign + str(abs(e))


# ---------------------------------------------------------------------------
# Strings -- JCS §3.2.2.2. Written out rather than delegated to
# `json.dumps(ensure_ascii=False)` so that the rule can be read here and
# compared to `lib/leaf/canonicalJson.ts` side by side. The two produce the
# same bytes; the point is that a reader can see that they do.
# ---------------------------------------------------------------------------

_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


def _quote(s: str, path: str) -> str:
    out = ['"']
    for ch in s:
        cp = ord(ch)
        if 0xD800 <= cp <= 0xDFFF:
            # A lone surrogate cannot be encoded as UTF-8 at all. JavaScript's
            # well-formed JSON.stringify escapes it and would produce a
            # canonical form Python could not even represent, so both sides
            # refuse instead.
            raise CanonicalizationError(
                "lone_surrogate",
                path,
                "string contains an unpaired UTF-16 surrogate and is not valid Unicode",
            )
        esc = _ESCAPES.get(cp)
        if esc is not None:
            out.append(esc)
        elif cp < 0x20:
            out.append("\\u%04x" % cp)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_sort_key(s: str) -> bytes:
    """JCS §3.2.3 -- sort property names as arrays of UTF-16 code units.

    NOT a code-point sort. Byte-wise comparison of the big-endian UTF-16
    encoding is exactly a unit-wise comparison of unsigned 16-bit code units,
    which is what the RFC asks for, and it differs from Python's default
    ``sorted()`` for any key above the BMP: a surrogate pair begins 0xD8.., so
    an astral key sorts BEFORE U+E000..U+FFFF under JCS and AFTER them under a
    code-point sort.

    ``ratchet.canonical_preimage`` deliberately uses the OTHER rule (H-4 §10
    C-1 pinned code point). Both are correct for their own preimage; see
    docs/canon/CANONICALIZATION.md §6 for why they are allowed to differ.
    """
    return s.encode("utf-16-be", errors="surrogatepass")


def _canon(v: Any, path: str) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return _quote(v, path)
    if isinstance(v, int):
        # Deliberate collapse: JCS numbers are doubles, and JavaScript has no
        # int. `1` and `1.0` MUST canonicalize identically or nothing verifies.
        return es_number_to_string(_int_as_double(v, path))
    if isinstance(v, float):
        try:
            return es_number_to_string(v)
        except CanonicalizationError as exc:
            raise CanonicalizationError(exc.reason, path, str(exc)) from None
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_canon(x, f"{path}[{i}]") for i, x in enumerate(v)) + "]"
    if isinstance(v, dict):
        for k in v:
            if not isinstance(k, str):
                raise CanonicalizationError(
                    "non_string_key", path, f"object key {k!r} is not a string"
                )
        keys = sorted(v.keys(), key=_utf16_sort_key)
        return (
            "{"
            + ",".join(_quote(k, path) + ":" + _canon(v[k], f"{path}.{k}") for k in keys)
            + "}"
        )
    raise CanonicalizationError(
        "unsupported_type", path, f"a {type(v).__name__} is not a JSON value"
    )


def canonicalize(value: Any) -> str:
    """RFC 8785 canonical JSON text for any JSON-representable value.

    Raises ``CanonicalizationError`` rather than answering for a value with no
    canonical form -- NaN, Infinity, a non-string key, an unrepresentable
    integer, a lone surrogate, or a type JSON does not have.
    """
    return _canon(value, "")


def canonicalize_bytes(value: Any) -> bytes:
    """The canonical form as the bytes that are actually hashed."""
    return canonicalize(value).encode("utf-8")


def hash_workflow(doc: Any) -> str:
    """``workflow_hash`` -- sha256 hex of the canonical serialization.

    The ComfyUI ``workflow_api_json`` for ``kind=graph_execute``; the training
    recipe for ``kind=model_write``. ``lib/leaf/registry.yaml`` states the
    preimage in prose and this is the only implementation of it in Python.
    """
    return hashlib.sha256(canonicalize_bytes(doc)).hexdigest()
