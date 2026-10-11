import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import { DISCLAIMER, PITCH } from "./productView";
import { themeHeadScript } from "@/lib/theme/theme.mjs";
import { SiteNav } from "./siteNav";
import { ThemeToggle } from "./themeToggle";

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
  description: `${PITCH} Research and fun only.`,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The inline script sets data-theme before React hydrates, hence suppressHydrationWarning.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies a saved light/dark choice before the first paint: no flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeHeadScript() }} />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-20 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
        >
          Skip to the content
        </a>
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-8 gap-y-1 px-5 py-2">
            <Link href="/" className="flex items-center gap-2 text-xl font-bold tracking-tight">
              <span
                aria-hidden="true"
                className="grid size-8 place-items-center rounded-[10px] bg-blue text-surface"
              >
                p.
              </span>
              ProphETF
            </Link>
            {/* The current page is read in the browser, so the links stream in. */}
            {/* On a phone the links take their own row under the logo and the button. */}
            <div className="order-3 w-full sm:order-2 sm:w-auto">
              <Suspense fallback={<div className="h-8" />}>
                <SiteNav />
              </Suspense>
            </div>
            <ThemeToggle className="order-2 ml-auto sm:order-3" />
          </div>
        </header>
        <main id="content" className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:py-10">
          {children}
        </main>
        <footer className="border-t border-line bg-surface">
          <p className="mx-auto w-full max-w-6xl px-5 py-5 text-xs text-muted">{DISCLAIMER}</p>
        </footer>
      </body>
    </html>
  );
}
