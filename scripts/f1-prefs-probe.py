"""Run INSIDE Blender: does the Scruple add-on's Settings UI bind, and what
does an unconfigured `get_base_url()` yield?

    blender --background --python scripts/f1-prefs-probe.py -- \
        [--enable MODULE] [--sandbox http://127.0.0.1:3902]

⚑ WO-F1 / finding E7-2. `bpy.types.AddonPreferences` is matched to an add-on by
`bl_idname == the module name Blender enabled it under`, and that name is a
property of the INSTALL PATH: `scruple_blender` on the legacy `scripts/addons/`
path, `bl_ext.user_default.scruple_blender` through `blender_manifest.toml`.
The add-on hardcoded the first, so on the shipping path Blender bound nothing,
there was no field to set, and `get_base_url()` fell through to the SDK's
default — `https://scruple.ai`, production.

This is `scripts/e7-prefs-probe.py` widened. E7's probe answered "is it bound";
this one has to answer "is it USABLE and is production gone", so it also:

  * round-trips a value through the bound preferences object — setting
    `base_url` and reading it back through the adapter's own `get_base_url()`,
    which is the thing the gate actually asserts;
  * asks what `get_base_url()` yields with nothing configured at all, which is
    control (a);
  * asks whether a cached KEY with no base URL still builds a session Client —
    on the old tree it does, pointed at production, because
    `Client.__init__` does `base_url or DEFAULT_BASE_URL`;
  * reports the add-on's `tamper_surface_hash`, because this change moves it
    and the report has to say by what.

It reports and asserts nothing. The gate compares the two install paths and the
two trees. Everything printed is read out of the running Blender.

🔴 It writes into the SDK auth cache under $HOME and clears it again. Run it
with HOME pointed somewhere disposable; the gate does.
"""
import json
import os
import sys

import bpy

MARK_OPEN = "<<<F1_PREFS"
MARK_CLOSE = "F1_PREFS>>>"


def argv():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {}
    i = 0
    while i < len(args):
        out[args[i].lstrip("-")] = args[i + 1]
        i += 2
    return out


a = argv()
SANDBOX = a.get("sandbox", "http://127.0.0.1:3902")

if a.get("enable"):
    import addon_utils
    addon_utils.enable(a["enable"], default_set=True, persistent=True)

report = {
    "blender_version": ".".join(str(x) for x in bpy.app.version),
    "home": os.path.expanduser("~"),
    "sandbox": SANDBOX,
    "enabled": [],
}

for entry in bpy.context.preferences.addons:
    if not entry.module.endswith("scruple_blender"):
        continue
    p = getattr(entry, "preferences", None)
    report["enabled"].append({
        "module": entry.module,
        "install_path": "manifest" if entry.module.startswith("bl_ext.") else "legacy",
        "preferences_bound": p is not None,
        "preferences_type": type(p).__name__ if p is not None else None,
        "api_key_settable": hasattr(p, "api_key"),
        "base_url_settable": hasattr(p, "base_url"),
        "verbose_logging_settable": hasattr(p, "verbose_logging"),
    })

try:
    from adapter import preferences as prefs
    from adapter import sdk as _sdk
    from scruple_host_sdk import auth as _auth
    from scruple_host_sdk import manifest as _manifest

    report["bl_idname"] = prefs.ScrupleAddonPreferences.bl_idname
    # Absent on the before-tree; its absence is itself the difference.
    report["has_addon_module_name"] = hasattr(prefs, "addon_module_name")
    if hasattr(prefs, "addon_module_name"):
        report["addon_module_name"] = prefs.addon_module_name()
    report["adapter_sees_prefs_object"] = prefs._addon_prefs() is not None

    # ── 1. ⚑ WHAT A USER WHO CONFIGURED NOTHING GETS ────────────────────
    # No value in the preferences object (or no preferences object at all)
    # and no `base_url` in the auth cache. This read is control (a).
    report["base_url_unconfigured"] = prefs.get_base_url()
    report["unconfigured_is_production"] = "scruple.ai" in prefs.get_base_url()

    # ── 2. a key, still no base URL. Does a session Client get built? ────
    # `Client.__init__` fills an empty base_url with DEFAULT_BASE_URL, so
    # the adapter is the only place this can be refused.
    try:
        _auth.save_cached(_sdk.HOST, "sk_f1_probe_no_base_url")
        _sdk.reset_client()
        c = _sdk.get_client()
        report["client_with_key_and_no_base_url"] = (
            None if c is None else getattr(c, "base_url", "?")
        )
    finally:
        _auth.clear_cached(_sdk.HOST)
        _sdk.reset_client()

    # ── 3. ⚑ THE GATE: is the bound object actually usable? ──────────────
    # Set the sandbox URL through the preferences object the way a user
    # types it into the field, and read it back through the adapter.
    obj = prefs._addon_prefs()
    if obj is None:
        report["roundtrip"] = None
    else:
        obj.base_url = SANDBOX
        obj.api_key = "sk_f1_probe_roundtrip"
        report["roundtrip"] = {
            "set_base_url": SANDBOX,
            "get_base_url": prefs.get_base_url(),
            "get_api_key": prefs.get_api_key(),
            "is_authed": prefs.is_authed(),
        }
        obj.base_url = ""
        obj.api_key = ""

    # ── 4. the tamper surface hash — the baseline this change moves ──────
    report["tamper_surface_hash"] = _manifest.compute_tamper_surface_hash(
        integration_version=_sdk.integration_version(),
        code_paths=list(_sdk.TAMPER_SURFACE_PATHS),
    )
    # ⚑ AND the one that actually keys a baseline. `flow.ensure_attached()`
    # passes `config={"host": ...}` and the config is folded into the hash,
    # so the bare call above is NOT the number a leaf is filed under. Both
    # are reported because confusing them is easy and the difference is
    # invisible: two 64-hex strings over the same files.
    report["attach_surface_hash"] = _manifest.compute_tamper_surface_hash(
        integration_version=_sdk.integration_version(),
        config={"host": _sdk.HOST},
        code_paths=list(_sdk.TAMPER_SURFACE_PATHS),
    )
    report["addon_root"] = _sdk.ADDON_ROOT
except Exception as e:
    report["adapter_error"] = repr(e)

sys.stdout.write("\n" + MARK_OPEN + "\n" + json.dumps(report, indent=1) + "\n" + MARK_CLOSE + "\n")
