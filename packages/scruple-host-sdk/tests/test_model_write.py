"""``model.write`` as a contract rather than as Kohya's integration.

WO-20. ``CANON_SKELETON.md`` §4.1 flags ``model.write`` as specified from one
integration, and WO-5's mapping exercise established what that means: a hook
with one implementation describes that integration. So the file this test
guards is only worth its line count if a SECOND trainer goes through it, and
the tests below are organised around that claim rather than around coverage.

The four things it exists to demonstrate:

  * **two trainer shapes, one contract** — a ``safetensors.torch.save_file``
    patch (Kohya's shape) and a ``torch.save`` patch (a plain PyTorch loop's
    shape) reach the same submission through the same object, and the ONE
    place they genuinely differ — the pickle has no header and therefore no
    structural fingerprint — is a recorded absence, never a guess;
  * **three placements, one derivation** — ``server-library``,
    ``sidecar-gate`` and a vendor who can isolate nothing. The third is
    REFUSED, before a counter is spent and before a provisioning token is
    burned. Nothing here declares a posture;
  * **the training shape** — dataset root, recipe, base-model fingerprints and
    ``header_hash``, with the three that have a home on the leaf pinned
    against the TypeScript formulas and the fourth pinned as UNCOVERED so the
    day it gets a home, this test says so;
  * **the float divergence** — a training recipe is mostly floats, and floats
    are where a preimage stops being reproducible across languages. The
    expected strings below were produced by node and are recorded with the
    command that produced them.

Neither torch nor safetensors is imported here. Both hooks take the module as
an argument precisely so the contract can be exercised without a GPU stack;
``examples/vendor-training/`` runs them against the real libraries.
"""

from __future__ import annotations

import hashlib
import json
import os
import struct

import pytest

from scruple_api.model_write import (
    DirectoryCheckpointError,
    TrainingRecipeError,
    TrainingRun,
    dataset_root_hash,
    encode_number,
    fingerprint_model_file,
    hash_model_fingerprints,
    hash_run_inputs,
    hash_training_recipe,
    observe_checkpoint,
    read_safetensors_header,
    structural_summary,
    training_recipe,
)
from scruple_api.surface import (
    AttestationOutcome,
    ObservationFidelity,
    Placement,
    PlacementEnforcement,
    SurfaceKind,
)
from scruple_host_sdk.errors import NoBaselineError
from scruple_host_sdk.model_write import (
    CheckpointVolumeWatch,
    ModelWriteIntegration,
    install_safetensors_save_file_hook,
    install_torch_save_hook,
    provision_or_refuse,
)
from scruple_api.model_write import MODEL_WRITE_IN_PROCESS, MODEL_WRITE_VOLUME_WATCH
from scruple_host_sdk.ratchet import Ratchet, derive_ik
from scruple_host_sdk.envelope import ComponentIdentity
from scruple_host_sdk.server_library import PlacementRefused, component_preimage

BDK = bytes(range(32))
COMPONENT_ID = "3f2b91c4-5d0a-4e77-9c18-6ab2d4e0f931"
BUILD = "sha256:" + "cd" * 32


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def write_safetensors(path: str, tensors: dict, metadata: dict | None = None) -> None:
    """Write a real safetensors container without importing torch.

    The format is eight bytes of little-endian header length, then the JSON
    header, then the data. Writing it by hand here rather than through the
    library keeps this suite free of a multi-hundred-megabyte dependency and
    keeps the parser under test honest: it is reading bytes, not calling
    safetensors.
    """
    header: dict = {}
    blob = b""
    for name, (dtype, shape, payload) in tensors.items():
        header[name] = {"dtype": dtype, "shape": shape, "data_offsets": [len(blob), len(blob) + len(payload)]}
        blob += payload
    if metadata is not None:
        header["__metadata__"] = metadata
    raw = json.dumps(header).encode()
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(raw)))
        f.write(raw)
        f.write(blob)


def integration(client, **kw) -> ModelWriteIntegration:
    kw.setdefault("component", ComponentIdentity(COMPONENT_ID, "vendor-acme", BUILD))
    kw.setdefault("ratchet", Ratchet(derive_ik(BDK, COMPONENT_ID), 0))
    return ModelWriteIntegration(client, **kw)


def attached(client, ref: str = "b" * 64):
    client.state.baseline_ref = ref
    return client


WITNESS_OK = (
    "ok",
    201,
    {
        "leaf_id": "leaf_1",
        "leaf_hash": "e" * 64,
        "witnessed": True,
        "leaf_scheme": "v2",
        "run_sequence": 1,
        "baseline_ref": "b" * 64,
    },
)


# ---------------------------------------------------------------------------
# The evidence shape — what a training run carries that an image does not
# ---------------------------------------------------------------------------


def test_the_safetensors_header_is_hashed_from_raw_bytes(tmp_path):
    """The header hash must be over the bytes on disk, not over a
    re-serialised parse — a re-serialisation orders keys by whatever the local
    JSON implementation does, which would give two hashes for one file."""
    p = str(tmp_path / "lora.safetensors")
    write_safetensors(p, {"w": ("F32", [2, 2], b"\x00" * 16)}, {"trained_by": "acme"})

    header = read_safetensors_header(p)
    assert header is not None
    with open(p, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        raw = f.read(n)
    assert header.raw == raw
    facts = observe_checkpoint(p)
    assert facts.header_hash == hashlib.sha256(raw).hexdigest()
    assert facts.has_structural_fingerprint


def test_the_structural_summary_carries_no_weights(tmp_path):
    """P6 / zero-content is a property of what the function CAN do."""
    p = str(tmp_path / "lora.safetensors")
    payload = b"\xde\xad\xbe\xef" * 4
    write_safetensors(p, {"layer.0": ("F32", [2, 2], payload)}, {"note": "n"})
    summary = structural_summary(read_safetensors_header(p))
    blob = json.dumps(summary).encode()
    assert payload not in blob
    assert summary["layer_count"] == 1
    assert summary["layers"][0] == {"name": "layer.0", "shape": [2, 2], "dtype": "F32"}


def test_a_pickle_has_no_header_and_that_is_recorded_not_guessed(tmp_path):
    """THE SECOND TRAINER'S FINDING, as a test.

    A `torch.save` checkpoint is a zip-wrapped pickle. There is no safetensors
    header, so the structural fingerprint KOHYA_REPLACEMENT.md leans on does
    not exist for it. `header_hash` is None — an absence, which is a different
    fact from a header that parsed empty, and neither of them is a guess.
    """
    p = str(tmp_path / "epoch-1.pt")
    with open(p, "wb") as f:
        f.write(b"PK\x03\x04" + os.urandom(512))
    facts = observe_checkpoint(p)
    assert facts.header_hash is None
    assert facts.structural is None
    assert facts.has_structural_fingerprint is False
    assert facts.content_hash and facts.size_bytes == 516


def test_a_directory_checkpoint_is_refused_rather_than_answered(tmp_path):
    """THE MISFIT, ASSERTED. A save_pretrained()/accelerate checkpoint is a
    directory of shards. `content_hash` is one hash of one file; every way of
    giving a directory one invents a preimage lib/leaf/registry.yaml does not
    define and a third party could not reproduce. Refusing is the finding."""
    d = tmp_path / "checkpoint-500"
    d.mkdir()
    (d / "model-00001-of-00002.safetensors").write_bytes(b"x")
    with pytest.raises(DirectoryCheckpointError) as e:
        observe_checkpoint(str(d))
    assert "directory" in str(e.value)


def test_the_dataset_root_hash_is_stable_and_reports_what_it_skipped(tmp_path):
    root = tmp_path / "dataset"
    (root / "a").mkdir(parents=True)
    (root / "a" / "1.png").write_bytes(b"one")
    (root / "a" / "1.txt").write_text("a caption")
    (root / "2.png").write_bytes(b"two")
    os.symlink(str(tmp_path / "elsewhere"), str(root / "link.png"))

    first = dataset_root_hash(str(root), keep_manifest=True)
    second = dataset_root_hash(str(root))
    assert first.root_hash == second.root_hash
    assert first.file_count == 3
    assert sorted(first.manifest) == ["2.png", "a/1.png", "a/1.txt"]
    # A symlink is not followed and is not silently dropped: following it would
    # make the commitment depend on something outside the directory.
    assert "link.png" in first.skipped

    (root / "3.png").write_bytes(b"three")
    assert dataset_root_hash(str(root)).root_hash != first.root_hash


def test_the_dataset_lands_on_input_hash_with_the_shipped_formula():
    """input_hash's preimage is fixed-order JSON.stringify — deliberately not
    canonical JSON, because existing leaves commit to exactly that. Pinned
    against the TypeScript, not merely against itself."""
    run = TrainingRun(recipe={}, dataset=None)
    assert run.input_hash() is None
    expected = hash_run_inputs([{"kind": "dataset", "hash": "a" * 64}])
    # node -e "const c=require('crypto');console.log(c.createHash('sha256').update(
    #   JSON.stringify({provider:null,prompt:null,spec:null,
    #   inputs:[{kind:'dataset',hash:'a'.repeat(64)}]}),'utf8').digest('hex'))"
    assert expected == "01b1a7a6f7344a8aac3ea6723e0aa8118c3d90da7422f07054284f65a2852b8c"


def test_base_model_fingerprints_use_the_shipped_top_level_sort(tmp_path):
    p = str(tmp_path / "base.safetensors")
    write_safetensors(p, {"w": ("F16", [1], b"\x00\x00")})
    fp = fingerprint_model_file(p)
    assert set(fp) == {"content_hash", "header_hash", "header_size", "bytes"}
    assert fp["header_hash"] is not None

    manifest = {"z.safetensors": fp, "a.safetensors": fp}
    text, digest = hash_model_fingerprints(manifest)
    assert list(json.loads(text)) == ["a.safetensors", "z.safetensors"]
    assert digest == hashlib.sha256(text.encode()).hexdigest()
    # An absent manifest is NULL, never the hash of {} — "we enumerated the
    # weights and there were none" is a claim an unpopulated field must not make.
    assert hash_model_fingerprints({}) is None
    assert hash_model_fingerprints(None) is None


# ---------------------------------------------------------------------------
# The float divergence — the training-specific landmine
# ---------------------------------------------------------------------------


def test_a_raw_float_would_not_survive_being_hashed_in_another_language():
    """The reason `training_recipe` quotes numbers, demonstrated rather than
    asserted. These are the strings the two languages actually produce:

        node -e "console.log([1e-5,5e-6,1.0,1e16].map(v=>JSON.stringify(v)))"
          -> 0.00001, 0.000005, 1, 10000000000000000
        python3 -c "import json;print([json.dumps(v) for v in ...])"
          -> 1e-05,   5e-06,     1.0, 1e+16

    A learning rate of 1e-5 is the most ordinary value in a training config,
    and workflow_hash over a recipe containing one is not reproducible from
    the other language. That is a property of the recipe document, not of a
    bug anywhere: ratchet.canonical_preimage already refuses floats outright
    for this reason (§10 C-1); the workflow preimage never had to care until
    the document it carried was mostly floats.
    """
    assert json.dumps(1e-5) == "1e-05"
    assert json.dumps(1.0) == "1.0"
    # ...and what we commit instead round-trips exactly and spells the same
    # in every language.
    assert encode_number(1e-5) == "1e-05"
    assert float(encode_number(1e-5)) == 1e-5
    assert encode_number(1000) == 1000  # integers ARE portable; leave them alone
    assert encode_number(True) is True
    for bad in (float("nan"), float("inf")):
        with pytest.raises(TrainingRecipeError):
            encode_number(bad)


def test_the_recipe_hashes_to_what_the_typescript_would_compute():
    """Pinned against node, with the command recorded. hashGraphOrTraining ->
    hashWorkflow -> canonicalize, and this is that value."""
    recipe = training_recipe(
        framework="pytorch",
        trainer="t",
        hyperparameters={"lr": 1e-5, "steps": 100, "x": 1.0},
    )
    assert recipe["hyperparameters"] == {"lr": "1e-05", "steps": 100, "x": "1.0"}
    # node -e "const c=require('crypto');function k(v){if(v===null||typeof v!=='object')
    #   return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(k).join(',')+']';
    #   return '{'+Object.keys(v).sort().map(x=>JSON.stringify(x)+':'+k(v[x])).join(',')+'}'}
    #   console.log(c.createHash('sha256').update(k({framework:'pytorch',trainer:'t',
    #   hyperparameters:{lr:'1e-05',steps:100,x:'1.0'}}),'utf8').digest('hex'))"
    assert (
        hash_training_recipe(recipe)
        == "c939ce3c44d150f38d7f45f391733743d488d3d6502f22d97febc267cf55e3b6"
    )


def test_a_float_cannot_sneak_into_a_fixed_order_preimage():
    with pytest.raises(TrainingRecipeError):
        hash_model_fingerprints({"a": {"bytes": 1.5}})


# ---------------------------------------------------------------------------
# Placement — derived across three shapes, refused on the fourth
# ---------------------------------------------------------------------------


def test_server_library_and_sidecar_both_witness_and_both_are_passthrough(make_client):
    """Two placements a vendor can actually have, resolved and not declared.
    Note the top-right cell: `server-library` earns P1 for free and STILL
    yields `passthrough`. Nothing buys `verified` except root chaining."""
    client, _ = make_client()
    lib = integration(client)
    assert lib.resolution.effective is Placement.SERVER_LIBRARY
    assert lib.assurance().p1.value == "holds"
    assert lib.assurance().leaf == "passthrough"

    client2, _ = make_client()
    side = integration(
        client2,
        declared_placement=Placement.SIDECAR_GATE,
        enforcement=PlacementEnforcement.ISOLATED_NAMESPACE,
        surface_profile=MODEL_WRITE_VOLUME_WATCH,
    )
    assert side.resolution.effective is Placement.SIDECAR_GATE
    assert side.assurance().p1.value == "conditional"
    assert side.assurance().leaf == "passthrough"
    assert side.can_claim


def test_a_vendor_who_cannot_isolate_is_refused_not_downgraded(make_client, tmp_path):
    """THE IN-POD KOHYA SHAPE. Server-side, on hardware the tenant does not
    own, and identical to browser JS because the tenant has root in that
    container. It is told so; it is not sold a lower tier."""
    client, _ = make_client()
    attached(client)
    unenforced = integration(
        client,
        declared_placement=Placement.SIDECAR_GATE,
        enforcement=PlacementEnforcement.NONE,
    )
    a = unenforced.assurance()
    assert unenforced.resolution.effective is Placement.UNATTESTED_CLIENT
    assert a.leaf is None and a.can_claim is False

    p = str(tmp_path / "lora.safetensors")
    write_safetensors(p, {"w": ("F32", [1], b"\x00" * 4)})
    before = unenforced.ratchet.counter
    with pytest.raises(PlacementRefused):
        unenforced.witness_checkpoint(p, TrainingRun(recipe={}))
    assert unenforced.ratchet.counter == before, "a refusal must not cost a counter"


def test_attestation_cannot_lift_a_refused_placement(make_client):
    """A pod can relay a genuine root-verified quote it obtained from a machine
    it does not run. If that could lift the tier, the standard would be
    claimable by anyone able to make one HTTP request."""
    client, _ = make_client()
    forged = integration(
        client,
        declared_placement=Placement.SERVER_LIBRARY,
        enforcement=PlacementEnforcement.NONE,
        attestation_outcome=AttestationOutcome.VERIFIED,
    )
    assert forged.can_claim is False


def test_provisioning_refuses_before_the_token_is_spent(make_client):
    """Refusing AFTER provisioning would burn a one-time token and seal an IK
    into a filesystem the tenant can read — H-4 §7 probe 3's exact condition.
    The FakeOpener has no script, so any HTTP call at all would raise."""
    client, opener = make_client([])
    with pytest.raises(PlacementRefused):
        provision_or_refuse(
            client,
            token="tok_never_used",
            build_measurement=BUILD,
            declared_placement=Placement.SIDECAR_GATE,
            enforcement=PlacementEnforcement.NONE,
        )
    assert opener.calls == [], "no request may be made on a refused placement"


def test_no_baseline_no_witness(make_client, tmp_path):
    client, _ = make_client()
    p = str(tmp_path / "lora.safetensors")
    write_safetensors(p, {"w": ("F32", [1], b"\x00" * 4)})
    with pytest.raises(NoBaselineError):
        integration(client).witness_checkpoint(p, TrainingRun(recipe={}))


# ---------------------------------------------------------------------------
# The submission itself
# ---------------------------------------------------------------------------


def _run(tmp_path) -> TrainingRun:
    root = tmp_path / "dataset"
    root.mkdir()
    (root / "1.png").write_bytes(b"one")
    base = str(tmp_path / "base.safetensors")
    write_safetensors(base, {"w": ("F16", [1], b"\x00\x00")})
    return TrainingRun(
        recipe=training_recipe(
            framework="pytorch",
            trainer="acme-lora",
            hyperparameters={"learning_rate": 1e-4, "steps": 20},
        ),
        dataset=dataset_root_hash(str(root)),
        base_model_fingerprints={"base.safetensors": fingerprint_model_file(base)},
        run_id="run-7",
    )


def test_the_leaf_carries_the_training_shape_and_the_fidelity_is_as_written(make_client, tmp_path):
    """`ServerLibraryIntegration` would stamp `as-delivered` here. Nothing was
    delivered: the trainer wrote a file to disk. `as-written` is what a third
    party holding the checkpoint can actually check."""
    client, opener = make_client([WITNESS_OK])
    attached(client)
    integ = integration(client)
    p = str(tmp_path / "lora.safetensors")
    write_safetensors(p, {"w": ("F32", [1], b"\x00" * 4)}, {"epoch": "1"})
    run = _run(tmp_path)

    out = integ.witness_checkpoint(p, run, mime="application/x-safetensors")
    body = opener.calls[-1]["body"]

    assert body["kind"] == "model_write"
    assert body["capture"]["hook"] == "model.write"
    assert body["capture"]["surface"] == SurfaceKind.IN_PROCESS_CALLBACK.value
    assert body["capture"]["fidelity"] == ObservationFidelity.AS_WRITTEN.value
    assert body["capture"]["close_detection"] == "save-returned"
    assert body["capture"]["correlation_method"] == "training-run"
    assert body["capture"]["correlation_id"] == "run-7"
    # The three that have a home on the leaf.
    assert body["input_hash"] == run.input_hash()
    assert body["model_fingerprints_hash"] == run.model_fingerprints()[1]
    assert body["capture"]["workflow_hash"] == run.workflow_hash()
    assert body["training"] == run.recipe
    # Both sent, so the route's disagreement check has something to check.
    assert body["model_fingerprints"] == run.base_model_fingerprints
    assert out.witnessed is True and out.leaf_status == "passthrough"


def test_header_hash_rides_on_the_wire_and_is_not_covered_by_the_mac(make_client, tmp_path):
    """THE REGISTRY GAP, PINNED.

    `header_hash` is not a field in lib/leaf/registry.yaml, is not in
    /v2/witness's accepted body, and is not read by component_preimage() — so
    it is sent, it is not sealed, and it is not persisted. The outcome says so
    on every event rather than letting the field's presence imply otherwise.

    When someone closes it (one registry entry, one Zod field, three preimage
    implementations) this test fails and tells them to flip the flag. That is
    the intent: a gap that goes quiet when it is fixed is a gap nobody closes.
    """
    client, opener = make_client([WITNESS_OK])
    attached(client)
    integ = integration(client)
    p = str(tmp_path / "lora.safetensors")
    write_safetensors(p, {"w": ("F32", [1], b"\x00" * 4)})

    out = integ.witness_checkpoint(p, TrainingRun(recipe={}))
    body = opener.calls[-1]["body"]
    assert out.header_hash is not None
    assert body["capture"]["header_hash"] == out.header_hash
    assert out.header_hash_covered is False
    assert "header_hash" not in component_preimage(body)


def test_the_mac_still_verifies_over_the_body_that_was_sent(make_client, tmp_path):
    """Adding an uncovered field must not break the covered ones. The server
    recomputes component_preimage() over the body it RECEIVED, so a field the
    preimage does not read may ride along; a field it does read may not
    change."""
    client, opener = make_client([WITNESS_OK])
    attached(client)
    ratchet = Ratchet(derive_ik(BDK, COMPONENT_ID), 0)
    integ = integration(client, ratchet=ratchet)
    p = str(tmp_path / "lora.safetensors")
    write_safetensors(p, {"w": ("F32", [1], b"\x00" * 4)})
    out = integ.witness_checkpoint(p, _run(tmp_path))

    body = opener.calls[-1]["body"]
    replay = Ratchet(derive_ik(BDK, COMPONENT_ID), 0)
    counter, mac = replay.mac(component_preimage(body))
    assert (counter, mac) == (out.counter, body["mac"])


def test_a_torch_pickle_witnesses_with_a_null_header_and_no_mime(make_client, tmp_path):
    """The second trainer's leaf, end to end. No header, and no media type —
    a torch pickle has none, and `application/octet-stream` would be a false
    declaration rather than a missing one."""
    client, opener = make_client([WITNESS_OK])
    attached(client)
    integ = integration(client)
    p = str(tmp_path / "epoch-1.pt")
    with open(p, "wb") as f:
        f.write(b"PK\x03\x04" + os.urandom(64))

    out = integ.witness_checkpoint(p, _run(tmp_path))
    body = opener.calls[-1]["body"]
    assert out.header_hash is None
    assert "header_hash" not in body["capture"]
    assert "mime" not in body, "absent, not application/octet-stream"
    assert body["kind"] == "model_write"


def test_the_queue_takes_an_undeliverable_checkpoint_and_keeps_its_counter(make_client, tmp_path):
    """Derive, MAC, ratchet, THEN enqueue. The counter is spent when the MAC is
    computed, so a witness that never answers costs the event a queue entry
    and nothing else — and one undeliverable checkpoint must not silence the
    component, because silence is what the design makes visible."""
    client, _ = make_client([("network_error",), ("network_error",)])
    attached(client)
    integ = integration(client)
    p = str(tmp_path / "lora.safetensors")
    write_safetensors(p, {"w": ("F32", [1], b"\x00" * 4)})

    first = integ.witness_checkpoint(p, TrainingRun(recipe={}))
    with open(p, "ab") as f:
        f.write(b"more")
    second = integ.witness_checkpoint(p, TrainingRun(recipe={}))
    assert first.queued and second.queued
    assert (first.counter, second.counter) == (0, 1)
    assert first.witnessed is False and first.envelope is None
    assert integ.queue_depth == 2


# ---------------------------------------------------------------------------
# Two trainers, one contract
# ---------------------------------------------------------------------------


class FakeSafetensorsTorch:
    """Stands in for `safetensors.torch`. The patched attribute is the one
    Kohya-ss reaches through `LoRANetwork.save_weights`."""

    def __init__(self) -> None:
        self.calls = 0

    def save_file(self, tensors, filename, metadata=None):
        self.calls += 1
        write_safetensors(filename, tensors, metadata)


class FakeTorch:
    """Stands in for `torch`. `save` is a GENERIC serializer, which is the
    difference the second implementation surfaced."""

    def __init__(self) -> None:
        self.calls = 0

    def save(self, obj, f, *args, **kwargs):
        self.calls += 1
        with open(f, "wb") as handle:
            handle.write(b"PK\x03\x04" + json.dumps(sorted(obj)).encode())


def test_both_trainer_shapes_reach_the_same_contract(make_client, tmp_path):
    client, opener = make_client([WITNESS_OK, WITNESS_OK])
    attached(client)
    integ = integration(client)
    run = _run(tmp_path)

    st = FakeSafetensorsTorch()
    uninstall_st = install_safetensors_save_file_hook(
        st, integ, lambda: run, mime="application/x-safetensors"
    )
    st.save_file({"w": ("F32", [1], b"\x00" * 4)}, str(tmp_path / "kohya.safetensors"), {"e": "1"})
    kohya_body = opener.calls[-1]["body"]

    torch = FakeTorch()
    uninstall_torch = install_torch_save_hook(torch, integ, lambda: run)
    torch.save({"w": 1}, str(tmp_path / "plain.pt"))
    plain_body = opener.calls[-1]["body"]

    # ONE contract: same kind, same hook, same fidelity, same run commitment.
    for body in (kohya_body, plain_body):
        assert body["kind"] == "model_write"
        assert body["capture"]["hook"] == "model.write"
        assert body["capture"]["fidelity"] == "as-written"
        assert body["capture"]["workflow_hash"] == run.workflow_hash()
        assert body["input_hash"] == run.input_hash()

    # ONE difference, and it is a property of the FORMAT, not of the hook.
    assert kohya_body["capture"]["header_hash"] is not None
    assert "header_hash" not in plain_body["capture"]

    uninstall_st()
    uninstall_torch()
    # uninstall() restores by setattr, so identity is checked on the
    # underlying function rather than on the freshly-bound method object.
    assert st.save_file.__func__ is FakeSafetensorsTorch.save_file
    assert torch.save.__func__ is FakeTorch.save
    assert st.calls == 1 and torch.calls == 1


def test_torch_save_is_scoped_because_it_is_not_a_checkpoint_call(make_client, tmp_path):
    """`torch.save` also writes optimizer state, resume files and cached
    tensors. Witnessing every call as a model write would assert that things
    which are not checkpoints are. Kohya's call site needed no such scoping,
    which is exactly why one implementation could not have shown this."""
    client, opener = make_client([WITNESS_OK])
    attached(client)
    integ = integration(client)
    ckpt_dir = tmp_path / "checkpoints"
    ckpt_dir.mkdir()
    other = tmp_path / "scratch"
    other.mkdir()

    torch = FakeTorch()
    install_torch_save_hook(torch, integ, lambda: None, only_paths_under=str(ckpt_dir))
    torch.save({"a": 1}, str(other / "optimizer.pt"))
    assert opener.calls == [], "a save outside the checkpoint directory is not a model write"
    torch.save({"a": 1}, str(ckpt_dir / "epoch-1.pt"))
    assert opener.calls[-1]["body"]["kind"] == "model_write"


def test_a_hook_cannot_be_installed_at_a_refused_placement(make_client):
    """The patch is identical to the in-pod hook's. What differs is whether
    the placement permits a leaf, and that is checked before the trainer is
    touched rather than per save."""
    client, _ = make_client()
    attached(client)
    refused = integration(
        client,
        declared_placement=Placement.SERVER_LIBRARY,
        enforcement=PlacementEnforcement.NONE,
    )
    st = FakeSafetensorsTorch()
    with pytest.raises(PlacementRefused):
        install_safetensors_save_file_hook(st, refused, lambda: None)
    # The patch is an instance attribute shadowing the class method; its
    # absence is what says nothing was installed.
    assert "save_file" not in st.__dict__, "a refused install must not leave a patch behind"


# ---------------------------------------------------------------------------
# The sidecar surface — watch IS the capture
# ---------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _watch_integration(client):
    return integration(
        client,
        declared_placement=Placement.SIDECAR_GATE,
        enforcement=PlacementEnforcement.ISOLATED_NAMESPACE,
        surface_profile=MODEL_WRITE_VOLUME_WATCH,
    )


def test_the_watcher_waits_for_the_settle_window_then_emits(make_client, tmp_path):
    client, opener = make_client([WITNESS_OK])
    attached(client)
    volume = tmp_path / "volume"
    volume.mkdir()
    clock = Clock()
    watch = CheckpointVolumeWatch(
        str(volume), _watch_integration(client), lambda: None, settle_s=15.0, clock=clock
    )
    watch.open()

    write_safetensors(str(volume / "epoch-1.safetensors"), {"w": ("F32", [1], b"\x00" * 4)})
    assert watch.scan() == [], "first sighting only records size and mtime"
    clock.t += 5
    assert watch.scan() == [], "still inside the settle window"
    clock.t += 20
    out = watch.scan()
    assert len(out) == 1
    body = opener.calls[-1]["body"]
    assert body["capture"]["surface"] == SurfaceKind.FILESYSTEM_WATCH.value
    assert body["capture"]["fidelity"] == "as-written"
    assert body["capture"]["close_detection"] == "quiescence"
    assert watch.scan() == [], "an unchanged file is not re-emitted"


def test_a_non_checkpoint_file_is_emitted_as_an_artifact_not_dropped(make_client, tmp_path):
    """A file the capture declines to emit is an invisible hole, and H-4 §7
    probe 4 exists to find exactly those. Sample images and logs get a leaf
    under `artifact.produced` rather than nothing."""
    client, opener = make_client([WITNESS_OK])
    attached(client)
    volume = tmp_path / "volume"
    volume.mkdir()
    (volume / "sample-0001.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 32)
    clock = Clock()
    watch = CheckpointVolumeWatch(str(volume), _watch_integration(client), settle_s=1.0, clock=clock)
    watch.open()
    watch.scan()
    clock.t += 5
    out = watch.scan()
    assert len(out) == 1 and out[0].kind == "artifact"
    assert opener.calls[-1]["body"]["capture"]["hook"] == "artifact.produced"


def test_a_watcher_over_nothing_refuses_to_open(make_client, tmp_path):
    """A surface that silently fails to open is the ComfyUI WebSocket gap by
    another name: an empty watch and a quiet volume look identical from the
    outside, and only one of them is a deployment."""
    client, _ = make_client()
    watch = CheckpointVolumeWatch(str(tmp_path / "absent"), _watch_integration(client))
    with pytest.raises(FileNotFoundError):
        watch.open()


def test_a_rewritten_checkpoint_is_recorded_twice_and_the_ambiguity_is_logged(
    make_client, tmp_path
):
    """§10 C-10 on a checkpoint. A trainer that stalled past the settle window
    produces exactly the same pair of events as a tamper. Both are recorded;
    this code does not decide which, because from here they are the same
    evidence."""
    client, _ = make_client([WITNESS_OK, WITNESS_OK])
    attached(client)
    volume = tmp_path / "volume"
    volume.mkdir()
    path = volume / "epoch-1.safetensors"
    lines: list = []
    clock = Clock()
    watch = CheckpointVolumeWatch(
        str(volume),
        _watch_integration(client),
        settle_s=1.0,
        clock=clock,
        log=lines.append,
    )
    watch.open()
    write_safetensors(str(path), {"w": ("F32", [1], b"\x00" * 4)})
    watch.scan()
    clock.t += 5
    assert len(watch.scan()) == 1

    write_safetensors(str(path), {"w": ("F32", [1], b"\x11" * 4)})
    # mtime is set explicitly: a rewrite that happens to preserve both size
    # and mtime is a real case, and leaving it to the filesystem's clock
    # granularity would make WHICH scan emits depend on the host.
    os.utime(path, (2_000_000, 2_000_000))
    clock.t += 5
    watch.scan()
    clock.t += 5
    assert len(watch.scan()) == 1
    assert lines and "AMBIGUOUS" in lines[0]
