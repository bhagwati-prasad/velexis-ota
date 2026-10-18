import type { Metadata } from "next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LEGAL_STRINGS } from "@/lib/strings";
import { termsVersion } from "@/lib/terms";

export const metadata: Metadata = { title: LEGAL_STRINGS.termsTitle };

/**
 * `/legal/terms` (README §2 Public): the terms of service, with placeholder text until the final terms exist. The
 * version shown is `termsVersion` of `lib/terms.ts`, the value sign-up sends, so the page and the acceptance the
 * API stores always name the same text.
 */
export default function TermsPage() {
  return (
    <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
      <article aria-labelledby="terms-title" className="mx-auto grid w-full max-w-3xl gap-8 px-6 py-16">
        <header className="grid gap-3">
          <h1 id="terms-title" className="text-4xl font-semibold tracking-tight">
            {LEGAL_STRINGS.termsTitle}
          </h1>
          <p className="text-sm text-muted-foreground">{LEGAL_STRINGS.version(termsVersion)}</p>
          <p className="text-lg text-muted-foreground">{LEGAL_STRINGS.termsIntro}</p>
        </header>
        <Alert role="note">
          <AlertTitle>{LEGAL_STRINGS.placeholderTitle}</AlertTitle>
          <AlertDescription>{LEGAL_STRINGS.placeholder}</AlertDescription>
        </Alert>
        {LEGAL_STRINGS.termsSections.map((section, index) => (
          <section key={section.title} aria-labelledby={`terms-section-${index + 1}`} className="grid gap-2">
            <h2 id={`terms-section-${index + 1}`} className="text-xl font-semibold tracking-tight">
              {`${index + 1}. ${section.title}`}
            </h2>
            <p className="text-muted-foreground">{section.text}</p>
          </section>
        ))}
      </article>
    </main>
  );
}
