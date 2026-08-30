"""Two real trainers, deliberately not the same shape.

The stand-in for a vendor's training stack. Neither is interesting as a
trainer — both do a handful of steps on a toy tensor on the CPU — and both are
interesting as *save paths*, because the save path is what ``model.write``
hooks and the two save paths are genuinely different:

**KohyaLike** saves through ``safetensors.torch.save_file``, the exact call
site ``public/pod-hooks/kohya_safetensors_hook.py`` monkey-patches. The file
carries a safetensors header: every layer name, shape and dtype, hashable
separately from the content.

**PlainPyTorch** saves through ``torch.save``, which writes a zip-wrapped
pickle. There is **no header**, so there is no structural fingerprint. It is
also not a checkpoint-specific call — the same function serialises optimizer
state and resume files — which is why the hook is scoped to a directory.

That second trainer is the WO's requirement and it earned its place: running
the contract over it is what turned "``model.write`` carries a header hash"
from a property of the hook into a property of the *format*.
"""

from __future__ import annotations

import os
from typing import Callable, Dict, List

try:
    import torch
    import safetensors.torch as safetensors_torch
except ImportError as e:  # pragma: no cover - environment guard
    raise SystemExit(
        f"[vendor-training] this example trains for real and needs torch + safetensors ({e}).\n"
        "                  pip install torch safetensors"
    )

__all__ = ["safetensors_torch", "torch", "make_base_model", "make_dataset", "KohyaLike", "PlainPyTorch"]


def make_dataset(root: str, n: int = 6) -> str:
    """A caption dataset in Kohya's own shape: image next to its .txt."""
    os.makedirs(root, exist_ok=True)
    for i in range(n):
        with open(os.path.join(root, f"{i:03d}.png"), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + bytes([i]) * 256)
        with open(os.path.join(root, f"{i:03d}.txt"), "w", encoding="utf-8") as f:
            f.write(f"a photo of subject {i}")
    return root


def make_base_model(path: str) -> str:
    """The weights the run starts from. Fingerprinted, not loaded by us."""
    safetensors_torch.save_file(
        {"unet.block.0.weight": torch.zeros(8, 8), "unet.block.0.bias": torch.zeros(8)},
        path,
        metadata={"model": "acme-base-v1"},
    )
    return path


class KohyaLike:
    """A LoRA-shaped trainer that saves safetensors. The Kohya call site."""

    framework = "kohya-ss"
    trainer = "lora-network"
    hyperparameters: Dict[str, object] = {
        # A learning rate is the value the float divergence bites on:
        # JavaScript spells 1e-5 as "0.00001" and Python as "1e-05".
        "learning_rate": 1e-5,
        "network_dim": 8,
        "network_alpha": 4.0,
        "max_train_steps": 3,
        "mixed_precision": "no",
    }

    def __init__(self, out_dir: str) -> None:
        self.out_dir = out_dir
        os.makedirs(out_dir, exist_ok=True)
        # Non-zero init on purpose. With both factors at zero the product and
        # its gradient are zero, the weights never move, and every checkpoint
        # comes out byte-identical — which the watcher correctly declines to
        # re-emit, and which would make this example look like it was dropping
        # events when it was doing exactly the right thing.
        self.down = torch.nn.Parameter(torch.full((8, 8), 0.10))
        self.up = torch.nn.Parameter(torch.full((8, 8), 0.05))

    def train(self, steps: int = 3, save_every: int = 2) -> List[str]:
        written = []
        optimiser = torch.optim.SGD([self.down, self.up], lr=self.hyperparameters["learning_rate"])
        target = torch.ones(8, 8)
        for step in range(1, steps + 1):
            optimiser.zero_grad()
            loss = ((self.down @ self.up) - target).pow(2).mean()
            loss.backward()
            optimiser.step()
            if step % save_every == 0 or step == steps:
                path = os.path.join(self.out_dir, f"acme-lora-{step:06d}.safetensors")
                # THE CALL SITE. Patched by install_safetensors_save_file_hook.
                safetensors_torch.save_file(
                    {"lora_down.weight": self.down.detach(), "lora_up.weight": self.up.detach()},
                    path,
                    metadata={"ss_steps": str(step), "ss_network_dim": "8"},
                )
                written.append(path)
        return written


class PlainPyTorch:
    """A plain training loop that saves with ``torch.save``. No header.

    Also saves an OPTIMIZER file through the same function, on purpose: that
    is what makes ``torch.save`` different from ``save_file``, and it is the
    reason the hook takes a directory scope.
    """

    framework = "pytorch"
    trainer = "torch-save-loop"
    hyperparameters: Dict[str, object] = {
        "learning_rate": 3e-4,
        "hidden": 8,
        "epochs": 2,
        "optimizer": "sgd",
        "weight_decay": 0.0,
    }

    def __init__(self, out_dir: str, scratch_dir: str) -> None:
        self.out_dir = out_dir
        self.scratch_dir = scratch_dir
        os.makedirs(out_dir, exist_ok=True)
        os.makedirs(scratch_dir, exist_ok=True)
        self.model = torch.nn.Linear(8, 8, bias=False)
        # See KohyaLike: a checkpoint that never changes is a checkpoint the
        # watcher is right to emit once.
        torch.nn.init.constant_(self.model.weight, 0.05)

    def train(self, epochs: int = 2) -> List[str]:
        written = []
        optimiser = torch.optim.SGD(
            self.model.parameters(), lr=self.hyperparameters["learning_rate"]
        )
        x, y = torch.ones(4, 8), torch.ones(4, 8)
        for epoch in range(1, epochs + 1):
            optimiser.zero_grad()
            torch.nn.functional.mse_loss(self.model(x), y).backward()
            optimiser.step()
            # NOT a checkpoint. Same function, different meaning — and the
            # scoped hook is what keeps it out of the leaf as a model write.
            torch.save(optimiser.state_dict(), os.path.join(self.scratch_dir, "optimizer.pt"))
            path = os.path.join(self.out_dir, f"epoch-{epoch:03d}.pt")
            torch.save(self.model.state_dict(), path)
            written.append(path)
        return written
