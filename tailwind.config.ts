import type { Config } from 'tailwindcss';

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
          bg: '#0a0a0b',
          surface: '#15151a',
          border: '#27272f',
          text: '#e6e6eb',
          muted: '#8a8a96',
          accent: '#7c5cff',
          success: '#22c55e',
          warn: '#eab308',
          danger: '#ef4444',
        },
      },
    },
  },
  plugins: [],
};

export default config;
