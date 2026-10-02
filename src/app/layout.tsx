import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Optimize files",
  description: "Optimisation en masse de photos (redimensionnement + compression), avec conservation optionnelle des originaux",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">{children}</body>
    </html>
  );
}
