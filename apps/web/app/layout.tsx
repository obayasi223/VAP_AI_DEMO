import type { ReactNode } from 'react';

export const metadata = {
  title: 'LLM VAP Demo',
  description: 'Research prototype scaffold',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
