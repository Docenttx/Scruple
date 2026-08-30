# scruple-capture — Kohya profile

The capture component (`../src/`) is written against ComfyUI. This directory is
Kohya, and it is **not** a copy with a different directory path: the artifact is
a file, so nothing can be withheld pending a leaf, and the three duties do not
translate one to one.

Read `docs/canon/KOHYA_REPLACEMENT.md` first. In short:

- **gate** applies *in part* — the training request on the way in, never the
  checkpoint on the way out;
- **watch** applies and is load-bearing rather than complementary;
- **submit** applies unchanged, and on a host with no fail-closed point it
  carries the most weight: a stopped ratchet counter is visible.

## Files

| | |
|---|---|
| `profile.ts` | duties, the four H-4 §2 topology obligations as a vendor declaration, and `resolveKohyaPlacement()` |
| `checkpoint-watch.ts` | `filesystem-watch` / `model.write` / `model_write`, hash on close, safetensors header hashed separately |
| `safetensors.ts` | header read and hashed from outside the writing process. No tensor data is ever read |
| `index.ts` | the runner, and its refusal |

## It refuses to start on a RunPod Pod

That is the behaviour, not a bug. A Pod is one container; a component in it
shares a filesystem and a PID namespace with a process the tenant can make run
arbitrary commands, so H-4 §2 obligation 2 fails and the declared `sidecar-gate`
resolves to `unattested-client`, where no leaf may be issued at all.

```
SCRUPLE_KOHYA_CHECKPOINT_VOLUME=/workspace/out
SCRUPLE_API_URL=https://scruple.stooges.ai
SCRUPLE_API_KEY=...                       # witness:write + component:provision
SCRUPLE_CAPTURE_PROVISIONING_TOKEN=spt_...  # first start only
SCRUPLE_CAPTURE_BASELINE_REF=<64-hex>

# All four default to false. Declaring one is the vendor's accountable act;
# H-4 §7 is where they get probed, from inside the tenant container.
SCRUPLE_KOHYA_TOPOLOGY_INGRESS_GATED=1
SCRUPLE_KOHYA_TOPOLOGY_COMPONENT_ISOLATED=1
SCRUPLE_KOHYA_TOPOLOGY_ALL_VOLUMES_WATCHED=1
SCRUPLE_KOHYA_TOPOLOGY_EGRESS_DENIED=1
```

Obligations 1 and 2 decide the tier. Obligations 3 and 4 are **coverage** and
are reported as caveats rather than moving it — a missing leaf is a different
failure from a weaker one, and modelling it as a tier hides it
(`PLACEMENT_AND_SURFACES.md` §2.2).
