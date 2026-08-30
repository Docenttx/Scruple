#!/usr/bin/env python3
"""A vendor hosting training, end to end, in six scenarios.

    python3 examples/vendor-training/run_demo.py

WO-20. Starts the CVM surrogate (services/cvm-surrogate, port 8799) if it is
not already answering, starts a stub witness on a loopback port, TRAINS FOR
REAL on the CPU with torch, and runs:

  1. SERVER-LIBRARY, KOHYA-SHAPED — a witnessed checkpoint, an envelope, and a
     third party verifying it. The whole assurance derivation printed.
  2. THE SECOND TRAINER, SAME CONTRACT — a plain torch.save loop. No header,
     therefore no structural fingerprint, therefore a null in the leaf.
  3. SIDECAR-GATE, WATCHING A VOLUME — and the honest limit demonstrated: the
     checkpoint is read straight off disk with no leaf in the way, because
     there is no fail-closed point on a host whose artifact is a file.
  4. THE RECORD IS WHAT YOU CANNOT DISTURB — a suppressed submission shows up
     as a counter gap the next time the component is heard from.
  5. THE WITNESS IS UNREACHABLE — queue, drain, counters preserved.
  6. A TOPOLOGY THAT CANNOT CLAIM — today's in-pod Kohya. Refused before a
     provisioning token is spent, not sold a lower tier.

Exit status is non-zero if any scenario does not do what it says.

NEVER POINT THIS AT 127.0.0.1:5799. That is the production witness.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SIBLING = os.path.join(REPO, "examples", "server-library-vendor")
sys.path[:0] = [
    os.path.join(REPO, "packages", "scruple-api"),
    os.path.join(REPO, "packages", "scruple-host-sdk"),
    HERE,
    # The stub witness and the KMS signer are the sibling example's, imported
    # rather than copied: a second stub would be a second protocol, and this
    # example's subject is the hook, not the wire.
    SIBLING,
]

import kms_signer  # noqa: E402
import stub_witness  # noqa: E402
import trainers  # noqa: E402
import vendor_training_backend as vendor  # noqa: E402
from scruple_api.model_write import dataset_root_hash, observe_checkpoint  # noqa: E402
from scruple_api.surface import Placement, PlacementEnforcement  # noqa: E402
from scruple_host_sdk.envelope import open_leaf_attestation  # noqa: E402
from scruple_host_sdk.server_library import PlacementRefused  # noqa: E402

BUILD = "sha256:" + "ef" * 32
FAILURES: list = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"    {'PASS' if condition else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))
    if not condition:
        FAILURES.append(label)


def rule(title: str) -> None:
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def print_posture(integ) -> None:
    a = integ.assurance()
    print(f"\n  placement declared   {integ.resolution.declared.value}")
    print(f"  enforcement          {integ.resolution.enforcement.value}")
    print(f"  placement effective  {integ.resolution.effective.value}")
    print(f"  surface              {integ.profile.surface.value}")
    print(f"  fidelity             {integ.profile.fidelity.value}")
    print(f"  P1                   {a.p1.value}")
    print(f"  P3                   {a.p3.value}")
    print(f"  LEAF TIER            {a.leaf}")
    print(f"  can claim            {a.can_claim}")
    print(f"\n  {a.reason}\n")


def settle_and_scan(watch, clock, window: float = 30.0):
    """Drive the watcher the way a vendor's timer would.

    Two scans, deliberately: the first records size and mtime for a file it
    has not seen in this state, the second emits it once it has been stable
    for the settle window. A single scan emitting immediately would be the
    partial-hash bug the window exists to avoid.
    """
    watch.scan()
    clock[0] += window
    return watch.scan()


def start_surrogate() -> None:
    if kms_signer.health():
        print("[demo] CVM surrogate already answering on 127.0.0.1:8799")
        return
    keydir = tempfile.mkdtemp(prefix="scruple-surrogate-")
    atexit.register(shutil.rmtree, keydir, True)
    env = {**os.environ, "SURROGATE_KEY_PATH": os.path.join(keydir, "key.pem")}
    proc = subprocess.Popen(
        [sys.executable, os.path.join(REPO, "services", "cvm-surrogate", "surrogate.py")],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    atexit.register(proc.terminate)
    for _ in range(50):
        if kms_signer.health():
            print("[demo] started the CVM surrogate on 127.0.0.1:8799")
            return
        time.sleep(0.1)
    raise SystemExit(
        "[demo] the CVM surrogate did not come up. Start it by hand:\n"
        "         python3 services/cvm-surrogate/surrogate.py"
    )


def attach(workdir, *, base_url, declared, enforcement, mime=None, signers=True):
    os.makedirs(workdir, exist_ok=True)
    component_id = str(uuid.uuid4())
    token = f"tok_{uuid.uuid4().hex}"
    stub_witness.issue_provisioning_token(component_id, token)
    return vendor.attach(
        base_url=base_url,
        api_key=stub_witness.STUB_API_KEY,
        provisioning_token=token,
        build_measurement=BUILD,
        seal_path=os.path.join(workdir, "component.seal"),
        declared_placement=declared,
        enforcement=enforcement,
        declared_mime=mime,
        envelope_signers=[kms_signer.signer()] if signers else [],
    )


def main() -> int:
    start_surrogate()
    _srv, witness_url = stub_witness.start()
    print(f"[demo] stub witness on {witness_url}")

    root = tempfile.mkdtemp(prefix="scruple-vendor-training-")
    atexit.register(shutil.rmtree, root, True)

    dataset = trainers.make_dataset(os.path.join(root, "dataset"))
    base_model = trainers.make_base_model(os.path.join(root, "base.safetensors"))
    commitment = dataset_root_hash(dataset)
    print(
        f"[demo] dataset {commitment.file_count} files -> root "
        f"{commitment.root_hash[:16]}…, base model fingerprinted"
    )

    # ---------------------------------------------------------------- 1
    rule("1 · SERVER-LIBRARY, KOHYA-SHAPED — the vendor's backend runs the trainer")
    print(
        "\n  The vendor orchestrates training themselves; the customer supplies a dataset\n"
        "  and hyperparameters and has no code execution in this process. That is\n"
        "  `no-tenant-code`, and P1 is free — and the leaf is STILL `passthrough`,\n"
        "  because nothing lifts a leaf to `verified` except an attestation chained to a\n"
        "  vendor root. PLACEMENT_AND_SURFACES.md §5.2, top-right cell."
    )
    w1 = os.path.join(root, "worker-1")
    integ = attach(w1, base_url=witness_url,
                   declared=Placement.SERVER_LIBRARY,
                   enforcement=PlacementEnforcement.NO_TENANT_CODE,
                   mime="application/x-safetensors")
    print_posture(integ)

    kohya = trainers.KohyaLike(os.path.join(w1, "checkpoints"))
    run = vendor.commit_run(
        dataset_dir=dataset, base_model_path=base_model,
        framework=kohya.framework, trainer=kohya.trainer,
        hyperparameters=kohya.hyperparameters, run_id="run-kohya-1",
    )
    outcomes: list = []
    uninstall = vendor.instrument_in_process(
        integ, lambda: run, safetensors_torch=trainers.safetensors_torch
    )
    # The vendor's own trainer, unmodified. Nothing below knows about Scruple.
    written = kohya.train(steps=3, save_every=2)
    uninstall()
    print(f"  trained {len(written)} checkpoints through safetensors.torch.save_file")

    # The hook does not return its outcomes to the caller — the trainer's save
    # signature belongs to the trainer, not to us — so the demo reads the
    # witness's own record, which is what an auditor would do too.
    check("every checkpoint the trainer wrote reached the witness",
          len(stub_witness.verified_events) == len(written),
          f"{len(written)} checkpoints, {len(stub_witness.verified_events)} verified events")

    # One explicit call, so the demo can show a leaf and an envelope.
    explicit = integ.witness_checkpoint(written[-1], run, mime="application/x-safetensors")
    print(f"\n  leaf_id       {explicit.leaf_id}")
    print(f"  content_hash  {explicit.content_hash}")
    print(f"  header_hash   {explicit.header_hash}")
    print(f"  workflow_hash {explicit.workflow_hash}   (the training recipe)")
    print(f"  input_hash    {explicit.input_hash}   (the dataset root)")
    print(f"  model_fp_hash {explicit.model_fingerprints_hash}   (the base model)")
    print(f"  counter       {explicit.counter}")
    print(f"  witnessed     {explicit.witnessed}")
    print(f"  leaf_status   {explicit.leaf_status}")

    check("the witness verified the component's MAC", explicit.witnessed is True)
    check("the tier is passthrough, NOT verified — §5.2's top-right cell",
          explicit.leaf_status == "passthrough",
          "P1 is free at server-library and buys no tier at all")
    check("the leaf commits to the dataset, the recipe and the base model",
          all([explicit.input_hash, explicit.workflow_hash, explicit.model_fingerprints_hash]))
    check("the checkpoint carries a structural fingerprint",
          explicit.header_hash is not None,
          "safetensors header hashed separately from content")
    check("…and the leaf does NOT yet carry it",
          explicit.header_hash_covered is False,
          "no registry field, no /v2 body field, not in the MAC preimage — MODEL_WRITE_HOOK.md §4")
    check("fidelity is as-written, not as-delivered",
          integ.profile.fidelity.value == "as-written",
          "nothing was delivered; the trainer wrote a file and it was hashed")

    opened = open_leaf_attestation(explicit.envelope, [kms_signer.verifier()])
    check("the DSSE envelope verifies against the vendor's published key", True)
    check("the subject digest is the checkpoint's own sha256",
          opened.statement["subject"][0]["digest"]["sha256"] == explicit.content_hash,
          "re-derivable by anyone holding the file")
    check("the predicate's derived posture agrees",
          opened.predicate["leaf_status"] == "passthrough"
          and opened.predicate["properties"]["p1"] == "holds")

    # ---------------------------------------------------------------- 2
    rule("2 · THE SECOND TRAINER, THE SAME CONTRACT — a plain torch.save loop")
    print(
        "\n  A hook with one implementation describes that integration rather than a\n"
        "  contract (WO-5). So: a different trainer, a different save call, a different\n"
        "  file format, the same `model.write`. What it surfaced is that HALF THE\n"
        "  EVIDENCE IS A PROPERTY OF THE FORMAT: a torch pickle has no safetensors\n"
        "  header, so there is no structural fingerprint to record, and the leaf says\n"
        "  so with a null rather than with a guess.\n"
    )
    w2 = os.path.join(root, "worker-2")
    integ2 = attach(w2, base_url=witness_url,
                    declared=Placement.SERVER_LIBRARY,
                    enforcement=PlacementEnforcement.NO_TENANT_CODE)
    plain = trainers.PlainPyTorch(os.path.join(w2, "checkpoints"), os.path.join(w2, "scratch"))
    run2 = vendor.commit_run(
        dataset_dir=dataset, base_model_path=base_model,
        framework=plain.framework, trainer=plain.trainer,
        hyperparameters=plain.hyperparameters, run_id="run-plain-1",
    )
    before = len(stub_witness.verified_events)
    uninstall2 = vendor.instrument_in_process(
        integ2, lambda: run2, torch=trainers.torch,
        checkpoint_dir=os.path.join(w2, "checkpoints"),
    )
    written2 = plain.train(epochs=2)
    uninstall2()
    from_hook = len(stub_witness.verified_events) - before

    pt = integ2.witness_checkpoint(written2[-1], run2)
    print(f"  checkpoint    {os.path.basename(written2[-1])}")
    print(f"  content_hash  {pt.content_hash}")
    print(f"  header_hash   {pt.header_hash}")
    print(f"  workflow_hash {pt.workflow_hash}   (a DIFFERENT recipe vocabulary)")
    check("the same hook witnessed a completely different trainer",
          pt.witnessed is True and pt.kind == "model_write" and pt.hook == "model.write")
    check("header_hash is NULL — the format has no header, and that is recorded",
          pt.header_hash is None,
          "not a failure to look; there is nothing there to look at")
    check("no MIME was declared, and none was invented",
          integ2.declared_mime is None,
          "a torch pickle has no media type; octet-stream would be a false declaration")
    check("the recipe hash differs from the Kohya run's",
          pt.workflow_hash != explicit.workflow_hash,
          "different framework, different hyperparameter vocabulary")
    check("the optimizer file was NOT witnessed as a model write",
          from_hook == len(written2),
          f"{from_hook} leaves for {len(written2)} checkpoints; torch.save also wrote "
          f"{plain.hyperparameters['epochs']} optimizer files outside the scoped "
          "directory and none became a leaf")
    hp = json.loads(json.dumps(run2.recipe))["hyperparameters"]
    check("float hyperparameters are quoted so the hash survives another language",
          hp["learning_rate"] == "0.0003" and isinstance(hp["hidden"], int),
          "JS spells 1e-5 '0.00001' and Python '1e-05'; integers are portable and left alone")

    # ---------------------------------------------------------------- 3
    rule("3 · SIDECAR-GATE — the vendor CAN isolate the trainer, and watch is the capture")
    print(
        "\n  A different vendor, a different topology, and we do not get to choose it:\n"
        "  this one runs the trainer in a container the capture is not in, and mounts\n"
        "  the checkpoint volume into the component's namespace. Surface becomes\n"
        "  `filesystem-watch`. P1 is now CONDITIONAL rather than free, and the\n"
        "  conditions are named so they can be probed.\n"
        "\n  AND HERE IS THE LIMIT, STATED RATHER THAN IMPLIED. ComfyUI's gate can block:\n"
        "  it awaits the leaf before forwarding a byte. A checkpoint is a FILE. It is\n"
        "  collected by a file browser, JupyterLab, scp, a remounted volume — there is\n"
        "  no point at which the bytes can be withheld pending a leaf. So `watch` is\n"
        "  the capture, not a complement to a gate, and there is no fail-closed point.\n"
    )
    w3 = os.path.join(root, "worker-3")
    volume = os.path.join(w3, "checkpoints")
    os.makedirs(volume, exist_ok=True)
    integ3 = attach(w3, base_url=witness_url,
                    declared=Placement.SIDECAR_GATE,
                    enforcement=PlacementEnforcement.ISOLATED_NAMESPACE,
                    mime="application/x-safetensors")
    print_posture(integ3)

    clock = [1000.0]
    isolated = trainers.KohyaLike(volume)
    run3 = vendor.commit_run(
        dataset_dir=dataset, base_model_path=base_model,
        framework=isolated.framework, trainer=isolated.trainer,
        hyperparameters=isolated.hyperparameters, run_id="run-isolated-1",
    )
    watch = vendor.watch_checkpoint_volume(
        integ3, volume, lambda: run3, settle_s=15.0, clock=lambda: clock[0],
        log=lambda line: print(f"  [watch] {line}"),
    )
    isolated.train(steps=2, save_every=2)
    check("nothing is emitted before the settle window", watch.scan() == [],
          "a multi-gigabyte checkpoint is written over tens of seconds; a short window "
          "slices it into partial hashes, which on a checkpoint is indistinguishable "
          "from tampering")
    clock[0] += 30
    emitted = watch.scan()
    check("the checkpoint was witnessed from outside the trainer's namespace",
          len(emitted) == 1 and emitted[0].witnessed,
          f"surface={integ3.profile.surface.value} fidelity={integ3.profile.fidelity.value}")

    # THE LIMIT, DEMONSTRATED RATHER THAN ASSERTED.
    checkpoint = emitted[0]
    stolen = os.path.join(root, "collected-by-scp.safetensors")
    shutil.copyfile(
        os.path.join(volume, sorted(os.listdir(volume))[-1]), stolen
    )
    facts = observe_checkpoint(stolen)
    check("the bytes CAN be collected with nothing in the way",
          facts.content_hash == checkpoint.content_hash,
          "a plain file copy — a file browser, JupyterLab and scp are all this")
    print(
        "\n  That copy succeeded and it was always going to. What did not happen is the\n"
        "  part that matters: the leaf for that checkpoint already exists, its counter\n"
        "  is spent, and the record is what the tenant cannot quietly alter.\n"
    )

    # ---------------------------------------------------------------- 4
    rule("4 · THE RECORD IS WHAT YOU CANNOT DISTURB — a suppressed event is a gap")
    print(
        "\n  Losing fail-closed sounds like losing everything. It is not. What replaces\n"
        "  'you cannot get the bytes without a leaf' is 'you cannot get the bytes AND\n"
        "  leave the record looking undisturbed' — H-4 §4.2's gap accounting, obtained\n"
        "  free from the key schedule.\n"
        "\n  Below: a tenant intercepts one submission and deletes the spool that would\n"
        "  have retried it. The counter was already spent. The next event the witness\n"
        "  hears from this component arrives one higher than it should.\n"
    )
    good_url, integ3.client.base_url = integ3.client.base_url, "http://127.0.0.1:1"
    isolated.train(steps=4, save_every=2)
    suppressed = settle_and_scan(watch, clock)
    check("the suppressed events still spent their counters",
          len(suppressed) > 0 and all(o.queued for o in suppressed),
          f"{len(suppressed)} undelivered, counters {[o.counter for o in suppressed]}")
    # The tenant deletes the queue file — the one thing they CAN reach.
    with open(integ3.client.queue.path, "w", encoding="utf-8"):
        pass
    integ3.client.base_url = good_url

    before_events = len(stub_witness.verified_events)
    isolated.train(steps=6, save_every=2)
    settle_and_scan(watch, clock)
    fresh = stub_witness.verified_events[before_events:]
    gaps = [e["gap"] for e in fresh]
    print(f"  the witness saw counters {[e['counter'] for e in fresh]} with gaps {gaps}")
    check("the witness can see that events are missing", any(g > 0 for g in gaps),
          "the counter travels in the clear; suppression is visible without a "
          "separate protocol")

    # ---------------------------------------------------------------- 5
    rule("5 · THE WITNESS IS UNREACHABLE — queue, drain, counters preserved")
    w5 = os.path.join(root, "worker-5")
    integ5 = attach(w5, base_url=witness_url,
                    declared=Placement.SERVER_LIBRARY,
                    enforcement=PlacementEnforcement.NO_TENANT_CODE,
                    mime="application/x-safetensors")
    trainer5 = trainers.KohyaLike(os.path.join(w5, "checkpoints"))
    run5 = vendor.commit_run(
        dataset_dir=dataset, base_model_path=base_model,
        framework=trainer5.framework, trainer=trainer5.trainer,
        hyperparameters=trainer5.hyperparameters, run_id="run-offline-1",
    )
    files5 = trainer5.train(steps=4, save_every=2)
    good5, integ5.client.base_url = integ5.client.base_url, "http://127.0.0.1:1"
    q1 = integ5.witness_checkpoint(files5[0], run5)
    q2 = integ5.witness_checkpoint(files5[1], run5)
    print(f"  first  queued={q1.queued} counter={q1.counter} envelope={q1.envelope}")
    print(f"  second queued={q2.queued} counter={q2.counter} depth={integ5.queue_depth}")
    check("the checkpoint is durably queued, not lost",
          q1.queued is True and integ5.queue_depth == 2)
    check("the counter was spent anyway — derive, MAC, ratchet, THEN enqueue",
          (q1.counter, q2.counter) == (0, 1))
    check("one undeliverable checkpoint did not silence the component",
          q2.counter == 1,
          "silence is what the design makes visible; blocking would hide it")
    check("no envelope was minted for an event the witness never saw",
          q1.envelope is None,
          "attesting it would assert something that did not happen")
    integ5.client.base_url = good5
    drained = integ5.drain()
    print(f"  drained: {drained}")
    check("the queue drained on reconnect",
          drained["succeeded"] == 2 and integ5.queue_depth == 0)
    replayed = [e["counter"] for e in stub_witness.verified_events[-2:]]
    check("the drained events carried their ORIGINAL counters", replayed == [0, 1],
          f"the witness saw {replayed} — a re-MAC would have meant two counters for one event")

    # ---------------------------------------------------------------- 6
    rule("6 · A TOPOLOGY THAT CANNOT CLAIM — refused before a token is spent")
    print(
        "\n  This is today's Kohya on a RunPod Pod, and it is the shape a vendor is most\n"
        "  likely to arrive with: one container, the trainer's own UI exposed, the\n"
        "  tenant holding a shell inside it. The capture code is readable and editable\n"
        "  by the party being measured, so `sidecar-gate` was a declaration and not a\n"
        "  boundary. It resolves to `unattested-client`, where NO LEAF MAY BE ISSUED —\n"
        "  and note it is refused BEFORE the one-time provisioning token is spent, so\n"
        "  the deployment never seals a key into a filesystem the tenant can read.\n"
    )
    w6 = os.path.join(root, "worker-6")
    os.makedirs(w6, exist_ok=True)
    token6 = f"tok_{uuid.uuid4().hex}"
    stub_witness.issue_provisioning_token(str(uuid.uuid4()), token6)
    try:
        vendor.attach(
            base_url=witness_url, api_key=stub_witness.STUB_API_KEY,
            provisioning_token=token6, build_measurement=BUILD,
            seal_path=os.path.join(w6, "component.seal"),
            declared_placement=Placement.SIDECAR_GATE,
            enforcement=PlacementEnforcement.NONE,
        )
        check("the topology is refused", False)
    except PlacementRefused as e:
        check("the topology is refused", True)
        for line in str(e).splitlines():
            print(f"  {line}")
    check("no key was sealed for a configuration that may not issue a leaf",
          not os.path.exists(os.path.join(w6, "component.seal")),
          "H-4 §7 probe 3 — an IK on a filesystem the measured party can read")
    check("the provisioning token was never spent",
          token6 in stub_witness._tokens,
          "a refusal after provisioning would burn a one-time token")
    print(
        "\n  WHAT THIS VENDOR IS TOLD, rather than sold: their events may be RECORDED as\n"
        "  declared and may never be reported as witnessed (D-8). The route to a leaf is\n"
        "  to remove the tenant's code execution or to isolate the trainer — scenarios 1\n"
        "  and 3 — and neither is something we can do on their behalf."
    )

    rule("SUMMARY")
    if FAILURES:
        print(f"  {len(FAILURES)} check(s) failed:")
        for f in FAILURES:
            print(f"    - {f}")
        return 1
    print(
        "  All checks passed.\n\n"
        "  Two trainers, one contract, three placements, one derivation. The tier this\n"
        "  integration earns is `passthrough` at both placements that can claim at all —\n"
        "  a `verified` leaf needs an attestation chained to a vendor root, which is a\n"
        "  property of the COMPUTE and not of the integration.\n\n"
        "  And the guarantee, stated the way it should be stated to a vendor:\n"
        "  YOU CAN GET THE BYTES. YOU CANNOT LEAVE THE RECORD UNDISTURBED."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
