'use client';

// WO-46 · Post-lock result modal (success or error).
//
// Port of renderGlobalModal cases:
//   chain-lock-success, chain-lock-error,
//   persistent-lock-success, persistent-lock-error,
//   stripe-lock-success, stripe-payment-error.
//
// One component, branches on `result.ok`. Shows the receipt-able
// fields (SCR-ID, RVN txid, IPFS CID, Arweave txid) when present.

import Link from 'next/link';
import ModalShell, { ModalButton } from './ModalShell';

export interface LockResult {
  ok: boolean;
  kind: 'local' | 'checkpoint' | 'chain' | 'persistent';
  scrId?: string | null;
  merkleRoot?: string | null;
  rvnTxId?: string | null;
  ipfsCid?: string | null;
  arweaveTxId?: string | null;
  paymentRef?: string | null;
  error?: string;
}

export default function LockResultModal({
  result,
  onClose,
}: {
  result: LockResult;
  onClose: () => void;
}) {
  if (result.ok) {
    return <SuccessView result={result} onClose={onClose} />;
  }
  return <ErrorView result={result} onClose={onClose} />;
}

function SuccessView({ result, onClose }: { result: LockResult; onClose: () => void }) {
  const title =
    result.kind === 'persistent'
      ? '✓ Persistent Lock Complete'
      : result.kind === 'chain'
        ? '✓ Chain Lock Complete'
        : result.kind === 'checkpoint'
          ? '◇ Checkpoint Complete'
          : '◆ Finalize Complete';

  const rows: Array<[string, string | null | undefined, string?]> = [
    ['Asset ID (SCR)', result.scrId, 'font-mono'],
    ['Merkle root', result.merkleRoot, 'font-mono text-[10px] break-all'],
    ['Ravencoin', result.rvnTxId, 'font-mono text-[10px] break-all'],
    ['IPFS', result.ipfsCid, 'font-mono text-[10px] break-all'],
    ['Arweave', result.arweaveTxId, 'font-mono text-[10px] break-all'],
    ['Payment', result.paymentRef, 'font-mono text-[10px] break-all'],
  ];

  return (
    <ModalShell
      tone="success"
      title={title}
      subtitle="Provenance sealed."
      onClose={onClose}
      wide
      footer={
        <>
          {result.scrId && (
            <Link
              href={`/receipt/${result.scrId}`}
              className="rounded-md border border-scruple-border bg-scruple-bg px-3 py-1.5 text-xs hover:border-scruple-accent"
            >
              View receipt →
            </Link>
          )}
          <ModalButton variant="primary" onClick={onClose}>
            Continue
          </ModalButton>
        </>
      }
    >
      <table className="w-full">
        <tbody className="divide-y divide-scruple-border">
          {rows
            .filter(([, v]) => v != null && v !== '')
            .map(([label, value, cls]) => (
              <tr key={label}>
                <td className="py-1.5 pr-3 align-top text-[10px] uppercase tracking-widest text-scruple-muted">
                  {label}
                </td>
                <td className={`py-1.5 ${cls ?? ''}`}>{String(value)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </ModalShell>
  );
}

function ErrorView({ result, onClose }: { result: LockResult; onClose: () => void }) {
  return (
    <ModalShell
      tone="danger"
      title="Lock Failed"
      onClose={onClose}
      footer={<ModalButton onClick={onClose}>Close</ModalButton>}
    >
      <p className="text-scruple-muted">
        The lock operation didn&apos;t complete. Check the error below and try
        again, or consult the witness server logs.
      </p>
      {result.error && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-md border border-scruple-danger/30 bg-scruple-danger/5 p-3 text-[11px] text-scruple-danger">
          {result.error}
        </pre>
      )}
      {/* Per-network status when partial */}
      {(result.rvnTxId || result.ipfsCid || result.arweaveTxId) && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-[10px]">
          <PartialStatus label="RVN" value={result.rvnTxId} />
          <PartialStatus label="IPFS" value={result.ipfsCid} />
          <PartialStatus label="Arweave" value={result.arweaveTxId} />
        </div>
      )}
    </ModalShell>
  );
}

function PartialStatus({ label, value }: { label: string; value?: string | null }) {
  return (
    <div
      className={
        'rounded-md border px-2 py-1.5 ' +
        (value
          ? 'border-scruple-success/40 bg-scruple-success/10 text-scruple-success'
          : 'border-scruple-danger/40 bg-scruple-danger/10 text-scruple-danger')
      }
    >
      <div className="text-[10px] uppercase">{label}</div>
      <div className="font-mono text-[10px]">{value ? 'OK' : '—'}</div>
    </div>
  );
}
