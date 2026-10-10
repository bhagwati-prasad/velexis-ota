import Link from "next/link";
import { customerClient, mustBeCustomer } from "@/lib/velexis";
import { signOutAction } from "./actions";
import { ProfileForm } from "./profile-form";

/** Profile (customer only — the middleware redirects signed-out visitors; `requireCustomer` double-checks). */
export default async function AccountPage() {
  await mustBeCustomer("/account");
  const vx = await customerClient();
  const [me, prefs] = await Promise.all([vx.account.get(), vx.account.preferences.get()]);

  return (
    <section>
      <h1>My account</h1>
      {!me.emailVerified && <p className="notice">Please confirm {me.email} — check your inbox.</p>}
      {me.pendingEmail && <p className="notice">Confirm your new address {me.pendingEmail} to finish the change.</p>}
      <nav className="tabs">
        <Link href="/account" aria-current="page">Profile</Link>
        <Link href="/account/travelers">Saved travellers</Link>
        <Link href="/bookings">My trips</Link>
      </nav>
      <ProfileForm customer={me} />
      <p className="muted">
        Preferences: {prefs.locale ?? "default language"} · {prefs.currency ?? "default currency"} · home airport {prefs.homeAirport ?? "—"}
      </p>
      <form action={signOutAction}>
        <button type="submit">Sign out</button>
      </form>
    </section>
  );
}
