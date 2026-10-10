"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTicketingStatus } from "@velexis/ota-sdk/react";

/**
 * Polls ticketing (`bookings.getTicketingStatus`, refresh) through the proxy, which attaches the customer token or the
 * guest booking-token cookie — the token never reaches JavaScript. Refreshes the page once tickets are final.
 */
export function TicketingStatus({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const { data, error } = useTicketingStatus(bookingId);
  const final = data && !["pending", "in_progress"].includes(data.status) && data.bookingStatus !== "pending";

  useEffect(() => {
    if (final) router.refresh();
  }, [final, router]);

  if (error) return <p className="muted">Ticket status unavailable right now.</p>;
  if (!data) return <p className="muted">Checking ticket status…</p>;
  return (
    <p className="notice" aria-live="polite">
      {data.message ?? `Tickets: ${data.status.replace("_", " ")}`}
      {data.tickets.length > 0 && ` · ${data.tickets.map((t) => t.documentNumber).join(", ")}`}
    </p>
  );
}
