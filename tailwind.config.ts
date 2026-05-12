import type { Config } from 'tailwindcss';

// Design tokens lifted from
// research/electron-source/scruple-studio/renderer/styles/main.css and
// wallet.css (the canonical desktop UI). Token names mirror the desktop
// CSS variables so visual review against the desktop is direct.
//
// Phase 1 (committed) — color palette + sidebar width + transition durations.
// Phase 2 (this file) — extended spacing scale, border-radius scale,
// typography scale, animations, grid templates, and wallet-specific
// fallback tokens picked up from wallet.css.
//
// The legacy keys (bg, surface, border, text, muted, accent) used
// throughout existing components are aliased onto the canonical desktop
// tokens — flipping these cascades the desktop palette into every
// existing className without a per-file sweep.

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

          // ── Wallet-specific fallback colors (from wallet.css) ────────
          'panel-bg': '#1e1e1e',
          'panel-header-bg': '#252525',
          'panel-footer-bg': '#1a1a1a',
          'flag-bg': '#2a2a2a',
          'status-bg': '#2a2a2a',
          'code-bg': '#2a2a2a',
          'input-bg': '#2a2a2a',
          'wallet-accent': '#4a9eff',         // wallet primary accent (different from main!)
          'wallet-success': '#28a745',
          'wallet-warning': '#ffc107',
          'wallet-danger': '#dc3545',

          // ── Legacy aliases — same Tailwind keys, retuned to desktop ──
          bg: '#0a0f1c',
          surface: '#111827',
          border: '#374151',
          text: '#f9fafb',
          muted: '#9ca3af',
          accent: '#00d9ff',
          success: '#10b981',
          warn: '#f59e0b',
          danger: '#ef4444',
        },
      },
      width: {
        sidebar: '220px',
      },
      gridTemplateColumns: {
        shell: '220px 1fr',
        // Workspace iterations grid — auto-fill with 280px minimum,
        // 16px gap is set via gap-4 utility on the parent.
        iters: 'repeat(auto-fill, minmax(280px, 1fr))',
        // Wallet mnemonic 3-col grid
        mnemonic: 'repeat(3, 1fr)',
        // Lock buttons row — 3 cols, collapses to 1 below 900px (md)
        locks: 'repeat(3, 1fr)',
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
      // Desktop typography goes down to 9px in places (sidebar footer
      // status line). Tailwind's text-xs is 12px; we need finer.
      fontSize: {
        '2xs': ['10px', '1.4'],
        '3xs': ['9px', '1.3'],
      },
      // Desktop letter-spacings for ALL-CAPS section headers
      letterSpacing: {
        wider2: '1px',     // section h3, preflight h4, tracking labels
        widest2: '2px',    // logo text
        widest3: '3px',    // setup header
      },
      // Desktop keyframes (catalog §7)
      animation: {
        spin: 'spin 1s linear infinite',
        'spin-slow': 'spin 1.5s linear infinite',
        pulse: 'pulse 1.5s ease-in-out infinite',
        'pulse-slow': 'pulse 2s ease-in-out infinite',
        'fade-in': 'fadeIn 200ms ease',
        'modal-in': 'modalSlideIn 200ms ease',
      },
      keyframes: {
        spin: {
          to: { transform: 'rotate(360deg)' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(-5px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        modalSlideIn: {
          from: { opacity: '0', transform: 'translateY(-20px) scale(0.95)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      boxShadow: {
        // Desktop iteration card hover lift
        card: '0 4px 12px rgba(0,0,0,0.3)',
        // Modal drop shadow
        modal: '0 12px 40px rgba(0,0,0,0.6)',
      },
    },
  },
  plugins: [],
};

export default config;
