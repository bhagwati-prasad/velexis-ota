import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

/**
 * Every page renders per request: the Content-Security-Policy of `middleware.ts` carries a fresh nonce, and Next.js
 * can only put that nonce on the inline scripts of a page it renders for the request. A prerendered page (the
 * not-found page, or a later page that reads no request data) would keep scripts without it, which the policy blocks
 * (README §10).
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Velexis OTA admin", template: "%s · Velexis OTA admin" },
  description: "Back office of a Velexis OTA: bookings, console operations, payments and settings.",
  // A signed-in back office: nothing here belongs in a search index.
  robots: { index: false, follow: false },
};

/**
 * Root layout of every OTA admin page. The signed-in shell with the tenant, the environment switch and the
 * navigation is the `(console)` route group's layout (README §5, §6). The skip link is the first focusable
 * element; the shell renders its main content as `<main id="main-content" tabIndex={-1}>`.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:ring-[3px] focus:ring-ring/50"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
