import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { LANDING_STRINGS } from "@/lib/strings";

/**
 * `/` (README §2 Public, scope §2.2): the marketing landing page. Static content, no API call and no client state;
 * the calls to action lead to `/sign-up` and `/pricing`. The page has exactly one `h1`.
 */
export default function LandingPage() {
  return (
    <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
      <section
        aria-labelledby="landing-title"
        className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 pt-20 pb-16 sm:pt-28"
      >
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
          {LANDING_STRINGS.eyebrow}
        </p>
        <h1
          id="landing-title"
          className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
        >
          {LANDING_STRINGS.title}
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">{LANDING_STRINGS.intro}</p>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/sign-up" prefetch={false}>
              {LANDING_STRINGS.getStarted}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/pricing" prefetch={false}>
              {LANDING_STRINGS.seePricing}
            </Link>
          </Button>
        </div>
      </section>

      <section aria-labelledby="landing-steps" className="border-t bg-muted/40">
        <div className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-16">
          <h2 id="landing-steps" className="text-2xl font-semibold tracking-tight">
            {LANDING_STRINGS.stepsTitle}
          </h2>
          <ol className="grid gap-6 md:grid-cols-3">
            {LANDING_STRINGS.steps.map((step, index) => (
              <li key={step.title} className="grid content-start gap-2 rounded-lg border bg-background p-5">
                <span aria-hidden="true" className="text-sm font-medium text-muted-foreground">
                  {index + 1}
                </span>
                <h3 className="font-semibold">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="landing-features">
        <div className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-16">
          <h2 id="landing-features" className="text-2xl font-semibold tracking-tight">
            {LANDING_STRINGS.featuresTitle}
          </h2>
          <ul className="grid gap-6 sm:grid-cols-2">
            {LANDING_STRINGS.features.map((feature) => (
              <li key={feature.title} className="grid content-start gap-2">
                <h3 className="font-semibold">{feature.title}</h3>
                <p className="text-sm text-muted-foreground">{feature.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="landing-closing" className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-start gap-4 px-6 py-16">
          <h2 id="landing-closing" className="text-2xl font-semibold tracking-tight">
            {LANDING_STRINGS.closingTitle}
          </h2>
          <p className="max-w-2xl text-muted-foreground">{LANDING_STRINGS.closingText}</p>
          <Button asChild size="lg">
            <Link href="/sign-up" prefetch={false}>
              {LANDING_STRINGS.getStarted}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
