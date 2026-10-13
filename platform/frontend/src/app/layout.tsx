import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Velexis", template: "%s · Velexis" },
  description: "Create and run your own online travel agency with Velexis.",
};

/**
 * Root layout of every portal page. The skip link is the first focusable element; every page or area layout
 * renders its main content as `<main id="main-content" tabIndex={-1}>` so the link has a target.
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
