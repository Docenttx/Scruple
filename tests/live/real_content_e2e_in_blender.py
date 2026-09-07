"""WO-B6 — real content, end to end, from inside real Blender.

  blender --background --factory-startup --python tests/live/real_content_e2e_in_blender.py

Nothing here is simulated. Blender renders, saves and exports; the addon
witnesses what Blender wrote; the leaves land in a scratch witness; the
PNG bytes are then C2PA-signed against the CVM surrogate through the real
services/c2pa-signer pipeline; and every claim below is re-derived from a
side effect somebody else can go and look at:

  * the artifact is on disk and its bytes are re-hashed HERE, in this
    process, and compared to the `content_hash` the leaf recorded;
  * the receipt is fetched from /api/v2/receipt/{leaf_id};
  * the leaf is read out of BOTH databases -- the app's `iterations` and
    the witness server's `witnesses`;
  * the ECDSA signature the receipt discloses is CHECKED here against the
    key the receipt names, by the addon's own `assurance.check_signature`;
  * the C2PA credential is read back with `c2pa.Reader` and its
    validation_state recorded.

THE ASSURANCE TIER IS THE THING BEING MEASURED. Every leaf in this run is
signed by the CVM surrogate, which reports `protectionMode: SOFTWARE`
truthfully. The honest tier is therefore `passthrough (software-signed)`
and never `verified`: Blender declares no attestation provider, so the
first half of `verified` is unreachable here no matter how good the
signature is. A run that produced `verified` would be the exact
dishonesty the L2 floor exists to prevent, and `checks` below asserts it
did not.

TWO PHASES, AND THE DIFFERENCE BETWEEN THEM IS ONE ENVIRONMENT VARIABLE.
`SCRUPLE_WITNESS_PUBLIC_URL` on the app decides whether a receipt
publishes an address for the verifying key. Unset, the client holds a
signature it cannot check and must say so; set, it checks it. Run this
file once against each configuration and the two evidence files show a
deployment knob moving the honesty of every leaf.

Environment:
  SCRUPLE_APP_URL       http://127.0.0.1:3902     (never :3001, never :5799)
  SCRUPLE_B6_API_KEY    a key with witness:write + mark:write
  SCRUPLE_B6_BASE       scratch dir for renders and evidence
  SCRUPLE_B6_PHASE      a label; artifacts and evidence are named by it
  SCRUPLE_SCRATCH_DB    the app's sqlite file
  SCRUPLE_WITNESS_DB    the witness server's sqlite file
  SCRUPLE_CVM_SURROGATE http://127.0.0.1:8799
"""

import hashlib
import json
import os
import subprocess
import sys
import traceback
import zipfile

PHASE = os.environ.get("SCRUPLE_B6_PHASE", "default")
BASE = os.environ.get("SCRUPLE_B6_BASE", "/mnt/corpus/scruple-blender-l2/b6")
ZIP = os.environ.get("SCRUPLE_B6_ZIP", "/data/scruple-blender/dist/scruple-blender-0.1.0.zip")
APP = os.environ.get("SCRUPLE_APP_URL", "http://127.0.0.1:3902")
KEY = os.environ.get("SCRUPLE_B6_API_KEY", "")
APP_DB = os.environ.get("SCRUPLE_SCRATCH_DB", "/mnt/corpus/scruple-blender-l2/scruple-scratch.db")
WIT_DB = os.environ.get("SCRUPLE_WITNESS_DB", "/mnt/corpus/scruple-blender-l2/witness-scratch.db")
SURROGATE = os.environ.get("SCRUPLE_CVM_SURROGATE", "http://127.0.0.1:8799")
SIGNER_DIR = os.environ.get("SCRUPLE_C2PA_SIGNER_DIR", "/data/scruple-web/services/c2pa-signer")
CERT_DIR = os.path.join(BASE, "certs")

# THE SANDBOX RULE, ENFORCED RATHER THAN DOCUMENTED. :5799 is the
# production witness and a live audit log; :3001 is scruple.stooges.ai.
assert "5799" not in APP and ":3001" not in APP, f"refusing to run against {APP}"
assert "5799" not in SURROGATE, "refusing to point the signer at production"

WORK = os.path.join(BASE, PHASE)
DEST = os.path.join(WORK, "addons")
OUT = os.path.join(BASE, f"{PHASE}-evidence.json")

import sqlite3  # noqa: E402

report = {
    "phase": PHASE,
    "app": APP,
    "python": sys.version.split()[0],
    "leaves": [],
    "c2pa": [],
    "checks": {},
    "controls": {},
}

import bpy  # noqa: E402

report["blender"] = ".".join(str(v) for v in bpy.app.version)

os.makedirs(DEST, exist_ok=True)
with zipfile.ZipFile(ZIP) as z:
    z.extractall(DEST)
sys.path.insert(0, DEST)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def app_row(leaf_id):
    con = sqlite3.connect(f"file:{APP_DB}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT id, leaf_hash, output_hash, output_content_type, witnessed, leaf_scheme,"
            "       canonicalization_profile, workflow_hash, platform_attestation_status,"
            "       leaf_signature, leaf_signer_key_id, leaf_signature_alg,"
            "       leaf_signer_surrogate, leaf_signature_state,"
            "       modalities_requested, modalities_applied, modalities_outstanding"
            "  FROM iterations WHERE id = ?", (int(leaf_id),)).fetchone()
    finally:
        con.close()
    if not row:
        return None
    keys = ("id", "leaf_hash", "output_hash", "output_content_type", "witnessed", "leaf_scheme",
            "canonicalization_profile", "workflow_hash", "platform_attestation_status",
            "leaf_signature", "leaf_signer_key_id", "leaf_signature_alg",
            "leaf_signer_surrogate", "leaf_signature_state",
            "modalities_requested", "modalities_applied", "modalities_outstanding")
    return dict(zip(keys, row))


def witness_row(leaf_hash):
    """The witness server's own record. It is the ORIGIN of the signature
    the app tier now stores, so comparing the two is how a copied field is
    told from a fabricated one."""
    con = sqlite3.connect(f"file:{WIT_DB}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT leaf_hash, leaf_signature, leaf_signer_key_id, leaf_signature_alg,"
            "       leaf_signer_surrogate FROM witnesses WHERE leaf_hash = ?", (leaf_hash,)).fetchone()
    finally:
        con.close()
    if not row:
        return None
    return dict(zip(("leaf_hash", "leaf_signature", "leaf_signer_key_id",
                     "leaf_signature_alg", "leaf_signer_surrogate"), row))


# ── the content ──────────────────────────────────────────────────────────
#
# Distinct in geometry, sample count, resolution AND file format, so the
# leaves are different content and not one file witnessed N times. The
# JPEG is there to put a second MIME through the same path: `mime` is
# declared, never sniffed, and a run that only ever declared image/png
# would not have exercised the declaration.

RENDERS = [
    ("torus",  dict(samples=6, res=(160, 120), primitive="primitive_torus_add",     fmt="PNG")),
    ("monkey", dict(samples=4, res=(200, 150), primitive="primitive_monkey_add",    fmt="PNG")),
    ("cone",   dict(samples=8, res=(128, 128), primitive="primitive_cone_add",      fmt="PNG")),
    ("sphere", dict(samples=5, res=(192, 144), primitive="primitive_ico_sphere_add", fmt="JPEG")),
]


def build_scene(primitive, *, samples, res, fmt, name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.image_settings.file_format = fmt
    sc.render.filepath = os.path.join(WORK, name)
    getattr(bpy.ops.mesh, primitive)(location=(0, 0, 0))
    bpy.ops.object.camera_add(location=(4, -4, 3), rotation=(1.1, 0, 0.8))
    sc.camera = bpy.context.object
    bpy.ops.object.light_add(type="SUN", location=(3, -3, 6))
    return sc


def render(name, *, samples, res, primitive, fmt):
    sc = build_scene(primitive, samples=samples, res=res, fmt=fmt, name=name)
    bpy.ops.render.render(write_still=True)
    return sc, sc.render.filepath + sc.render.file_extension


def c2pa_sign_against_surrogate(asset, out, *, mime, title, leaf):
    """Sign `asset` through services/c2pa-signer, keyed by the surrogate.

    THE SUBPROCESS IS THE POINT. lib/c2pa/signAsset.ts spawns exactly this
    script with exactly this job spec, so what runs here is the production
    signing path and not a lookalike built for the report. The only thing
    that differs is `SCRUPLE_C2PA_KMS_ENDPOINT`, which selects the
    kms-http key mode -- the private key stays inside the surrogate
    process and this one never sees it.

    THE ASSERTION RECORDS WHAT PROTECTED THE KEY, AND IT SAYS SOFTWARE.
    `surrogate_cert.py` read `protectionMode` off the surrogate's own key
    metadata; it is carried into the signed manifest verbatim. A C2PA
    credential that omitted it would be a third-party-verifiable document
    that is silent on the one fact that decides what it is worth.
    """
    with open(os.path.join(CERT_DIR, "chain-info.json")) as f:
        cert_info = json.load(f)

    job = {
        "asset_path": asset,
        "output_path": out,
        "cert_path": os.path.join(CERT_DIR, "surrogate-chain.pem"),
        "manifest": {
            "claim_generator": "Scruple-Blender/0.1",
            "format": mime,
            "title": title,
            "assertions": [{
                "label": "ai.scruple.provenance",
                "data": {
                    "leaf_id": leaf["leaf_id"],
                    "leaf_hash": leaf["leaf_hash"],
                    "content_hash": leaf["content_hash"],
                    "baseline_ref": leaf["baseline_ref"],
                    "assurance_tier": leaf["assurance_tier"],
                    "signer_key_ocid": cert_info["key_ocid"],
                    "signer_protection_mode": cert_info["surrogate_protection_mode"],
                    "hardware_backed": cert_info["hardware_backed"],
                    "note": cert_info["hardware_backed_basis"],
                },
            }],
        },
        # Blender runs no inference. DIGITAL_CREATION, never
        # TRAINED_ALGORITHMIC_MEDIA -- sign.py refuses to guess and this is
        # why (sign.py's module docstring).
        "intent": "CREATE",
        "digital_source_type": "DIGITAL_CREATION",
    }
    env = dict(os.environ)
    env.update({
        "SCRUPLE_C2PA_DEV": "1",
        "SCRUPLE_C2PA_VAULT_KEY_OCID": cert_info["key_ocid"],
        "SCRUPLE_C2PA_KMS_ENDPOINT": SURROGATE,
    })
    proc = subprocess.run(
        [sys.executable if "blender" not in sys.executable.lower() else "/usr/bin/python3",
         os.path.join(SIGNER_DIR, "sign.py")],
        input=json.dumps(job), capture_output=True, text=True, env=env, cwd=SIGNER_DIR,
    )
    try:
        result = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        return {"ok": False, "error": f"signer produced no JSON: {proc.stdout[-400:]} / {proc.stderr[-400:]}"}
    return result


def c2pa_read(path, mime):
    """Read the credential back with c2pa.Reader, out of process.

    Out of process because Blender's interpreter is not where the c2pa
    native library is installed, and because a verifier is a different
    program from a signer -- reading back in the process that just signed
    would prove less.
    """
    code = (
        "import sys,json,c2pa\n"
        "d=json.loads(c2pa.Reader(sys.argv[2],open(sys.argv[1],'rb')).json())\n"
        "m=d['manifests'][d['active_manifest']]\n"
        "print(json.dumps({'validation_state':d.get('validation_state'),"
        "'signature_info':m.get('signature_info'),"
        "'assertions':m.get('assertions')}))\n"
    )
    proc = subprocess.run(["/usr/bin/python3", "-c", code, path, mime],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        return {"validation_state": None, "error": proc.stderr.strip().splitlines()[-1] if proc.stderr else "?"}
    return json.loads(proc.stdout)


try:
    import scruple_blender  # noqa: F401
    from adapter import assurance as a_assurance, flow as a_flow, sdk as a_sdk, state as a_state

    report["sdk_is_vendored"] = a_sdk.sdk_is_vendored()
    report["vendor_commit"] = a_sdk.vendored_sdk_info().get("source_commit", "")[:12]

    client = a_sdk.new_client(base_url=APP, api_key=KEY, cache_dir=os.path.join(WORK, "home"))
    a_sdk.set_client(client, key=(APP, KEY))

    attached = a_flow.ensure_attached(client)
    report["checks"]["baseline_established"] = bool(attached)
    report["baseline_ref"] = client.state.baseline_ref

    def record(rec, artifact):
        on_disk = sha256_file(artifact)
        e = rec.to_dict()
        e["artifact"] = artifact
        e["artifact_bytes"] = os.path.getsize(artifact)
        e["sha256_of_bytes_on_disk"] = on_disk
        e["artifact_exists"] = os.path.exists(artifact)
        e["content_hash_matches_bytes"] = rec.content_hash == on_disk
        e["app_row"] = app_row(rec.leaf_id) if rec.leaf_id else None
        e["witness_row"] = witness_row(rec.leaf_hash) if rec.leaf_hash else None
        # A field the app tier COPIED is told from one it invented by
        # asking the tier it was copied from.
        wr, ar = e["witness_row"] or {}, e["app_row"] or {}
        e["app_signature_equals_witness_signature"] = (
            bool(wr.get("leaf_signature")) and wr.get("leaf_signature") == ar.get("leaf_signature")
        )
        report["leaves"].append(e)
        return e

    # ---- 4 distinct renders ------------------------------------------
    for name, kw in RENDERS:
        sc, path = render(name, **kw)
        a_flow.witness_render(client, sc, trigger="headless")
        rec = a_flow.resolve_assurance(client, a_state.last_assurance())
        record(rec, path)

    # ---- a real .blend save ------------------------------------------
    blend = os.path.join(WORK, "b6-scene.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    a_flow.witness_save(client, bpy.context.scene, blend, trigger="headless_save")
    record(a_flow.resolve_assurance(client, a_state.last_assurance()), blend)

    # ---- two real exports, two declared MIMEs ------------------------
    obj = os.path.join(WORK, "b6-scene.obj")
    bpy.ops.export_scene.obj(filepath=obj, use_selection=False)
    a_flow.witness_export(client, bpy.context.scene, obj, "obj", trigger="headless_export")
    record(a_flow.resolve_assurance(client, a_state.last_assurance()), obj)

    stl = os.path.join(WORK, "b6-scene.stl")
    bpy.ops.export_mesh.stl(filepath=stl, use_selection=False)
    a_flow.witness_export(client, bpy.context.scene, stl, "stl", trigger="headless_export")
    record(a_flow.resolve_assurance(client, a_state.last_assurance()), stl)

    # ---- C2PA, against the surrogate ---------------------------------
    for e in report["leaves"]:
        if e["mime"] not in ("image/png", "image/jpeg") or e["state"] != "witnessed":
            continue
        out = e["artifact"] + ".c2pa" + os.path.splitext(e["artifact"])[1]
        signed = c2pa_sign_against_surrogate(
            e["artifact"], out, mime=e["mime"],
            title=os.path.basename(e["artifact"]), leaf=e,
        )
        entry = {
            "source_artifact": e["artifact"],
            "leaf_id": e["leaf_id"],
            "signed": signed.get("ok", False),
            "signing_mode": signed.get("signing_mode"),
            "signer_identity": signed.get("signer_identity"),
            "error": signed.get("error"),
        }
        if signed.get("ok"):
            entry["output"] = out
            entry["output_bytes"] = os.path.getsize(out)
            entry["output_sha256"] = sha256_file(out)
            # The credential changed the bytes -- that is what embedding a
            # manifest does -- so the signed file is NOT the witnessed
            # file, and saying so keeps the two hashes from being read as
            # one broken one.
            entry["differs_from_witnessed_bytes"] = entry["output_sha256"] != e["sha256_of_bytes_on_disk"]
            entry["readback"] = c2pa_read(out, e["mime"])
        report["c2pa"].append(entry)

    # ---- the addon's OWN c2pa control, through the product path -------
    #
    # What a user pressing the button gets today. Recorded verbatim, next
    # to a run in which the same key signed a real credential, so the two
    # can be read against each other.
    first = next((e for e in report["leaves"] if e["state"] == "witnessed"), None)
    if first:
        outcome = client.mark(leaf_id=first["leaf_id"], mime=first["mime"], modalities=["c2pa"])
        report["mark_c2pa_through_the_product_path"] = {
            "leaf_id": first["leaf_id"],
            "modalities_applied": list(outcome.modalities_applied or ()),
            "outstanding": [{"modality": o.modality, "reason": o.reason} for o in (outcome.outstanding or ())],
            "surrogate_was_reachable": True,
        }

    # ── CONTROLS ──────────────────────────────────────────────────────
    witnessed = [e for e in report["leaves"] if e["state"] == "witnessed"]

    # C-1. One pixel of a witnessed render, changed with Blender's own
    # image API. /api/v2/verify must NOT find it.
    src = next(e for e in witnessed if e["mime"] == "image/png")
    img = bpy.data.images.load(src["artifact"])
    px = list(img.pixels)
    idx = (len(px) // 8) * 4
    px[idx] = 1.0 - px[idx]
    img.pixels = px
    altered = os.path.join(WORK, "altered-one-pixel.png")
    img.filepath_raw = altered
    img.file_format = "PNG"
    img.save()
    altered_hash = sha256_file(altered)
    good_v = a_flow.verify_content(client, src["content_hash"])
    bad_v = a_flow.verify_content(client, altered_hash)
    report["controls"]["one_pixel_altered"] = {
        "original": src["artifact"], "original_hash": src["content_hash"],
        "altered": altered, "altered_hash": altered_hash,
        "hashes_differ": altered_hash != src["content_hash"],
        "original_found": bool(good_v and good_v.get("found")),
        "altered_found": bool(bad_v and bad_v.get("found")),
    }
    report["checks"]["C1_original_verifies"] = report["controls"]["one_pixel_altered"]["original_found"]
    report["checks"]["C1_altered_does_NOT_verify"] = not report["controls"]["one_pixel_altered"]["altered_found"]

    # C-2. A signature check that must FAIL. The same leaf, the same
    # published key, one byte of the DER flipped. Run through the addon's
    # own check_signature, so a green check above cannot be a check that
    # returns True regardless.
    import base64
    from dataclasses import replace as _replace
    checkable = next((e for e in witnessed if e["signature"].get("leaf_signature")), None)
    if checkable:
        raw = bytearray(base64.b64decode(checkable["signature"]["leaf_signature"]))
        raw[-1] ^= 0x01
        rec = a_assurance.LeafAssurance(
            state=a_assurance.WITNESSED, kind="artifact", mime=checkable["mime"],
            leaf_id=checkable["leaf_id"], leaf_hash=checkable["leaf_hash"],
            signature=a_assurance.SignatureRecord(
                leaf_signature=base64.b64encode(bytes(raw)).decode(),
                leaf_signer_key_id=checkable["signature"]["leaf_signer_key_id"],
                leaf_signature_alg=checkable["signature"]["leaf_signature_alg"],
                signer_surrogate=checkable["signature"]["signer_surrogate"],
                state="signed", key_protection=checkable["signature"]["key_protection"],
                verification=checkable["signature"]["verification"],
                source=a_assurance.FROM_RECEIPT,
            ),
        )
        tampered = a_assurance.check_signature(rec, fetch_key=client.published_key)
        good_checked = checkable["signature"]["checked_ok"]
        report["controls"]["tampered_signature"] = {
            "leaf_id": checkable["leaf_id"],
            "good_checked_ok": good_checked,
            "tampered_checked_ok": tampered.signature.checked_ok,
            "tampered_tier": tampered.assurance_tier,
            "note": tampered.signature.check_note,
        }
        if good_checked is None:
            # THE CHECK COULD NOT RUN AT ALL IN THIS PHASE, and asserting
            # `rejected` here would be asserting that a check which never
            # happened came out the right way. The correct control for a
            # deployment that publishes no key address is that BOTH the
            # good and the tampered signature come back `not checked` --
            # a client that reported the tampered one as rejected without
            # fetching a key would be guessing.
            report["checks"]["C2_no_key_address_means_neither_is_checked"] = (
                tampered.signature.checked_ok is None
                and tampered.signature.check_note == a_assurance.NO_KEY_ADDRESS
            )
            report["controls"]["tampered_signature"]["why_not_rejected"] = (
                "this phase publishes no verifying-key address, so nothing was checked"
            )
        else:
            report["checks"]["C2_a_tampered_signature_is_rejected"] = (
                tampered.signature.checked_ok is False
            )
    else:
        report["controls"]["tampered_signature"] = {
            "skipped": "no leaf disclosed a signature to tamper with"}

    # C-3. A C2PA credential whose bytes were altered after signing must
    # NOT read back Valid.
    signed_ok = next((c for c in report["c2pa"] if c.get("signed")), None)
    if signed_ok:
        blob = bytearray(open(signed_ok["output"], "rb").read())
        # Flip a byte deep in the image data, past the manifest.
        blob[int(len(blob) * 0.9)] ^= 0xFF
        tam = os.path.join(WORK, "c2pa-tampered" + os.path.splitext(signed_ok["output"])[1])
        open(tam, "wb").write(bytes(blob))
        mime = next(e["mime"] for e in report["leaves"] if e["leaf_id"] == signed_ok["leaf_id"])
        report["controls"]["tampered_c2pa"] = {
            "signed": signed_ok["output"],
            "signed_validation_state": signed_ok["readback"].get("validation_state"),
            "tampered": tam,
            "tampered_validation_state": c2pa_read(tam, mime).get("validation_state"),
        }
        c = report["controls"]["tampered_c2pa"]
        report["checks"]["C3_signed_credential_is_Valid"] = c["signed_validation_state"] == "Valid"
        report["checks"]["C3_tampered_credential_is_NOT_Valid"] = c["tampered_validation_state"] != "Valid"

    # C-4. The surrogate's cert cannot be used with the LOCAL key. If it
    # could, "signed against the surrogate" would be unfalsifiable -- the
    # cert would vouch for whatever signed.
    probe_src = signed_ok["source_artifact"] if signed_ok else src["artifact"]
    wrong = subprocess.run(
        ["/usr/bin/python3", os.path.join(SIGNER_DIR, "sign.py")],
        input=json.dumps({
            "asset_path": probe_src,
            "output_path": os.path.join(WORK, "wrong-key.png"),
            "cert_path": os.path.join(CERT_DIR, "surrogate-chain.pem"),
            "key_path": os.path.join(SIGNER_DIR, "keys", "signer.key"),
            "manifest": {"claim_generator": "control", "format": "image/png",
                         "title": "control", "assertions": []},
            "intent": "CREATE", "digital_source_type": "DIGITAL_CREATION",
        }),
        capture_output=True, text=True, cwd=SIGNER_DIR,
        env={**os.environ, "SCRUPLE_C2PA_DEV": "1",
             "SCRUPLE_C2PA_VAULT_KEY_OCID": "", "SCRUPLE_C2PA_KMS_ENDPOINT": ""},
    )
    try:
        wrong_result = json.loads(wrong.stdout.strip().splitlines()[-1])
    except Exception:
        wrong_result = {"ok": None, "error": wrong.stdout[-300:] + wrong.stderr[-300:]}
    # THE CONTROL IS THE READBACK, NOT THE SIGNER'S RETURN CODE, and the
    # difference is a finding rather than a detail.
    #
    # sign.py reports ok:true here. It is running with SCRUPLE_C2PA_DEV=1,
    # which sets `verify.verify_after_sign: False`, so nothing checks that
    # the certificate's public key is the one that signed -- the signer
    # emits a credential no verifier will accept and calls it a success.
    # c2pa.Reader then answers Invalid, which is what makes "signed against
    # the surrogate" a falsifiable claim: swap the key and every C2PA tool
    # in the world rejects the asset.
    wrong_out = os.path.join(WORK, "wrong-key.png")
    wrong_readback = c2pa_read(wrong_out, "image/png") if os.path.exists(wrong_out) else {}
    report["controls"]["surrogate_cert_with_local_key"] = {
        "signer_result": wrong_result,
        "signer_reported_ok": wrong_result.get("ok"),
        "readback_validation_state": wrong_readback.get("validation_state"),
        "finding": (
            "the signer returned ok:true for a credential whose certificate does not "
            "bind the key that signed it. verify_after_sign is off under "
            "SCRUPLE_C2PA_DEV=1, so the mismatch is caught only by the reader."
        ),
    }
    report["checks"]["C4_the_wrong_key_does_NOT_read_back_as_Valid"] = (
        wrong_readback.get("validation_state") not in (None, "Valid")
    )

    # ── THE GATE ──────────────────────────────────────────────────────
    distinct_renders = {e["sha256_of_bytes_on_disk"] for e in report["leaves"][:4]}
    report["checks"]["at_least_5_leaves"] = len(witnessed) >= 5
    report["checks"]["at_least_3_distinct_renders"] = len(distinct_renders) >= 3
    report["checks"]["every_artifact_exists_on_disk"] = all(e["artifact_exists"] for e in report["leaves"])
    report["checks"]["every_content_hash_matches_the_bytes"] = all(
        e["content_hash_matches_bytes"] for e in witnessed)
    report["checks"]["every_receipt_fetched"] = all(
        e["signature"]["source"] != a_assurance.NOT_DISCLOSED for e in witnessed)
    report["checks"]["every_leaf_in_the_app_db"] = all(e["app_row"] for e in witnessed)
    report["checks"]["every_leaf_in_the_witness_db"] = all(e["witness_row"] for e in witnessed)
    report["checks"]["the_app_copied_the_witness_signature"] = all(
        e["app_signature_equals_witness_signature"] for e in witnessed)

    # THE HONESTY GATES. What no leaf may claim.
    report["checks"]["no_leaf_claims_verified"] = all(
        e["assurance_tier"] != "verified" for e in report["leaves"])
    report["checks"]["no_leaf_claims_hardware_backing"] = all(
        e["signature"].get("key_protection") in (None, "software", "unknown") for e in witnessed)
    report["checks"]["every_signed_leaf_is_marked_software"] = all(
        e["signature"]["key_protection"] == "software"
        for e in witnessed if e["signature"].get("leaf_signature"))
    report["checks"]["no_leaf_failed_its_signature_check"] = all(
        e["signature"]["checked_ok"] is not False for e in witnessed)
    report["checks"]["every_c2pa_signature_used_the_surrogate"] = all(
        c.get("signing_mode") == "kms-http" and "surrogate=true" in (c.get("signer_identity") or "")
        for c in report["c2pa"] if c.get("signed"))

    report["tiers"] = sorted({e["assurance_tier"] for e in report["leaves"]})
    report["ok"] = True
except Exception as e:
    report["ok"] = False
    report["error"] = f"{type(e).__name__}: {e}"
    report["traceback"] = traceback.format_exc()

with open(OUT, "w") as f:
    json.dump(report, f, indent=2)

# ── the table ────────────────────────────────────────────────────────────
COLS = ("leaf", "kind", "mime", "artifact", "bytes", "rehash==content_hash",
        "receipt", "sig", "checked", "tier")
rows = []
for e in report["leaves"]:
    sig = e["signature"]
    rows.append((
        str(e["leaf_id"] or "-"),
        e["kind"],
        (e["mime"] or "-").replace("application/", "app/"),
        os.path.basename(e["artifact"]),
        str(e["artifact_bytes"]),
        "YES" if e["content_hash_matches_bytes"] else "NO",
        "yes" if sig["source"] != "not_disclosed" else "no",
        (sig.get("state") or "-"),
        {True: "verified here", False: "REJECTED", None: "not checked"}[sig.get("checked_ok")],
        e["assurance_tier"],
    ))
widths = [max(len(c), *(len(r[i]) for r in rows)) if rows else len(c) for i, c in enumerate(COLS)]
line = "  ".join(c.ljust(w) for c, w in zip(COLS, widths))
print("\n[B6] " + line)
print("[B6] " + "  ".join("-" * w for w in widths))
for r in rows:
    print("[B6] " + "  ".join(v.ljust(w) for v, w in zip(r, widths)))

print("\n[B6] C2PA against the surrogate")
for c in report["c2pa"]:
    print(f"[B6]   leaf {c['leaf_id']}: signed={c['signed']} mode={c.get('signing_mode')} "
          f"validation={(c.get('readback') or {}).get('validation_state')} "
          f"identity={c.get('signer_identity')}{' err=' + str(c.get('error')) if c.get('error') else ''}")

print("\n[B6] checks")
for k, v in report["checks"].items():
    print(f"[B6]   {'PASS' if v is True else 'FAIL'}  {k} = {v}")

failed = [k for k, v in report.get("checks", {}).items() if v is not True]
if not report.get("ok") or failed:
    print("\n[B6] FAILED: " + (", ".join(failed) if failed else report.get("error", "")))
    print(report.get("traceback", ""))
    print("[B6] evidence at " + OUT)
    sys.exit(1)
print("\n[B6] ALL CHECKS PASSED — evidence at " + OUT)
