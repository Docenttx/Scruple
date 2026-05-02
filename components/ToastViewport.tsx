'use client';

import { useToast } from '@/lib/store/toast';
import clsx from 'clsx';
import Link from 'next/link';

export default function ToastViewport() {
  const toasts = useToast((s) => s.toasts);
  const dismiss = useToast((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'pointer-events-auto rounded-md border p-3 text-xs backdrop-blur',
            t.tone === 'error' && 'border-scruple-danger/60 bg-scruple-danger/10 text-scruple-danger',
            t.tone === 'warn' && 'border-scruple-warn/60 bg-scruple-warn/10 text-scruple-warn',
            t.tone === 'success' && 'border-scruple-success/60 bg-scruple-success/10 text-scruple-success',
            t.tone === 'info' && 'border-scruple-border bg-scruple-surface text-scruple-text',
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <div className="font-medium">{t.title}</div>
              {t.body && <div className="mt-0.5 text-[11px] opacity-90">{t.body}</div>}
              {t.link && (
                <Link href={t.link.href} className="mt-1 block text-[11px] underline">
                  {t.link.label}
                </Link>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="text-scruple-muted hover:text-scruple-text"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
