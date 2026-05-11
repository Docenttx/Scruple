'use client';

// WO-43 · Wallet management modals (UI shells).
//
// Six modals per the desktop's renderWalletModal switch. Per D-012 the
// submit handlers are stubbed — they show a toast pointing to the
// next-build wallet-storage architecture rather than actually creating
// keys. UI surface is complete so the experience is real.

import { useState } from 'react';
import { useWallet } from '@/lib/store/wallet';
import { addToast } from '@/lib/toast';
import ModalShell, { ModalButton } from './ModalShell';

const SOON_TOAST = {
  tone: 'info' as const,
  title: 'Wallet engine coming next build',
  detail: 'Per-user wallet storage is being finalized (D-012). UI is ready; handler lands in the next overnight.',
};

export default function WalletModals() {
  const modal = useWallet(s => s.modal);
  const close = useWallet(s => s.closeModal);

  if (!modal) return null;

  switch (modal) {
    case 'rvn-create':
      return <CreateWalletModal onClose={close} />;
    case 'rvn-import':
      return <ImportWalletModal onClose={close} />;
    case 'rvn-unlock':
      return <UnlockWalletModal onClose={close} />;
    case 'rvn-mnemonic':
      return <SaveMnemonicModal onClose={close} />;
    case 'rvn-settings':
      return <SettingsModal onClose={close} />;
    case 'ipfs-config':
      return <IpfsConfigModal onClose={close} />;
    default:
      return null;
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

function CreateWalletModal({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const ok = pw.length >= 8 && pw === pw2;

  return (
    <ModalShell
      tone="info"
      title="Create RVN Wallet"
      subtitle="Choose a password to encrypt your new wallet."
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            disabled={!ok}
            onClick={() => {
              addToast(SOON_TOAST);
              onClose();
            }}
          >
            Create Wallet
          </ModalButton>
        </>
      }
    >
      <Field label="Password" value={pw} onChange={setPw} type="password" placeholder="min 8 chars" />
      <Field label="Confirm" value={pw2} onChange={setPw2} type="password" />
      <p className="mt-2 text-[11px] text-scruple-muted">
        After creation you&apos;ll be shown a 12-word recovery phrase. Write it down — it&apos;s the only way to restore the wallet.
      </p>
    </ModalShell>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────

function ImportWalletModal({ onClose }: { onClose: () => void }) {
  const [phrase, setPhrase] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  const ok = words.length === 12 && pw.length >= 8 && pw === pw2;

  return (
    <ModalShell
      tone="info"
      title="Import RVN Wallet"
      subtitle="Restore from a 12-word recovery phrase."
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            disabled={!ok}
            onClick={() => {
              addToast(SOON_TOAST);
              onClose();
            }}
          >
            Import Wallet
          </ModalButton>
        </>
      }
    >
      <label className="block text-[10px] uppercase tracking-widest text-scruple-muted">
        Recovery phrase (12 words)
      </label>
      <textarea
        value={phrase}
        onChange={e => setPhrase(e.target.value)}
        rows={3}
        className="mt-1 w-full rounded-md border border-scruple-border bg-scruple-bg p-2 font-mono text-xs focus:border-scruple-accent focus:outline-none"
        placeholder="word1 word2 word3 …"
      />
      <p className="mt-1 text-[11px] text-scruple-muted">
        {words.length}/12 words
      </p>
      <Field label="New password" value={pw} onChange={setPw} type="password" placeholder="min 8 chars" />
      <Field label="Confirm" value={pw2} onChange={setPw2} type="password" />
    </ModalShell>
  );
}

// ── Unlock ──────────────────────────────────────────────────────────────────

function UnlockWalletModal({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState('');
  return (
    <ModalShell
      tone="info"
      title="Unlock RVN Wallet"
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            disabled={!pw}
            onClick={() => {
              addToast(SOON_TOAST);
              onClose();
            }}
          >
            Unlock
          </ModalButton>
        </>
      }
    >
      <Field label="Password" value={pw} onChange={setPw} type="password" />
    </ModalShell>
  );
}

// ── Save Mnemonic ───────────────────────────────────────────────────────────

function SaveMnemonicModal({ onClose }: { onClose: () => void }) {
  // Stubbed display words — real ones come from wallet creation handler.
  const PLACEHOLDER_WORDS = [
    'paper', 'wind', 'forest', 'rocket',
    'silver', 'amber', 'orchard', 'token',
    'velvet', 'mango', 'cipher', 'navigate',
  ];
  const [confirmed, setConfirmed] = useState(false);

  return (
    <ModalShell
      tone="warn"
      title="Save Recovery Phrase"
      subtitle="Write these 12 words down. They're the only way to restore this wallet."
      onClose={onClose}
      wide
      footer={
        <ModalButton variant="primary" disabled={!confirmed} onClick={onClose}>
          Continue
        </ModalButton>
      }
    >
      <div className="mb-4 grid grid-cols-3 gap-2">
        {PLACEHOLDER_WORDS.map((w, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-md border border-scruple-border bg-scruple-bg px-3 py-2"
          >
            <span className="w-5 text-[10px] text-scruple-muted">{i + 1}.</span>
            <span className="font-mono text-sm">{w}</span>
          </div>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={e => setConfirmed(e.target.checked)}
        />
        I have written down my recovery phrase.
      </label>
    </ModalShell>
  );
}

// ── Settings ───────────────────────────────────────────────────────────────

function SettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell
      tone="danger"
      title="Wallet Settings"
      onClose={onClose}
      footer={<ModalButton onClick={onClose}>Close</ModalButton>}
    >
      <h3 className="mb-1 text-xs uppercase tracking-widest text-scruple-danger">
        Danger Zone
      </h3>
      <p className="mb-3 text-xs text-scruple-muted">
        Make sure you have your recovery phrase before deleting!
      </p>
      <ModalButton
        variant="danger"
        onClick={() => {
          addToast(SOON_TOAST);
          onClose();
        }}
      >
        Delete Wallet
      </ModalButton>
    </ModalShell>
  );
}

// ── IPFS Config ────────────────────────────────────────────────────────────

function IpfsConfigModal({ onClose }: { onClose: () => void }) {
  const [gateway, setGateway] = useState('https://ipfs.io');
  const [service, setService] = useState<'none' | 'pinata'>('none');
  const [pinataKey, setPinataKey] = useState('');
  const [pinataSecret, setPinataSecret] = useState('');

  return (
    <ModalShell
      tone="info"
      title="Configure IPFS"
      subtitle="Gateway and pinning service for persistent-lock uploads."
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => {
              // Real save lands in WO-41 (IPFS config endpoint).
              addToast({
                tone: 'info',
                title: 'IPFS config persistence pending',
                detail: 'WO-41 wires the save endpoint.',
              });
              onClose();
            }}
          >
            Save
          </ModalButton>
        </>
      }
    >
      <Field label="Gateway URL" value={gateway} onChange={setGateway} />
      <label className="mt-3 block text-[10px] uppercase tracking-widest text-scruple-muted">
        Pinning Service
      </label>
      <select
        value={service}
        onChange={e => setService(e.target.value as 'none' | 'pinata')}
        className="mt-1 w-full rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-xs focus:border-scruple-accent focus:outline-none"
      >
        <option value="none">None</option>
        <option value="pinata">Pinata</option>
      </select>
      {service === 'pinata' && (
        <>
          <Field label="Pinata API Key" value={pinataKey} onChange={setPinataKey} />
          <Field label="Pinata Secret" value={pinataSecret} onChange={setPinataSecret} type="password" />
        </>
      )}
    </ModalShell>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="mt-3 block">
      <span className="block text-[10px] uppercase tracking-widest text-scruple-muted">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-scruple-border bg-scruple-bg px-2 py-1 text-sm focus:border-scruple-accent focus:outline-none"
      />
    </label>
  );
}
