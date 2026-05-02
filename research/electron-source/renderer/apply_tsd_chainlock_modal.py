"""
apply_tsd_chainlock_modal.py
----------------------------
Applies the tsd-chain-lock-confirm modal changes to:
  - render-main.js         (add to allowlist)
  - render-wallet.js       (add modal HTML to renderGlobalModal)
  - render-wallet-testnet.js (add modal HTML to renderGlobalModal)

Usage (from PowerShell, run from the renderer/ folder):
  python apply_tsd_chainlock_modal.py

Or with explicit paths:
  python apply_tsd_chainlock_modal.py --dir "E:\\Scruple Beta\\SCRUPLE-STUDIO\\renderer"
"""

import sys
import os
import shutil
import argparse

# ---------------------------------------------------------------------------
# The new modal HTML block inserted before 'confirm-chain-lock' in both
# render-wallet files. Uses single-quoted JS template literal delimiters
# so Python's triple-quote has no conflicts.
# ---------------------------------------------------------------------------
TSD_CHAIN_LOCK_MODAL = r"""
  // --- TSD chain lock confirm (fiat mode) ---
  if (walletModal === 'tsd-chain-lock-confirm') {
    const project = State.get('pendingLockProject');
    const projectName = project ? escapeHtml(project.name) : 'this project';
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #a855f7; box-shadow: 0 8px 32px rgba(168,85,247,0.3);">
          <div class="modal-header" style="background: linear-gradient(135deg, #4c1d95, #5b21b6); border-bottom: 1px solid #a855f7;">
            <h3>⛓ Chain Lock — TSD Payment</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>You are about to chain lock <strong>${projectName}</strong>.</p>
            <p style="margin-top:12px;">The Oracle will anchor your provenance package to the Ravencoin blockchain, IPFS, and Arweave on your behalf.</p>
            <div style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:6px;padding:12px;margin:16px 0;">
              <div style="display:flex;justify-content:space-between;color:#e6edf3;font-size:13px;margin-bottom:6px;">
                <span>Basic Chain Lock</span><span style="color:#a855f7;font-weight:600;">50 TSD</span>
              </div>
              <div style="display:flex;justify-content:space-between;color:#e6edf3;font-size:13px;">
                <span>Pinned Chain Lock (IPFS)</span><span style="color:#a855f7;font-weight:600;">65 TSD</span>
              </div>
            </div>
            <p style="color:#f59e0b;font-weight:600;font-size:13px;">This action is permanent and cannot be undone.</p>
            <div class="modal-actions" style="margin-top:20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-tsd-chain-lock" data-lock-tier="basic" style="background:#7c3aed;border-color:#7c3aed;">Basic Lock (50 TSD) →</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-tsd-chain-lock" data-lock-tier="pinned" style="background:#6d28d9;border-color:#6d28d9;margin-left:6px;">Pinned Lock (65 TSD) →</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

"""

# ---------------------------------------------------------------------------
# Allowlist addition for render-main.js
# ---------------------------------------------------------------------------
OLD_ALLOWLIST = "|| walletModal === 'tsd-insufficient') {"
NEW_ALLOWLIST  = "|| walletModal === 'tsd-insufficient' || walletModal === 'tsd-chain-lock-confirm') {"

# ---------------------------------------------------------------------------
# Anchor string: insert TSD block immediately before confirm-chain-lock
# in both wallet files. The anchor is unique in both files.
# ---------------------------------------------------------------------------
CHAIN_LOCK_ANCHOR = "  if (walletModal === 'confirm-chain-lock') {"


def backup(path):
    bak = path + '.bak'
    shutil.copy2(path, bak)
    print(f'  Backup created: {bak}')


def patch_file(path, old, new, description):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    count = content.count(old)
    if count == 0:
        print(f'  ERROR: target string not found in {os.path.basename(path)}')
        print(f'  Looking for: {repr(old[:80])}...')
        return False
    if count > 1:
        print(f'  WARNING: target string found {count} times — patching first occurrence only')

    new_content = content.replace(old, new, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f'  OK: {description}')
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', default='.', help='Path to renderer/ folder containing the JS files')
    args = parser.parse_args()

    base = args.dir

    files = {
        'render-main.js':           os.path.join(base, 'render-main.js'),
        'render-wallet.js':         os.path.join(base, 'render-wallet.js'),
        'render-wallet-testnet.js': os.path.join(base, 'render-wallet-testnet.js'),
    }

    # Verify all files exist before touching anything
    missing = [name for name, path in files.items() if not os.path.exists(path)]
    if missing:
        print('ERROR: The following files were not found:')
        for m in missing:
            print(f'  {m}  (looked in {base})')
        print('Run from the renderer/ folder or pass --dir with the correct path.')
        sys.exit(1)

    print('\n=== Backing up files ===')
    for path in files.values():
        backup(path)

    print('\n=== Patching render-main.js ===')
    patch_file(
        files['render-main.js'],
        OLD_ALLOWLIST,
        NEW_ALLOWLIST,
        'Added tsd-chain-lock-confirm to global modal allowlist'
    )

    print('\n=== Patching render-wallet.js ===')
    patch_file(
        files['render-wallet.js'],
        CHAIN_LOCK_ANCHOR,
        TSD_CHAIN_LOCK_MODAL + CHAIN_LOCK_ANCHOR,
        'Inserted tsd-chain-lock-confirm modal block before confirm-chain-lock'
    )

    print('\n=== Patching render-wallet-testnet.js ===')
    patch_file(
        files['render-wallet-testnet.js'],
        CHAIN_LOCK_ANCHOR,
        TSD_CHAIN_LOCK_MODAL + CHAIN_LOCK_ANCHOR,
        'Inserted tsd-chain-lock-confirm modal block before confirm-chain-lock'
    )

    print('\n=== Done ===')
    print('All patches applied. Backup files (.bak) left alongside originals.')
    print('To revert: rename the .bak files back to their original names.')


if __name__ == '__main__':
    main()
