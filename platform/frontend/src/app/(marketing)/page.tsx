import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Placeholder landing page (M0). The marketing content, pricing and legal pages replace it in M1. */
export default function LandingPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-6 px-6 py-24 focus:outline-none"
    >
      <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        Your own online travel agency, ready to sell flights.
      </h1>
      <p className="text-lg text-muted-foreground">
        Create an OTA, connect Amadeus and Stripe, and open a hosted storefront for your customers, all from
        one portal.
      </p>
      <div>
        <Button asChild size="lg">
          <Link href="/sign-up" prefetch={false}>
            Get started
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </main>
  );
}
