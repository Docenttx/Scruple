# Blender canonical-form prototype

Working prototype from the `asset-custody` study
(`docs/canon/custody-study/oss-cad.md`). **Preserved here because it lived in a
scratch directory outside the repo and would have been lost.**

## The defect it addresses

`.blend` is a memory dump — `writefile.c:42` records that `bh.old` is *"the
address at the time of writing the file"*. **Open a file, change nothing, save
two copies: three different SHA-256s.**

`/data/scruple-blender`'s `capture.py:206` hashes exactly that, so **our Blender
receipt chain cannot distinguish *changed* from *saved*.** The custody claim is
not weak, it is empty — every hash differs, so no hash means anything.

## What the prototype does

Pointer-normalises via the `DNA1` catalogue the file already carries, zeroes nine
named runtime fields, drops UI blocks. On a 261-block scene the original and two
resaves then produce **one digest**, while a **0.001 m translation still moves
it**. ~0.1 s, pure Python, **no Blender process required** — which matters,
because it means canonicalisation can run server-side rather than inside an
add-on the user controls.

## Status

**Prototype, not shipped.** Not wired into the Blender integration, not covered
by the leaf registry, and the sensitivity result above is the only evidence it
does not over-normalise. Before it ships it needs: a corpus wider than one
scene, a decision on whether the canonical form or the raw file is what the leaf
commits to (a change here is a leaf-scheme question — see
`docs/canon/CANONICALIZATION.md`), and the same cross-language vector treatment
the `workflow_hash` rule got in WO-21.

`canon2.py` is the working version; `canon.py` is the earlier fuller pass.
`cmp2.py` compares digests across resaves; `sens.py` is the sensitivity check.
