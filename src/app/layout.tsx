import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/shared/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ASSET_VERSION } from "@/lib/asset-version";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "File Optimizer",
  description:
    "Optimisation en masse de photos (redimensionnement + compression), avec conservation optionnelle des originaux.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "File Optimizer",
  },
  icons: {
    icon: [
      { url: `/logo.svg?v=${ASSET_VERSION}`, type: "image/svg+xml" },
      { url: `/icon-192.png?v=${ASSET_VERSION}`, sizes: "192x192", type: "image/png" },
      { url: `/icon-512.png?v=${ASSET_VERSION}`, sizes: "512x512", type: "image/png" },
    ],
    apple: `/apple-touch-icon.png?v=${ASSET_VERSION}`,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#100d08" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="app-backdrop min-h-full">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={250}>
            {children}
            <Toaster position="bottom-right" richColors />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
