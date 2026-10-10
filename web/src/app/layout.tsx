import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "ProphETF — stock baskets backed by prediction-market odds",
    template: "%s · ProphETF",
  },
  description:
    "Type an investing idea and get a stock basket picked by Gemini from live Polymarket evidence, weighted by how the odds moved. Research and fun only.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-5 py-4">
            <Link href="/" className="flex items-center gap-2 text-xl font-bold tracking-tight">
              <span
                aria-hidden="true"
                className="grid size-8 place-items-center rounded-[10px] bg-blue text-white"
              >
                p.
              </span>
              ProphETF
            </Link>
            <span className="ml-auto rounded-full bg-blue-soft px-3 py-1 text-xs font-medium text-blue">
              Backend test console
            </span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10">{children}</main>
        <footer className="border-t border-line bg-surface">
          <p className="mx-auto w-full max-w-6xl px-5 py-5 text-xs text-muted">
            Paper portfolios for research and fun. Not investment advice. Not affiliated with
            Polymarket.
          </p>
        </footer>
      </body>
    </html>
  );
}
