"""What a vendor hosting training writes. All of it.

This is the artifact a vendor with their own trainer is actually handed, so
it is deliberately the shortest file in this directory. Everything outside
the INTEGRATION block is a stand-in for their stack.

WE DO NOT GET TO CHOOSE THEIR TOPOLOGY, WHICH IS THE WHOLE POINT
----------------------------------------------------------------
Studio's answer to Kohya is to remove the GUI and expose a job-submission API
instead (``docs/canon/KOHYA_REPLACEMENT.md`` §4). That answer is available to
us because we own the product surface. **A vendor may have no such freedom** —
they may have a UI they cannot remove, a customer contract that promises a
shell, or an image they do not build. So this file takes the topology as an
input and derives the tier from it, in all three shapes:

  * the vendor's backend orchestrates training       -> ``server-library``
  * the vendor can isolate the trainer               -> ``sidecar-gate``
  * the vendor can do neither                        -> ``unattested-client``,
                                                        and they are TOLD so
                                                        rather than sold to

:func:`attach` is one function for all three. Nothing in it declares a
posture; ``resolve_placement`` and ``assurance_for`` compute one, and the
third shape refuses before a provisioning token is spent.

THE LIMIT, BEFORE THE CODE
--------------------------
A checkpoint is a file. It is collected by a file browser, JupyterLab, ``scp``
or a remounted volume, and there is no point at which the bytes can be
withheld pending a leaf. There is **no fail-closed point on this host**, and
this integration does not pretend to give you one. What it gives you is the
counter in the clear:

    **You can get the bytes. You cannot leave the record undisturbed.**
"""

from __future__ import annotations

import os
from typing import Any, Optional, Sequence

# ── THE INTEGRATION ─────────────────────────────────────────────────────────
# Everything a vendor writes is between these two markers.

from scruple_api.model_write import (
    MODEL_WRITE_IN_PROCESS,
    MODEL_WRITE_VOLUME_WATCH,
    TrainingRun,
    dataset_root_hash,
    fingerprint_model_file,
    training_recipe,
)
from scruple_api.surface import Placement, PlacementEnforcement
from scruple_host_sdk import Client
from scruple_host_sdk.model_write import (
    CheckpointVolumeWatch,
    ModelWriteIntegration,
    install_safetensors_save_file_hook,
    install_torch_save_hook,
    provision_or_refuse,
)


def attach(
    *,
    base_url: str,
    api_key: str,
    provisioning_token: str,
    build_measurement: str,
    seal_path: str,
    declared_placement: Placement,
    enforcement: PlacementEnforcement,
    envelope_signers: Sequence[Any] = (),
    declared_mime: Optional[str] = None,
) -> ModelWriteIntegration:
    """Once per training worker, at startup.

    ``provision_or_refuse`` resolves the placement BEFORE it spends the
    one-time token: a configuration that may not issue a leaf must never hold
    a key, and refusing afterwards would seal an IK into a filesystem the
    measured party can read.
    """
    workdir = os.path.dirname(seal_path)
    client = Client(
        host="acme-training",
        integration_version="1.0.0",
        api_key=api_key,
        base_url=base_url,
        cache_dir=workdir,
        queue_path=os.path.join(workdir, "witness-queue.jsonl"),
    )
    client.attach(code_paths=[__file__])
    identity, ratchet = provision_or_refuse(
        client,
        token=provisioning_token,
        build_measurement=build_measurement,
        declared_placement=declared_placement,
        enforcement=enforcement,
        seal_path=seal_path,
    )
    return ModelWriteIntegration(
        client,
        component=identity,
        ratchet=ratchet,
        declared_placement=declared_placement,
        enforcement=enforcement,
        surface_profile=(
            MODEL_WRITE_IN_PROCESS
            if declared_placement is Placement.SERVER_LIBRARY
            else MODEL_WRITE_VOLUME_WATCH
        ),
        declared_mime=declared_mime,
        envelope_signers=envelope_signers,
        seal_path=seal_path,
    )


def commit_run(
    *,
    dataset_dir: str,
    base_model_path: str,
    framework: str,
    trainer: str,
    hyperparameters: dict,
    run_id: str,
) -> TrainingRun:
    """Once per training run, before the first step.

    The three commitments an image's provenance does not have. Numbers go
    through ``training_recipe``, which quotes floats — a learning rate of 1e-5
    serialises as ``1e-05`` in Python and ``0.00001`` in JavaScript, and a
    ``workflow_hash`` nobody outside our toolchain can reproduce is not
    evidence.
    """
    return TrainingRun(
        recipe=training_recipe(
            framework=framework,
            trainer=trainer,
            hyperparameters=hyperparameters,
        ),
        dataset=dataset_root_hash(dataset_dir),
        base_model_fingerprints={
            os.path.basename(base_model_path): fingerprint_model_file(base_model_path)
        },
        run_id=run_id,
    )


def instrument_in_process(integration, run_provider, *, safetensors_torch=None, torch=None,
                          checkpoint_dir=None):
    """Once per worker, for a vendor whose backend runs the trainer.

    Two trainers, one contract. Whichever module the vendor's trainer actually
    saves through gets patched; both land on ``model.write``.
    """
    uninstall = []
    if safetensors_torch is not None:
        uninstall.append(
            install_safetensors_save_file_hook(
                safetensors_torch, integration, run_provider,
                mime="application/x-safetensors",
            )
        )
    if torch is not None:
        # No `mime`: a torch pickle has no media type. Not "we did not look" —
        # there is none, and application/octet-stream would be a declaration
        # that is false.
        uninstall.append(
            install_torch_save_hook(
                torch, integration, run_provider, only_paths_under=checkpoint_dir,
            )
        )
    return lambda: [u() for u in uninstall]


def watch_checkpoint_volume(integration, volume, run_provider, **kwargs) -> CheckpointVolumeWatch:
    """Once per worker, for a vendor who CAN isolate the trainer.

    ``watch`` is the capture here, not a complement to a gate: nothing stands
    between the trainer and the volume, so there is nothing to hold bytes
    back. Call ``scan()`` on the vendor's own timer.
    """
    watch = CheckpointVolumeWatch(volume, integration, run_provider, **kwargs)
    watch.open()
    return watch


# ── END OF THE INTEGRATION ──────────────────────────────────────────────────
#
# Four functions and, collapsed, five calls a vendor makes:
#
#   integ = attach(..., declared_placement=..., enforcement=...)   # per worker
#   run   = commit_run(dataset_dir=..., base_model_path=..., ...)  # per run
#   instrument_in_process(integ, lambda: run, safetensors_torch=st)  # or
#   watch = watch_checkpoint_volume(integ, "/checkpoints", lambda: run)
#   integ.drain()                                                  # on shutdown
#
# What is NOT here, and must not appear here:
#
#   * `try/except` around a witness call. `http.submit()` enqueues on failure
#     inside its own control flow; a vendor's own retry would double-send AND
#     re-MAC, meaning two counters for one event.
#   * anything computing a posture. `integration.assurance()` reports one.
#     A vendor is not a placement; a CONFIGURATION is, and a vendor with a
#     managed path and a bring-your-own-container path has two of them.
#   * `mimetypes.guess_type()`, or an `application/octet-stream` default.
#   * a hash of a checkpoint directory. `observe_checkpoint()` refuses one
#     rather than inventing a preimage nobody can reproduce.


def drain_on_shutdown(integration) -> dict:
    return integration.drain()
