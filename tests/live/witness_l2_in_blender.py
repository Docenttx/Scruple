"""WO-B3, driven against the real stack from inside real Blender.

  blender --background --factory-startup --python tests/live/witness_l2_in_blender.py

Everything here is a side effect somebody else can check:

  * three DISTINCT Cycles renders and one .blend save, produced here;
  * each witnessed through `adapter.flow` -> the vendored SDK ->
    POST /api/v2/witness on the scratch app;
  * each leaf's `content_hash` re-hashed from the bytes on disk, in this
    process and again from the shell;
  * each leaf looked up in BOTH databases -- the app's `iterations` and
    the witness server's `witnesses` -- so the H-1 fields the app drops
    can be shown to exist on the other side of the wire;
  * the receipt fetched from /api/v2/receipt/{leaf_id} and the check run
    through /api/v2/verify/{content_hash};
  * and the CONTROL: one pixel of a witnessed render is changed with
    Blender's own image API, the altered file is re-hashed, and
    /api/v2/verify is asked about it. It must answer found=false. A run
    where the control also verifies proves nothing.

Environment (the sandbox the runner sets up; production is never
touched):
  SCRUPLE_APP_URL          http://127.0.0.1:3902
  SCRUPLE_B3_API_KEY       a key on the scratch app with witness:write
  SCRUPLE_B3_BASE          scratch directory for renders and the report
  SCRUPLE_SCRATCH_DB       the app's sqlite file
  SCRUPLE_WITNESS_DB       the witness server's sqlite file
"""
import hashlib, json, os, sqlite3, sys, traceback, zipfile

BASE = os.environ.get("SCRUPLE_B3_BASE", "/mnt/corpus/scruple-blender-l2/b3")
ZIP = os.environ.get("SCRUPLE_B3_ZIP", "/data/scruple-blender/dist/scruple-blender-0.1.0.zip")
APP = os.environ.get("SCRUPLE_APP_URL", "http://127.0.0.1:3902")
KEY = os.environ.get("SCRUPLE_B3_API_KEY", "")
APP_DB = os.environ.get("SCRUPLE_SCRATCH_DB", "/mnt/corpus/scruple-blender-l2/scruple-scratch.db")
WIT_DB = os.environ.get("SCRUPLE_WITNESS_DB", "/mnt/corpus/scruple-blender-l2/witness-scratch.db")
DEST = os.path.join(BASE, "addons")
OUT = os.path.join(BASE, "l2-evidence.json")

assert "5799" not in APP and ":3001" not in APP, "refusing to run against production"

report = {"app": APP, "python": sys.version.split()[0], "leaves": [], "checks": {}}
import bpy
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
    """What the APP tier stored. Note the columns it does not have."""
    con = sqlite3.connect(f"file:{APP_DB}?mode=ro", uri=True)
    try:
        cols = [r[1] for r in con.execute("PRAGMA table_info(iterations)")]
        row = con.execute(
            "SELECT id, leaf_hash, output_hash, output_content_type, witnessed, leaf_scheme,"
            "       witness_signature, canonicalization_profile, workflow_hash,"
            "       machine_manifest_hash, platform_attestation_status, seal_state, mime_declared"
            "  FROM iterations WHERE id = ?", (int(leaf_id),)).fetchone()
    finally:
        con.close()
    if not row:
        return None
    keys = ("id", "leaf_hash", "output_hash", "output_content_type", "witnessed", "leaf_scheme",
            "witness_signature", "canonicalization_profile", "workflow_hash",
            "machine_manifest_hash", "platform_attestation_status", "seal_state", "mime_declared")
    d = dict(zip(keys, row))
    d["_has_leaf_signature_column"] = "leaf_signature" in cols
    return d


def witness_row(leaf_hash):
    """What the WITNESS SERVER stored for the same leaf. This is where
    the H-1 triple lives, and the app tier never asks for it."""
    con = sqlite3.connect(f"file:{WIT_DB}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT leaf_hash, leaf_signature, leaf_signer_key_id, leaf_signature_alg,"
            "       leaf_signer_surrogate, signature"
            "  FROM witnesses WHERE leaf_hash = ?", (leaf_hash,)).fetchone()
    finally:
        con.close()
    if not row:
        return None
    return dict(zip(("leaf_hash", "leaf_signature", "leaf_signer_key_id", "leaf_signature_alg",
                     "leaf_signer_surrogate", "hmac_signature"), row))


def render(name, *, samples, res, primitive):
    """A DISTINCT render: different geometry, samples and resolution, so
    three leaves are three different content hashes and not one file
    witnessed three times."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.image_settings.file_format = "PNG"
    out = os.path.join(BASE, name)
    sc.render.filepath = out
    getattr(bpy.ops.mesh, primitive)(location=(0, 0, 0))
    bpy.ops.object.camera_add(location=(4, -4, 3), rotation=(1.1, 0, 0.8))
    sc.camera = bpy.context.object
    bpy.ops.object.light_add(type="SUN", location=(3, -3, 6))
    bpy.ops.render.render(write_still=True)
    return sc, out + ".png"


try:
    import scruple_blender  # noqa: F401  (sets up the addon's sys.path)
    import adapter
    from adapter import assurance as a_assurance, flow as a_flow, scene as a_scene, sdk as a_sdk, state as a_state

    report["sdk_is_vendored"] = a_sdk.sdk_is_vendored()
    report["vendor_commit"] = a_sdk.vendored_sdk_info().get("source_commit", "")[:12]
    report["client_canonicalization_profile"] = a_assurance.CLIENT_CANONICALIZATION_PROFILE

    client = a_sdk.new_client(base_url=APP, api_key=KEY, cache_dir=os.path.join(BASE, "home"))
    a_sdk.set_client(client, key=(APP, KEY))

    # D-3: a baseline over the INSTALLED zip's own bytes, before anything
    # is witnessed. witness() refuses client-side without one.
    attached = a_flow.ensure_attached(client)
    report["checks"]["baseline_established"] = bool(attached)
    report["baseline_ref"] = client.state.baseline_ref
    report["tamper_surface_hash"] = client.state.tamper_surface_hash
    report["checks"]["baseline_is_the_measured_surface"] = (
        client.state.baseline_ref == client.state.tamper_surface_hash)

    RENDERS = [
        ("torus", dict(samples=6, res=(160, 120), primitive="primitive_torus_add")),
        ("monkey", dict(samples=4, res=(200, 150), primitive="primitive_monkey_add")),
        ("cone", dict(samples=8, res=(128, 128), primitive="primitive_cone_add")),
    ]

    first_png = None
    for name, kw in RENDERS:
        sc, png = render(name, **kw)
        a_flow.witness_render(client, sc, trigger="headless")
        rec = a_flow.resolve_assurance(client, a_state.last_assurance())
        on_disk = sha256_file(png)
        entry = rec.to_dict()
        entry["artifact"] = png
        entry["artifact_bytes"] = os.path.getsize(png)
        entry["sha256_of_bytes_on_disk"] = on_disk
        entry["content_hash_matches_bytes"] = rec.content_hash == on_disk
        entry["app_row"] = app_row(rec.leaf_id) if rec.leaf_id else None
        entry["witness_row"] = witness_row(rec.leaf_hash) if rec.leaf_hash else None
        report["leaves"].append(entry)
        if first_png is None:
            first_png = (png, rec)

    # A real .blend save, through the save path (leaf kind document_save).
    blend = os.path.join(BASE, "l2-scene.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    a_flow.witness_save(client, bpy.context.scene, blend, trigger="headless_save")
    rec = a_flow.resolve_assurance(client, a_state.last_assurance())
    entry = rec.to_dict()
    entry["artifact"] = blend
    entry["artifact_bytes"] = os.path.getsize(blend)
    entry["sha256_of_bytes_on_disk"] = sha256_file(blend)
    entry["content_hash_matches_bytes"] = rec.content_hash == entry["sha256_of_bytes_on_disk"]
    entry["app_row"] = app_row(rec.leaf_id) if rec.leaf_id else None
    entry["witness_row"] = witness_row(rec.leaf_hash) if rec.leaf_hash else None
    report["leaves"].append(entry)

    # ---- THE CONTROL -------------------------------------------------
    # One pixel, changed with Blender's own image API, saved as a real
    # PNG. Everything else about the file is what it was.
    png, good = first_png
    img = bpy.data.images.load(png)
    px = list(img.pixels)
    idx = (len(px) // 8) * 4          # some pixel that is not the first
    px[idx] = 1.0 - px[idx]           # invert its red channel
    img.pixels = px
    altered = os.path.join(BASE, "torus-one-pixel-altered.png")
    img.filepath_raw = altered
    img.file_format = "PNG"
    img.save()

    altered_hash = sha256_file(altered)
    report["control"] = {
        "original": png,
        "original_hash": good.content_hash,
        "altered": altered,
        "altered_hash": altered_hash,
        "hashes_differ": altered_hash != good.content_hash,
        "original_bytes": os.path.getsize(png),
        "altered_bytes": os.path.getsize(altered),
    }
    good_verify = a_flow.verify_content(client, good.content_hash)
    bad_verify = a_flow.verify_content(client, altered_hash)
    report["control"]["verify_original"] = good_verify
    report["control"]["verify_altered"] = bad_verify
    report["checks"]["original_verifies_found"] = bool(good_verify and good_verify.get("found"))
    report["checks"]["altered_does_NOT_verify"] = bool(bad_verify and bad_verify.get("found") is False)

    # ---- the aggregate gates ------------------------------------------
    witnessed = [e for e in report["leaves"] if e["state"] == "witnessed"]
    report["checks"]["at_least_3_distinct_renders"] = len({e["sha256_of_bytes_on_disk"] for e in report["leaves"][:3]}) == 3
    report["checks"]["every_leaf_witnessed"] = len(witnessed) == len(report["leaves"])
    report["checks"]["every_content_hash_matches_disk"] = all(e["content_hash_matches_bytes"] for e in report["leaves"])
    report["checks"]["every_leaf_in_the_app_db"] = all(e["app_row"] for e in witnessed)
    report["checks"]["every_leaf_in_the_witness_db"] = all(e["witness_row"] for e in witnessed)
    report["checks"]["every_leaf_has_a_canonicalization_profile_on_the_row"] = all(
        (e["app_row"] or {}).get("canonicalization_profile") for e in witnessed)
    report["checks"]["every_leaf_declared_its_mime"] = all(
        (e["app_row"] or {}).get("mime_declared") == 1 for e in witnessed)

    # THE CANONICALIZATION CHECK THE ADDON CANNOT MAKE AT RUNTIME.
    # scruple_api says its profile is `jcs-1`; the server stamps `jcs-2`
    # on the row. The labels disagree -- but do the RULES? The only way
    # to find out is to canonicalize the same document on both sides and
    # compare the digest, and no v2 route returns `workflow_hash`, so the
    # addon cannot. This harness can, because it reads the database.
    report["checks"]["client_and_server_workflow_hashes_agree"] = all(
        e["canonicalization"]["client_workflow_hash"] == (e["app_row"] or {}).get("workflow_hash")
        for e in witnessed)
    report["canonicalization_labels"] = {
        "client": a_assurance.CLIENT_CANONICALIZATION_PROFILE,
        "server_on_row": (witnessed[0]["app_row"] or {}).get("canonicalization_profile") if witnessed else None,
        "labels_agree": (a_assurance.CLIENT_CANONICALIZATION_PROFILE
                         == ((witnessed[0]["app_row"] or {}).get("canonicalization_profile") if witnessed else None)),
        "note": ("The digests agree and the labels do not. The label is what an "
                 "auditor reads to know which rule to replay, so this is a real "
                 "divergence even though no hash is wrong today."),
    }

    # THE SIGNATURE THE APP TIER DISCARDS, VERIFIED HERE AGAINST THE
    # PUBLISHED KEY. This is what "independently verifiable" is supposed
    # to mean, and it is achievable -- from the witness server's database,
    # which is the one place the addon cannot reach.
    try:
        import base64 as _b64, urllib.request as _u
        from cryptography.hazmat.primitives import hashes as _h, serialization as _ser
        from cryptography.hazmat.primitives.asymmetric import ec as _ec
        pem = _u.urlopen(os.environ.get("WITNESS_SERVER_URL", "http://127.0.0.1:5899")
                         + "/api/signer/pubkey", timeout=10).read()
        pub = _ser.load_pem_public_key(pem)
        results = []
        for e in witnessed:
            wr = e["witness_row"] or {}
            if not wr.get("leaf_signature"):
                results.append(None)
                continue
            try:
                pub.verify(_b64.b64decode(wr["leaf_signature"]),
                           bytes.fromhex(wr["leaf_hash"]), _ec.ECDSA(_h.SHA256()))
                results.append(True)
            except Exception:
                results.append(False)
        report["discarded_signatures_verify_against_the_published_key"] = results
        report["checks"]["the_discarded_signatures_are_real"] = bool(results) and all(r is True for r in results)
    except Exception as _e:
        report["discarded_signature_check_error"] = str(_e)
        report["checks"]["the_discarded_signatures_are_real"] = False

    # THE HONESTY GATES. These assert what the addon must NOT claim.
    report["checks"]["no_leaf_claims_verified_assurance"] = all(
        e["assurance_tier"] != "verified" for e in report["leaves"])
    report["checks"]["no_leaf_claims_a_checked_verification"] = all(
        e["independently_verifiable_checked"] is False for e in report["leaves"])
    report["checks"]["signature_absence_recorded_as_not_disclosed"] = all(
        e["signature"]["source"] == "not_disclosed" for e in witnessed)

    # THE FINDING, as data rather than prose: the witness server signed
    # these leaves and the app tier has nowhere to put the signature.
    report["finding_h1_dropped_between_tiers"] = {
        "witness_server_signed": [bool((e["witness_row"] or {}).get("leaf_signature")) for e in witnessed],
        "app_has_leaf_signature_column": bool((witnessed[0]["app_row"] or {}).get("_has_leaf_signature_column")) if witnessed else None,
        "verify_claims_independently_verifiable": [
            e["independently_verifiable_claimed"] for e in witnessed],
    }

    report["ok"] = True
except Exception as e:
    report["ok"] = False
    report["error"] = f"{type(e).__name__}: {e}"
    report["traceback"] = traceback.format_exc()

with open(OUT, "w") as f:
    json.dump(report, f, indent=2)
print("REPORT " + json.dumps({"ok": report.get("ok"), "checks": report.get("checks"),
                              "leaves": len(report.get("leaves", []))}, indent=2))
failed = [k for k, v in report.get("checks", {}).items() if v is not True]
if not report.get("ok") or failed:
    print("FAILED CHECKS: " + ", ".join(failed) if failed else "FAILED: " + report.get("error", ""))
    print(report.get("traceback", ""))
    sys.exit(1)
print("ALL CHECKS PASSED — evidence at " + OUT)
