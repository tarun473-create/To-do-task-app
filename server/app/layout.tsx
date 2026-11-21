export const metadata = { title: 'Task360 — Team Performance & Accountability Hub' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head><link rel="stylesheet" href="/app/css/styles.css" /></head>
      <body>{children}</body>
    </html>
  );
}
