// Embed-only layout. In Next.js App Router, only the ROOT layout owns
// <html>/<body>. Nested layouts are wrapper components — putting another
// <html> inside is invalid HTML and produces a hydration mismatch on
// the client (which is what blew up in Fusion's embedded Chromium).
//
// We don't try to strip the root layout's overlays here — DebugConsole
// etc. are tiny floating buttons that don't interfere with the palette.

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Scruple for Fusion',
};

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
