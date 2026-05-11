// Thin convenience wrapper over lib/store/toast for client components
// that just want to fire a one-liner.

'use client';

import { useToast } from './store/toast';

export function addToast(t: { tone: 'info' | 'success' | 'warn' | 'error'; title: string; detail?: string }) {
  useToast.getState().push({ tone: t.tone, title: t.title, body: t.detail });
}

export { useToast };
