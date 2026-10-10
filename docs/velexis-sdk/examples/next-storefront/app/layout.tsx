import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getTenant } from "@velexis/ota-sdk/next";
import { getStorefront, velexisConfig } from "@/lib/velexis";
import { Providers } from "./providers";
import { AccountMenu } from "@/components/account-menu";

export async function generateMetadata(): Promise<Metadata> {
  const sf = await getStorefront();
  return {
    title: { template: sf.seo.titleTemplate, default: sf.seo.defaultTitle },
    description: sf.seo.defaultDescription,
    metadataBase: new URL(sf.seo.canonicalBaseUrl),
    robots: sf.seo.robots,
    icons: { icon: sf.branding.faviconUrl },
    openGraph: sf.seo.ogImageUrl ? { images: [sf.seo.ogImageUrl] } : undefined,
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Storefront config is cached per tenant (revalidate 300 s + tag); the session is NOT read here so pages
  // without personal data stay cacheable — the account menu loads the session client-side via the proxy.
  const [sf, tenant] = await Promise.all([getStorefront(), getTenant({ config: velexisConfig })]);
  const c = sf.branding.colors;
  const dir = sf.locales.find((l) => l.code === sf.defaultLocale)?.direction ?? "ltr";
  const css = `:root{--primary:${c.primary};--on-primary:${c.onPrimary};--bg:${c.background};--surface:${c.surface};--text:${c.text};--muted:${c.mutedText};--error:${c.error};--font-heading:'${sf.branding.fonts.heading.family}';--font-body:'${sf.branding.fonts.body.family}'}`;

  return (
    <html lang={sf.defaultLocale} dir={dir}>
      <head>
        <link rel="stylesheet" href={sf.branding.fonts.heading.cssUrl} />
        <link rel="stylesheet" href={sf.branding.fonts.body.cssUrl} />
        <style>{css}</style>
      </head>
      <body>
        {sf.environment === "test" && <div className="test-banner">Test environment — bookings are not real</div>}
        {/* The publishable key is public; per tenant in multi-domain setups. Storefront config contains no secrets. */}
        <Providers publishableKey={tenant.publishableKey} storefront={sf}>
          <header className="site-header">
            <Link href="/" className="logo">
              <img src={sf.branding.logoUrl} alt={sf.name} height={32} />
            </Link>
            <nav>
              <Link href="/">Flights</Link>
              <Link href="/bookings">My trips</Link>
              <Link href="/bookings/lookup">Manage booking</Link>
            </nav>
            {sf.features.customerAccounts && <AccountMenu />}
          </header>
          <main>{children}</main>
          <footer className="site-footer">
            <a href={sf.legal.termsUrl}>Terms</a> · <a href={sf.legal.privacyUrl}>Privacy</a> ·{" "}
            <a href={sf.legal.refundPolicyUrl}>Refunds</a> · <a href={`mailto:${sf.support.email}`}>{sf.support.email}</a>
            {sf.support.phone && <> · {sf.support.phone}</>} · {sf.support.hours}
          </footer>
        </Providers>
      </body>
    </html>
  );
}
