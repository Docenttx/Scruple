# H-4 as DUKPT — the capture component, specified against ComfyUI

_2026-08-30. Spec. Reference integration: ComfyUI, because it is the shape a
vendor actually hosts and the one Studio already proved twice._

Supersedes the WO-05 recommendation to replace `SCRUPLE_APPS_WITNESS_SECRET`
with a per-session secret. Per-session narrows blast radius and leaves P3
failing; this replaces the custody model.

---

## 1. Threat model — say it before designing to it

| Party | Trust | Role in payments |
|---|---|---|
| **Tenant** — the end customer running workflows | **Adversary.** Assume root in their own container, DevTools, a shell | The party at the terminal |
| **Vendor** — HF, RunPod, an inference host | **Semi-trusted.** Operates in good faith, accountable, but we cannot see inside | The merchant / acquirer |
| **Scruple** | Evidence authority | The card network |

P1 and P3 are claims against the **tenant**, not the vendor. That is the whole
reason this is tractable: we are not trying to build something a hostile vendor
cannot subvert, any more than PCI tries to stop a hostile acquirer. We are
building something a hostile *tenant* cannot subvert, operated by a vendor who
is accountable for operating it correctly.

Naming this settles an argument that keeps recurring. "The vendor could just lie"
is true and is not the design's problem. "The tenant could just modify the
capture code" is the design's problem, and it is the one being solved here.

---

## 2. Where the component sits — and why one surface is not enough

ComfyUI produces retrievable output through **two independent paths**, and a
gate on either one alone is bypassable.

**Path 1 — disk.** `SaveImage` writes through
`folder_paths.get_save_image_path()` (`folder_paths.py:428`, called from
`nodes.py:483`) into the output directory; the tenant retrieves via
`GET /view` (`server.py:501`) or `GET /history/{prompt_id}`
(`server.py:902`) — or, with a shell in the container, by reading the file.

**Path 2 — WebSocket, never touching disk.** `server.py:1115-1204` sends binary
frames (`send_bytes`, `BinaryEventTypes.PREVIEW_IMAGE`,
`PREVIEW_IMAGE_WITH_METADATA`). ComfyUI ships a client example whose first line
states the bypass outright:

> `script_examples/websockets_api_example_ws_images.py:1-2` — *"an example that
> uses the websockets api and the SaveImageWebsocket node to get images directly
> without them being saved to disk"*

So:

- A **network gate alone** (today's canvas proxy — HTTP only, WS handed to a
  pass-through sidecar) misses nothing on Path 2 *if* it also gated WS, but
  misses a tenant with a shell reading `output/` directly.
- A **filesystem watcher alone** misses Path 2 entirely, because those bytes
  never exist as a file.

**The component must own both surfaces.** This is not belt-and-braces; each
covers what the other structurally cannot.

### Deployment shape

```
        tenant ──TLS──▶ ┌──────────────────┐
                        │ scruple-capture  │  ← the component. Vendor deploys.
                        │  · HTTP+WS gate  │    Vendor does not author.
                        │  · FS watcher    │    Holds the ratchet key.
                        │  · queue+drain   │
                        └────────┬─────────┘
                                 │ loopback only
                        ┌────────▼─────────┐
                        │ ComfyUI          │  ← tenant may have root here.
                        │  (tenant's       │    Assume they do.
                        │   container)     │
                        └────────┬─────────┘
                                 │ writes
                          [shared output volume] ──inotify──▶ component
```

Requirements on the vendor's topology — these are the P1 obligations, and
§7 turns them into probes:

1. ComfyUI binds loopback or a private network namespace. **The component is the
   only route to the tenant.**
2. The component runs in a separate container/namespace the tenant has no exec,
   debug, or filesystem access to.
3. The output volume is mounted into both; the tenant's container need not have
   it read-only (see §6 — hash-on-close makes later modification visible rather
   than preventable).

---

## 3. What the component captures

| Trigger | Source | Produces |
|---|---|---|
| `POST /prompt` (`server.py:915`) | gate, body teed | `workflow_hash`, `input_hash`; opens a pending record keyed by the returned `prompt_id` |
| `IN_CLOSE_WRITE` in the output volume | FS watcher | `content_hash` (SHA-256, streamed), `mime` **declared from the writing node's type, never guessed** (`capture.py` already refuses to guess) |
| WS binary frame, `PREVIEW_IMAGE*` | gate | `content_hash` of the frame payload |
| `executing` / `execution_success` WS messages | gate | correlation of output → `prompt_id` |

Leaf carries the fields the legacy v2.2 canvas leaf already carries —
`content_hash`, `input_hash`, `workflow_hash`, `model_fingerprints_hash`,
`machine_manifest_hash` — plus the component identity in §4. **`/v2/witness`
must stop dropping three of those before this ships** (see
`STUDIO_P1-P8_GRADE.md`).

---

## 4. The key schedule

### What we take from DUKPT, and what we do not

DUKPT's property set is exactly what H-4 needs:

- the base key never exists on the component;
- every event uses a distinct key, destroyed after use (**forward secrecy** —
  compromising a component now does not expose its past events);
- a **counter travels in the clear** with every event, so the receiving host
  sees the sequence;
- one component's compromise is not systemic.

We do **not** implement ANSI X9.24-3 literally. Its future-key registers exist
to give constrained hardware O(1) derivation at an arbitrary counter; we have no
such constraint, and hand-rolling X9.24-3 in Python is more risk than it buys.
We take the properties via a **forward-secure hash ratchet**. If a regulated
vendor requires the named standard, X9.24-3 can be swapped in behind the same
wire format — that is a reason to keep §4.3 stable, not a reason to start there.

**Do not call this DUKPT in customer-facing material.** Call it a forward-secure
per-event key ratchet, and cite DUKPT as the precedent.

### 4.1 Derivation

```
BDK                 32B, generated in and never leaving the signer HSM
                    (OCI Vault, the key already in the TOE)

component_id        UUIDv4, assigned at provisioning
IK  = HKDF-SHA256(ikm=BDK, salt=component_id, info="scruple/ik/v1", L=32)

state on component: (K_n, n)   ← K_0 = IK, n starts at 0

per event n:
  M_n   = HKDF-Expand(K_n, "scruple/mac/v1", 32)      # this event's MAC key
  K_n+1 = HKDF-Expand(K_n, "scruple/ratchet/v1", 32)  # next chain key
  mac   = HMAC-SHA256(M_n, canonical_preimage)
  zeroize(K_n, M_n); n += 1                            # irreversible
```

The component never holds `BDK` and cannot compute any other component's `IK`.
After event *n* it cannot recompute `M_0..M_n` — an attacker who takes the
container gets future events, not history.

### 4.2 Verification and reconciliation — the same mechanism

The server holds `BDK`, so it can derive any `IK` and ratchet to any counter. It
caches `(component_id → last_verified_n, K_n)` and ratchets forward to the
received counter.

**Gap detection is free.** Receiving `n = last + 4` means three events were
produced and not delivered; the leaf still verifies (the server ratchets
through), and the gap is recorded as a first-class fact. That is Missing-2 from
`L2_AS_THE_VENDOR_FLOOR.md` obtained from the key schedule rather than a
separate protocol — the KSN counter in payments does precisely this job.

Server-side rules:
- `n` **must** be strictly greater than `last_verified_n` for that component.
  Replay and reuse are rejected, not merely noticed.
- A gap is recorded on the leaf and on the component's record. It does not
  reject the leaf; **a suppressed event must not be able to invalidate the
  events around it**, or suppression becomes an attack on the vendor.
- No leaf for longer than the component's heartbeat window → the component is
  marked silent. Silence is the signal Kohya's design made invisible.

### 4.3 Wire format

Every submission carries, in the clear:

```json
{
  "component": {
    "component_id": "…uuid…",
    "build_measurement": "sha256:…",   // the image we published
    "counter": 41,
    "attestation": { "provider": "amd-sev-snp" | "none", "quote_ref": "…" }
  },
  "mac": "hex-hmac-sha256"
}
```

`build_measurement` is the analogue of a terminal's firmware version riding in
the transaction. Because we publish the component, the server can check the
claimed build is one we shipped — **the first time P1 is checkable at ingest
rather than attested.**

**The honest limit, stated in the spec rather than discovered later:** a
modified build can claim any measurement string. What it cannot do is produce a
valid MAC without the IK — which is why the key and the measurement are one
piece of work. Where the vendor has attestable compute, the IK is sealed to the
measurement and a modified build cannot unseal it; the leaf is `verified`
(H-5). Where they do not, the IK is software-protected, the binding is
assertion, and the leaf is `passthrough` and says so. That is the design
reporting its own strength, not a weakness in it.

### 4.4 Injection

1. Vendor creates a component instance in their Scruple console → one-time
   provisioning token, short TTL.
2. Component starts, `POST /v2/components/provision` with the token, its
   `build_measurement`, and an attestation quote if it has one.
3. Server derives `IK`, returns it over TLS, burns the token, records
   `(component_id, build, attestation posture, n=0)`.
4. Component seals `IK` — to the TPM/SEV measurement where available, else a
   `0600` file owned by a user the tenant is not.

If the seal cannot be restored on restart, the component re-provisions as a
**new** `component_id` starting at `n=0`. Never reuse a counter under an
existing id.

### 4.5 What this does to H-2

`SCRUPLE_WITNESS_SECRET` and `SCRUPLE_APPS_WITNESS_SECRET` are single long-lived
shared secrets used as though they were evidence. H-2 says the HMAC survives,
demoted to a transport-integrity check. **This is that demotion done properly:**
per-event, forward-secure, per-component, with the evidence claim carried by
H-1's ECDSA signature over the canonical record. H-4 as specified here closes
H-2 as a side effect.

---

## 5. Offline behaviour

`packages/scruple-host-sdk/queue.py` already implements the durable half — JSONL
on disk, `BACKOFF_SCHEDULE = [5, 30, 120, 600, 1800]`, survives process death.
Its own docstring records that it was ported into all six forks and **wired into
the failure path in none of them.** The component wires it.

Ratchet ordering matters and is easy to get wrong: **derive, MAC, ratchet, then
enqueue.** The counter is consumed when the MAC is computed, not when the
submission succeeds. A queued event keeps its counter; a retry re-sends the same
bytes, and the server's strict-increase rule treats a genuine duplicate as a
replay and drops it idempotently on `(component_id, counter)`.

---

## 6. What this does not solve — state it plainly

- **A tenant who works outside the sanctioned path.** Root in their container
  lets them run a second ComfyUI writing somewhere unwatched. They get no
  witnessed artifacts and their session reconciles as producing nothing. This is
  P2PE's posture exactly: the device protects what flows through it, and a
  merchant writing card numbers on paper is out of scope and committing fraud.
- **Modification after hashing.** Hash-on-`IN_CLOSE_WRITE` means a later edit is
  a new close event and a new hash — tamper-**evident**, not tamper-proof. That
  is the correct posture and should be described that way.
- **A hostile vendor.** Out of model (§1).
- **Retroactive proof of P1.** The component proves what it captured, not that
  the tenant lacked another route. Topology probes (§7) plus reconciliation are
  what make that claim checkable; neither makes it provable.

---

## 7. Conformance probes — converting part of P1 into a test

The Sonobuoy study found P1 not directly testable but partially probe-able. The
topology requirements in §2 are exactly the probe-able part. Run **from inside
the tenant container**, where the adversary sits; each must fail:

1. Reach ComfyUI directly, bypassing the component.
2. Reach the component's provisioning or admin surface.
3. Read the sealed `IK`.
4. Write to the output volume a file that produces no leaf within the drain
   window.
5. Retrieve output over WS and observe no corresponding leaf.
6. Submit a leaf with a counter at or below the component's last.

Probes 4 and 5 are the two-surface finding from §2 turned into tests, and they
are the ones that would have caught both Studio paths. Certification is per
**configuration**, EMV Level 3-style, re-run on material change — the vendor's
topology is the configuration.

---

## 8. Migration

1. Restore `input_hash`, `workflow_hash`, `model_fingerprints_hash` to
   `/v2/witness`. Nothing below matters until the leaf carries them.
2. Server: `components` table, provisioning endpoint, ratchet verification,
   counter/gap/silence accounting.
3. Component: gate (HTTP **and** WS — today's WS sidecar is pass-through), FS
   watcher, ratchet, queue wiring. Publish with a measurement.
4. Canvas migrates first: it already has the gate and already passes P1/P3/P4.
   It is a re-platform, not a rewrite, and it proves the component against a
   path we know works.
5. Kohya second, as the shape the pod-side hook cannot ever satisfy. **Until
   then, stop the hook's docstring claiming a leaf is signed and stop the route
   returning `ok: true` for an unwitnessed save.**
6. Retire `SCRUPLE_APPS_WITNESS_SECRET`. Not rotate — retire.

## 9. Open

- **Who holds the BDK?** Specified above as Scruple, which prevents a vendor
  forging their own tenants' leaves and makes component identity ours. The
  alternative — BDK in the vendor's KMS, us verifying against their derivation
  — suits an air-gapped or sovereignty-constrained vendor and weakens the claim
  correspondingly. Recommend Scruple-held as the default with vendor-held as a
  declared, receipt-visible variant.
- **Heartbeat window** is a tenant-visible parameter with a real tradeoff: short
  windows make silence a fast signal and make ordinary idleness noisy.
- **Does canvas's Modal deployment have attestable compute?** Determines whether
  the reference integration demonstrates `verified` or only `passthrough`. If
  not, we should build the reference against something that does, or we ship a
  reference implementation that cannot demonstrate its own strongest tier.
