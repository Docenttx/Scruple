# `server-library` — the worked reference integration

WO-6 of `docs/canon/WO-SERIES-CANON-AS-FLOOR.md`. This is the placement
where Hugging Face and RunPod-serverless actually live: the vendor's own
backend calls the SDK, in a process the **tenant has no code execution in
at all**.

```
python3 examples/server-library-vendor/run_demo.py
```

It starts the CVM surrogate (`services/cvm-surrogate/`, port 8799) if it is
not already answering, starts a stub witness on a loopback port, and runs
four scenarios. Exit status is non-zero if any check fails.

---

## Read this before the code: what this tier actually is

`server-library` + `no-tenant-code` enforcement gets **P1 for free** — the
measured party cannot modify the code that measures them, because they
cannot run code in that process. **P3 is ordinary secret management.** Two
of the eight properties for nothing, which is why this is the shortest path
to a vendor running real traffic.

**And the leaf is still `passthrough`.**

`PLACEMENT_AND_SURFACES.md` §5.2's top-right cell: `server-library` with no
attestation yields `passthrough`. Nothing lifts a leaf to `verified` except
an attestation chained to a vendor root, and no verifier plugin in the
estate implements root chaining today. A free P1 buys two properties and
zero tiers.

The demo prints the tier in full on every run, and the SDK returns it on
every outcome, because this is the expectation gap a vendor would otherwise
discover at exactly the wrong moment — mid-sales-cycle, from a customer's
auditor.

---

## The four scenarios

| | What it shows |
|---|---|
| **1 · The happy path** | A leaf, a DSSE envelope, and a third party verifying it with only the envelope and the vendor's published key. Prints the whole assurance derivation. |
| **2 · The witness is unreachable** | The event is queued, the counter is **spent anyway** (§5: derive, MAC, ratchet, *then* enqueue), the second event does not block behind the first, no envelope is minted for an event the witness never saw, and the drain re-sends the **original** counters. |
| **3 · The placement does not permit the claim** | The same vendor's custom-handler configuration. `server-library` declared, `none` enforced → effective `unattested-client`, `can_claim: false`, and the SDK refuses **before a counter is spent**. |
| **4 · A tampered submission** | The stub recomputes the MAC over `component_preimage(body)` — the same function the component called — and refuses a body that changed in flight. An unauthenticated submission gets 401 before any verification happens at all (§10 C-6). |

Scenario 3 is `PLACEMENT_AND_SURFACES.md` §7.3, which calls itself the
single most commercially important line in that document: a vendor is not a
placement, a **configuration** is, and a bring-your-own-container or
`trust_remote_code` feature silently revokes the free P1 on that path
without touching the managed one.

---

## The files

| File | What it is |
|---|---|
| `vendor_backend.py` | **What a vendor writes.** 38 lines between the two markers, 30 of which are two constructor calls broken across lines. |
| `stub_witness.py` | A stand-in for scruple.ai's `/api/v2` surface. Verifies real MACs and refuses bad ones. |
| `kms_signer.py` | The vendor's signing key, through the CVM surrogate. |
| `run_demo.py` | The four scenarios, with assertions. |

### What a vendor writes, collapsed

```python
client = Client(host="acme-inference", integration_version="1.0.0",
                api_key=..., base_url=...)
client.attach(code_paths=[__file__])                       # once: the baseline

identity, ratchet = provision_component(                   # once per worker
    client, token=..., build_measurement=..., seal_path=...)

integration = ServerLibraryIntegration(
    client, component=identity, ratchet=ratchet,
    enforcement=PlacementEnforcement.NO_TENANT_CODE,
    envelope_signers=[kms_signer.signer()], seal_path=...)

outcome = integration.witness_file(path, mime="image/png")  # per artifact
```

Five calls. What is deliberately **absent** from it:

- no `try/except` around the witness call — `http.submit()` enqueues on
  failure inside its own control flow, and a vendor's own retry would
  double-send *and* re-MAC, meaning two counters for one event;
- no `mimetypes.guess_type()` — MIME is declared or it is absent, and a
  placeholder is a declaration that is false;
- nothing computing a posture — `integration.assurance()` reports one;
  nothing in vendor code may assert one.

Those are three of the six things `CANON_SKELETON.md` §5 says an adapter may
not do. The SDK owning them is what makes that list enforceable rather than
aspirational.

---

## Two seals, two scopes

A reader will otherwise assume there is one.

- The **ratchet MAC** (H-4 §4.3) covers which component, which counter,
  which build, and the leaf's hashes. It is what the witness verifies, and
  it is what makes a suppressed event visible as a gap.
- The **DSSE signature** covers the whole statement — the leaf verbatim plus
  the `scruple-vendor-baseline` predicate. It is what a third party checks.

The MAC does not cover the predicate, and that is a boundary rather than an
oversight: the predicate is the *vendor's* declaration about the *vendor's*
configuration, signed with the vendor's own key, and at `server-library` the
vendor is not the adversary — the tenant is, and the tenant is outside this
process.

The signing key belongs to the **vendor**, not to Scruple, which is why the
example signs through the CVM surrogate: its README frames it as a
wire-compatible stand-in for OCI KMS Crypto Sign, which is the shape a
vendor's real key custody has. The signatures are real ECDSA P-256 over a
real key; what is absent is any hardware that protected it — and that
absence is precisely why the attestation outcome is `none` and the leaf is
`passthrough`.

---

## What the stub witness is not

It reproduces the D-3 baseline handshake, §4.4 provisioning, §4.2 MAC
verification and gap accounting, and C-6's authenticate-first ordering. It
does **not** reproduce the Merkle chain, the leaf signature, or persistence,
and `witnessed: true` from it means only "this stub verified your MAC" —
strictly less than production means by it.

It exists because the real route is a Next.js handler that needs the whole
app, a database and a witness server, and a vendor evaluating the
integration should not need any of those to see a leaf come out. An example
that cannot be run is not a reference.

**Never point this at `127.0.0.1:5799`.** That is the production witness,
and a prior session polluted its audit log doing exactly that.
