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
  title: { default: "ProphETF — personal ETFs from prediction markets", template: "%s · ProphETF" },
  description:
    "Build a paper ETF from Polymarket outcomes and watch its NAV move live. Research and fun only.",
};

const NAV = [
  { href: "/markets", label: "Markets" },
  { href: "/build", label: "Build" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/built-with", label: "Built with" },
] as const;

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
            <nav aria-label="Main" className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="hover:text-ink">
                  {item.label}
                </Link>
              ))}
            </nav>
            <span className="ml-auto rounded-full bg-blue-soft px-3 py-1 text-xs font-medium text-blue">
              Paper portfolios · Live Polymarket prices
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
