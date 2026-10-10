import { redirect } from "next/navigation";
import { getStorefront } from "@/lib/velexis";
import { SignUpForm } from "./sign-up-form";

export const metadata = { title: "Create account" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const sf = await getStorefront();
  if (!sf.features.customerAccounts) redirect("/");
  const policy = sf.auth.passwordPolicy;
  return (
    <section>
      <h1>Create your account</h1>
      <SignUpForm termsVersion={sf.legal.termsVersion} termsUrl={sf.legal.termsUrl} privacyUrl={sf.legal.privacyUrl} next={next ?? "/account"} minLength={policy.minLength} />
    </section>
  );
}
