import type { Config } from 'tailwindcss';

// Design tokens lifted verbatim from
// research/electron-source/scruple-studio/renderer/styles/main.css
// (the canonical desktop UI). Token names mirror the desktop CSS
// variables so visual review against the desktop is direct.
//
// The legacy keys (bg, surface, border, text, muted, accent, ...) used
// throughout existing components are aliased onto the canonical desktop
// tokens — flipping these here cascades the new palette into every
// existing className without a per-file sweep. The biggest change:
// the primary accent goes from #7c5cff (purple) to #00d9ff (cyan) which
// matches the desktop's --accent-primary. Purple is reserved for
// Fiat-mode highlights (--accent-purple #8b5cf6).

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        scruple: {
          // ── Canonical desktop palette (1:1 from main.css :root) ──────
          'bg-primary': '#0a0f1c',
          'bg-secondary': '#111827',
          'bg-tertiary': '#1f2937',
          'bg-hover': '#374151',
          'text-primary': '#f9fafb',
          'text-secondary': '#9ca3af',
          'text-deep-muted': '#6b7280',
          'accent-primary': '#00d9ff',
          'accent-secondary': '#3b82f6',
          'accent-purple': '#8b5cf6',
          'border-color': '#374151',
          'border-light': '#4b5563',

          // ── Legacy aliases — same Tailwind keys, retuned to desktop ──
          // Existing components reference `scruple-bg`, `scruple-text`,
          // `scruple-accent`, etc. Re-pointing these aliases lights up
          // the desktop palette everywhere at once.
          bg: '#0a0f1c',         // was #0a0a0b — now matches desktop window bg
          surface: '#111827',    // was #15151a — now matches desktop panels
          border: '#374151',     // was #27272f — desktop borders are lighter
          text: '#f9fafb',       // was #e6e6eb — desktop primary text is whiter
          muted: '#9ca3af',      // was #8a8a96 — close, slightly cooler
          accent: '#00d9ff',     // was #7c5cff (purple) — now CYAN, the desktop primary
          success: '#10b981',    // was #22c55e — desktop's exact green
          warn: '#f59e0b',       // was #eab308 — desktop's exact amber
          danger: '#ef4444',     // ✓ matches
        },
      },
      width: {
        sidebar: '220px',
      },
      gridTemplateColumns: {
        // Used by AppShell — replaces the hand-typed grid-cols-[260px_1fr].
        shell: '220px 1fr',
      },
      transitionDuration: {
        fast: '150ms',
        normal: '250ms',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'sans-serif',
        ],
        mono: ['Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
