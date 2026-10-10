import { redirect } from "next/navigation";
import { currentStaff } from "@/lib/velexis";
import { StaffSignInForm } from "./sign-in-form";

export default async function ConsoleSignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await currentStaff()) redirect(next?.startsWith("/console") ? next : "/console/bookings");
  return (
    <section className="console-sign-in">
      <h1>Staff sign-in</h1>
      <StaffSignInForm next={next ?? "/console/bookings"} />
    </section>
  );
}
