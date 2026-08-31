import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-inter" });

export const metadata: Metadata = {
  // szablon: operator pracuje na kilku sklepach naraz i musi rozróżniać karty przeglądarki
  title: { template: "%s · midrev esp", default: "midrev esp" },
  description: "Panel operatora - email marketing dla sklepów klientów MidRev",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
