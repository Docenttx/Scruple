"""WO-21 -- the Python half of ``workflow_hash``, checked against the TypeScript.

WHY THIS FILE IS IN THE SDK'S SUITE AND THE MODULE IS IN ``scruple-api``
------------------------------------------------------------------------
``scruple_api.canonical`` is pure computation with no network capability, so it
belongs in the API package by the rule ``scruple_api/__init__.py`` states. The
TEST lives here because this is the suite that has both package roots on
``sys.path`` (see ``packages/scruple-host-sdk/conftest.py``) and because the
cross-language claim being made is about the whole estate, not about one
package standing alone -- the same reason
``tests/test_server_library.py`` owns the component-preimage vectors.

WHAT IS BEING PROVED
--------------------
``test/vectors/canonicalization-vectors.json`` is emitted by
``lib/leaf/canonicalJson.ts`` and reproduced here. The inputs are raw JSON
DOCUMENT TEXT rather than values, which matters: the failure being guarded
against is two languages holding one document, and a vector file of Python
values could not express the case that started this -- ``1.0``, which Python
parses to a float and JavaScript cannot distinguish from ``1``.

Three classes of case, and the third is the honest one:

1. **Agreement.** Both languages produce the same canonical bytes and the same
   sha256. This is the bulk of the file.
2. **Refusal.** Neither language answers, and both say the same reason.
3. **Asymmetry.** ``9007199254740993`` parses exactly in Python and lossily in
   JavaScript. No agreement is achievable, Python refuses, JavaScript answers
   for a document it no longer holds, and the vectors say so rather than
   pretending the two sides can be reconciled.
"""

from __future__ import annotations

import hashlib
import json
import math
import pathlib
import struct

import pytest

from scruple_api.canonical import (
    CANONICALIZATION_PROFILE,
    CanonicalizationError,
    canonicalize,
    canonicalize_bytes,
    es_number_to_string,
    hash_workflow,
)

REPO = pathlib.Path(__file__).resolve().parents[3]
VECTORS = REPO / "test" / "vectors" / "canonicalization-vectors.json"


@pytest.fixture(scope="module")
def vectors() -> dict:
    with VECTORS.open() as fh:
        return json.load(fh)


# ── 1. the divergence, demonstrated from this side ──────────────────────────


def test_the_bug_is_real_in_this_language() -> None:
    """The pre-WO-21 rule, run here, produces the other answer.

    This is the "failing before the fix" half. `json.dumps` with a recursive
    key sort IS what a conforming second implementation would have written
    from the registry's prose, and it disagrees with the shipped TypeScript on
    every one of these.
    """

    def old_rule(v):
        if v is None or not isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        if isinstance(v, list):
            return "[" + ",".join(old_rule(x) for x in v) + "]"
        return (
            "{"
            + ",".join(
                json.dumps(k, ensure_ascii=False) + ":" + old_rule(v[k]) for k in sorted(v)
            )
            + "}"
        )

    # left: what Python used to produce. right: what the shipped JS produced.
    assert old_rule({"learning_rate": 1e-5}) == '{"learning_rate":1e-05}'
    assert old_rule({"cfg": 3.0}) == '{"cfg":3.0}'  # JS said {"cfg":3}
    assert old_rule({"eps": 1e-7}) == '{"eps":1e-07}'  # JS said {"eps":1e-7}
    assert old_rule({"n": 1e16}) == '{"n":1e+16}'  # JS said 10000000000000000
    assert old_rule({"z": -0.0}) == '{"z":-0.0}'  # JS said 0

    # and the same documents under the RFC 8785 rule now agree with JS.
    assert canonicalize({"learning_rate": 1e-5}) == '{"learning_rate":0.00001}'
    assert canonicalize({"cfg": 3.0}) == '{"cfg":3}'
    assert canonicalize({"eps": 1e-7}) == '{"eps":1e-7}'
    assert canonicalize({"n": 1e16}) == '{"n":10000000000000000}'
    assert canonicalize({"z": -0.0}) == '{"z":0}'


def test_the_canvas_file_that_proves_it_is_not_a_training_bug() -> None:
    """A shipped ComfyUI graph with ``"cfg": 3.0``.

    Before WO-21 this file hashed to 40fbeb04… in Python and d39a015e… in
    JavaScript. Same bytes on disk, two answers, nothing anywhere saying so.
    """
    p = REPO / "docs/provenance-bundles/bundle-29e9a40e1d43/iterations/video-1/workflow_api.json"
    raw = p.read_text()
    assert '"cfg": 3.0' in raw
    doc = json.loads(raw)
    assert hash_workflow(doc) == "d39a015eb81b7af7a29f9e266dcbcbd4604df1cb6baab79e3e0ed756e72c0ee3"


# ── 2. the shared vectors ───────────────────────────────────────────────────


def test_vector_file_is_present_and_declares_the_profile(vectors: dict) -> None:
    assert vectors["profile"] == CANONICALIZATION_PROFILE == "jcs-1"
    assert len(vectors["cases"]) >= 20


def test_every_vector_reproduces(vectors: dict) -> None:
    for case in vectors["cases"]:
        doc = json.loads(case["json"])
        if "python_refuses" in case:
            with pytest.raises(CanonicalizationError) as exc:
                canonicalize(doc)
            assert exc.value.reason == case["python_refuses"], case["name"]
            continue
        assert canonicalize(doc) == case["canonical"], case["name"]
        assert hash_workflow(doc) == case["sha256"], case["name"]


def test_canonical_bytes_are_utf8_of_the_canonical_text(vectors: dict) -> None:
    for case in vectors["cases"]:
        if "python_refuses" in case:
            continue
        doc = json.loads(case["json"])
        assert canonicalize_bytes(doc) == case["canonical"].encode("utf-8"), case["name"]


def test_legacy_leaves_still_verify(vectors: dict) -> None:
    """The backward-compatibility claim, checked from the OTHER language.

    Each hash here was captured from the pre-WO-21 TypeScript. That Python now
    reproduces it is the stronger statement: not merely "the fix changed
    nothing", but "the fix made a second language able to reproduce what
    already shipped".
    """
    leaves = vectors["legacy_leaves"]
    assert len(leaves) >= 12
    for leaf in leaves:
        if leaf.get("profile") == "insertion-order-1":
            continue  # its own test, below
        raw = leaf["json"] if "json" in leaf else (REPO / leaf["file"]).read_text()
        assert hash_workflow(json.loads(raw)) == leaf["legacy_sha256"], leaf["name"]


def test_the_four_rows_that_predate_canonicalization(vectors: dict) -> None:
    """The older break WO-21 found while looking for this one.

    ids 166..169 in data/scruple.db, written 2026-07-05, carry a
    ``workflow_hash`` computed by plain ``JSON.stringify`` in object key order.
    ec188d6 (2026-07-13) made the formula canonical and did NOT version it, so
    those rows carry ``leaf_scheme: 'v2.2'`` exactly like the rows written
    after the change. Four of the seven rows in the corpus.

    They happen to be replayable from Python as well, because these graphs are
    keyed "3", "4", "5"… and numeric-like keys order the same way under V8's
    object ordering and Python's insertion order. That is a coincidence of this
    corpus, not a property of the profile.
    """
    pre = [l for l in vectors["legacy_leaves"] if l.get("profile") == "insertion-order-1"]
    assert len(pre) == 4
    for leaf in pre:
        doc = json.loads(leaf["json"])
        replay = hashlib.sha256(
            json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
        assert replay == leaf["legacy_sha256"], leaf["name"]
        # and the current rule does not reproduce them, which is the finding
        assert hash_workflow(doc) != leaf["legacy_sha256"], leaf["name"]


def test_at_least_one_legacy_fixture_is_a_real_witnessed_row(vectors: dict) -> None:
    real = [l for l in vectors["legacy_leaves"] if l["provenance"] == "db_leaf"]
    assert len(real) >= 6


# ── 3. the number rule ──────────────────────────────────────────────────────


def test_es_number_to_string_matches_javascript_on_the_named_cases() -> None:
    # Every one of these is a value JavaScript's JSON.stringify produces; the
    # left column is what Python's own formatter would have said.
    assert es_number_to_string(1e-5) == "0.00001"  # repr: 1e-05
    assert es_number_to_string(5e-6) == "0.000005"  # repr: 5e-06
    assert es_number_to_string(1e-4) == "0.0001"
    assert es_number_to_string(1e-6) == "0.000001"  # repr: 1e-06
    assert es_number_to_string(1e-7) == "1e-7"  # repr: 1e-07
    assert es_number_to_string(1.0) == "1"  # repr: 1.0
    assert es_number_to_string(300.0) == "300"  # repr: 300.0
    assert es_number_to_string(1e15) == "1000000000000000"
    assert es_number_to_string(1e16) == "10000000000000000"  # repr: 1e+16
    assert es_number_to_string(1e20) == "100000000000000000000"
    assert es_number_to_string(1e21) == "1e+21"
    assert es_number_to_string(-0.0) == "0"  # repr: -0.0
    assert es_number_to_string(0.0) == "0"
    assert es_number_to_string(-1.5) == "-1.5"
    assert es_number_to_string(0.1) == "0.1"
    assert es_number_to_string(1 / 3) == "0.3333333333333333"
    assert es_number_to_string(5e-324) == "5e-324"
    assert es_number_to_string(1.7976931348623157e308) == "1.7976931348623157e+308"


def test_es_number_to_string_round_trips_every_double_it_formats() -> None:
    """The property that makes the formatter safe: it never loses a bit.

    Shortest-round-trip is what ECMA-262 §6.1.6.1.20 requires and what makes
    the canonical form a faithful commitment rather than an approximation of
    one. Checked over a deterministic sweep of bit patterns rather than a
    handful of literals, because a layout bug shows up in a narrow exponent
    band and nowhere else.
    """
    state = 0x243F6A8885A308D3  # a fixed seed; this test must not be flaky
    checked = 0
    for _ in range(20000):
        state = (state * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
        x = struct.unpack("<d", struct.pack("<Q", state))[0]
        if math.isnan(x) or math.isinf(x):
            continue
        assert float(es_number_to_string(x)) == x
        checked += 1
    assert checked > 19000


def test_the_type_collapse_is_deliberate() -> None:
    """1, 1.0 and 1e0 are one document. Python is the side that must be told."""
    assert canonicalize(json.loads("1")) == canonicalize(json.loads("1.0"))
    assert canonicalize({"a": 1, "b": 1.0, "c": 1e0}) == '{"a":1,"b":1,"c":1}'
    assert canonicalize({"steps": 1000}) == '{"steps":1000}'


def test_integers_outside_the_double_range_are_refused_by_exactness() -> None:
    # 2**53 IS exactly representable and must pass -- refusing it (which the
    # conservative Number.isSafeInteger bound would) would break a document
    # JavaScript handles perfectly.
    assert canonicalize({"a": 2**53}) == '{"a":9007199254740992}'
    assert canonicalize({"a": 2**53 + 2}) == '{"a":9007199254740994}'
    assert canonicalize({"a": -(2**53)}) == '{"a":-9007199254740992}'

    # 2**53 + 1 is not. JavaScript's parser already rounded it, so the two
    # sides are not holding the same document.
    with pytest.raises(CanonicalizationError) as exc:
        canonicalize({"a": 2**53 + 1})
    assert exc.value.reason == "integer_out_of_double_range"

    with pytest.raises(CanonicalizationError):
        canonicalize({"a": 10**400})  # past the double range entirely


def test_nan_and_infinity_are_refused() -> None:
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(CanonicalizationError) as exc:
            canonicalize({"lr": bad})
        assert exc.value.reason == "non_finite_number"


# ── 4. keys and strings ─────────────────────────────────────────────────────


def test_keys_sort_by_utf16_code_unit_not_code_point() -> None:
    """JCS §3.2.3. This is where Python's default ``sorted()`` is wrong.

    U+1F600 encodes as the surrogate pair D83D DE00, so under a UTF-16
    code-unit sort it precedes U+E000 and U+FFFD. Python's ``sorted()`` is a
    code-point sort and puts it last -- the exact trap H-4 §10 C-1 closed for
    the ratchet MAC preimage, arriving here in a second one.
    """
    doc = {"\U0001F600": 1, "": 2, "�": 3, "a": 4, "Z": 5}
    out = canonicalize(doc)
    assert out.index("\U0001F600") < out.index("") < out.index("�")
    # and the code-point sort Python would have used gives the other order
    assert sorted(doc)[-1] == "\U0001F600"


def test_string_escaping_is_jcs_3_2_2_2() -> None:
    s = "a\x00b\x08c\x09d\x0ae\x0cf\x0dg\x1fh\x7fi\"j\\k/l"
    assert canonicalize({"s": s}) == (
        '{"s":"a\\u0000b\\bc\\td\\ne\\ff\\rg\\u001fh\x7fi\\"j\\\\k/l"}'
    )
    # non-ASCII is left literal, not \u-escaped: Python's json.dumps default
    # (ensure_ascii=True) would have diverged on every accented prompt.
    assert canonicalize({"p": "héllo ☃ \U0001D11E"}) == '{"p":"héllo ☃ \U0001D11E"}'
    # DEL (U+007F) is NOT escaped -- the one Python's default gets wrong.
    assert "\\u007f" not in canonicalize({"s": "\x7f"})


def test_lone_surrogates_are_refused() -> None:
    for doc in ({"s": "\ud800"}, {"\udc00": 1}):
        with pytest.raises(CanonicalizationError) as exc:
            canonicalize(doc)
        assert exc.value.reason == "lone_surrogate"


def test_non_string_keys_and_unsupported_types_are_refused() -> None:
    with pytest.raises(CanonicalizationError) as exc:
        canonicalize({1: "a"})
    assert exc.value.reason == "non_string_key"

    with pytest.raises(CanonicalizationError) as exc:
        canonicalize({"s": {1, 2}})
    assert exc.value.reason == "unsupported_type"

    with pytest.raises(CanonicalizationError) as exc:
        canonicalize({"b": b"bytes"})
    assert exc.value.reason == "unsupported_type"


def test_arrays_keep_order_and_nested_objects_do_not() -> None:
    assert canonicalize({"inputs": {"model": ["4", 0]}}) == '{"inputs":{"model":["4",0]}}'
    assert canonicalize([3, 1, 2]) == "[3,1,2]"
    assert canonicalize([{"b": 1, "a": 2}]) == '[{"a":2,"b":1}]'


def test_error_carries_the_path_so_a_big_graph_can_be_debugged() -> None:
    with pytest.raises(CanonicalizationError) as exc:
        canonicalize({"3": {"inputs": {"cfg": float("nan")}}})
    assert exc.value.path == ".3.inputs.cfg"


# ── 5. the other homegrown rule, and why it is now unnecessary ──────────────


def test_wo20s_string_encoding_would_itself_have_diverged() -> None:
    """``model_write.encode_number`` moved the problem, it did not remove it.

    It commits a float as ``repr(x)`` -- a STRING, which canonicalizes
    identically everywhere. True, and it hides that the string is
    Python-specific: a JavaScript component encoding the same float writes
    "0.00001" where Python writes "1e-05", so two components disagree on the
    recipe document itself and the hash faithfully reports the disagreement.

    With RFC 8785 the workaround is unnecessary: the float can be committed as
    a number and the receipt reads ``1e-05`` rather than ``"1e-05"``.
    """
    from scruple_api.model_write import encode_number

    assert encode_number(1e-5) == "1e-05"  # Python's repr
    # what a JavaScript component would have produced for the same double
    js_side = es_number_to_string(1e-5)
    assert js_side == "0.00001"
    assert hash_workflow({"lr": encode_number(1e-5)}) != hash_workflow({"lr": js_side})
    # and both differ from the encoding-free form, which now agrees across
    # languages on its own.
    assert canonicalize({"lr": 1e-5}) == '{"lr":0.00001}'
