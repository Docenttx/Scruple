'use client';

import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  link?: { href: string; label: string };
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id'>): string;
  dismiss(id: string): void;
}

export const useToast = create<ToastState>((set) => ({
  toasts: [],
  push(t) {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    if (t.tone !== 'error') {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, 5000);
    }
    return id;
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

// Convenience wrapper around fetch that surfaces non-2xx responses to the
// global toast stack. Returns the parsed JSON or throws.
export async function fetchOrToast<T>(
  url: string,
  init?: RequestInit & { actionTitle?: string },
): Promise<T> {
  const res = await fetch(url, init);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    useToast.getState().push({
      tone: 'error',
      title: init?.actionTitle ?? 'Request failed',
      body: msg,
    });
    throw new Error(msg);
  }
  return data as T;
}
