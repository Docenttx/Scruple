# `model.write` — the worked integration for a vendor hosting training

WO-20 of `docs/canon/WO-SERIES-2-PROVING-IT.md`. Findings, gaps and the
contract itself: **`docs/canon/MODEL_WRITE_HOOK.md`**.

```
python3 examples/vendor-training/run_demo.py
```

It starts the CVM surrogate (`services/cvm-surrogate/`, port 8799) if it is
not already answering, starts a stub witness on a loopback port, **trains for
real on the CPU with torch**, and runs six scenarios. Exit status is non-zero
if any check fails.

---

## Read this before the code: what you get, and what you do not

**You can get the bytes. You cannot leave the record undisturbed.**

That is the whole guarantee on a training host, and it is smaller than the one
ComfyUI gets. The reason is not our design and it is not fixable by more code:

- ComfyUI's artifacts are *retrieved through a surface the gate owns*, so the
  gate can await a leaf before forwarding a byte. **Fail-closed is available
  there.**
- **A checkpoint is a file.** It is written to a volume the trainer's own
  process owns, and every ordinary way of collecting it — the pod's file
  browser, JupyterLab, `scp`, remounting a network volume — reads bytes off
  disk without crossing anything we could stand in front of. **There is no
  point at which bytes can be withheld pending a leaf.**

So `watch` **is** the capture rather than a complement to a gate, there is no
fail-closed point, and what replaces "you cannot get the bytes without a leaf"
is the ratchet's counter travelling in the clear: a suppressed event leaves a
gap and a removed capture leaves silence, and both are visible without a
separate protocol. Scenario 4 demonstrates it rather than asserting it.

This is written down here because an overstated guarantee in vendor material
is worse than a narrower true one — the vendor will design against it.

---

## We do not get to choose your topology

Studio's answer to Kohya is to delete the GUI and expose a job-submission API
(`docs/canon/KOHYA_REPLACEMENT.md` §4). That answer is available to us because
**we own the product surface**. A vendor may not: a UI they cannot remove, a
contract that promises a shell, an image they do not build.

So `attach()` takes the topology as an input and derives the tier from it. All
three shapes, one code path, nothing declared:

| Your topology | Declared | Enforcement | Effective | Leaf |
|---|---|---|---|---|
| your backend orchestrates training; the customer supplies data and hyperparameters, never a command | `server-library` | `no-tenant-code` | `server-library` — P1 **holds** | `passthrough` |
| you can run the trainer in a container the capture is not in | `sidecar-gate` | `isolated-namespace` | `sidecar-gate` — P1 conditional | `passthrough` |
| the customer has a shell, a notebook, or `--network_module` | anything | `none` | **`unattested-client`** | **none** |

The third row is **refused, not downgraded**, and it is refused *before* the
one-time provisioning token is spent — so a configuration that may not issue a
leaf never holds a key on a filesystem the measured party can read.

**Note the second column of the last row.** A vendor is not a placement; a
*configuration* is. If you offer a managed training path **and** a
bring-your-own-container path, you have two configurations, two placements and
two tiers, and only one of them can claim anything.

**And note what `server-library` does not buy.** P1 is free there and the leaf
is *still* `passthrough`. Nothing lifts a leaf to `verified` except an
attestation chained to a vendor root, which is a property of your compute.

---

## The six scenarios

| | What it shows |
|---|---|
| **1 · `server-library`, Kohya-shaped** | The vendor's backend runs the trainer. A witnessed checkpoint, a DSSE envelope, a third party verifying it with only the envelope and the vendor's published key. The whole assurance derivation printed. |
| **2 · The second trainer, the same contract** | A plain `torch.save` loop. Same hook, same `kind`, same run commitment — and **no `header_hash`, because a pickle has no header.** Half the evidence is a property of the *format*. |
| **3 · `sidecar-gate`, watching a volume** | A vendor who can isolate. Surface becomes `filesystem-watch`, P1 becomes conditional — and the checkpoint is then copied straight off disk with no leaf in the way, because there is no fail-closed point. |
| **4 · The record is what you cannot disturb** | A tenant suppresses one submission and deletes the spool. The counter was already spent, and the next event the witness hears arrives with a visible gap. |
| **5 · The witness is unreachable** | Queue, drain, counters preserved. No envelope is minted for an event the witness never saw. |
| **6 · A topology that cannot claim** | Today's in-pod Kohya. Refused before a provisioning token is spent, and told why. |

---

## Two trainers, because one is not a contract

`CANON_SKELETON.md` §4.1 records `model.write` as specified from Kohya alone,
and WO-5's mapping exercise established that **a hook with one implementation
describes that integration rather than a contract.** So `trainers.py` carries
two save paths that are genuinely different:

- **`KohyaLike`** saves through `safetensors.torch.save_file` — the exact call
  site `public/pod-hooks/kohya_safetensors_hook.py` monkey-patches. The file
  has a safetensors header: every layer name, shape and dtype, hashable
  separately from the content, which is what distinguishes a metadata-only
  edit from a re-train.
- **`PlainPyTorch`** saves through `torch.save`, a zip-wrapped pickle.

Three things the second one surfaced that Kohya alone could not:

1. **`header_hash` does not exist for it.** The structural fingerprint is a
   property of the *format*, not of the hook. The leaf carries `null` — a
   recorded absence, never a guess.
2. **`torch.save` is not a checkpoint call.** The same function serialises
   optimizer state and resume files. The hook takes a directory scope for that
   reason; Kohya's call site needed none.
3. **A torch pickle has no media type.** Not "we did not look" — there is
   none. `mime` stays absent and the route records `mime_declared: false`.
   `application/octet-stream` would be a declaration that is false.

**And one thing that does not fit at all:** a `save_pretrained()` /
`accelerate` checkpoint is a **directory** of shards plus optimizer state plus
a config. `content_hash` is one hash of one file. `observe_checkpoint()`
**refuses** a directory rather than inventing a preimage the leaf registry does
not define — see `MODEL_WRITE_HOOK.md` §5.

---

## What a training leaf carries that an image's does not

| Commitment | Where it lands on the leaf | Status |
|---|---|---|
| training recipe (hyperparameters) | `workflow_hash` — on `kind=model_write` the recipe plays the graph's role | in the registry |
| dataset root | `input_hash`, as one `{kind: "dataset", hash}` input | in the registry; **the dataset-root preimage itself is not** |
| base-model fingerprint | `model_fingerprints_hash` | in the registry |
| checkpoint `header_hash` | **nowhere** | **not in the registry, not in `/v2/witness`, not in the MAC preimage** |

The last row is why every outcome carries `header_hash_covered: False`. The
field rides on the wire so a server that grows a slot needs no client change,
and until then the SDK says out loud that it is not sealed and not stored,
rather than letting its presence imply otherwise.

**One more, and it is training-specific.** A training recipe is mostly floats,
and JavaScript and Python do not spell floats the same way — `1e-5` is
`0.00001` in one and `1e-05` in the other, and `1.0` is `1` in one and `1.0`
in the other. `workflow_hash` is `sha256(canonicalize(doc))`, so a recipe with
a raw learning rate in it hashes differently depending on who canonicalizes
it, which reads exactly like a tampered document. `training_recipe()` commits
floats as their shortest round-trip **string** for that reason. It is a real
cost, paid deliberately; `MODEL_WRITE_HOOK.md` §6 has the alternative.

---

## The files

| File | What it is |
|---|---|
| `vendor_training_backend.py` | **What a vendor writes.** Four functions and five calls. 104 lines between the markers, 30 of them imports and most of the rest constructor arguments one per line. |
| `trainers.py` | Two real trainers. The stand-in for the vendor's own stack. |
| `run_demo.py` | The six scenarios, with assertions. |

The stub witness and the KMS signer are **imported from
`examples/server-library-vendor/`**, not copied. A second stub would be a
second protocol, and this example's subject is the hook, not the wire.

### What a vendor writes, collapsed

```python
integ = attach(..., declared_placement=..., enforcement=...)      # per worker
run   = commit_run(dataset_dir=..., base_model_path=..., ...)     # per run

instrument_in_process(integ, lambda: run, safetensors_torch=st)   # in-process
watch = watch_checkpoint_volume(integ, "/checkpoints", lambda: run)  # or sidecar

integ.drain()                                                     # on shutdown
```

What is deliberately **absent**:

- no `try/except` around a witness call — `http.submit()` enqueues on failure
  inside its own control flow, and a vendor's own retry would double-send
  *and* re-MAC, meaning two counters for one event;
- no `mimetypes.guess_type()` and no `application/octet-stream`;
- nothing computing a posture — `integration.assurance()` reports one;
- no hash of a checkpoint directory.

---

## What the stub witness is not

It reproduces the D-3 baseline handshake, §4.4 provisioning, §4.2 MAC
verification and gap accounting, and C-6's authenticate-first ordering. It does
**not** reproduce the Merkle chain, the leaf signature, or persistence, and
`witnessed: true` from it means only "this stub verified your MAC".

It also does not reproduce `/v2/witness`'s handling of `training`,
`model_fingerprints` or `input_hash` — those are computed by the real route
from the same formulas this SDK mirrors, and the vectors that hold the two
languages together live in `test/vectors/`.

**Never point this at `127.0.0.1:5799`.** That is the production witness, and a
prior session polluted its audit log doing exactly that.
