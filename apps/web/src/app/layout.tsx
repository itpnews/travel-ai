import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Travel AI',
  description: 'Flight disruption intelligence — find reliable routes and understand the risks.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
