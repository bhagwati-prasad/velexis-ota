"use server";

import { redirect } from "next/navigation";
import { signInStaff, signOutStaff, toActionError } from "@velexis/ota-sdk/next";
import { isVelexisError } from "@velexis/ota-sdk";
import { velexisConfig } from "@/lib/velexis";
import type { FormState } from "@/lib/action-state";

export type StaffSignInState = FormState & { needMfa?: boolean };

/** Staff sign-in with portal credentials (+ TOTP) — tokens go into httpOnly, SameSite=strict cookies. */
export async function signInStaffAction(_prev: StaffSignInState, form: FormData): Promise<StaffSignInState> {
  const mfaCode = String(form.get("mfaCode") ?? "").trim();
  try {
    await signInStaff(
      { grantType: "password", email: String(form.get("email") ?? ""), password: String(form.get("password") ?? ""), mfaCode: mfaCode || undefined },
      { config: velexisConfig },
    );
  } catch (e) {
    if (isVelexisError(e, "STAFF_MFA_REQUIRED")) return { needMfa: true };
    if (isVelexisError(e, "INVALID_CREDENTIALS")) return { needMfa: !!mfaCode, message: "Wrong e-mail, password or code." };
    if (isVelexisError(e, "ACCOUNT_LOCKED")) return { message: "Too many attempts — try again in 15 minutes." };
    if (isVelexisError(e, "STAFF_MEMBERSHIP_INACTIVE")) return { message: "You are not an active staff member of this OTA." };
    return { error: toActionError(e) };
  }
  const next = String(form.get("next") ?? "");
  redirect(next.startsWith("/console") ? next : "/console/bookings");
}

/** Portal "Open console" deep link: one-time portal token → staff session. */
export async function exchangePortalTokenAction(portalToken: string): Promise<void> {
  await signInStaff({ grantType: "portal_token", portalToken }, { config: velexisConfig });
  redirect("/console/bookings");
}

export async function signOutStaffAction(): Promise<void> {
  await signOutStaff({ config: velexisConfig });
  redirect("/console/sign-in");
}
