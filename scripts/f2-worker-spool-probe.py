#!/usr/bin/env python3
"""⚑ WO-F2 / FINDING E7-3, measured on the add-on's own class rather than argued.

    python3 scripts/f2-worker-spool-probe.py --mode MODE --n N --out FILE ...

`adapter/handlers.WitnessWorker` is the in-memory queue every ambient capture
goes through. `stop()` used to re-check the stop flag AFTER pulling a job and
BEFORE running it, so a capture still queued when the add-on was disabled or
Blender quit never ran -- and because it never reached the SDK it was not on
the SDK's on-disk spool either. `unregister()` calls `stop()`.

WHAT THIS RUNS IS THE SHIPPED CODE. `adapter/handlers` and `adapter/flow`
import `bpy` defensively, so they load with bpy absent and the worker under
test IS the worker in a user's Blender. The one thing taken out is the SCENE
READ: the job body calls `flow._witness_path()`, which is everything
`witness_render()` does after it has resolved a path out of a Blender scene --
the ledger line, `client.capture()`, `client.witness()`, the assurance record.
Nothing is mocked and nothing is reimplemented.

⚑ NOTHING HERE IS COUNTED FROM THE WORKER. The probe prints the content hashes
it captured and where each capture ended up according to the SDK; the GATE
recomputes those hashes with sha256sum and counts them in the app's database
and in the spool FILE. The worker's own accounting is printed alongside so the
two can be compared, never instead.

MODES
  deliver   N captures queued behind a blocked worker, stop() immediately.
            All N must reach the server.
  offline   attach first, then point the session at a CLOSED port. All N must
            reach the on-disk spool.
  hang      attach first, then point the session at a socket that accepts and
            never answers -- the case the shutdown bound exists for. All N must
            reach the spool, inside the bound.
  inflight  the same wedged server, but ONE capture is put on the wire and left
            there BEFORE stop() is called. ⚑ Finding F2-1: that request keeps
            the budget it was given and cannot be called back, so the drain may
            never get to run. What this measures is that the captures it could
            not reach are NAMED by stop(), and that stop() still returns inside
            its own bound.
  empty     nothing queued, stop() called. Control (b): no spool entry may be
            manufactured.
  reject    a server that answers 400. Control (c): delivered, refused, NOT
            queued -- and PRESENT on the record, which a dropped capture is not.
  oversize  a file over the SDK's inline limit. Control (c), the local half:
            refused before the wire, and present on the record.

🔴 The only address dialled from here is the one passed in --base-url (the gate
passes the sandbox) plus loopback stubs this process starts and stops itself.
"""
import argparse
import http.server
import json
import os
import socket
import sys
import threading
import time

ADDON = os.environ.get("SCRUPLE_ADDON_REPO", "/data/scruple-blender")
sys.path.insert(0, ADDON)
sys.path.insert(0, os.path.join(ADDON, "vendor"))

from adapter import flow as F          # noqa: E402
from adapter import handlers as H      # noqa: E402
from adapter import scene as S         # noqa: E402
from adapter import sdk as SDK         # noqa: E402
from adapter import state as ST        # noqa: E402


# ---- loopback stubs ----------------------------------------------------

def closed_port() -> int:
    """A port nothing is listening on: bind it, read it, release it."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class HangServer:
    """Accepts the connection and never answers. This is the case a shutdown
    bound is FOR: a refused connection fails in microseconds, a wedged one
    burns the session's whole 30s timeout per capture."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)
        self.port = self.sock.getsockname()[1]
        self.conns = []
        self._t = threading.Thread(target=self._accept, daemon=True)
        self._t.start()

    def _accept(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            self.conns.append(c)

    # Deliberately no close(): see the note at the end of main().


class _Reject(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = b'{"error":"invalid_body"}'
        self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class RejectServer:
    """Answers every submission with 400. A real refusal by a real server:
    `http.submit()` queues transport failures and 5xx ONLY, so this is the
    shape of failure that is deliberately not spooled."""

    def __init__(self) -> None:
        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), _Reject)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    # Deliberately no close(): see the note at the end of main().


# ---- ⚑ the same script has to measure BOTH trees -----------------------
#
# The gate builds the parent of the add-on's WO-F2 commit into a worktree and
# points this probe at it (SCRUPLE_ADDON_REPO). The before-tree's `submit()`
# takes no `label`, its `stop()` takes no `hurry_timeout` and returns None, and
# its worker has no `queued`. Describing the old behaviour instead of running
# it is exactly what a control is not, so the calls are made compatibly and the
# differences are RECORDED rather than papered over.


def submit(job, label):
    try:
        return H.WORKER.submit(job, label=label)
    except TypeError:
        H.WORKER.submit(job)
        return None


def stop(drain, hurry):
    try:
        r = H.WORKER.stop(timeout=drain, hurry_timeout=hurry)
    except TypeError:
        r = H.WORKER.stop() if drain is None else H.WORKER.stop(drain)
    if not isinstance(r, dict):
        # The before-tree's stop() returns None -- it has no idea what it did.
        return {"queued_at_stop": None, "ran": None, "hurried": None,
                "abandoned": None, "seconds": None, "reported": False}
    r = dict(r)
    r["reported"] = True
    return r


# ---- the captures ------------------------------------------------------

def make_file(work: str, i: int, *, size: int = 0) -> str:
    path = os.path.join(work, f"f2-{i:02d}.png")
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + f"f2-probe-{i}-".encode() + os.urandom(48))
        if size:
            f.truncate(size)
    return path


def capture_job(client, path: str, i: int):
    """The body of `flow.witness_render()` with the scene read taken out."""
    workflow = S.build_render_workflow(
        filename=os.path.basename(path), scene_name="f2-probe",
        render_engine="CYCLES", resolution=(64, 64), samples=1,
        camera="Camera", frame=i, trigger="render_write",
    )

    def _job():
        F._witness_path(client, path, mime="image/png", kind="render", workflow=workflow)

    return _job


def spool_rows(client):
    """The on-disk spool, read as a FILE. Not `client.queue_depth`."""
    out = []
    if not os.path.exists(client.queue.path):
        return out
    with open(client.queue.path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            out.append({
                "id": e.get("id"), "kind": e.get("kind"), "path": e.get("path"),
                "content_hash": (e.get("body") or {}).get("content_hash"),
            })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True,
                    choices=["deliver", "offline", "hang", "inflight", "empty",
                             "reject", "oversize"])
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--out", required=True)
    ap.add_argument("--drain-budget", type=float, default=None)
    ap.add_argument("--hurry-budget", type=float, default=None)
    a = ap.parse_args()

    base = a.base_url.rstrip("/")
    if ":5799" in base or ":3001" in base:
        raise SystemExit(f"refusing to talk to {base} -- that is production")
    os.makedirs(a.work, exist_ok=True)
    os.makedirs(a.cache_dir, exist_ok=True)

    report = {
        "mode": a.mode, "n": a.n, "base_url": base,
        "worker_class": f"{H.WitnessWorker.__module__}.{H.WitnessWorker.__name__}",
        "worker_source": os.path.abspath(H.__file__),
        "drain_seconds": getattr(H, "SHUTDOWN_DRAIN_SECONDS", None) if a.drain_budget is None else a.drain_budget,
        "hurry_seconds": getattr(H, "SHUTDOWN_HURRY_SECONDS", None) if a.hurry_budget is None else a.hurry_budget,
        # The one-word answer to "which tree is this": the before-tree has no
        # shutdown budget because it has no drain to bound.
        "stop_has_drain": hasattr(H, "SHUTDOWN_DRAIN_SECONDS"),
        "shutdown_timeout": getattr(H, "SHUTDOWN_TIMEOUT_SECONDS", None),
    }

    ST.reset()
    SDK.reset_client()
    client = SDK.new_client(base_url=base, api_key=a.api_key, cache_dir=a.cache_dir)
    SDK.set_client(client)
    report["queue_file"] = client.queue.path
    report["spool_before"] = len(spool_rows(client))

    # The baseline is established against the REAL server, before anything is
    # broken. D-3: witness() refuses client-side without one, so a probe that
    # attached through a dead port would be measuring the refusal and not the
    # drop.
    report["attached"] = bool(F.ensure_attached(client))
    report["baseline_ref"] = getattr(client.state, "baseline_ref", None)
    if not report["attached"]:
        report["error"] = ST.get().last_error or "attach failed"
        json.dump(report, open(a.out, "w"), indent=1)
        return 2

    stub = None
    if a.mode == "offline":
        client.base_url = f"http://127.0.0.1:{closed_port()}"
    elif a.mode in ("hang", "inflight"):
        stub = HangServer()
        client.base_url = f"http://127.0.0.1:{stub.port}"
    elif a.mode == "reject":
        stub = RejectServer()
        client.base_url = f"http://127.0.0.1:{stub.port}"
    report["submit_url"] = client.base_url
    report["timeout_at_submit"] = client.timeout

    # ⚑ The worker is BLOCKED before the captures are queued, so that "still
    # queued when stop() was called" is a fact and not a race. This is the
    # only thing the probe stages; everything after it is the shipped path.
    H.WORKER.start()
    release = threading.Event()
    holding = threading.Event()
    paths = []
    n = 1 if a.mode == "oversize" else (0 if a.mode == "empty" else a.n)

    if a.mode == "inflight":
        # ⚑ No hold. The first capture IS the hold: it goes on the wire against
        # a server that never answers and is still blocked in read() when
        # stop() is called, with the 30s budget it was given before any of this
        # started. Finding F2-1.
        p0 = make_file(a.work, 0)
        paths.append(p0)
        submit(capture_job(client, p0, 0), f"render_write {os.path.basename(p0)}")
        time.sleep(2.0)
        report["inflight_timeout"] = client.timeout
        start = 1
    else:
        if a.mode != "empty":
            submit(lambda: (holding.set(), release.wait(20)), "hold")
            holding.wait(5)
        start = 0

    for i in range(start, n):
        p = make_file(a.work, i, size=(26 * 1024 * 1024 if a.mode == "oversize" else 0))
        paths.append(p)
        submit(capture_job(client, p, i), f"render_write {os.path.basename(p)}")
    report["files"] = paths
    report["queued_before_stop"] = getattr(H.WORKER, "queued", None)

    release.set()
    t0 = time.monotonic()
    report["stop"] = stop(a.drain_budget, a.hurry_budget)
    report["stop_wall_seconds"] = round(time.monotonic() - t0, 3)

    # ---- what the SDK and the record say. The gate checks disk itself. ----
    # ⚑ READ BEFORE THE STUB IS CLOSED. Closing a wedged connection unblocks
    # whatever is still on it, which would let a capture land on the spool
    # AFTER the moment being measured -- and in a real Blender quit there is no
    # such second chance.
    report["spool"] = [r for r in spool_rows(client) if r["path"] == "/api/v2/witness"]
    report["spool_rows_total"] = len(spool_rows(client))
    report["captures"] = [
        {
            "state": getattr(r, "state", None),
            "leaf_id": getattr(r, "leaf_id", None),
            "content_hash": getattr(r, "content_hash", None),
            "filename": getattr(r, "filename", None),
            "error": getattr(r, "error", None),
        }
        for r in ST.assurances()
    ]
    report["state_counts"] = ST.state_counts()
    report["last_error"] = ST.get().last_error
    report["timeout_after_stop"] = client.timeout

    # ⚑ THE STUBS ARE NEVER CLOSED. Closing a wedged connection unblocks
    # whatever is still on it, so a capture the shutdown did NOT manage could
    # land on the spool a moment after the moment being measured -- and the
    # gate reads that file after this process exits, so it would read the
    # second number. A real Blender quit offers no such second chance. Both
    # stubs run on daemon threads and go when this process does.
    report["stub_left_open"] = stub is not None

    json.dump(report, open(a.out, "w"), indent=1)
    print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
