#!/usr/bin/env python3
"""WO-B7 close-out measurement — is H-4 still blocked in the ADDON?

WO-B4 reported the H-4 component envelope as unreachable because
`witness_flow.witness()` had no `component`/`mac`/`ratchet` parameter, and
an adapter may not assemble its own request (CANON_SKELETON §5).  WO-S1(b)
added those parameters three hours later, and WO-B6 re-vendored the SDK at
`b6cb1fd` -- which is AFTER S1.

So the question this close-out has to answer with an observable, not an
inference, is: can the bytes that ship inside the addon's zip TODAY put an
H-4 envelope on the wire?

This script imports ONLY from /data/scruple-blender/vendor -- the addon's
own vendored copy, the one `build_addon.sh` stages into the zip -- and
never from /data/scruple-web/packages.  It does NOT touch the addon's
adapter, because the adapter does not do this; that is the finding.
"""
import hashlib, json, os, sys

VENDOR = "/data/scruple-blender/vendor"
sys.path.insert(0, VENDOR)

from scruple_host_sdk.client import Client                              # noqa: E402
from scruple_host_sdk import witness_flow                               # noqa: E402
from scruple_host_sdk.server_library import (                           # noqa: E402
    provision_component, component_status, component_preimage,
)

for mod in (witness_flow, Client.__module__ and sys.modules[Client.__module__]):
    assert os.path.realpath(mod.__file__).startswith(VENDOR), mod.__file__
print("SDK in use:", witness_flow.__file__)
print("            (the addon's vendored copy, NOT /data/scruple-web/packages)")
print("VENDOR.json source_commit:",
      json.load(open(VENDOR + "/VENDOR.json"))["source_commit"][:7])

SB   = "/mnt/corpus/scruple-blender-l2"
APP  = "http://127.0.0.1:3902"
KEY  = open(f"{SB}/s1/s1b-api-key.txt").read().strip()
BASE = "a3a4934623aa090ff9b9141ae543ef0aa2ba8c69124800dfbe57ebba9aed242c"
CID, TOKEN = [l.strip() for l in open(f"{SB}/b7/token.txt")][:2]
MEAS = "sha256:" + hashlib.sha256(b"wo-b7-blender-vendored").hexdigest()

client = Client(host="blender", integration_version="1.0.0", api_key=KEY,
                base_url=APP, cache_dir=f"{SB}/b7/.scruple",
                queue_path=f"{SB}/b7/queue.jsonl")
client.state.baseline_ref = BASE

identity, ratchet = provision_component(
    client, token=TOKEN, build_measurement=MEAS, attestation={"provider": "none"})
print(f"\nprovision      component_id={identity.component_id}  counter={ratchet.counter}")
assert identity.component_id == CID and ratchet.counter == 0

CAPTURE = {"surface": "bpy.app.handlers", "hook": "render_complete",
           "fidelity": "exact", "mime_source": "declared",
           "observed_at": "2026-09-07T11:00:00.000Z"}

def artifact(tag):
    """Real Blender output, not random bytes: the B6 renders, re-read."""
    src = {"a": "torus.png", "b": "monkey.png", "c": "cone.png",
           "d": "sphere.jpg", "e": "b6-scene.obj"}[tag]
    p = f"{SB}/b7/b7-{tag}-{src}"
    data = open(f"{SB}/b6/key-address-published/{src}", "rb").read() + tag.encode()
    open(p, "wb").write(data)                       # distinct hash per leaf
    return p, hashlib.sha256(data).hexdigest()

def send(tag):
    path, ch = artifact(tag)
    mime = "image/jpeg" if path.endswith(".jpg") else (
        "model/obj" if path.endswith(".obj") else "image/png")
    o = witness_flow.witness(
        client, kind="artifact", content_hash=ch, mime=mime,
        component={"component_id": identity.component_id,
                   "build_measurement": MEAS,
                   "attestation": {"provider": "none", "quote_ref": None}},
        capture=CAPTURE, ratchet=ratchet)
    c = o.component
    print(f"witness {tag}  leaf={o.leaf_id:<4} witnessed={o.witnessed}  "
          f"component={{counter:{c.counter}, verified:{c.verified}, gap:{c.gap}}}  "
          f"{os.path.basename(path)}")
    return o, ch

print("\n-- MUST FIRE: the vendored SDK puts a MACed envelope on the wire --")
a, ha = send("a")
assert a.component.verified is True and a.component.counter == 0 and a.component.gap == 0

print("\n-- CONTROL: an unskipped sequence must report gap 0 --")
b, hb = send("b")
c, hc = send("c")
assert (b.component.counter, b.component.gap) == (1, 0), b
assert (c.component.counter, c.component.gap) == (2, 0), c
print("   gaps:", [a.component.gap, b.component.gap, c.component.gap],
      "- the detector is not simply always saying yes")

print("\n-- MUST FIRE: spend counter 3, never send it; counter 4 reports gap 1 --")
_p, _ch = artifact("d")
ratchet.mac(component_preimage({
    "baseline_ref": BASE, "kind": "artifact", "content_hash": _ch,
    "mime": "image/jpeg", "capture": CAPTURE,
    "component": {"component_id": identity.component_id, "counter": 3,
                  "build_measurement": MEAS,
                  "attestation": {"provider": "none", "quote_ref": None}}}))
print(f"   counter 3 spent on a capture never delivered; ratchet now at {ratchet.counter}")
e, he = send("e")
assert e.component.counter == 4 and e.component.verified is True
assert e.component.gap == 1, f"expected gap 1, got {e.component.gap}"
assert e.witnessed is True and e.leaf_id is not None   # 4.2: the gap does not void the leaf

print("\n-- the standing account: GET /api/v2/components/status, via the SDK --")
st = component_status(client, component_id=identity.component_id)
body = st.get("component", st)
print(json.dumps({k: body[k] for k in ("counters", "gaps", "liveness", "attestation") if k in body}, indent=2))

print("\n-- CONTROL: an envelope with no MAC never reaches the wire --")
before = ratchet.counter
try:
    witness_flow.witness(client, kind="artifact", content_hash="0" * 64,
                         mime="image/png",
                         component={"component_id": identity.component_id, "counter": 99})
    raise SystemExit("FAIL: the vendored SDK sent an unMACed envelope")
except ValueError as ex:
    print(f"   refused client-side: {str(ex)[:88]}...")
assert ratchet.counter == before

json.dump({"component_id": identity.component_id,
           "sdk": witness_flow.__file__,
           "vendor_commit": json.load(open(VENDOR + "/VENDOR.json"))["source_commit"],
           "leaves": {t: {"leaf_id": o.leaf_id, "content_hash": h,
                          "counter": o.component.counter, "gap": o.component.gap}
                      for t, (o, h) in {"a": (a, ha), "b": (b, hb),
                                        "c": (c, hc), "e": (e, he)}.items()},
           "status": st},
          open(f"{SB}/b7/h4-vendored-evidence.json", "w"), indent=1)
print("\nOK - the addon's SHIPPED SDK can do H-4. The addon's adapter does not call it.")
