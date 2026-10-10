import { LookupForm } from "./lookup-form";

export const metadata = { title: "Manage your booking" };

/** Guest booking lookup (no account needed). */
export default async function LookupPage({ searchParams }: { searchParams: Promise<{ bookingId?: string }> }) {
  const { bookingId } = await searchParams;
  return (
    <section>
      <h1>Manage your booking</h1>
      {bookingId && <p className="notice">Your access to this booking expired on this device. Please look it up again.</p>}
      <p>Enter the booking reference from your confirmation e-mail (or the airline reference) and the last name of any traveller.</p>
      <LookupForm />
    </section>
  );
}
