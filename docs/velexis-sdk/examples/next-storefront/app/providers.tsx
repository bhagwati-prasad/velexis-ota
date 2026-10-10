"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@velexis/ota-sdk/next";
import { VelexisProvider } from "@velexis/ota-sdk/react";
import type { Schemas } from "@velexis/ota-sdk";

export function Providers({
  publishableKey,
  storefront,
  children,
}: {
  publishableKey: string;
  storefront: Schemas["StorefrontConfig"];
  children: ReactNode;
}) {
  const router = useRouter();
  // One browser client per tenant/page load. Public calls go direct with the publishable key; calls that need the
  // customer or a guest booking token go through /api/velexis (tokens stay in httpOnly cookies).
  const [client] = useState(() =>
    createBrowserClient({
      publishableKey,
      mode: "hybrid",
      proxyPath: "/api/velexis",
      authPath: "/api/auth",
      onUnauthenticated: () => router.refresh(),
    }),
  );
  return (
    <VelexisProvider client={client} storefront={storefront} onError={(e) => console.warn(`[velexis] ${e.code} ${e.requestId ?? ""}`)}>
      {children}
    </VelexisProvider>
  );
}
