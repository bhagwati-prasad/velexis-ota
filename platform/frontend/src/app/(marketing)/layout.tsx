import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { MARKETING_STRINGS } from "@/lib/strings";

/** The links of the header, in order. */
const HEADER_LINKS = [
  { href: "/pricing", label: MARKETING_STRINGS.pricing },
  { href: "/sign-in", label: MARKETING_STRINGS.signIn },
] as const;

/** The links of the footer, in order. */
const FOOTER_LINKS = [
  { href: "/legal/terms", label: MARKETING_STRINGS.terms },
  { href: "/legal/privacy", label: MARKETING_STRINGS.privacy },
] as const;

/**
 * The public pages (README §2 Public): a header with the home link, pricing, sign-in and sign-up, and a footer with
 * the legal pages. A server component without data or state. Each page renders its own
 * `<main id="main-content" tabIndex={-1}>` between the two, the target of the root layout's skip link.
 */
export default function MarketingLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <Link
            href="/"
            prefetch={false}
            aria-label={MARKETING_STRINGS.homeLink}
            className="text-lg font-semibold tracking-tight"
          >
            {MARKETING_STRINGS.productName}
          </Link>
          <nav aria-label={MARKETING_STRINGS.navigationLabel}>
            <ul className="flex items-center gap-1 text-sm">
              {HEADER_LINKS.map((link) => (
                <li key={link.href}>
                  <Button asChild variant="ghost" size="sm">
                    <Link href={link.href} prefetch={false}>
                      {link.label}
                    </Link>
                  </Button>
                </li>
              ))}
              <li className="ml-2">
                <Button asChild size="sm">
                  <Link href="/sign-up" prefetch={false}>
                    {MARKETING_STRINGS.getStarted}
                  </Link>
                </Button>
              </li>
            </ul>
          </nav>
        </div>
      </header>
      {children}
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-6 text-sm text-muted-foreground">
          <p>{MARKETING_STRINGS.footerNote}</p>
          <nav aria-label={MARKETING_STRINGS.footerLabel}>
            <ul className="flex flex-wrap items-center gap-4">
              {FOOTER_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    prefetch={false}
                    className="underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </footer>
    </div>
  );
}
