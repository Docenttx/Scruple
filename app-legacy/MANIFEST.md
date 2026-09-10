# SCRUPLE Studio — the application

**This directory is the app.** `package.json` `main` points at
`app-legacy/main-modular.js`; `app/` is a library it draws the host seam from.

**Source:** `D:\Scruple - Modular\Scruple Studio M\scruple-studio\` on the Windows
rig, via `/mnt/corpus/work/WindowsRigCorpus/`, dated **2026-04-06**.
**Imported:** 2026-09-10, WO-G1.

---

## What this replaced, and why it matters

Until WO-G1 this directory held a **2026-05-12 snapshot of `/mnt/project/`** — 51
files, and its own manifest warned that all four `capture/comfyui/` modules and
all seven `capture/training/` modules were missing, ending *"The bundle will not
run without them."* It was right. `main-modular.js` requires them at the top, so
the process could not reach its first statement.

The May date was misleading: it is when the snapshot was TAKEN, not when the code
was written. The April rig tree is **ahead** of it — stripe-payment and
blockchain-finalize modal states the snapshot has never heard of — and the
snapshot contributes **zero** files the rig lacks.

Three files the old manifest had "placed by inference" were placed wrongly:
`lock-executor-{blockchain,fiat,server}.js` belong in `lock/executors/`, which is
where `lock/lock-chain-lock.js:37` looks for them.

See `docs/G1-PORT-REPORT.md` for the full enumeration.

---

## Not imported from the rig

- `*.bak` (11 files) — editor backups.
- `apply_fiat_chainlock.py`, `renderer/apply_tsd_chainlock_modal.py` — one-shot
  patch scripts that have already been applied to the files here.
- `node_modules/`, `dist/`, `package-lock.json` — rebuilt locally.

## Added by WO-G1

- `config/witness-endpoint.js` — the ONE resolver for which witness this process
  may talk to. It refuses the production audit log unless told out loud. Read its
  header before changing a witness URL anywhere.
- `host-seam.js` — the join to the D/E-series host capabilities in `app/`.

## Changed by WO-G1

Six files, all listed in `docs/G1-PORT-REPORT.md` with a reason each. **Nothing in
`renderer/` was touched** — the interface is the spec, not old code.
