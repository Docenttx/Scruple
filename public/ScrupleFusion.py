"""ScrupleFusion add-in entry point.

Architecture: Option 2 — the palette loads scruple-web's React UI directly
via Fusion's embedded Qt WebEngine. This file is the host shell: palette
mount, documentSaved hook, auto-witness timer, and the JS↔Python bridge
that dispatches palette actions (witness_now, lock_chain, open_browser,
set_api_key) onto the appropriate Python flows.

Threading: HTMLEventHandler.notify and DocumentEventHandler.notify both
fire on Fusion's UI thread, which is also where adsk.* APIs are safe to
call. The auto-witness daemon thread does NOT touch adsk; it just fires
a custom event that we handle on the UI thread.
"""

import json
import os
import sys
import traceback
import urllib.request
import webbrowser

# Make lib/ importable without polluting sys.path globally.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

try:
    import adsk.core  # noqa: F401
    import adsk.fusion  # noqa: F401
    _IN_FUSION = True
except ImportError:
    _IN_FUSION = False

from lib import scruple_client, witness, auto_witness, palette_host  # noqa: E402

_handlers = []
_auto_witness_thread = None
_palette = None
_url_scheme_server = None

# Toolbar panel — created in run(), cleaned in stop().
TOOLBAR_PANEL_ID = "scruple_panel"
TOOLBAR_PANEL_NAME = "Scruple"
TARGET_WORKSPACE = "FusionSolidEnvironment"
CMD_SHOW_PALETTE = "scruple_show_palette"
CMD_WITNESS_NOW = "scruple_witness_now"
CMD_LOCK_ANCHOR = "scruple_lock_anchor"

SCRUPLE_WEB_ORIGIN = os.environ.get("SCRUPLE_WEB_ORIGIN", "https://scruple.stooges.ai")

# Random session id shared with the palette via URL query param, used by
# the /api/fusion/handoff endpoint as a bridge-free way to move the API
# key from the palette JS to Python when Fusion's palette bridge is dead.
import secrets  # noqa: E402
def _load_or_mint_handoff_session() -> str:
    """Persistent per-Windows-user handoff session. Stored next to the
    key cache so it survives module reloads AND palette webview caches.
    Both palette (via URL param) and Python (this constant) read the
    same value so the session-keyed /handoff endpoint works even after
    Fusion Stop/Start rotates the module namespace."""
    import os
    p = os.path.join(
        os.environ.get("APPDATA") or os.path.expanduser("~"),
        "ScrupleFusion.session",
    )
    try:
        with open(p, "r", encoding="utf-8") as f:
            s = f.read().strip()
        if len(s) >= 32:
            return s
    except Exception:
        pass
    s = secrets.token_hex(24)
    try:
        with open(p, "w", encoding="utf-8") as f:
            f.write(s)
    except Exception:
        pass
    return s


FUSION_HANDOFF_SESSION = _load_or_mint_handoff_session()


class _SharedState:
    """Mutable state shared between handlers. Holds the API key (set by the
    palette via 'set_api_key') + active project_id (set on 'project_changed'
    or inferred from a witness_now message). Both can be None initially.
    """
    def __init__(self):
        self.api_key: str | None = None
        self.active_project_id: int | None = None


_state = _SharedState()


def _key_cache_path() -> str:
    """Per-Windows-user disk cache. Survives add-in Stop/Start module
    reloads that reset FUSION_HANDOFF_SESSION and _state."""
    import os
    return os.path.join(
        os.environ.get("APPDATA") or os.path.expanduser("~"),
        "ScrupleFusion.key",
    )


def _save_key_to_disk(key: str) -> None:
    try:
        p = _key_cache_path()
        with open(p, "w", encoding="utf-8") as f:
            f.write(key.strip())
    except Exception:
        pass


def _load_key_from_disk() -> str:
    try:
        with open(_key_cache_path(), "r", encoding="utf-8") as f:
            k = f.read().strip()
        return k if k.startswith("sk_") else ""
    except Exception:
        return ""


def _ensure_api_key(*, source: str = "unknown") -> bool:
    """Recovery order:
      1. _state.api_key (fresh module + poller ran)
      2. disk cache (survives module reload after add-in restart)
      3. /handoff (only works if palette + this Python share a session)

    Any successful recovery also refreshes the disk cache so subsequent
    module loads pick it up immediately.
    """
    if _state.api_key:
        return True

    # 2. disk cache
    disk_key = _load_key_from_disk()
    if disk_key:
        _state.api_key = disk_key
        _diag_ping("ensure_api_key_recovered", source=source, via="disk", key_len=len(disk_key))
        return True

    # 3. handoff endpoint fallback
    try:
        import urllib.request
        req = urllib.request.Request(
            f"{SCRUPLE_WEB_ORIGIN}/api/fusion/handoff?session={FUSION_HANDOFF_SESSION}",
            headers={"User-Agent": "scruple-fusion-addin/0.1.0"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        key = (payload.get("key") or "").strip() if isinstance(payload, dict) else ""
        if key.startswith("sk_"):
            _state.api_key = key
            _save_key_to_disk(key)
            _diag_ping("ensure_api_key_recovered", source=source, via="handoff", key_len=len(key))
            return True
    except Exception as e:
        _diag_ping("ensure_api_key_error", source=source, error=str(e))
    return False


def _debug_flags() -> dict:
    """Runtime-editable behavior. Read from
    %APPDATA%\\ScrupleFusion.debug.json every call — so the user can
    edit + save the file and see behavior change without pulling code.

    Recognized flags (all default False / unset):
      verbose:            log every hook fire + state read
      log_all_commands:   log every commandTerminated regardless of
                          timeline growth
      force_witness:      documentSaved fires witness even if project
                          isn't bound
      witness_dry_run:    _do_witness captures payload but skips POST
      disable_poller:     don't spawn the /handoff poll thread
    """
    import os
    try:
        p = os.path.join(
            os.environ.get("APPDATA") or os.path.expanduser("~"),
            "ScrupleFusion.debug.json",
        )
        with open(p, "r", encoding="utf-8") as f:
            return json.loads(f.read()) or {}
    except Exception:
        return {}


def _module_context() -> dict:
    """Snapshot of Python-side state that helps identify stale-closure
    scenarios. Cheap; safe to include in every diag ping."""
    import os
    p_key = os.path.join(
        os.environ.get("APPDATA") or os.path.expanduser("~"),
        "ScrupleFusion.key",
    )
    p_sess = os.path.join(
        os.environ.get("APPDATA") or os.path.expanduser("~"),
        "ScrupleFusion.session",
    )
    return {
        "pid": os.getpid(),
        "state_id": id(_state),
        "sess": FUSION_HANDOFF_SESSION[:8],
        "disk_key": os.path.exists(p_key),
        "disk_sess": os.path.exists(p_sess),
        "active_project_id": _state.active_project_id,
    }


def _diag_ping(event: str, **fields):
    """DIAGNOSTIC ONLY. Fire-and-forget POST to /api/diag/fusion so the
    server log records which Python handlers fired, regardless of api_key
    state. Removed once end-to-end is proven.
    """
    try:
        import threading
        import urllib.request

        payload = {"event": event, "has_api_key": bool(_state.api_key)}
        # Always attach module context so we can distinguish stale-closure
        # events from fresh-module events at a glance.
        try:
            payload.update(_module_context())
        except Exception:
            pass
        payload.update(fields)

        def _do():
            try:
                req = urllib.request.Request(
                    f"{SCRUPLE_WEB_ORIGIN}/api/diag/fusion",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": "scruple-fusion-addin/0.1.0",
                    },
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=3).read()
            except Exception:
                pass

        threading.Thread(target=_do, daemon=True).start()
    except Exception:
        pass


if _IN_FUSION:
    def _send_to_palette(palette, action, payload):
        """JS-side window.fusionJavaScriptHandler(action, data_string) gets
        called with our payload. Used to push status updates / results from
        Python back to the React UI."""
        try:
            palette.sendInfoToHTML(action, json.dumps(payload))
        except Exception:
            pass

    def _client_for(state) -> scruple_client.ScrupleClient | None:
        if not state.api_key:
            return None
        return scruple_client.ScrupleClient(
            base_url=SCRUPLE_WEB_ORIGIN, api_key=state.api_key
        )

    def _fetch_thumbnail_b64(df, timeout_sec=4.0):
        """Resolve DataFile.thumbnail (a DataObjectFuture) to a PNG data URL.

        Canonical Fusion API (verified via research 2026-07-03):
          future = df.thumbnail                        # DataObjectFuture
          # state values: 0=Processing, 1=Finished, 2=Failed
          while future.state == 0:  # ProcessingFutureState
              adsk.doEvents(); time.sleep(0.25)
          if future.state != 1:  # FinishedFutureState
              return None
          do = future.dataObject                       # DataObject (base)
          do.saveToFile(path)                          # saveTOFile, not saveAsFile
          # or: base64_str = do.getAsBase64String()    # wider-deployment fallback

        Best-effort: any failure returns None, never raises.
        """
        try:
            import base64
            import os
            import tempfile
            import time
            future = getattr(df, "thumbnail", None)
            if future is None:
                return None
            # Poll state — 0 = Processing, 1 = Finished, 2 = Failed.
            deadline = time.time() + timeout_sec
            while time.time() < deadline:
                try:
                    s = getattr(future, "state", None)
                    if s is None or s != 0:
                        break
                except Exception:
                    break
                try:
                    adsk.doEvents()
                except Exception:
                    pass
                time.sleep(0.15)
            try:
                final_state = getattr(future, "state", None)
            except Exception:
                final_state = None
            if final_state != 1:
                return None
            do = getattr(future, "dataObject", None)
            if do is None:
                return None
            # Prefer getAsBase64String — no filesystem I/O, wider deployment.
            try:
                b64 = do.getAsBase64String()
                if b64:
                    return "data:image/png;base64," + b64
            except Exception:
                pass
            # Fallback: saveToFile (Sept 2024+ Fusion).
            image = do
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as t:
                tmp = t.name
            try:
                saved = False
                try:
                    saved = bool(image.saveToFile(tmp))
                except Exception:
                    return None
                if not saved:
                    return None
                with open(tmp, "rb") as fh:
                    data = fh.read()
                if not data:
                    return None
                return "data:image/png;base64," + base64.b64encode(data).decode("ascii")
            finally:
                try:
                    os.unlink(tmp)
                except Exception:
                    pass
        except Exception:
            return None

    def _walk_data_folder(folder, out, max_files=5000):
        """Recursively collect every .f3d DataFile under `folder` into `out`.
        `out` is a list mutated in place. Bounded by max_files.
        """
        if len(out) >= max_files:
            return
        try:
            files = folder.dataFiles
            for i in range(files.count):
                if len(out) >= max_files:
                    return
                try:
                    df = files.item(i)
                    ext = (getattr(df, "fileExtension", "") or "").lower()
                    if ext == "f3d":
                        entry = {
                            "fusion_data_id": df.id,
                            "name": df.name,
                        }
                        try:
                            web_url = getattr(df, "fusionWebURL", None)
                            if web_url:
                                entry["fusion_web_url"] = web_url
                        except Exception:
                            pass
                        # First-file INLINE diagnostic — no function boundary
                        # so we see every step in the log even if something
                        # throws.
                        is_first = (len(out) == 0)
                        if is_first:
                            _diag_ping("thumbA_start", file_name=df.name)
                        # First-file only: probe DataFile itself for any
                        # thumbnail-related direct methods, and try them.
                        # Ships their return status so we finally see what
                        # Fusion actually exposes for saving thumbs.
                        if is_first:
                            try:
                                df_methods = [a for a in dir(df) if "thumb" in a.lower() or "download" in a.lower() or "save" in a.lower()]
                                _diag_ping("thumbA_df_methods", methods=df_methods)
                            except Exception as e:
                                _diag_ping("thumbA_df_methods_err", error=str(e))
                            # Try DataFile.saveThumbnailToFile — sometimes the
                            # dataObject future is a red herring and there's
                            # a direct sync path.
                            try:
                                import tempfile as _tf, base64 as _b64, os as _os2
                                with _tf.NamedTemporaryFile(suffix=".png", delete=False) as _tmpf:
                                    _tp = _tmpf.name
                                _saved = False
                                for _method in ("saveThumbnailToFile", "downloadThumbnail", "saveAsPNG"):
                                    _fn = getattr(df, _method, None)
                                    if callable(_fn):
                                        try:
                                            _saved = bool(_fn(_tp))
                                            _diag_ping("thumbA_df_direct", method=_method, saved=_saved)
                                            if _saved:
                                                break
                                        except Exception as _e:
                                            _diag_ping("thumbA_df_direct_err", method=_method, error=str(_e))
                                if _saved:
                                    with open(_tp, "rb") as _fh2:
                                        _data = _fh2.read()
                                    if _data:
                                        thumb_direct = "data:image/png;base64," + _b64.b64encode(_data).decode("ascii")
                                        _diag_ping("thumbA_df_direct_bytes", bytes=len(_data))
                                        entry["thumbnail_b64"] = thumb_direct
                                try:
                                    _os2.unlink(_tp)
                                except Exception:
                                    pass
                            except Exception as _e:
                                _diag_ping("thumbA_df_direct_outer_err", error=str(_e))
                        thumb = None
                        try:
                            future = df.thumbnail
                            if is_first:
                                _diag_ping("thumbA_got_future", is_none=(future is None))
                            if future is not None:
                                # Probe dataObject as method AND property.
                                if is_first:
                                    try:
                                        v_prop = getattr(future, "dataObject", None)
                                        _diag_ping("thumbA_prop_dataObject",
                                                   type=type(v_prop).__name__,
                                                   is_none=(v_prop is None),
                                                   str_repr=str(v_prop)[:100])
                                    except Exception as e:
                                        _diag_ping("thumbA_prop_err", error=str(e))
                                    try:
                                        v_state = getattr(future, "state", None)
                                        _diag_ping("thumbA_state",
                                                   type=type(v_state).__name__,
                                                   str_repr=str(v_state)[:100])
                                    except Exception as e:
                                        _diag_ping("thumbA_state_err", error=str(e))
                                # Poll dataObject.
                                import time as _t
                                image = None
                                for _i in range(20):
                                    try:
                                        v = getattr(future, "dataObject", None)
                                        if v is not None:
                                            image = v
                                            if is_first:
                                                _diag_ping("thumbA_got_image", iteration=_i, type=type(v).__name__)
                                            break
                                    except Exception:
                                        pass
                                    _t.sleep(0.2)
                                if image is not None:
                                    # ACTUAL SAVE PATH — try getAsBase64String
                                    # first; if empty, fall back to saveToFile.
                                    b64_empty = False
                                    try:
                                        b64 = image.getAsBase64String()
                                        if is_first:
                                            _diag_ping(
                                                "thumbA_b64_result",
                                                length=(len(b64) if b64 else 0),
                                                is_empty=(not b64),
                                            )
                                        if b64:
                                            thumb = "data:image/png;base64," + b64
                                        else:
                                            b64_empty = True
                                    except Exception as e:
                                        b64_empty = True
                                        if is_first:
                                            _diag_ping("thumbA_b64_err", error=str(e))
                                    # If b64 was empty, try saveToFile.
                                    if b64_empty and thumb is None:
                                        try:
                                            import tempfile as _tf3, base64 as _b643, os as _os3
                                            with _tf3.NamedTemporaryFile(suffix=".png", delete=False) as _tf4:
                                                _tp3 = _tf4.name
                                            _saved3 = False
                                            try:
                                                _saved3 = bool(image.saveToFile(_tp3))
                                            except Exception as _se:
                                                if is_first:
                                                    _diag_ping("thumbA_saveToFile_err", error=str(_se))
                                            if is_first:
                                                _diag_ping("thumbA_saveToFile_result", saved=_saved3)
                                            if _saved3:
                                                with open(_tp3, "rb") as _fh3:
                                                    _data3 = _fh3.read()
                                                if _data3:
                                                    thumb = "data:image/png;base64," + _b643.b64encode(_data3).decode("ascii")
                                                    if is_first:
                                                        _diag_ping("thumbA_saveToFile_bytes", bytes=len(_data3))
                                            try:
                                                _os3.unlink(_tp3)
                                            except Exception:
                                                pass
                                        except Exception as _e3:
                                            if is_first:
                                                _diag_ping("thumbA_saveToFile_outer_err", error=str(_e3))
                                    # image is a DataObject wrapper; probe its
                                    # attrs the first time so we see what's on it.
                                    if is_first:
                                        try:
                                            _diag_ping(
                                                "thumbA_dataobject_attrs",
                                                attrs=[a for a in dir(image) if not a.startswith("_")][:80],
                                            )
                                        except Exception:
                                            pass
                                    # Try to extract an actual Image. Common
                                    # Fusion patterns:
                                    #   - adsk.core.Image.cast(dataobject)
                                    #   - dataobject.image
                                    #   - dataobject.data
                                    #   - dataobject.value
                                    real_image = None
                                    try:
                                        real_image = adsk.core.Image.cast(image)
                                    except Exception:
                                        pass
                                    if real_image is None:
                                        for attr in ("image", "data", "value", "getImage", "png"):
                                            try:
                                                v = getattr(image, attr, None)
                                                if callable(v):
                                                    v = v()
                                                if v is not None:
                                                    if is_first:
                                                        _diag_ping(
                                                            "thumbA_via_attr",
                                                            attr=attr,
                                                            type=type(v).__name__,
                                                        )
                                                    real_image = v
                                                    break
                                            except Exception:
                                                continue
                                    if is_first:
                                        _diag_ping(
                                            "thumbA_real_image",
                                            is_none=(real_image is None),
                                            type=(type(real_image).__name__ if real_image is not None else "None"),
                                            has_saveAsFile=hasattr(real_image, "saveAsFile") if real_image is not None else False,
                                        )
                                    if real_image is not None and hasattr(real_image, "saveToFile"):
                                        try:
                                            import tempfile, base64, os as _os
                                            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as _t2:
                                                tmp = _t2.name
                                            saved = bool(real_image.saveToFile(tmp))
                                            if is_first:
                                                _diag_ping("thumbA_saved", saved=saved, path=tmp)
                                            if saved:
                                                with open(tmp, "rb") as _fh:
                                                    data = _fh.read()
                                                _os.unlink(tmp)
                                                if data:
                                                    thumb = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
                                                    if is_first:
                                                        _diag_ping("thumbA_encoded", bytes=len(data))
                                        except Exception as e:
                                            if is_first:
                                                _diag_ping("thumbA_save_err", error=str(e))
                                elif is_first:
                                    _diag_ping("thumbA_no_image_after_poll")
                        except Exception as e:
                            if is_first:
                                _diag_ping("thumbA_outer_err", error=str(e))
                        if thumb:
                            entry["thumbnail_b64"] = thumb
                        out.append(entry)
                except Exception:
                    continue
        except Exception:
            pass
        try:
            subs = folder.dataFolders
            for i in range(subs.count):
                if len(out) >= max_files:
                    return
                try:
                    _walk_data_folder(subs.item(i), out, max_files=max_files)
                except Exception:
                    continue
        except Exception:
            pass

    def _scan_fusion_account(app):
        """Walk every DataProject in every DataHub the user has access to
        and collect every .f3d file (recursively through folders). Returns
        a list of {fusion_data_id, name, fusion_project_id} dicts, capped.

        Uses dataHubs (all hubs — Personal + Team) rather than the
        activeHub shortcut app.data.dataProjects, so Team hub projects
        are always included regardless of which hub is currently active
        in the Fusion UI.
        """
        collected = []
        try:
            hubs = app.data.dataHubs
            for h in range(hubs.count):
                try:
                    hub = hubs.item(h)
                    hub_projects = hub.dataProjects
                    for i in range(hub_projects.count):
                        try:
                            proj = hub_projects.item(i)
                            proj_id = getattr(proj, "id", None)
                            root = proj.rootFolder
                            before = len(collected)
                            _walk_data_folder(root, collected)
                            for k in range(before, len(collected)):
                                collected[k]["fusion_project_id"] = proj_id
                        except Exception:
                            continue
                except Exception:
                    continue
        except Exception:
            pass
        return collected

    def _find_first_f3d(folder, max_depth=10):
        """Recursively search a folder for the first .f3d DataFile."""
        if max_depth <= 0:
            return None
        try:
            files = folder.dataFiles
            for i in range(files.count):
                try:
                    df = files.item(i)
                    ext = (getattr(df, "fileExtension", "") or "").lower()
                    if ext == "f3d":
                        return df
                except Exception:
                    continue
        except Exception:
            pass
        try:
            subs = folder.dataFolders
            for i in range(subs.count):
                try:
                    found = _find_first_f3d(subs.item(i), max_depth - 1)
                    if found is not None:
                        return found
                except Exception:
                    continue
        except Exception:
            pass
        return None

    def _diag_probe_thumbnail_future(app):
        """DIAGNOSTIC — resolve a DataObjectFuture for one .f3d thumbnail
        and dump what its actual API surface looks like. We know
        DataFile.thumbnail returns a DataObjectFuture — need to see the
        method/property names for polling + extracting the image.
        """
        try:
            hubs = app.data.dataHubs
            df = None
            for h in range(hubs.count):
                if df is not None:
                    break
                try:
                    hub = hubs.item(h)
                    projs = hub.dataProjects
                    for pi in range(projs.count):
                        if df is not None:
                            break
                        try:
                            proj = projs.item(pi)
                            df = _find_first_f3d(proj.rootFolder)
                        except Exception:
                            continue
                except Exception:
                    continue
            if df is None:
                _diag_ping("thumb_future_no_f3d")
                return
            future = df.thumbnail
            attrs = [a for a in dir(future) if not a.startswith("_")]
            _diag_ping("thumb_future_attrs", file_name=df.name, attrs=attrs)
            # Poll a few candidate readiness signals.
            for name in ("isValid", "isReady", "isFinished", "isDone", "isComplete", "hasCompleted", "value", "getData"):
                try:
                    v = getattr(future, name, "<missing>")
                    _diag_ping(
                        "thumb_future_attr",
                        attr=name,
                        type=type(v).__name__,
                        str_repr=str(v)[:200],
                    )
                except Exception as e:
                    _diag_ping("thumb_future_attr_err", attr=name, error=str(e))
            # Wait for readiness — try isReady/isValid patterns.
            import time
            waited = 0
            for _ in range(30):  # up to 15s
                try:
                    if getattr(future, "isReady", False):
                        break
                    if getattr(future, "isValid", False):
                        break
                except Exception:
                    pass
                time.sleep(0.5)
                waited += 500
            _diag_ping("thumb_future_waited_ms", ms=waited)
            # Try to extract a value.
            for name in ("value", "getValue", "data", "getData"):
                try:
                    method_or_prop = getattr(future, name, None)
                    if method_or_prop is None:
                        continue
                    if callable(method_or_prop):
                        val = method_or_prop()
                    else:
                        val = method_or_prop
                    _diag_ping(
                        "thumb_future_value",
                        via=name,
                        type=type(val).__name__,
                        str_repr=str(val)[:200],
                        attrs=[a for a in dir(val) if not a.startswith("_")][:60] if val is not None else [],
                    )
                except Exception as e:
                    _diag_ping("thumb_future_value_err", via=name, error=str(e))
        except Exception as e:
            _diag_ping("thumb_future_probe_fatal", error=str(e))

    def _diag_probe_thumbnail(app):
        """DIAGNOSTIC — find the first .f3d DataFile we can (recursing
        through subfolders) and dump what thumbnail-related APIs it exposes.
        """
        try:
            hubs = app.data.dataHubs
            df = None
            for h in range(hubs.count):
                if df is not None:
                    break
                try:
                    hub = hubs.item(h)
                    projs = hub.dataProjects
                    for pi in range(projs.count):
                        if df is not None:
                            break
                        try:
                            proj = projs.item(pi)
                            df = _find_first_f3d(proj.rootFolder)
                        except Exception:
                            continue
                except Exception:
                    continue
            if df is None:
                _diag_ping("thumbnail_probe_no_f3d_found")
                return
            attrs = [a for a in dir(df) if not a.startswith("_")]
            thumb_attrs = [
                a for a in attrs
                if "thumb" in a.lower() or "preview" in a.lower() or "image" in a.lower()
            ]
            _diag_ping(
                "thumbnail_probe",
                file_name=df.name,
                file_id_prefix=(df.id or "")[:40],
                all_attrs=attrs[:80],
                thumb_related=thumb_attrs,
            )
            for name in ("thumbnail", "hasThumbnail", "previewImage", "thumbnailImage"):
                try:
                    val = getattr(df, name, None)
                    _diag_ping(
                        "thumbnail_probe_attr",
                        attr=name,
                        type=type(val).__name__,
                        str_repr=str(val)[:120],
                    )
                except Exception as e:
                    _diag_ping(
                        "thumbnail_probe_attr_error",
                        attr=name, error=str(e),
                    )
        except Exception as e:
            _diag_ping("thumbnail_probe_fatal", error=str(e))

    def _diag_dump_fusion_data(app):
        """DIAGNOSTIC — enumerate app.data.dataHubs + dataProjects and ping
        the server with what Fusion actually reports. Runs Python-only, no
        palette bridge needed. Answers 'can Python read the project list?'
        definitively before we debug the sync path further.
        """
        try:
            hubs = app.data.dataHubs
            hub_count = hubs.count
            _diag_ping("data_dump_start", hub_count=hub_count)
            try:
                active_hub = app.data.activeHub
                active_hub_name = getattr(active_hub, "name", "?")
                _diag_ping("active_hub", name=active_hub_name)
            except Exception as e:
                _diag_ping("active_hub_error", error=str(e))
            for h in range(hub_count):
                try:
                    hub = hubs.item(h)
                    hub_name = getattr(hub, "name", "?")
                    hub_type = getattr(hub, "hubType", "?")
                    try:
                        projs = hub.dataProjects
                        proj_count = projs.count
                    except Exception as e:
                        _diag_ping(
                            "hub_projects_error",
                            hub_index=h, hub_name=hub_name, error=str(e),
                        )
                        continue
                    _diag_ping(
                        "hub_info",
                        hub_index=h,
                        hub_name=hub_name,
                        hub_type=str(hub_type),
                        project_count=proj_count,
                    )
                    for i in range(min(proj_count, 25)):
                        try:
                            proj = projs.item(i)
                            proj_name = getattr(proj, "name", "?")
                            try:
                                root = proj.rootFolder
                                folder_files = root.dataFiles.count
                                subfolders = root.dataFolders.count
                            except Exception:
                                folder_files = -1
                                subfolders = -1
                            _diag_ping(
                                "project_info",
                                hub_index=h,
                                proj_index=i,
                                name=proj_name,
                                root_files=folder_files,
                                root_folders=subfolders,
                            )
                        except Exception as e:
                            _diag_ping(
                                "project_iter_error",
                                hub_index=h, proj_index=i, error=str(e),
                            )
                except Exception as e:
                    _diag_ping("hub_iter_error", hub_index=h, error=str(e))
            _diag_ping("data_dump_end")
        except Exception as e:
            _diag_ping("data_dump_fatal", error=str(e))

    def _scan_and_sync(app, palette):
        """One-shot: scan Fusion account, POST to /api/projects/fusion-sync.
        Fires diag pings around each phase so the server log shows what
        happened even if the sync silently succeeds with 0 files."""
        client = _client_for(_state)
        if client is None:
            _diag_ping("scan_skipped_no_key")
            return
        try:
            files = _scan_fusion_account(app)
            with_thumb = sum(1 for f in files if f.get("thumbnail_b64"))
            _diag_ping(
                "scan_complete",
                file_count=len(files),
                with_thumbnail=with_thumb,
            )
            # Probe thumbnail APIs on the first .f3d — data is hydrated by
            # the time the scan finishes.
            try:
                _diag_probe_thumbnail(app)
            except Exception as e:
                _diag_ping("thumbnail_probe_dispatch_error", error=str(e))
            try:
                _diag_probe_thumbnail_future(app)
            except Exception as e:
                _diag_ping("thumb_future_dispatch_error", error=str(e))
            if not files:
                _send_to_palette(palette, "fusion_sync_done", {"synced": 0})
                return
            import urllib.request
            body = json.dumps({"files": files}).encode("utf-8")
            req = urllib.request.Request(
                f"{SCRUPLE_WEB_ORIGIN}/api/projects/fusion-sync",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {_state.api_key}",
                    "User-Agent": "scruple-fusion-addin/0.1.0",
                },
                method="POST",
            )
            resp = urllib.request.urlopen(req, timeout=30)
            payload = json.loads(resp.read().decode("utf-8"))
            _diag_ping(
                "sync_complete",
                created=payload.get("created", 0),
                updated=payload.get("updated", 0),
                skipped=payload.get("skipped", 0),
            )
            _send_to_palette(palette, "fusion_sync_done", payload)
        except Exception as e:
            _diag_ping("sync_error", error=str(e))
            _send_to_palette(palette, "fusion_sync_error", {"message": str(e)})

    def _do_witness(app, ui, palette):
        """Run an export + witness on the active design. Called on UI thread."""
        _diag_ping("_do_witness_enter")
        try:
            recovered = _ensure_api_key(source="_do_witness")
            client = _client_for(_state)
            _diag_ping(
                "_do_witness_precheck",
                have_client=(client is not None),
                have_project=bool(_state.active_project_id),
                recovered=recovered,
            )
            flags = _debug_flags()
            if flags.get("witness_dry_run"):
                _diag_ping("_do_witness_dry_run_skip")
                _send_to_palette(palette, "witness_done", {"dry_run": True})
                return
            if client is None:
                _send_to_palette(palette, "witness_error", {
                    "message": "No API key — sign in first",
                })
                return
            project_id = _state.active_project_id
            if not project_id:
                _send_to_palette(palette, "witness_error", {
                    "message": "No project selected — pick one in the palette",
                })
                return

            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is None:
                _send_to_palette(palette, "witness_error", {
                    "message": "No active design in Fusion",
                })
                return

            _send_to_palette(palette, "witness_started", {"project_id": project_id})
            resp = witness.export_and_witness(
                design, client, project_id, trigger="palette"
            )
            _send_to_palette(palette, "witness_done", {
                "project_id": project_id,
                "run_sequence": resp.get("runSequence"),
                "leaf_hash": resp.get("leafHash"),
            })
        except Exception as e:
            _send_to_palette(palette, "witness_error", {
                "message": f"Witness failed: {e}",
                "trace": traceback.format_exc(),
            })

    class _DocActivatedHandler(adsk.core.DocumentEventHandler):
        """documentActivated fires when a document becomes the active one
        in Fusion (opened from Fusion Team, switched to a different tab,
        etc). If the design is already saved AND has no Scruple binding
        yet, we auto-bind and take an initial witness of the current state.

        This is how existing designs get picked up — no user action needed,
        no batch scan required. Every existing design the user opens gets
        tracked as they encounter it. Honest receipt: the first leaf is
        a snapshot of "state at first observation," not a build history.
        """
        def __init__(self, app, ui):
            super().__init__()
            self._app = app
            self._ui = ui

        def notify(self, args):
            try:
                # Give the palette a beat to load + hand us the API key
                # in case Fusion just started up. If we don't have a
                # client yet, skip — user will get the design bound
                # on the next save or activation.
                if _client_for(_state) is None:
                    return
                design = adsk.fusion.Design.cast(self._app.activeProduct)
                if design is None:
                    return
                # Only auto-bind saved designs; brand-new unsaved ones wait
                # for their first save (Fusion's normal name-your-file dialog).
                try:
                    doc = args.document if hasattr(args, 'document') else self._app.activeDocument
                    if not getattr(doc, 'isSaved', True):
                        return
                except Exception:
                    pass
                # Already bound? nothing to do.
                existing = design.attributes.itemByName("Scruple", "project_id")
                if existing and existing.value:
                    try:
                        _state.active_project_id = int(existing.value)
                    except Exception:
                        pass
                    return
                # Unbound saved design — bind + take an initial witness.
                _auto_bind_project_on_save(self._app, self._ui)
                try:
                    self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
                except Exception:
                    pass
            except Exception:
                pass

    class _DocSavedHandler(adsk.core.DocumentEventHandler):
        """documentSaved → auto-bind Scruple project if not bound yet, then
        fire the witness tick.

        This is the ONLY project-creation trigger. Zero prompts inside
        Fusion — user just saves their design normally and Scruple picks
        up the file name as the project name automatically.
        """
        def __init__(self, app, ui):
            super().__init__()
            self._app = app
            self._ui = ui

        def notify(self, args):
            recovered = _ensure_api_key(source="documentSaved")
            flags = _debug_flags()
            _diag_ping(
                "documentSaved",
                recovered=recovered,
                force_witness=bool(flags.get("force_witness")),
            )
            try:
                bound = _auto_bind_project_on_save(self._app, self._ui)
                _diag_ping("auto_bind_result", project_id=bound)
                # Always fire witness tick — the tick handler decides whether
                # to actually export (needs a bound project). Under
                # force_witness, we also seed active_project_id from the
                # binding attempt so the tick can proceed.
                if bound and not _state.active_project_id:
                    _state.active_project_id = bound
                self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
            except Exception as e:
                _diag_ping("documentSaved_error", error=str(e))

    class _WitnessTickHandler(adsk.core.CustomEventHandler):
        """Consumes the auto-witness custom event on the UI thread. The
        daemon thread fires this event when the design is dirty; we run
        the actual export here where adsk APIs are safe."""
        def __init__(self, app, ui, palette_ref):
            super().__init__()
            self._app = app
            self._ui = ui
            self._palette_ref = palette_ref

        def notify(self, args):
            try:
                _do_witness(self._app, self._ui, self._palette_ref[0])
            except Exception:
                pass

    class _CommandTerminatedHandler(adsk.core.ApplicationCommandEventHandler):
        """Fires after every Fusion command completes. If the timeline
        grew since the last observation, a feature was added and we
        witness the design state. This is the core per-edit witnessing.

        Filters out commands that don't touch the timeline (Zoom, Orbit,
        selection, etc.) by comparing timeline.count. Only witnesses when
        the count increased.

        Parametric mode is required — Direct mode has no timeline.
        """
        def __init__(self, app):
            super().__init__()
            self._app = app
            self._last_count = 0

        def notify(self, args):
            # Verbose command logging — captures EVERY commandTerminated
            # regardless of whether it changed the timeline. Under a debug
            # flag so a normal run isn't noisy.
            try:
                flags = _debug_flags()
                if flags.get("log_all_commands") or flags.get("verbose"):
                    try:
                        cmd_id = getattr(getattr(args, "commandDefinition", None), "id", "?")
                    except Exception:
                        cmd_id = "?"
                    _diag_ping("cmd_terminated", cmd_id=cmd_id)
            except Exception:
                pass
            try:
                design = adsk.fusion.Design.cast(self._app.activeProduct)
                if design is None:
                    return
                if design.designType != adsk.fusion.DesignTypes.ParametricDesignType:
                    return
                try:
                    count = design.timeline.count
                except Exception:
                    return
                if count > self._last_count:
                    _diag_ping("timeline_grew", old=self._last_count, new=count)
                    self._last_count = count
                    try:
                        self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
                    except Exception:
                        pass
                elif count < self._last_count:
                    _diag_ping("timeline_shrank", old=self._last_count, new=count)
                    self._last_count = count
                    try:
                        self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
                    except Exception:
                        pass
            except Exception:
                pass

    def _do_checkpoint(app, ui, palette):
        """Mid-tier lock — checkpoint the chain. Uses same dev test-pay
        path as _do_lock. Real Stripe Checkout handoff lands after Probe 5.5.
        """
        try:
            client = _client_for(_state)
            if client is None:
                _send_to_palette(palette, "checkpoint_error", {"message": "No API key"})
                return
            project_id = _state.active_project_id
            if not project_id:
                _send_to_palette(palette, "checkpoint_error", {"message": "No project selected"})
                return
            _send_to_palette(palette, "checkpoint_started", {"project_id": project_id})

            # Mint PI + confirm via dev test-pay → then hit /api/lock/checkpoint
            try:
                pi_resp = _post_json(
                    SCRUPLE_WEB_ORIGIN + "/api/stripe/payment-intent",
                    {"action": "checkpoint", "projectId": project_id},
                    api_key=_state.api_key,
                )
                pi_id = pi_resp.get("paymentIntentId") or pi_resp.get("id")
                if not pi_id:
                    raise RuntimeError("no paymentIntentId")
                resp = _post_json(
                    SCRUPLE_WEB_ORIGIN + "/api/lock/checkpoint",
                    {"projectId": project_id, "paymentIntentId": pi_id},
                    api_key=_state.api_key,
                )
            except Exception as e:
                _send_to_palette(palette, "checkpoint_error", {
                    "message": f"Checkpoint failed: {e}",
                })
                return

            _send_to_palette(palette, "checkpoint_done", {
                "project_id": project_id,
                "pre_scr_id": resp.get("preScrId"),
                "merkle_root": resp.get("merkleRoot"),
            })
        except Exception:
            _send_to_palette(palette, "checkpoint_error", {
                "message": "Checkpoint crashed",
                "trace": traceback.format_exc(),
            })

    def _get_design_state(app):
        """Read the active Fusion document's name + Scruple project binding
        (from design.attributes if present)."""
        state = {"name": None, "project_id": None, "last_saved_at": None}
        try:
            doc = app.activeDocument
            state["name"] = getattr(doc, "name", None) or None
            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is not None:
                attr = design.attributes.itemByName("Scruple", "project_id")
                if attr and attr.value:
                    try:
                        state["project_id"] = int(attr.value)
                    except Exception:
                        pass
        except Exception:
            pass
        return state

    def _bind_project(app, project_id: int):
        """Write project_id to the active design's Scruple attribute group."""
        try:
            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is not None:
                design.attributes.add("Scruple", "project_id", str(project_id))
        except Exception:
            pass

    # -------------------------------------------------------------------
    # Toolbar buttons — a "Scruple" panel in the Design workspace toolbar
    #
    # Fusion command buttons are wired as follows:
    #   1. ui.commandDefinitions.addButtonDefinition(id, name, tooltip, resFolder)
    #   2. commandDef.commandCreated.add(handler)  — handler subclasses
    #      CommandCreatedEventHandler; its notify() fires on button click.
    #   3. panel.controls.addCommand(commandDef)
    #
    # For actions that don't need a dialog, we do the work directly in
    # the commandCreated handler — no need to plumb an execute handler.
    # -------------------------------------------------------------------

    class _ShowPaletteHandler(adsk.core.CommandCreatedEventHandler):
        """Toolbar button → open the Scruple palette (re-mount if missing)."""
        def __init__(self, app, ui):
            super().__init__()
            self._app = app
            self._ui = ui

        def notify(self, args):
            try:
                pal = self._ui.palettes.itemById(palette_host.PALETTE_ID)
                if pal is not None:
                    pal.isVisible = True
                else:
                    global _palette
                    _palette = palette_host.create_palette(self._app, self._ui)
            except Exception:
                try:
                    self._ui.messageBox(
                        "Show Scruple failed:\n" + traceback.format_exc()
                    )
                except Exception:
                    pass

    class _WitnessNowToolbarHandler(adsk.core.CommandCreatedEventHandler):
        """Toolbar button → fire an immediate witness of the current design.
        Same code path as the palette's Witness button and documentSaved."""
        def __init__(self, app):
            super().__init__()
            self._app = app

        def notify(self, args):
            try:
                self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
            except Exception:
                pass

    class _LockAnchorToolbarHandler(adsk.core.CommandCreatedEventHandler):
        """Toolbar button → show the palette and start the chain-lock flow."""
        def __init__(self, app, ui, palette_ref):
            super().__init__()
            self._app = app
            self._ui = ui
            self._palette_ref = palette_ref

        def notify(self, args):
            try:
                pal = self._ui.palettes.itemById(palette_host.PALETTE_ID)
                if pal is not None:
                    pal.isVisible = True
                _do_lock(self._app, self._ui, self._palette_ref[0], "pinned")
            except Exception:
                try:
                    self._ui.messageBox(
                        "Lock via toolbar failed:\n" + traceback.format_exc()
                    )
                except Exception:
                    pass

    def _install_toolbar(app, ui, palette_ref):
        """Register the Scruple panel + 3 buttons in the Design workspace.
        Idempotent — tears down any leftover panel / command defs from a
        previous Stop+Run cycle before creating fresh ones.
        """
        try:
            workspace = ui.workspaces.itemById(TARGET_WORKSPACE)
            if workspace is None:
                return

            # Tear down leftovers from a previous run.
            existing_panel = workspace.toolbarPanels.itemById(TOOLBAR_PANEL_ID)
            if existing_panel is not None:
                try:
                    existing_panel.deleteMe()
                except Exception:
                    pass
            for cid in (CMD_SHOW_PALETTE, CMD_WITNESS_NOW, CMD_LOCK_ANCHOR):
                cd = ui.commandDefinitions.itemById(cid)
                if cd is not None:
                    try:
                        cd.deleteMe()
                    except Exception:
                        pass

            panel = workspace.toolbarPanels.add(TOOLBAR_PANEL_ID, TOOLBAR_PANEL_NAME)

            # Single Scruple button — opens the palette. All witness /
            # checkpoint / lock actions live INSIDE the palette, not on
            # the toolbar. This matches the "toolbar is a launcher, palette
            # is the product" mental model.
            # Absolute path to our icon folder so Fusion picks up the 16/32
            # PNGs regardless of its current working directory. Fusion
            # expects the folder to contain 16x16.png and 32x32.png.
            addin_dir = os.path.dirname(os.path.abspath(__file__))
            icon_dir = os.path.join(addin_dir, "resources", "scruple_toolbar")
            # Fusion caches CommandDefinitions across restarts — if the id
            # already exists Fusion returns the cached def (with the OLD
            # icon). Force a fresh definition so new PNGs actually load.
            try:
                existing_def = ui.commandDefinitions.itemById(CMD_SHOW_PALETTE)
                if existing_def is not None:
                    existing_def.deleteMe()
            except Exception:
                pass
            show_def = ui.commandDefinitions.addButtonDefinition(
                CMD_SHOW_PALETTE,
                "Scruple",
                "Open Scruple Studio for Autodesk Fusion",
                icon_dir,
            )
            show_handler = _ShowPaletteHandler(app, ui)
            show_def.commandCreated.add(show_handler)
            _handlers.append(show_handler)
            panel.controls.addCommand(show_def)

        except Exception:
            try:
                ui.messageBox(
                    "Scruple toolbar install failed:\n" + traceback.format_exc()
                )
            except Exception:
                pass

    def _uninstall_toolbar(ui):
        """Remove the Scruple panel + command defs on add-in stop."""
        try:
            workspace = ui.workspaces.itemById(TARGET_WORKSPACE)
            if workspace is not None:
                panel = workspace.toolbarPanels.itemById(TOOLBAR_PANEL_ID)
                if panel is not None:
                    try:
                        panel.deleteMe()
                    except Exception:
                        pass
            for cid in (CMD_SHOW_PALETTE, CMD_WITNESS_NOW, CMD_LOCK_ANCHOR):
                cd = ui.commandDefinitions.itemById(cid)
                if cd is not None:
                    try:
                        cd.deleteMe()
                    except Exception:
                        pass
        except Exception:
            pass

    def _ensure_parametric(design, ui) -> bool:
        """If the design is in Direct modeling mode, prompt to switch to
        Parametric so the timeline is populated. Returns True if parametric
        by the time we return, False if user declined.
        """
        try:
            if design.designType == adsk.fusion.DesignTypes.ParametricDesignType:
                return True
            btn = adsk.core.MessageBoxButtonTypes.YesNoButtonType
            result = ui.messageBox(
                "Scruple needs Design History (Parametric mode) to witness "
                "every edit as a distinct event.\n\n"
                "Switch this design to Parametric mode now?",
                "Scruple — Enable Design History",
                btn,
            )
            if result == adsk.core.DialogResults.DialogYes:
                design.designType = adsk.fusion.DesignTypes.ParametricDesignType
                return True
            return False
        except Exception:
            return False

    def _auto_bind_project_on_save(app, ui):
        """Called from _DocSavedHandler on every save. If the active design
        has no Scruple project bound yet, this is the first save — so we
        take the Fusion file name (now known, because save just happened)
        and create a Scruple project under that name.

        Zero user prompts. The user's normal save flow IS the project
        creation trigger. The Fusion filename = the Scruple project name.

        Returns the project_id (whether pre-existing or newly created),
        or None if we couldn't bind yet (no API key, no design, unnamed).
        """
        try:
            _ensure_api_key(source="_auto_bind_project_on_save")
            client = _client_for(_state)
            if client is None:
                return None  # user hasn't signed in yet
            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is None:
                return None

            existing = design.attributes.itemByName("Scruple", "project_id")
            if existing and existing.value:
                try:
                    _state.active_project_id = int(existing.value)
                    return _state.active_project_id
                except Exception:
                    return None

            # First save of an unbound design → create the project.
            name = ""
            try:
                name = (app.activeDocument.name or "").strip()
            except Exception:
                pass
            if not name:
                return None  # still untitled somehow — skip

            # Silently ensure parametric mode. If user explicitly picked
            # Direct mode we respect their choice, but the timeline hook
            # won't fire for them — they'll only get save-time witnesses.
            try:
                if design.designType == adsk.fusion.DesignTypes.ParametricDesignType:
                    pass
            except Exception:
                pass

            proj = client.create_project(name=name, kind="cad")
            pid = int(proj.get("id"))
            pre_scr_id = proj.get("pre_scr_id") or proj.get("preScrId") or ""

            design.attributes.add("Scruple", "project_id", str(pid))
            design.attributes.add("Scruple", "project_name", name)
            if pre_scr_id:
                design.attributes.add("Scruple", "pre_scr_id", pre_scr_id)

            _state.active_project_id = pid

            # Small non-modal notification so the user knows tracking is on.
            # Fusion doesn't have a native toast API; messageBox is intrusive
            # for every save, so we only show it on FIRST bind.
            try:
                ui.messageBox(
                    f"Scruple is now tracking this design.\n\n"
                    f"Project: {name}\n"
                    + (f"SCR-ID (pre-lock): {pre_scr_id}\n\n" if pre_scr_id else "\n")
                    + "The project should appear in Scruple Studio's project "
                    "list within a few seconds. Every save and every timeline "
                    "change from now on will be witnessed automatically.",
                    "Scruple — Tracking started"
                )
            except Exception:
                pass
            return pid
        except Exception:
            try:
                ui.messageBox("Scruple auto-bind failed:\n\n" + traceback.format_exc())
            except Exception:
                pass
            return None

    class _PaletteMsgHandler(adsk.core.HTMLEventHandler):
        """JS → Python message dispatcher.

        Actions:
            set_api_key       — palette tells us the user's bearer token
            get_design_state  — send design_state event with name + binding
            project_changed   — palette tells us which project is selected
            bind_project      — write project_id to design.attributes
            witness_now       — manual witness trigger
            checkpoint        — mid-tier lock via dev test-pay
            lock_chain        — full chain lock + 3-anchor commit
            open_browser      — open URL in system browser
        """
        def __init__(self, app, ui, palette_ref):
            super().__init__()
            self._app = app
            self._ui = ui
            self._palette_ref = palette_ref

        def notify(self, args):
            try:
                action = args.action
                _diag_ping("palette_msg_received", action=action)
                data = {}
                if args.data:
                    try:
                        data = json.loads(args.data)
                    except Exception:
                        pass

                if action == "set_api_key":
                    key = (data.get("key") or "").strip()
                    _diag_ping(
                        "set_api_key_received",
                        key_len=len(key),
                        starts_with_sk=key.startswith("sk_"),
                    )
                    if key.startswith("sk_"):
                        _state.api_key = key
                        _save_key_to_disk(key)
                        # Auto-scan the user's Fusion account and mirror
                        # every .f3d into Scruple. Idempotent on server —
                        # safe to fire on every reconnect. The palette
                        # picks up new projects on its next poll.
                        try:
                            _scan_and_sync(self._app, self._palette_ref[0])
                        except Exception as e:
                            _diag_ping("scan_dispatch_error", error=str(e))

                elif action == "scan_now":
                    # Manual "refresh from Fusion account" trigger from palette.
                    try:
                        _scan_and_sync(self._app, self._palette_ref[0])
                    except Exception as e:
                        _diag_ping("scan_dispatch_error", error=str(e))

                elif action == "get_design_state":
                    state = _get_design_state(self._app)
                    _send_to_palette(self._palette_ref[0], "design_state", state)

                elif action == "bind_project":
                    pid = data.get("project_id")
                    if pid:
                        try:
                            pid_int = int(pid)
                            _bind_project(self._app, pid_int)
                            _state.active_project_id = pid_int
                        except Exception:
                            pass

                elif action == "project_changed":
                    pid = data.get("project_id")
                    try:
                        _state.active_project_id = int(pid) if pid else None
                    except Exception:
                        _state.active_project_id = None

                elif action == "witness_now":
                    pid = data.get("project_id")
                    if pid:
                        try:
                            _state.active_project_id = int(pid)
                        except Exception:
                            pass
                    _do_witness(self._app, self._ui, self._palette_ref[0])

                elif action == "checkpoint":
                    pid = data.get("project_id")
                    if pid:
                        try:
                            _state.active_project_id = int(pid)
                        except Exception:
                            pass
                    _do_checkpoint(self._app, self._ui, self._palette_ref[0])

                elif action == "lock_chain":
                    pid = data.get("project_id")
                    tier = data.get("tier") or "pinned"
                    if pid:
                        try:
                            _state.active_project_id = int(pid)
                        except Exception:
                            pass
                    _do_lock(self._app, self._ui, self._palette_ref[0], tier)

                elif action == "open_browser":
                    url = (data.get("url") or "").strip()
                    if url.startswith("/"):
                        url = SCRUPLE_WEB_ORIGIN.rstrip("/") + url
                    if not url:
                        url = SCRUPLE_WEB_ORIGIN
                    webbrowser.open(url)

            except Exception:
                try:
                    self._ui.messageBox(
                        "Scruple palette message handler failed:\n\n"
                        + traceback.format_exc()
                    )
                except Exception:
                    pass

    def _do_lock(app, ui, palette, tier):
        """Lock the active project. For now: drives the dev test-pay path
        (same as scripts/stripe-test-pay.mjs) so the user can see the full
        end-to-end RVN+IPFS+Arweave anchor flow without a real Stripe
        Checkout step. Production Checkout handoff lands in a follow-up
        once Probe 5.5 (custom URL scheme) is confirmed.
        """
        try:
            client = _client_for(_state)
            if client is None:
                _send_to_palette(palette, "lock_error", {
                    "message": "No API key — sign in first",
                })
                return
            project_id = _state.active_project_id
            if not project_id:
                _send_to_palette(palette, "lock_error", {
                    "message": "No project selected",
                })
                return

            _send_to_palette(palette, "lock_started", {"project_id": project_id})

            # Dev path: hit the test-pay helper endpoint on scruple-web
            # (which uses the witness server's admin confirm-pi to fake a
            # successful Stripe sandbox PaymentIntent). This is gated to
            # NODE_ENV=development server-side.
            action_name = f"chain-lock-{tier}"
            try:
                pi_resp = _post_json(
                    SCRUPLE_WEB_ORIGIN
                    + f"/api/stripe/payment-intent",
                    {"action": action_name, "projectId": project_id},
                    api_key=_state.api_key,
                )
                pi_id = pi_resp.get("paymentIntentId") or pi_resp.get("id")
                if not pi_id:
                    raise RuntimeError(
                        "no paymentIntentId from /api/stripe/payment-intent"
                    )
                # Confirm + execute the lock
                lock_resp = client.lock_chain(
                    project_id, pi_id, tier=tier
                )
            except Exception as e:
                _send_to_palette(palette, "lock_error", {
                    "message": f"Lock failed: {e}",
                    "trace": traceback.format_exc(),
                })
                return

            # Write attribute back to the active document so the chain
            # survives close + reopen.
            try:
                design = adsk.fusion.Design.cast(app.activeProduct)
                if design is not None:
                    witness.write_lock_attributes(design, lock_resp)
            except Exception:
                pass

            _send_to_palette(palette, "lock_done", {
                "project_id": project_id,
                "scr_id": lock_resp.get("scrId"),
                "merkle_root": lock_resp.get("merkleRoot"),
                "proof_tx_id": lock_resp.get("proofTxId"),
                "ipfs_cid": lock_resp.get("ipfsCid"),
                "arweave_tx_id": lock_resp.get("arweaveTxId"),
            })
        except Exception:
            try:
                _send_to_palette(palette, "lock_error", {
                    "message": "Lock crashed",
                    "trace": traceback.format_exc(),
                })
            except Exception:
                pass

    def _post_json(url, body, api_key=None):
        """Simple stdlib POST. Avoids dragging in the lib's client since
        we want a slightly different shape (api_key optional, plain dict
        return)."""
        data = json.dumps(body).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "scruple-fusion-addin/0.1.0",
        }
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return json.loads(raw)
            except Exception:
                return {"raw": raw}


def run(context):
    """Add-in startup hook called by Fusion."""
    _diag_ping("run_start", in_fusion=_IN_FUSION)
    if not _IN_FUSION:
        return
    ui = None
    try:
        global _palette, _auto_witness_thread, _url_scheme_server
        app = adsk.core.Application.get()
        ui = app.userInterface

        # palette_ref is a 1-element list so handlers can capture a stable
        # reference to the palette even though we may swap it later.
        palette_ref = [None]

        # 1. Mount the palette. Session id is baked into the URL so the
        # palette JS can POST its api key back via /api/fusion/handoff —
        # a bridge-free path we use when Fusion's palette bridge is dead.
        handoff_url = (
            f"{SCRUPLE_WEB_ORIGIN}/embed/fusion?session={FUSION_HANDOFF_SESSION}"
        )
        _palette = palette_host.create_palette(app, ui, embed_url=handoff_url)
        palette_ref[0] = _palette
        _diag_ping(
            "palette_mounted",
            palette_present=(_palette is not None),
            session_prefix=FUSION_HANDOFF_SESSION[:8],
        )

        # 1b. Background poller — checks /api/fusion/handoff for the api key.
        # When the palette JS POSTs the key, this picks it up and kicks off
        # the scan even if the JS→Python bridge never fires set_api_key.
        #
        # Runs FOREVER (daemon thread; dies with the add-in). When the key
        # is set, it heartbeats every 30s doing nothing so a palette remount
        # that re-posts a fresh key can be picked up too. When the key is
        # NOT set, it polls /handoff every 2s.
        try:
            import threading, time, urllib.request
            def _handoff_poll():
                first_receive = True
                while True:
                    if _state.api_key:
                        # Have a key. Sleep longer; heartbeat only so we can
                        # pick up a re-delivered key if _state.api_key gets
                        # cleared (rare) or the palette remounts with a new
                        # key (common after add-in restart mid-session).
                        time.sleep(30)
                        continue
                    try:
                        req = urllib.request.Request(
                            f"{SCRUPLE_WEB_ORIGIN}/api/fusion/handoff?session={FUSION_HANDOFF_SESSION}",
                            headers={"User-Agent": "scruple-fusion-addin/0.1.0"},
                        )
                        with urllib.request.urlopen(req, timeout=5) as resp:
                            payload = json.loads(resp.read().decode("utf-8"))
                        key = (payload.get("key") or "").strip() if isinstance(payload, dict) else ""
                        if key.startswith("sk_"):
                            _state.api_key = key
                            _save_key_to_disk(key)
                            _diag_ping("handoff_key_received", key_len=len(key), first=first_receive)
                            first_receive = False
                            try:
                                _scan_and_sync(app, palette_ref[0])
                            except Exception as e:
                                _diag_ping("handoff_scan_error", error=str(e))
                            continue  # loop back, will sleep 30s in the heartbeat branch
                    except Exception:
                        pass
                    time.sleep(2)
            threading.Thread(target=_handoff_poll, daemon=True).start()
        except Exception as e:
            _diag_ping("handoff_poll_dispatch_error", error=str(e))

        # 2a. documentSaved → auto-bind Scruple project on first save (using
        #     the Fusion filename as the project name), then fire witness.
        on_saved = _DocSavedHandler(app, ui)
        app.documentSaved.add(on_saved)
        _handlers.append(on_saved)

        # 2b. documentActivated → auto-bind any previously-saved design
        #     that has no Scruple binding yet. Picks up the user's
        #     existing designs organically as they open them.
        on_activated = _DocActivatedHandler(app, ui)
        app.documentActivated.add(on_activated)
        _handlers.append(on_activated)

        # 3. Register the custom event + UI-thread handler that actually
        # runs the witness flow when the daemon thread fires the tick.
        try:
            tick_event = app.registerCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
        except Exception:
            tick_event = None  # Already registered (Stop+Run) — that's OK
        if tick_event is not None:
            try:
                tick_handler = _WitnessTickHandler(app, ui, palette_ref)
                tick_event.add(tick_handler)
                _handlers.append(tick_handler)
            except Exception:
                pass

        # 4. Wire palette → Python messages.
        if _palette is not None:
            _diag_ping("registering_msg_handler")
            try:
                msg_handler = _PaletteMsgHandler(app, ui, palette_ref)
                _palette.incomingFromHTML.add(msg_handler)
                _handlers.append(msg_handler)
                _diag_ping("msg_handler_registered")
            except Exception as e:
                _diag_ping("msg_handler_registration_failed", error=str(e))
                try:
                    ui.messageBox(
                        "Scruple: palette message bridge failed to register.\n"
                        "UI displays but action buttons won't reach Python.\n\n"
                        + traceback.format_exc()
                    )
                except Exception:
                    pass
        else:
            _diag_ping("no_palette_for_msg_handler")

        # 5. UI commands + toolbar panel with Scruple / Witness / Lock buttons
        # in the Design workspace toolbar.
        palette_host.install_ui_commands(app, ui, _handlers)
        _install_toolbar(app, ui, palette_ref)

        # 6. Start the ambient auto-witness loop (5-min default).
        _auto_witness_thread = auto_witness.start(app, ui, _palette)

        # 6a-diag. DIAGNOSTIC — dump the user's dataHubs + dataProjects to
        # the server log, independent of the palette bridge. Answers "can
        # Python read the project list at all?" definitively. Runs on the
        # UI thread (Fusion API isn't guaranteed thread-safe); may briefly
        # stall UI while cloud data is fetched, acceptable for the diag.
        try:
            _diag_dump_fusion_data(app)
        except Exception as e:
            _diag_ping("diag_dump_dispatch_error", error=str(e))
        try:
            _diag_probe_thumbnail(app)
        except Exception as e:
            _diag_ping("thumbnail_probe_dispatch_error", error=str(e))
        # Bridge is intermittent — schedule a delayed re-probe on a
        # background thread. Fusion data is usually hydrated by then and
        # this fires even when the palette bridge is dead so we can still
        # find the thumbnail API.
        try:
            import threading
            def _delayed_probe():
                try:
                    _diag_ping("delayed_probe_starting")
                    _diag_probe_thumbnail(app)
                except Exception as e:
                    _diag_ping("delayed_probe_error", error=str(e))
            threading.Timer(15.0, _delayed_probe).start()
        except Exception as e:
            _diag_ping("delayed_probe_dispatch_error", error=str(e))

        # 6b. Hook commandTerminated → witness on every timeline growth.
        # This is the "witness every edit" behavior — every extrude,
        # fillet, sketch, etc. that adds a node to the timeline fires
        # an immediate witness. Non-timeline commands (zoom, orbit,
        # selection) don't trigger because timeline.count doesn't change.
        try:
            cmd_handler = _CommandTerminatedHandler(app)
            app.commandTerminated.add(cmd_handler)
            _handlers.append(cmd_handler)
        except Exception:
            pass

        # 7. Register custom URL scheme handler (for payment callbacks).
        _url_scheme_server = palette_host.register_url_scheme_handler(app, ui, _palette)

    except Exception:
        if ui is not None:
            try:
                ui.messageBox(
                    'Scruple add-in failed to start:\n\n' + traceback.format_exc()
                )
            except Exception:
                pass


def stop(context):
    """Add-in shutdown hook."""
    if not _IN_FUSION:
        return
    try:
        global _palette, _auto_witness_thread, _url_scheme_server
        if _auto_witness_thread is not None:
            auto_witness.stop(_auto_witness_thread)
            _auto_witness_thread = None
        if _url_scheme_server is not None:
            try:
                _url_scheme_server.stop()
            except Exception:
                pass
            _url_scheme_server = None
        if _palette is not None:
            try:
                _palette.deleteMe()
            except Exception:
                pass
            _palette = None
        _handlers.clear()
        palette_host.uninstall_ui_commands()
        try:
            app = adsk.core.Application.get()
            _uninstall_toolbar(app.userInterface)
        except Exception:
            pass
    except Exception:
        pass
