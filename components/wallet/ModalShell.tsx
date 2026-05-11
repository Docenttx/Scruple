'use client';

// Generic centered modal shell used by every wallet flow + lock
// confirmation. Mirrors the desktop's renderGlobalModal styling
// (color stripe at top, large title, body, action footer).

import { useEffect } from 'react';

export type ModalTone = 'info' | 'warn' | 'danger' | 'success' | 'purple';

const TONE_BORDER: Record<ModalTone, string> = {
  info: 'border-scruple-accent',
  warn: 'border-scruple-warn',
  danger: 'border-scruple-danger',
  success: 'border-scruple-success',
  purple: 'border-fuchsia-500',
};

export default function ModalShell({
  tone = 'info',
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  tone?: ModalTone;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  // Esc-to-close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[8000] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className={
          `border-t-2 ${TONE_BORDER[tone]} ` +
          'flex max-h-[85vh] w-full flex-col rounded-lg border border-scruple-border bg-scruple-surface shadow-2xl ' +
          (wide ? 'max-w-2xl' : 'max-w-md')
        }
        onClick={e => e.stopPropagation()}
      >
        <header className="border-b border-scruple-border px-5 py-3">
          <h2 className="text-base font-medium text-scruple-text">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-scruple-muted">{subtitle}</p>}
        </header>
        <div className="flex-1 overflow-auto px-5 py-4 text-sm">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-scruple-border px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function ModalButton({
  variant = 'secondary',
  ...rest
}: {
  variant?: 'primary' | 'secondary' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls =
    variant === 'primary'
      ? 'border-scruple-accent bg-scruple-accent/20 text-scruple-text hover:bg-scruple-accent/40'
      : variant === 'danger'
        ? 'border-scruple-danger bg-scruple-danger/15 text-scruple-danger hover:bg-scruple-danger/25'
        : 'border-scruple-border bg-scruple-bg text-scruple-text hover:border-scruple-accent';
  return (
    <button
      {...rest}
      className={`rounded-md border px-3 py-1.5 text-xs disabled:opacity-50 ${cls}`}
    />
  );
}
