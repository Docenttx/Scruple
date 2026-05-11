'use client';

// WO-35 · Client log store for the debug console.
//
// Mirrors desktop's State.set('logs', [...]) ring-buffer. Last 100
// entries, FIFO eviction. Any component can push() to log a notable
// event. The DebugConsole component subscribes.

import { create } from 'zustand';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  ts: string;        // ISO timestamp
  level: LogLevel;
  source: string;    // short component/module name
  message: string;
  detail?: unknown;  // optional structured extra
}

interface LogsState {
  entries: LogEntry[];
  open: boolean;
  push(entry: Omit<LogEntry, 'ts'>): void;
  clear(): void;
  toggle(): void;
  setOpen(v: boolean): void;
}

const MAX = 100;

export const useLogs = create<LogsState>(set => ({
  entries: [],
  open: false,
  push(entry) {
    set(state => {
      const next = [...state.entries, { ts: new Date().toISOString(), ...entry }];
      if (next.length > MAX) next.splice(0, next.length - MAX);
      return { entries: next };
    });
  },
  clear() {
    set({ entries: [] });
  },
  toggle() {
    set(s => ({ open: !s.open }));
  },
  setOpen(v) {
    set({ open: v });
  },
}));

// Convenience: a log helper that also mirrors to console.* so dev-tools
// users see the same stream. Use sparingly — most surfaces should
// go through the toast component first, only push notable failures /
// state transitions here.
export function logEvent(level: LogLevel, source: string, message: string, detail?: unknown) {
  useLogs.getState().push({ level, source, message, detail });
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${source}] ${message}`, detail ?? '');
}
