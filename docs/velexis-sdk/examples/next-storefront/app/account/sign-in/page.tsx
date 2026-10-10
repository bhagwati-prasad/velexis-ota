import { redirect } from "next/navigation";
import { currentCustomer, getStorefront } from "@/lib/velexis";
import { SignInForm } from "./sign-in-form";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/account";
  const [session, sf] = await Promise.all([currentCustomer(), getStorefront()]);
  if (session) redirect(safeNext);
  if (!sf.features.customerAccounts) redirect("/bookings/lookup");
  return (
    <section>
      <h1>Sign in</h1>
      <SignInForm next={safeNext} />
    </section>
  );
}
