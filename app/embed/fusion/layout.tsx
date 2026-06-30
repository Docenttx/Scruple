// Embed-only layout: strips the global shell (ToastViewport, InterlockOverlay,
// DebugConsole) and Scruple chrome since the Fusion palette has its own.
// Tight viewport sized for ~400×800 palette dock.

import type { Metadata } from 'next';
import '../../globals.css';

export const metadata: Metadata = {
  title: 'Scruple for Fusion',
};

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className="bg-scruple-bg text-scruple-text antialiased"
        style={{ overflow: 'auto', minHeight: '100vh', margin: 0 }}
      >
        {children}
      </body>
    </html>
  );
}
