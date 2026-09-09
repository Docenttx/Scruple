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
          // ── Canonical desktop palette ────────────────────────────────
          // NOT hex any more. Every one of these reads the token declared by
          // app/theme/canon.css, which is generated from the canon stylesheet
          // itself — so `bg-scruple-bg` and a canon rule saying
          // `background: var(--bg-primary)` are now the SAME value by
          // construction rather than by two people keeping two files in step.
          //
          // The `rgb(<channels> / <alpha-value>)` form is what makes the
          // opacity modifiers already in use (bg-scruple-accent/10 and 34
          // others) keep working against a variable.
          'bg-primary': 'rgb(var(--bg-primary-rgb) / <alpha-value>)',
          'bg-secondary': 'rgb(var(--bg-secondary-rgb) / <alpha-value>)',
          'bg-tertiary': 'rgb(var(--bg-tertiary-rgb) / <alpha-value>)',
          'bg-hover': 'rgb(var(--bg-hover-rgb) / <alpha-value>)',
          'text-primary': 'rgb(var(--text-primary-rgb) / <alpha-value>)',
          'text-secondary': 'rgb(var(--text-secondary-rgb) / <alpha-value>)',
          'text-deep-muted': 'rgb(var(--text-muted-rgb) / <alpha-value>)',
          'accent-primary': 'rgb(var(--accent-primary-rgb) / <alpha-value>)',
          'accent-secondary': 'rgb(var(--accent-secondary-rgb) / <alpha-value>)',
          'accent-purple': 'rgb(var(--accent-purple-rgb) / <alpha-value>)',
          'border-color': 'rgb(var(--border-color-rgb) / <alpha-value>)',
          'border-light': 'rgb(var(--border-light-rgb) / <alpha-value>)',

          // ── Wallet fallback colours (from wallet.css) ────────────────
          // STILL LITERALS, and deliberately. wallet.css declares no tokens at
          // all; it reads names nothing defines and renders the fallback. Two
          // of those names carry MORE THAN ONE fallback at different sites
          // (--code-bg is #2a2a2a in one rule and #1a1a1a in another), so there
          // is no single token to point at. Hoisting them would have to pick a
          // winner and would silently restyle the loser. See the defect list at
          // the top of app/theme/canon.css.
          'panel-bg': '#1e1e1e',
          'panel-header-bg': '#252525',
          'panel-footer-bg': '#1a1a1a',
          'flag-bg': '#2a2a2a',
          'status-bg': '#2a2a2a',
          'code-bg': '#2a2a2a',
          'input-bg': '#2a2a2a',
          'wallet-accent': '#4a9eff',
          'wallet-success': '#28a745',
          'wallet-warning': '#ffc107',
          'wallet-danger': '#dc3545',

          // ── Legacy aliases — same Tailwind keys, same canon tokens ────
          bg: 'rgb(var(--bg-primary-rgb) / <alpha-value>)',
          surface: 'rgb(var(--bg-secondary-rgb) / <alpha-value>)',
          border: 'rgb(var(--border-color-rgb) / <alpha-value>)',
          text: 'rgb(var(--text-primary-rgb) / <alpha-value>)',
          muted: 'rgb(var(--text-secondary-rgb) / <alpha-value>)',
          accent: 'rgb(var(--accent-primary-rgb) / <alpha-value>)',
          success: 'rgb(var(--accent-success-rgb) / <alpha-value>)',
          warn: 'rgb(var(--accent-warning-rgb) / <alpha-value>)',
          danger: 'rgb(var(--accent-error-rgb) / <alpha-value>)',
        },
      },
      width: {
        // The canon token, not a copy of it.
        sidebar: 'var(--sidebar-width)',
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
        // --transition-fast is `150ms ease` in the canon: a duration AND an
        // easing in one token, which a Tailwind duration utility cannot take.
        // The durations are therefore still literals here, and the test pins
        // them against the canon token so they cannot drift apart.
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
        // These point at Tailwind's own keyframes below. The canon's keyframes
        // live in app/theme/canon.css under `canon-` names — @keyframes has one
        // global namespace, and two `spin`s fighting over it is exactly what
        // the port refused to leave in place.
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
