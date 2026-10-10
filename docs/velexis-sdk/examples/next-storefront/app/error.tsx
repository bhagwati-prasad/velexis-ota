"use client";

import { useEffect } from "react";

/**
 * Route error boundary. Errors thrown in server components arrive sanitised in production (message hidden,
 * `digest` set) — match the digest with the server logs (which include the Velexis `requestId`).
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const suspended = error.message.includes("TENANT_SUSPENDED");
  return (
    <section className="error-page">
      <h1>{suspended ? "We'll be right back" : "Something went wrong"}</h1>
      <p>{suspended ? "This travel shop is temporarily unavailable." : "Please try again. If the problem persists, contact support."}</p>
      {error.digest && <p className="muted">Reference: {error.digest}</p>}
      <button onClick={reset}>Try again</button>
    </section>
  );
}
