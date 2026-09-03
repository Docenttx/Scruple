"""The ``model.write`` hook's evidence shape. Zero network, like everything here.

WO-20 of ``docs/canon/WO-SERIES-2-PROVING-IT.md``. Companion prose:
``docs/canon/MODEL_WRITE_HOOK.md``.

WHY A MODULE AND NOT A FEW KWARGS ON ``capture()``
--------------------------------------------------
``CANON_SKELETON.md`` §4.1 admits it plainly: ``model.write`` is "specified
from a single integration" -- Kohya's ``safetensors.torch.save_file``
monkey-patch -- and WO-5's mapping exercise established that a hook with one
implementation describes that integration rather than a contract. What §4.1
says the hook carries is "checkpoint + dataset root + hyperparameters", and
none of those three had a definition anywhere. A training run's provenance is
not an image's provenance with different filenames:

* an image has one artifact hash; a checkpoint has **two** -- the content and
  the safetensors *header*, which is the structural fingerprint (every layer
  name, shape and dtype) and which survives a metadata-only edit that the
  content hash cannot distinguish from a re-train;
* an image's inputs are files; a training run's input is a **dataset**, which
  is a directory, and there was no rule for reducing one to a hash;
* an image's recipe is a graph of integers and strings; a training recipe is
  **floats**, and floats are where cross-language canonicalization breaks
  (see :func:`training_recipe`, and it is not a hypothetical).

So the shape lives here, in the package with no network capability, because
the definitions are what a third-party verifier needs and a verifier is not
going to install our SDK to get them.

WHAT IS HERE AND WHAT IS THE SDK'S
----------------------------------
Here: reading a safetensors header, hashing it, summarising it without
touching a weight, reducing a dataset directory to a root hash, building a
training recipe that survives being re-canonicalized in another language, and
the two preimage formulas ``lib/leaf/hashes.ts`` already owns on the
TypeScript side. All of it is ``hashlib`` and ``json``.

The SDK's: the ratchet, the MAC, the counter, the queue, the placement refusal
and the wire. See ``scruple_host_sdk/model_write.py``.

TWO IMPLEMENTATIONS, ONE CONTRACT -- which is the point of the WO
-----------------------------------------------------------------
Nothing in this module knows what a trainer is. It takes a path and returns
facts about it. That is what let the same contract serve Kohya's
``safetensors.torch.save_file`` patch and a plain PyTorch ``torch.save``
checkpoint loop, and what made the one place they genuinely differ visible
rather than papered over: a ``.pt`` pickle **has no header**, so
:attr:`CheckpointFacts.header_hash` is ``None`` for it, and ``None`` here is a
recorded absence and never a guess. The hook is the same; half its evidence
does not exist on the second trainer. That is a fact about the format, and the
contract's job was to make it sayable.

WHAT DOES NOT FIT, STATED RATHER THAN BENT
------------------------------------------
A ``save_pretrained()`` / ``accelerate`` checkpoint is a **directory** -- a
sharded ``model-00001-of-00003.safetensors`` set plus optimizer state plus a
config. ``content_hash`` is one hash of one file, and there is no honest way to
give a directory one without inventing a preimage the leaf registry does not
have. :func:`observe_checkpoint` therefore REFUSES a directory rather than
inventing one. ``MODEL_WRITE_HOOK.md`` §5 records the misfit and what closing
it would take.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass, field

from .canonical import canonicalize
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .manifest import canonicalize, sha256_file, sha256_hex
from .surface import CaptureHook, ObservationFidelity, SurfaceKind

__all__ = [
    "MODEL_WRITE_KIND",
    "SAFETENSORS_MAX_HEADER_BYTES",
    "SafetensorsHeader",
    "read_safetensors_header",
    "hash_header_bytes",
    "structural_summary",
    "CheckpointFacts",
    "observe_checkpoint",
    "DirectoryCheckpointError",
    "DatasetCommitment",
    "dataset_root_hash",
    "training_recipe",
    "TrainingRecipeError",
    "encode_number",
    "hash_run_inputs",
    "hash_model_fingerprints",
    "hash_training_recipe",
    "fingerprint_model_file",
    "TrainingRun",
    "MODEL_WRITE_IN_PROCESS",
    "MODEL_WRITE_VOLUME_WATCH",
    "ModelWriteSurfaceProfile",
]

#: The leaf kind. One of the four `app/api/v2/witness/route.ts` accepts, and
#: the one `lib/leaf/registry.yaml` keys `workflow_hash`'s training-recipe
#: reading off. Spelled once, imported, never restated.
MODEL_WRITE_KIND = "model_write"

#: Sanity bound on the safetensors header, kept identical to the two
#: implementations that already exist -- `public/pod-hooks/
#: kohya_safetensors_hook.py` and `services/scruple-capture/kohya/
#: safetensors.ts` -- so all three agree on what counts as well-formed. A
#: third implementation that disagreed about this number would accept files
#: the others reject, which is a difference nobody would find until an
#: auditor did.
SAFETENSORS_MAX_HEADER_BYTES = 20_000_000


# ── The safetensors header ──────────────────────────────────────────────────


@dataclass(frozen=True)
class SafetensorsHeader:
    """The header, and the exact bytes it was read from.

    ``raw`` is kept so the hash and the parse cannot diverge: hashing a
    re-serialised parse would give a different string on any JSON
    implementation that orders keys differently, and therefore a different
    hash for an identical file.
    """

    raw: bytes
    json: Dict[str, Any]


def read_safetensors_header(path: str) -> Optional[SafetensorsHeader]:
    """Read and parse the header, or return ``None``.

    Format, as the safetensors library writes it::

        bytes 0..8     little-endian u64: length of the JSON header, N
        bytes 8..8+N   the JSON header: one key per tensor, plus optional
                       "__metadata__". Each value carries dtype and shape.
        the rest       the tensor data.

    NULL IS A REAL ANSWER AND NOT AN ERROR PATH. A ``.pt`` pickle, a truncated
    write, a file that is simply not safetensors: none of those is a failure,
    and none of them may become a guess. The caller records the absence, which
    is a different fact from a header that parsed empty.

    NOTHING HERE READS PAST THE HEADER. P6 / zero-content is a property of
    what this function is capable of, not of a policy applied to its output.
    """
    try:
        with open(path, "rb") as f:
            length_bytes = f.read(8)
            if len(length_bytes) < 8:
                return None
            n = int.from_bytes(length_bytes, "little")
            if n <= 0 or n > SAFETENSORS_MAX_HEADER_BYTES:
                return None
            raw = f.read(n)
            if len(raw) < n:
                return None
        parsed = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    return SafetensorsHeader(raw=raw, json=parsed)


def hash_header_bytes(header: SafetensorsHeader) -> str:
    """SHA-256 of the RAW header bytes.

    WHY THE HEADER IS HASHED SEPARATELY, since this is the field a reader is
    most likely to think redundant: the content hash covers everything and
    therefore distinguishes nothing -- any change anywhere gives a different
    value. The header hash covers the STRUCTURE, so a file whose ``__metadata__``
    was edited but whose tensor structure is intact keeps its header hash and
    changes its content hash, and the PAIR says which of the two happened.
    """
    return hashlib.sha256(header.raw).hexdigest()


def structural_summary(header: SafetensorsHeader, *, limit: int = 50) -> Dict[str, Any]:
    """Layer names, shapes and dtypes. No weights, ever.

    Truncated at ``limit`` layers, matching the two existing implementations.
    ``layer_count`` is the untruncated count, so the truncation is visible
    rather than silent.
    """
    tensors = [(k, v) for k, v in header.json.items() if k != "__metadata__"]
    return {
        "layer_count": len(tensors),
        "layers": [
            {
                "name": name,
                "shape": info.get("shape") if isinstance(info, dict) else None,
                "dtype": info.get("dtype") if isinstance(info, dict) else None,
            }
            for name, info in tensors[:limit]
        ],
        "metadata": header.json.get("__metadata__", {}),
    }


# ── The checkpoint, as observed ─────────────────────────────────────────────


class DirectoryCheckpointError(ValueError):
    """A directory was handed to a contract whose unit is one file.

    See the module docstring and ``MODEL_WRITE_HOOK.md`` §5. Raised rather
    than answered, because every available answer invents a preimage the leaf
    registry does not have, and an invented preimage is one a third party
    cannot reproduce.
    """


@dataclass(frozen=True)
class CheckpointFacts:
    """What is true about the bytes on disk. No claims, no tier, no leaf.

    ``header_hash`` and ``structural`` are ``None`` for any format that has no
    safetensors header -- a ``.pt`` pickle, a ``.ckpt``, a truncated write.
    That is the second trainer's shape and it is recorded, never inferred.
    """

    path: str
    content_hash: str
    size_bytes: int
    header_hash: Optional[str]
    structural: Optional[Dict[str, Any]]

    @property
    def has_structural_fingerprint(self) -> bool:
        return self.header_hash is not None


def observe_checkpoint(path: str) -> CheckpointFacts:
    """Hash a checkpoint on disk, streaming, and read its header if it has one.

    NOT ``capture()``. ``capture()`` base64-inlines the whole file and refuses
    anything over 25 MB, which is correct for a render and useless for a
    checkpoint: the smallest LoRA this hook will ever see is around 9 MB and a
    full fine-tune is gigabytes. This function never holds the file in memory
    and never sends bytes anywhere -- the leaf is zero-content (P6) and the
    checkpoint stays where the trainer put it.
    """
    if os.path.isdir(path):
        raise DirectoryCheckpointError(
            f"{path!r} is a directory. `model.write` commits ONE content_hash, and a "
            "sharded / save_pretrained() checkpoint is a directory of shards plus "
            "optimizer state plus a config. Giving it a single hash would mean "
            "inventing a preimage lib/leaf/registry.yaml does not define, which a "
            "third party could not reproduce. Witness each file that is itself a "
            "checkpoint, or see docs/canon/MODEL_WRITE_HOOK.md section 5 for what "
            "closing this properly would take."
        )
    size = os.path.getsize(path)
    header = read_safetensors_header(path)
    return CheckpointFacts(
        path=path,
        content_hash=sha256_file(path),
        size_bytes=size,
        header_hash=hash_header_bytes(header) if header else None,
        structural=structural_summary(header) if header else None,
    )


# ── The dataset ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DatasetCommitment:
    """A dataset directory reduced to one hash, plus what was left out.

    ``skipped`` is not diagnostics. A dataset root that silently excluded
    symlinks would be a commitment to a set of files nobody can enumerate from
    the hash, and "we looked and found none" is a claim an unpopulated field
    must not make -- the same rule ``model_fingerprints_hash`` states in the
    registry.
    """

    root_hash: str
    file_count: int
    total_bytes: int
    skipped: Sequence[str] = field(default_factory=tuple)
    manifest: Optional[Dict[str, str]] = None


def dataset_root_hash(
    root: str,
    *,
    keep_manifest: bool = False,
) -> DatasetCommitment:
    """Reduce a dataset directory to one re-derivable hash.

    PREIMAGE, stated so a verifier can reproduce it without this code::

        manifest = { posix relative path : sha256 hex of the file bytes }
                   for every REGULAR file under `root`, recursively
        preimage = JSON of that manifest with keys sorted ascending,
                   no whitespace, non-ASCII left literal
        root_hash = sha256(preimage)

    The shape is deliberately ``hash_model_fingerprints``' shape -- top-level
    keys sorted, values verbatim -- so a verifier learns one rule and applies
    it twice rather than learning two.

    SYMLINKS ARE NOT FOLLOWED and are reported in ``skipped``. Following them
    would make the hash depend on something outside the directory being
    committed to, and a dataset that hashes differently depending on what a
    link happens to point at today is not a commitment.

    THIS PREIMAGE IS NOT IN ``lib/leaf/registry.yaml``. It is defined here and
    in ``MODEL_WRITE_HOOK.md`` §4 because the registry has no dataset field at
    all; where it lands on the wire is ``input_hash``, as a single
    ``{kind: "dataset", hash: root_hash}`` entry. Saying that plainly is the
    point -- it is a real gap, not a naming preference.
    """
    if not os.path.isdir(root):
        raise NotADirectoryError(f"dataset_root_hash(): {root!r} is not a directory")

    manifest: Dict[str, str] = {}
    skipped: List[str] = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for name in sorted(filenames):
            absolute = os.path.join(dirpath, name)
            relative = os.path.relpath(absolute, root).replace(os.sep, "/")
            if os.path.islink(absolute) or not os.path.isfile(absolute):
                skipped.append(relative)
                continue
            try:
                manifest[relative] = sha256_file(absolute)
                total += os.path.getsize(absolute)
            except OSError as e:
                # Recorded, not dropped. A file the walk could see and could
                # not read is exactly the kind of hole that must not close
                # silently.
                skipped.append(f"{relative} (UNREADABLE: {e})")
        for name in sorted(dirnames):
            absolute = os.path.join(dirpath, name)
            if os.path.islink(absolute):
                skipped.append(os.path.relpath(absolute, root).replace(os.sep, "/") + "/")

    return DatasetCommitment(
        root_hash=_stringify_sorted_toplevel(manifest),
        file_count=len(manifest),
        total_bytes=total,
        skipped=tuple(skipped),
        manifest=dict(manifest) if keep_manifest else None,
    )


# ── The recipe, and the float problem it is built around ────────────────────


class TrainingRecipeError(ValueError):
    """A recipe carried a value that cannot survive being hashed twice."""


def encode_number(value: Any) -> Any:
    """Make one hyperparameter value safe to canonicalize in any language.

    THIS IS THE TRAINING-SPECIFIC LANDMINE AND IT IS NOT HYPOTHETICAL.

    ``workflow_hash``'s preimage is ``canonicalize(doc)`` -- recursive key
    sort, no whitespace -- and on ``kind=model_write`` the registry says the
    training recipe IS that document. ``canonicalize`` serialises scalars with
    the host language's own JSON number formatter, and the two languages that
    have to agree do not::

        value      JavaScript JSON.stringify     Python json.dumps
        1e-4       0.0001                        0.0001      agree
        1e-5       0.00001                       1e-05       DIFFER
        5e-6       0.000005                      5e-06       DIFFER
        1.0        1                             1.0         DIFFER
        1e16       10000000000000000             1e+16       DIFFER

    A ComfyUI graph is mostly integers and strings and mostly gets away with
    it. A training recipe is learning rates. ``1e-5`` is the most ordinary
    value in the file, and the server (TypeScript) and a third-party verifier
    (anything else) would compute two different ``workflow_hash`` values for
    the identical recipe -- which reads exactly like a tampered document.

    ``ratchet.canonical_preimage`` already refuses floats outright for this
    reason (§10 C-1: "floats do not serialise identically across languages").
    The MAC preimage learned it; the workflow preimage did not, because until
    a training recipe went through it, no document it carried was mostly
    floats.

    So a float becomes its ``repr`` as a STRING. ``repr`` is the shortest
    round-trip decimal, so ``float(encode_number(x)) == x`` exactly, and a
    string canonicalizes identically everywhere. The cost is that the recipe's
    numbers are quoted -- a real cost, paid deliberately, and the alternative
    is a hash nobody outside our toolchain can reproduce.

    NaN and infinity are refused: JSON has no spelling for them, both
    languages emit something non-standard, and a hyperparameter that is NaN is
    a bug being committed to.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        # Integers ARE portable: both languages emit the same digits, and
        # `steps=1000` reading as "1000" in a receipt would be worse than the
        # problem it solves.
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise TrainingRecipeError(
                f"hyperparameter value {value!r} has no JSON spelling. A recipe that "
                "cannot be written down cannot be committed to."
            )
        return repr(value)
    return value


def _encode_recipe_values(node: Any) -> Any:
    if isinstance(node, dict):
        return {str(k): _encode_recipe_values(v) for k, v in node.items()}
    if isinstance(node, (list, tuple)):
        return [_encode_recipe_values(v) for v in node]
    return encode_number(node)


def training_recipe(
    *,
    framework: str,
    trainer: str,
    hyperparameters: Mapping[str, Any],
    dataset: Optional[Mapping[str, Any]] = None,
    base_model: Optional[Mapping[str, Any]] = None,
    extra: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """The document that plays the graph's role on ``kind=model_write``.

    Every numeric leaf goes through :func:`encode_number`, so the recipe
    canonicalizes to the same bytes in TypeScript, in Python, and in whatever
    a verifier happens to be holding. Read that function's docstring before
    changing anything here; the quoting is the whole point.

    ``framework`` and ``trainer`` are in the document because the two
    implementations of this hook are not interchangeable and a receipt that
    could not tell them apart would be asserting more than it knows: a Kohya
    LoRA recipe and a plain PyTorch loop's recipe share almost no key names,
    and a verifier reading one needs to know which vocabulary it is in.
    """
    doc: Dict[str, Any] = {
        "framework": framework,
        "trainer": trainer,
        "hyperparameters": _encode_recipe_values(dict(hyperparameters)),
    }
    if dataset is not None:
        doc["dataset"] = _encode_recipe_values(dict(dataset))
    if base_model is not None:
        doc["base_model"] = _encode_recipe_values(dict(base_model))
    if extra:
        doc.update(_encode_recipe_values(dict(extra)))
    return doc


def hash_training_recipe(doc: Mapping[str, Any]) -> str:
    """``workflow_hash`` for a training recipe.

    The Python mirror of ``hashGraphOrTraining`` in ``lib/leaf/hashes.ts``,
    over the same ``canonicalize``. Computed client-side so the value can ride
    in the MACed ``capture.workflow_hash`` field; the server recomputes it
    from ``body.training`` independently. See ``MODEL_WRITE_HOOK.md`` §6 for
    what it means that nothing currently compares the two.
    """
    return sha256_hex(canonicalize(doc))


# ── The two preimages lib/leaf/hashes.ts already owns ───────────────────────
#
# Mirrored rather than re-derived. Both are DELIBERATELY not canonical JSON --
# `hashes.ts`'s header says "DO NOT tidy these", because existing leaves
# commit to exactly these formulas and a better canonicalization needs a new
# leaf scheme rather than an edit. The same instruction binds this file, one
# language over.


def _js_json(obj: Any) -> str:
    """``JSON.stringify`` as JavaScript emits it, for the two fixed-order
    preimages below: no whitespace, non-ASCII literal, insertion order kept.

    Floats never reach here -- both callers below are given hex digests, path
    strings and integers -- and that is enforced rather than assumed, because
    a float slipping into either preimage would be the divergence
    :func:`encode_number` exists to prevent, in the one place a caller would
    not be looking for it.
    """
    _refuse_floats(obj)
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def _refuse_floats(node: Any, path: str = "") -> None:
    if isinstance(node, float):
        raise TrainingRecipeError(
            f"float at {path or '<root>'} in a fixed-order preimage. JavaScript and "
            "Python spell floats differently (see encode_number); a hash computed "
            "over one of them is not reproducible from the other."
        )
    if isinstance(node, dict):
        for k, v in node.items():
            _refuse_floats(v, f"{path}.{k}")
    elif isinstance(node, (list, tuple)):
        for i, v in enumerate(node):
            _refuse_floats(v, f"{path}[{i}]")


def _stringify_sorted_toplevel(mapping: Mapping[str, Any]) -> str:
    ordered = {k: mapping[k] for k in sorted(mapping)}
    return sha256_hex(_js_json(ordered))


def hash_run_inputs(inputs: Sequence[Mapping[str, str]]) -> str:
    """``input_hash``. Mirror of ``hashRunInputs``.

    Preimage: ``JSON.stringify({provider, prompt, spec, inputs})`` with the
    keys in exactly that order and each input reduced to ``{kind, hash}``. The
    ``/v2`` surface passes null for provider/prompt/spec because it is
    zero-content and never receives them -- and on a training run those three
    are null in the honest sense too: there was no provider and no prompt.
    """
    payload = {
        "provider": None,
        "prompt": None,
        "spec": None,
        "inputs": [{"kind": i["kind"], "hash": i["hash"]} for i in inputs],
    }
    # jcs-2 (2026-09-03). Was ``_js_json`` -- JSON.stringify-shaped, insertion
    # order kept -- which made this preimage engine-dependent the moment a
    # caller passed a ``spec``: the TypeScript side embeds the whole ComfyUI
    # graph there, keyed by numbers, and V8 orders integer-like keys ascending
    # while Python does not. A verifier recomputing here got a different
    # digest, which is indistinguishable from tampering.
    return sha256_hex(canonicalize(payload))


def hash_run_inputs_legacy(inputs: Sequence[Mapping[str, str]]) -> str:
    """Replay of ``canonicalization_profile = 'jcs-1'`` rows only."""
    payload = {
        "provider": None,
        "prompt": None,
        "spec": None,
        "inputs": [{"kind": i["kind"], "hash": i["hash"]} for i in inputs],
    }
    return sha256_hex(_js_json(payload))


def hash_model_fingerprints(
    fingerprints: Optional[Mapping[str, Mapping[str, Any]]],
) -> Optional[Tuple[str, str]]:
    """``model_fingerprints_hash``. Mirror of ``hashModelFingerprints``.

    Preimage: ``JSON.stringify`` of the manifest with TOP-LEVEL keys sorted
    ascending; nested per-file objects keep their original key order.
    Returns ``(json, hash)`` or ``None`` -- never the hash of ``{}``, because
    "we enumerated the weights and there were none" is a claim an absent
    manifest must not make.
    """
    if not fingerprints:
        return None
    # jcs-2 (2026-09-03). Two corrections, mirroring hashModelFingerprints.
    #
    # ``mtime`` leaves the preimage: a file's modification time is not a
    # property of its bytes, so identical weights on another volume replica
    # hashed differently and nobody holding the model could reproduce it.
    #
    # NOTE FOR ANYONE READING THE HISTORY: this side never actually hashed an
    # mtime, because ``_refuse_floats`` raised on it. The TypeScript side did.
    # The twins had already diverged -- one refused what the other committed --
    # and that is a sharper statement of the defect than either alone.
    stripped = {
        k: {kk: vv for kk, vv in fingerprints[k].items() if kk != "mtime"}
        for k in fingerprints
    }
    text = canonicalize(stripped)
    return text, sha256_hex(text)


def hash_model_fingerprints_legacy(
    fingerprints: Optional[Mapping[str, Mapping[str, Any]]],
) -> Optional[Tuple[str, str]]:
    """Replay of ``canonicalization_profile = 'jcs-1'`` rows only."""
    if not fingerprints:
        return None
    ordered = {k: fingerprints[k] for k in sorted(fingerprints)}
    text = _js_json(ordered)
    return text, sha256_hex(text)


def fingerprint_model_file(path: str, *, relpath: Optional[str] = None) -> Dict[str, Any]:
    """One base-model file, in the shape ``model_fingerprints`` expects.

    Key order matters and is fixed here, because the nested objects are NOT
    re-sorted by the preimage: two callers building this dict in two orders
    would produce two hashes for identical weights.

    ``header_hash`` rides INSIDE this manifest for the base model, and that is
    the only place in the whole leaf where a header hash currently has a home
    (``lib/types.ts:88`` documents the shape). The checkpoint the run WROTE
    has no such home; see ``MODEL_WRITE_HOOK.md`` §4.
    """
    header = read_safetensors_header(path)
    return {
        "content_hash": sha256_file(path),
        "header_hash": hash_header_bytes(header) if header else None,
        "header_size": len(header.raw) if header else None,
        "bytes": os.path.getsize(path),
    }


# ── The run, as one object ──────────────────────────────────────────────────


@dataclass(frozen=True)
class TrainingRun:
    """Everything a ``model.write`` leaf commits to that is not the checkpoint.

    Assembled once per run and reused for every checkpoint the run writes,
    which is the difference §4.1 was reaching for when it said the hook
    carries "checkpoint + dataset root + hyperparameters": the first is
    per-event and the other two are per-run.
    """

    recipe: Dict[str, Any]
    dataset: Optional[DatasetCommitment] = None
    base_model_fingerprints: Optional[Dict[str, Dict[str, Any]]] = None
    run_id: Optional[str] = None

    def input_hash(self) -> Optional[str]:
        """The dataset, as the one input this run had."""
        if self.dataset is None:
            return None
        return hash_run_inputs([{"kind": "dataset", "hash": self.dataset.root_hash}])

    def model_fingerprints(self) -> Optional[Tuple[str, str]]:
        return hash_model_fingerprints(self.base_model_fingerprints)

    def workflow_hash(self) -> str:
        return hash_training_recipe(self.recipe)


# ── The declared surfaces this hook is served by ────────────────────────────


@dataclass(frozen=True)
class ModelWriteSurfaceProfile:
    """How a given deployment sees a checkpoint. Carried onto the leaf's
    capture block, and NOT an input to assurance -- surface affects coverage,
    never tier (``PLACEMENT_AND_SURFACES.md`` §2.2)."""

    name: str
    surface: SurfaceKind
    fidelity: ObservationFidelity
    hook: CaptureHook = CaptureHook.MODEL_WRITE


#: The vendor's own backend runs the trainer and the SDK in one process. The
#: same SurfaceKind as Kohya's in-pod monkey-patch, and the opposite
#: assurance, which is exactly the point §3 of the axes doc makes.
#:
#: FIDELITY IS `as-written`, NOT `as-delivered`. Nothing was delivered: the
#: trainer wrote a file to disk and the handler hashed the file. Anyone
#: holding the checkpoint can re-derive the hash, which is what `as-written`
#: asserts and what `as-delivered` would assert falsely.
MODEL_WRITE_IN_PROCESS = ModelWriteSurfaceProfile(
    name="model-write-in-process",
    surface=SurfaceKind.IN_PROCESS_CALLBACK,
    fidelity=ObservationFidelity.AS_WRITTEN,
)

#: The vendor isolated the trainer and watches the checkpoint volume from a
#: namespace the tenant cannot reach.
#:
#: `watch` IS the capture here, not a complement to a gate. A checkpoint is a
#: file; it leaves by a file browser, JupyterLab, `scp` or a remounted volume,
#: and there is no point at which the bytes can be withheld pending a leaf.
#: KOHYA_REPLACEMENT.md §1.
MODEL_WRITE_VOLUME_WATCH = ModelWriteSurfaceProfile(
    name="model-write-checkpoint-volume",
    surface=SurfaceKind.FILESYSTEM_WATCH,
    fidelity=ObservationFidelity.AS_WRITTEN,
)
