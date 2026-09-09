"""The Level-2 host adapter: how this addon declares itself to a capture
gate, and what it says about one generation.

WO-E4. Read `/mnt/corpus/scruple-desktop/docs/HOST-HOOK.md` first -- it is
the contract and this module is a CONSUMER of it, not an amendment to it.
Its "Adding the next host" section has three steps and no step 4:

    1. Write the HostRegistration.  2. Write semanticsFor.  3. Register it.

Blender is consumer #1. Everything below is those three steps for this
addon, and nothing below changes the gate, the correlator, the Submitter,
the ratchet, the leaf or the route.

WHAT THIS BUYS, IN ONE SENTENCE

The gate observes a wire. A wire carries bytes and a workflow graph; it
cannot carry "those pixels were scene `atrium` at frame 12 through
`CAM_hero`, rendered by EEVEE at 1920x1080". This addon knows exactly
that and knows nothing about the model weights. Two halves, one leaf.

---------------------------------------------------------------------------
THE REGISTRATION IS STATIC AND IT IS IN THIS FILE
---------------------------------------------------------------------------

HOST-HOOK.md: "Registration is explicit, static and build-time... there is
no dynamic plugin loading and there will not be one -- an adapter loaded at
runtime from a path the measured party can write to is `unattested-client`
by definition, whatever it declares."

So `REGISTRATION_TEMPLATE` is a module constant, it ships in the zip, and
it is versioned with the addon. Two values are MEASURED rather than
written down, and both are identity rather than grade:

  * `host_version`   -- `bpy.app.version`, the Blender that declared itself.
  * `adapter_version` -- this addon's own VERSION.

`host_adapter` lands on the leaf as `comfy-bridge@0.1.0`, which is what
makes a batch of leaves from a known-bad addon build findable.

---------------------------------------------------------------------------
WE DECLARE `unattested-client`, AND THAT IS NOT MODESTY
---------------------------------------------------------------------------

A Blender addon is a zip in a directory the user can write to. Nothing
signs it, nothing isolates it, and `enforcement` is `none`. The phantom
host in `scenarios/host-adapter.json` declares `attested-client` on
purpose so that `assuranceForHost` can be seen degrading it -- that is a
demonstration of the degradation, not an example to copy.

Declaring what we can actually be resolved to means DECLARED == EFFECTIVE
and there is no gap to explain. The addon does not get a better grade by
asking for one; it only gets a finding.

---------------------------------------------------------------------------
THE ADDON VALIDATES ITS OWN DECLARATION WITH THE GATE'S OWN CODE
---------------------------------------------------------------------------

`scruple_api.host_registry.register_host` is vendored in this zip, and
`register()` below calls it. It is the Python mirror of the TypeScript
`registerHost()` the gate will run over the same declaration, so an
addon build that would be REFUSED by a gate refuses ITSELF first, at
enable time, in the user's own Blender -- with the same fifteen codes.

`declare()` will not write a declaration that `register_host` rejected.
A refused declaration is Level 1 at the gate and a recorded refusal; the
addon's contribution is not to ship one.

---------------------------------------------------------------------------
`announce()` REFUSES TO WRITE A DOCUMENT ITS OWN SCHEMA REJECTS
---------------------------------------------------------------------------

`hostAdapterSink` checks each announcement against the schema the host
declared, and a document that is short is `declined` rather than
supplied-with-holes. That check is PRESENCE ONLY -- `required.filter(k =>
evidence[k] === undefined)` -- so `{"camera": null}` satisfies it and a
leaf would read `supplied` with a null camera in the MAC.

That is a real gap and it is recorded as finding E4-2 in
`/mnt/corpus/scruple-desktop/docs/WO-E4.md`; it is NOT patched here,
because the gate is not this work order's to change. What IS this
addon's business is not to emit such a document: `schema_problems()`
checks presence AND type against the very schema in `EVIDENCE_SCHEMA`,
and `announce()` writes nothing when it finds a problem. A scene with no
camera therefore produces NO announcement and a leaf that says
`declined` -- which is true -- rather than an announcement asserting that
the camera was null, which would be a leaf saying something false.

---------------------------------------------------------------------------
TRANSPORT: A DIRECTORY, BECAUSE `open(path, 'w')` IS EVERYWHERE
---------------------------------------------------------------------------

    <host_dir>/scruple-host.json          the declaration, written at enable
    <host_dir>/announce/<prompt_id>.json  one document per generation

`<host_dir>` comes from the environment -- `SCRUPLE_COMFY_HOST_DIR`, which
Desktop Studio sets when it launches the gate. It is NOT an addon
preference, and that is deliberate: HOST-HOOK.md puts the directory in
the app's environment so that a page, a workflow or a user cannot name
it, and an addon preference would hand that naming right back.

⚑ NO ENV VAR MEANS NO DECLARATION AND NO ANNOUNCEMENT. A user running
this addon on its own, with no Desktop Studio, writes nothing anywhere
and loses nothing: the standalone product is unchanged. That is the
mirrored-products decision in `docs/BLENDER.md`, and it is one `if` here.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Mapping, Optional, Tuple

from . import log as _log
from . import scene as _scene

from scruple_api.host_registry import (
    HostRegistration,
    HostRegistrationError,
    lookup_host,
    register_host,
)
from scruple_api.surface import (
    CaptureHook,
    ObservationFidelity,
    Placement,
    PlacementEnforcement,
    SurfaceKind,
)

# ---- what a host writes, and where ---------------------------------------

#: The environment variable Desktop Studio sets when it launches the gate.
HOST_DIR_ENV = "SCRUPLE_COMFY_HOST_DIR"
DECLARATION_FILE = "scruple-host.json"
ANNOUNCE_DIR = "announce"

# ---- the registration, static ---------------------------------------------

#: Lands in `capture.host` and in a MAC preimage. Lowercase and stable: it
#: may not be a display name that changes when marketing does.
HOST_ID = "blender"

#: SEPARATE FROM THE HOST because one host has several. This one is the
#: bridge into ComfyUI: it announces the scene a generation was submitted
#: FROM. A render-queue adapter over `bpy.app.handlers.render_post` would
#: observe the same Blender and mean something different, and would
#: register under its own adapter id.
ADAPTER_ID = "comfy-bridge"

#: Versioned predicate URI. A verifier reads this off the leaf and knows
#: which document `host_evidence` is before reading a byte of it. If the
#: shape below ever changes, this becomes /v2 -- an evidence shape that
#: changes without changing its name is unreadable in hindsight.
EVIDENCE_TYPE = "scruple.dev/evidence/blender-comfy-bridge/v1"

#: THE ADDON'S OWN STATEMENT OF WHAT ITS EVIDENCE CONTAINS.
#:
#: `required` is what a Blender scene ALWAYS has when it is in a state to
#: submit a generation at all, and nothing more. `samples` is absent from
#: it because Workbench has no sample count and a required field that is
#: sometimes genuinely missing would make every Workbench generation read
#: `declined` for no reason. `document` is absent because a .blend that has
#: never been saved has no name and `bpy.data.filepath` is "" -- see
#: `scene.document_name`, which returns None rather than "untitled".
EVIDENCE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": [
        "scene",
        "frame",
        "camera",
        "engine",
        "resolution",
        "resolution_percentage",
        "file_format",
    ],
    "properties": {
        # WHAT A WIRE CANNOT SEE.
        "scene": {"type": "string"},
        "frame": {"type": "integer"},
        "camera": {"type": "string"},
        # THE RENDER SETTINGS THAT DETERMINED THE PIXELS.
        "engine": {"type": "string"},
        "resolution": {
            "type": "array",
            "items": {"type": "integer"},
            "minItems": 2,
            "maxItems": 2,
        },
        "resolution_percentage": {"type": "integer"},
        "file_format": {"type": "string"},
        "samples": {"type": "integer"},
        # Scene identity beyond the name, for a verifier who has the .blend.
        "document": {"type": "string"},
        "object_count": {"type": "integer"},
        "material_count": {"type": "integer"},
    },
}

#: Which §4 hooks this adapter serves. DECLARED, and checked by the SDK:
#: `hostAdapterSink` declines an observation whose hook is not in this list
#: rather than answering for one it never claimed. These two are what a
#: ComfyUI generation through the gate actually raises.
#:
#: ⚑ ENUM MEMBERS, NOT THE EQUAL STRINGS. `scruple_api.surface`'s enums are
#: `str` subclasses, so `"none" == PlacementEnforcement.NONE` is True and it
#: is tempting to write the strings. `resolve_placement` compares with `is`,
#: so a string lands in the degradation branch and then raises AttributeError
#: reaching for `.value`. Recorded as finding E4-3: the TypeScript
#: `registerHost` takes plain strings for the same fields and the Python
#: mirror does not. The wire form written to disk is `.value` either way.
HOOKS: Tuple[CaptureHook, ...] = (
    CaptureHook.ARTIFACT_PRODUCED,
    CaptureHook.GRAPH_EXECUTE,
)

#: How the host's semantics reach the adapter: Blender's own scripting API,
#: read in-process. Not `filesystem-watch` -- that is how the GATE observes
#: bytes, which is a different question from where the meaning came from.
SURFACES: Tuple[SurfaceKind, ...] = (SurfaceKind.HOST_API_CALLBACK,)

#: The scene facts are read off the live datablocks at the moment the
#: generation is announced -- the state Blender was in as the prompt was
#: written -- not reconstructed afterwards from an output file.
FIDELITY = ObservationFidelity.AS_WRITTEN

#: See the module header. A zip in a user-writable directory, with nothing
#: enforcing where it runs. Declared == effective, and no gap to explain.
DECLARED_PLACEMENT = Placement.UNATTESTED_CLIENT
ENFORCEMENT = PlacementEnforcement.NONE

CAPABILITY_CLASSES: Tuple[str, ...] = ("authoring-application",)
CUSTODY_LOCUS = "tenant-custody"


def adapter_version() -> str:
    """This addon's version, from the same VERSION file the zip is cut from."""
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(os.path.dirname(here), "VERSION")
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = f.read().strip()
        if v:
            return v
    except OSError:
        pass
    return "0.0.0-unknown"


def host_version() -> str:
    """The Blender that declared itself, MEASURED from the running process.

    `scene.blender_version_string()` returns "unknown" outside Blender, and
    "unknown" is a non-empty string that `register_host` accepts. That is
    the right outcome for a headless test harness and the wrong one for a
    shipped leaf, so callers that care read `registration().host_version`
    and see it for what it is.
    """
    return _scene.blender_version_string()


def registration() -> HostRegistration:
    """The declaration this build of the addon makes about itself."""
    return HostRegistration(
        host=HOST_ID,
        host_version=host_version(),
        adapter=ADAPTER_ID,
        adapter_version=adapter_version(),
        evidence_type=EVIDENCE_TYPE,
        hooks=list(HOOKS),
        surfaces=list(SURFACES),
        fidelity=FIDELITY,
        declared_placement=DECLARED_PLACEMENT,
        enforcement=ENFORCEMENT,
        schema=EVIDENCE_SCHEMA,
        capability_classes=list(CAPABILITY_CLASSES),
        custody_locus=CUSTODY_LOCUS,
    )


def register():
    """Register through the SDK's own `register_host`, and return the entry.

    This is step 3 of HOST-HOOK.md's three, run inside Blender against the
    vendored mirror of the code the gate runs. It raises
    `HostRegistrationError` with the same code the gate would use, so a bad
    build is refused by itself before it is refused by anybody else.

    Idempotent within a process: the registry refuses a second registration
    of the same host id (`host_already_registered`), and an addon that is
    disabled and re-enabled would otherwise fail on the second enable. The
    identity is static, so reusing the existing entry cannot smuggle a
    different declaration in -- with one exception, which is honest to name:
    an addon UPGRADED in a live session keeps the entry the previous
    version registered until Blender restarts.
    """
    existing = lookup_host(HOST_ID)
    if existing is not None:
        return existing
    return register_host(registration())


def _wire(v: Any) -> Any:
    """An enum member as the string the JSON declaration carries."""
    return getattr(v, "value", v)


def declaration_document() -> Dict[str, Any]:
    """The declaration as the gate reads it off disk.

    ⚑ camelCase, because `scruple-host.json` is consumed by
    `app/comfy/hostAdapter.ts` and validated by the TypeScript
    `registerHost()`, whose interface is camelCase. The Python mirror is
    snake_case. The two names for one field is the seam between the
    languages and it is spelled out HERE, once, rather than being
    rediscovered by whoever writes the next host in Python.
    """
    r = registration()
    return {
        "host": r.host,
        "hostVersion": r.host_version,
        "adapter": r.adapter,
        "adapterVersion": r.adapter_version,
        "evidenceType": r.evidence_type,
        "hooks": [_wire(h) for h in r.hooks],
        "surfaces": [_wire(s) for s in r.surfaces],
        "fidelity": _wire(r.fidelity),
        "declaredPlacement": _wire(r.declared_placement),
        "enforcement": _wire(r.enforcement),
        "schema": json.loads(json.dumps(r.schema)),
        "capabilityClasses": list(r.capability_classes or ()),
        "custodyLocus": r.custody_locus,
    }


# ---- where the files go ---------------------------------------------------


def host_dir(explicit: Optional[str] = None) -> Optional[str]:
    """The announcement directory, or None.

    None is not an error: it is a standalone Blender with no Desktop
    Studio, which is a supported product and writes nothing.
    """
    if explicit:
        return explicit
    value = os.environ.get(HOST_DIR_ENV, "").strip()
    return value or None


def declaration_path(explicit: Optional[str] = None) -> Optional[str]:
    d = host_dir(explicit)
    return os.path.join(d, DECLARATION_FILE) if d else None


def announce_path(prompt_id: str, explicit: Optional[str] = None) -> Optional[str]:
    d = host_dir(explicit)
    if not d:
        return None
    # Basename only. The prompt id is chosen by the caller and
    # `announce/../../etc/passwd.json` is a path this must not be able to
    # name. `hostAdapter.ts` takes the same precaution on the read side;
    # both sides doing it is not redundancy, it is neither side relying on
    # the other's manners.
    safe = os.path.basename(str(prompt_id))
    return os.path.join(d, ANNOUNCE_DIR, f"{safe}.json")


# ---- the evidence ---------------------------------------------------------

_JSON_TYPES: Dict[str, Any] = {
    "string": str,
    "integer": int,
    "array": list,
}


def schema_problems(doc: Mapping[str, Any]) -> List[str]:
    """Check a document against the addon's OWN declared schema.

    Presence AND type, unlike `hostAdapterSink`'s check, which is presence
    only (finding E4-2). A required key whose value is None is a PROBLEM
    here and is not one there, which is the whole reason this function
    exists: the difference between announcing nothing and announcing that
    the camera was null is the difference between a leaf that says less and
    a leaf that says something false.
    """
    problems: List[str] = []
    props: Mapping[str, Any] = EVIDENCE_SCHEMA.get("properties", {})
    for key in EVIDENCE_SCHEMA["required"]:
        if key not in doc:
            problems.append(f"missing required field {key!r}")
        elif doc[key] is None:
            problems.append(f"required field {key!r} is null")
    for key, value in doc.items():
        spec = props.get(key)
        if spec is None or value is None:
            continue
        want = _JSON_TYPES.get(spec.get("type", ""))
        if want is None:
            continue
        # bool is a subclass of int in Python and is not an integer here.
        if want is int and isinstance(value, bool):
            problems.append(f"{key!r} is a bool, not an integer")
            continue
        if not isinstance(value, want):
            problems.append(
                f"{key!r} is {type(value).__name__}, not {spec['type']}"
            )
            continue
        if want is list:
            n = len(value)
            lo, hi = spec.get("minItems"), spec.get("maxItems")
            if lo is not None and n < lo:
                problems.append(f"{key!r} has {n} items, fewer than {lo}")
            if hi is not None and n > hi:
                problems.append(f"{key!r} has {n} items, more than {hi}")
            item = (spec.get("items") or {}).get("type")
            iwant = _JSON_TYPES.get(item or "")
            if iwant is not None:
                for i, elem in enumerate(value):
                    if iwant is int and isinstance(elem, bool):
                        problems.append(f"{key}[{i}] is a bool, not an integer")
                    elif not isinstance(elem, iwant):
                        problems.append(
                            f"{key}[{i}] is {type(elem).__name__}, not {item}"
                        )
    return problems


def build_evidence(scn: Any) -> Dict[str, Any]:
    """The scene facts, read off Blender.

    Every value here comes from a datablock. Nothing is defaulted, nothing
    is guessed from a filename, and a field Blender does not have is
    OMITTED rather than filled -- `adapter/scene.py`'s rule about MIME,
    applied to meaning. A key that is present in this document was read;
    that is the only reason it is here.
    """
    settings = _scene.read_render_settings(scn)
    render = getattr(scn, "render", None)
    doc: Dict[str, Any] = {
        "scene": getattr(scn, "name", None),
        "frame": _int_or_none(getattr(scn, "frame_current", None)),
        "camera": settings.get("camera"),
        "engine": settings.get("engine") or None,
        "file_format": _scene.render_file_format(scn) or None,
    }

    resolution = settings.get("resolution")
    if resolution is not None:
        x, y = _int_or_none(resolution[0]), _int_or_none(resolution[1])
        doc["resolution"] = [x, y] if x is not None and y is not None else None
    else:
        doc["resolution"] = None

    doc["resolution_percentage"] = _int_or_none(
        getattr(render, "resolution_percentage", None)
    )

    samples = settings.get("samples")
    if samples is not None:
        doc["samples"] = int(samples)

    document = _scene.document_name()
    if document:
        doc["document"] = document

    inventory = _scene.scene_inventory(scn)
    doc["object_count"] = int(inventory["object_count"])
    doc["material_count"] = int(inventory["material_count"])
    return doc


def _int_or_none(v: Any) -> Optional[int]:
    if v is None or isinstance(v, bool):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def current_scene() -> Any:
    try:
        import bpy
    except ImportError:
        return None
    return getattr(getattr(bpy, "context", None), "scene", None)


# ---- the two writes -------------------------------------------------------


def declare(explicit_dir: Optional[str] = None) -> Dict[str, Any]:
    """Write `scruple-host.json`, having first registered ourselves.

    Returns a result rather than raising, for the reason `hostAdapter.ts`
    returns one: a host integration that cannot be set up must not take
    the host down. Nothing here is on a path a user's render depends on.
    """
    path = declaration_path(explicit_dir)
    if path is None:
        return {
            "ok": False,
            "wrote": None,
            "reason": f"no {HOST_DIR_ENV} -- standalone Blender declares nothing",
        }
    try:
        entry = register()
    except HostRegistrationError as e:
        # OUR OWN DECLARATION IS BAD. It is not written. A gate that never
        # sees it runs at Level 1 with no refusal recorded, which is the
        # honest reading: this addon build never declared itself at all.
        _log.error(f"host declaration refused by our own registry ({e.code}): {e}")
        return {"ok": False, "wrote": None, "refused": e.code, "reason": str(e)}

    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.makedirs(os.path.join(os.path.dirname(path), ANNOUNCE_DIR), exist_ok=True)
    doc = declaration_document()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, sort_keys=True)
        f.write("\n")
    resolution = getattr(entry, "resolution", None)
    effective = getattr(resolution, "effective", None)
    effective = getattr(effective, "value", effective)
    _log.info(
        f"declared {doc['host']}@{doc['hostVersion']} adapter "
        f"{doc['adapter']}@{doc['adapterVersion']} in {path}"
    )
    return {
        "ok": True,
        "wrote": path,
        "host": doc["host"],
        "adapter": f"{doc['adapter']}@{doc['adapterVersion']}",
        "declaredPlacement": _wire(DECLARED_PLACEMENT),
        "effectivePlacement": effective,
    }


def announce(
    prompt_id: str,
    scn: Any = None,
    explicit_dir: Optional[str] = None,
    extra: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Write `announce/<prompt_id>.json` for one generation.

    ⚑ THE CORRELATION IS THE PROMPT ID AND THE HOST CHOOSES IT. ComfyUI's
    `server.py` does `prompt_id = str(json_data.get("prompt_id",
    uuid.uuid4()))`, so a bridge may mint one, announce against it, and
    submit under it. Choosing it grants nothing: the directory is named by
    the app's environment, an id nobody announced reads back as `declined`,
    and a document this function refused to write is not on disk to be
    read. The worst a wrong id can do is make a leaf say less.
    """
    path = announce_path(prompt_id, explicit_dir)
    if path is None:
        return {
            "ok": False,
            "wrote": None,
            "reason": f"no {HOST_DIR_ENV} -- standalone Blender announces nothing",
        }
    if scn is None:
        scn = current_scene()
    if scn is None:
        return {"ok": False, "wrote": None, "reason": "no scene to read"}

    doc = build_evidence(scn)
    if extra:
        doc.update(dict(extra))
    # Omit the keys that came back None. A key that is present was read;
    # `schema_problems` then reports the required ones as MISSING, which is
    # the same refusal by a clearer name than "null".
    doc = {k: v for k, v in doc.items() if v is not None}

    problems = schema_problems(doc)
    if problems:
        # NOTHING IS WRITTEN. See the module header: a document that fails
        # our own schema would be `declined` at the gate anyway, and the
        # presence-only check there (E4-2) means a null in a required field
        # would NOT be. Refusing here is the difference between a leaf that
        # says less and a leaf that says something false.
        _log.warn(
            f"refusing to announce {prompt_id}: " + "; ".join(problems)
        )
        return {"ok": False, "wrote": None, "problems": problems, "evidence": doc}

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, sort_keys=True)
        f.write("\n")
    _log.info(f"announced {prompt_id}: {len(doc)} field(s) → {path}")
    return {"ok": True, "wrote": path, "promptId": str(prompt_id), "evidence": doc}
