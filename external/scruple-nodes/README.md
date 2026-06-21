# scruple-nodes — Scruple-managed ComfyUI custom-node forks

This directory holds **forks** of ComfyUI custom-node packs that
Scruple's canvas (on-host CPU ComfyUI at `canvas.stooges.ai`) and
runner (Modal-hosted GPU ComfyUI invoked from `/api/generate`) both
depend on. Each fork carries small Scruple-specific patches that
upstream wouldn't accept or hasn't accepted yet — the most common
case being **canvas registration on CPU hosts**, where some nodes
crash at `define_schema()` time because they assume CUDA devices
exist.

## Why forks instead of in-place edits

The on-host canvas's `custom_nodes/<name>` directory is a candidate
for clobbering at any moment:

- ComfyUI-Manager's "Update Node" button does a `git pull`
- Re-installing via Manager nukes the directory
- A re-deploy of the host could re-clone from upstream

In-place edits don't survive. Forks do. The pattern:

1. **Vendor upstream** as a git repository at `external/scruple-nodes/<name>/`
   with two starter branches:
   - `upstream-vendored` — the byte-identical upstream snapshot at the
     time we vendored it. Never modified, never `force-push`ed.
     `git remote add upstream <upstream-url>` is set on this branch.
   - `scruple-canvas-fork` — branches from `upstream-vendored`; carries
     our patches as ordinary commits. This is the branch the canvas
     (and Modal) check out.
2. **Symlink the canvas** in: `/data/reference/ui-inspire/ComfyUI/custom_nodes/<name>` is
   a symlink to `/data/scruple-web/external/scruple-nodes/<name>/`.
   ComfyUI's loader follows symlinks transparently. The upstream
   snapshot (if there was one) is moved to
   `external/scruple-nodes/_upstream-snapshots/<name>-<date>/` for
   archive — NEVER kept in `custom_nodes/` because ComfyUI would
   try to load it as a separate node pack.
3. **Modal references the fork by URL** in `modal/scruple_runner.py`'s
   image build:
   ```python
   "git clone --depth=1 --branch scruple-canvas-fork "
   "  https://github.com/<scruple-org>/<name> "
   "  /opt/ComfyUI/custom_nodes/<name>",
   ```
   Same branch, same patches → canvas and runner stay in lockstep.
   Modal containers have real CUDA so the CPU-fallback patches are
   no-ops there — semantics unchanged.

## Periodic upstream sync

Whenever we want a node's new upstream features:

```bash
cd external/scruple-nodes/<name>
git fetch upstream
git checkout upstream-vendored
git merge --ff-only upstream/main         # or upstream/master
git checkout scruple-canvas-fork
git rebase upstream-vendored              # replay our patches
# resolve any conflicts, then:
sudo systemctl restart comfyui.service    # canvas picks up changes
# modal deploy                            # runner picks up changes
```

If a rebase conflict shows our patch and upstream now collide
(e.g., upstream made the same fix), drop our commit:

```bash
git rebase -i upstream-vendored           # remove our commit
```

## Inventory

| Fork | Upstream | Branches | Why |
|---|---|---|---|
| `seedvr2_videoupscaler/` | `numz/ComfyUI-SeedVR2_VideoUpscaler` | `upstream-vendored` @ v2.5.22, `scruple-canvas-fork` (+1 commit) | DiT/VAE model loaders crash on CPU during `define_schema()`. Patch: `include_cpu=True` so the schema is non-empty on canvas. No-op on Modal (real CUDA). |

## Adding a new fork

```bash
NODE=<node-dir-name>
UPSTREAM=https://github.com/<owner>/<repo>.git

# 1. vendor
cp -a /data/reference/ui-inspire/ComfyUI/custom_nodes/$NODE \
      /data/scruple-web/external/scruple-nodes/$NODE
cd /data/scruple-web/external/scruple-nodes/$NODE
rm -rf .git __pycache__
git init -b upstream-vendored
git config user.email "scruple-nodes@stooges.ai"
git config user.name "scruple-nodes"
git add -A && git commit -m "vendor: upstream snapshot of $NODE"
git remote add upstream $UPSTREAM

# 2. branch for patches
git checkout -b scruple-canvas-fork

# 3. ... apply patches; commit with a "fork: <reason>" subject ...

# 4. archive in-place + symlink fork
cd /data/reference/ui-inspire/ComfyUI/custom_nodes
SNAPSHOT_DIR=/data/scruple-web/external/scruple-nodes/_upstream-snapshots/$NODE-$(date +%Y-%m-%d)
mkdir -p "$(dirname "$SNAPSHOT_DIR")"
mv $NODE "$SNAPSHOT_DIR"
ln -s /data/scruple-web/external/scruple-nodes/$NODE $NODE

# 5. verify
sudo systemctl restart comfyui.service
journalctl -u comfyui.service --since "2 min ago" | grep -E "IMPORT FAILED|installed failed"

# 6. update Modal image to pull from the same fork branch.
#    Edit modal/scruple_runner.py and modal deploy.
```

## GitHub push (when ready)

These forks aren't on GitHub yet — they're local-only. To publish:

1. Create a `scruple-nodes` GitHub org (or use a personal org).
2. For each fork directory:
   ```bash
   cd external/scruple-nodes/$NODE
   gh repo create scruple-nodes/$NODE --private --source=. --push
   # then push the fork branch:
   git push -u origin scruple-canvas-fork
   git push -u origin upstream-vendored
   ```
3. Update `modal/scruple_runner.py` to point at the published URL.
4. Optionally swap `--branch scruple-canvas-fork` for a tag if you
   want bit-for-bit reproducibility of which commit Modal pulled.

Repos should be **private by default** — the patches reference
internal context, and "scruple-nodes/seedvr2_videoupscaler" being
public would imply we're publishing a fork without coordinating
with upstream maintainers. If we want to upstream the fix instead,
the workflow is: PR against `numz/ComfyUI-SeedVR2_VideoUpscaler`,
keep our `scruple-canvas-fork` branch alive until the PR merges,
then collapse it back.
