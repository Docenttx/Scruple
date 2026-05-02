import type { Metadata } from 'next';
import './globals.css';
import ToastViewport from '@/components/ToastViewport';

export const metadata: Metadata = {
  title: 'Scruple Web',
  description: 'AI provenance middleware — web port of SCRUPLE Studio',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-scruple-bg text-scruple-text antialiased">
        {children}
        <ToastViewport />
      </body>
    </html>
  );
}
