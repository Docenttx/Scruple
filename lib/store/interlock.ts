'use client';

// Interlock store — mirrors desktop's `set-interlock` IPC. While true,
// lock + tracking buttons must be disabled across the app to prevent
// concurrent state-mutating calls.

import { create } from 'zustand';

interface InterlockState {
  busy: boolean;
  reason: string | null;
  set(busy: boolean, reason?: string): void;
}

export const useInterlock = create<InterlockState>((set) => ({
  busy: false,
  reason: null,
  set(busy, reason) {
    set({ busy, reason: reason ?? null });
  },
}));
