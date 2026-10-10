"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { setSessionCookies, signOutCustomer, toActionError } from "@velexis/ota-sdk/next";
import { isVelexisError, type Schemas } from "@velexis/ota-sdk";
import { anonymousClient, customerClient, velexisConfig } from "@/lib/velexis";
import type { FormState } from "@/lib/action-state";

const safeNext = (v: FormDataEntryValue | null) => (typeof v === "string" && v.startsWith("/") && !v.startsWith("//") ? v : "/account");

/** Sign-up as a server action (tokens go straight into httpOnly cookies). */
export async function signUpAction(_prev: FormState, form: FormData): Promise<FormState> {
  let signedIn = false;
  try {
    const vx = await anonymousClient(); // request tenant + visitor IP / user agent (sign-up limits are per end-user IP)
    const res = await vx.auth.signUp({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      marketingConsent: form.get("marketing") === "on",
      termsVersion: String(form.get("termsVersion") ?? ""),
      returnPath: safeNext(form.get("next")),
    });
    if (res.session) {
      await setSessionCookies(res.session, { config: velexisConfig });
      signedIn = true;
    }
  } catch (e) {
    if (isVelexisError(e, "EMAIL_ALREADY_REGISTERED")) return { message: "You already have an account — sign in or reset your password." };
    return { ok: false, error: toActionError(e) }; // PASSWORD_TOO_WEAK, VALIDATION_FAILED (fieldErrors)
  }
  if (!signedIn) return { ok: true, message: "Check your inbox to confirm your e-mail address, then sign in." };
  redirect(safeNext(form.get("next")));
}

/** Profile update with optimistic concurrency (`ifMatch` = customer.version). */
export async function updateProfileAction(version: number, _prev: FormState, form: FormData): Promise<FormState> {
  try {
    const vx = await customerClient();
    const phone = String(form.get("phone") ?? "").trim();
    const update: Schemas["CustomerUpdateRequest"] = {
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      dateOfBirth: String(form.get("dateOfBirth") ?? "") || null,
      marketingConsent: form.get("marketing") === "on",
      phone: phone ? { deviceType: "MOBILE", countryCallingCode: String(form.get("callingCode") ?? "").replace(/^\+/, ""), number: phone.replace(/\D/g, "") } : null,
    };
    await vx.account.update({ ...update, ifMatch: version });
  } catch (e) {
    if (isVelexisError(e, "PRECONDITION_FAILED")) return { message: "Your profile changed in another window. Reload and try again." };
    return { ok: false, error: toActionError(e) };
  }
  revalidatePath("/account");
  return { ok: true, message: "Saved." };
}

/** Sign out (current session) and go home. */
export async function signOutAction(): Promise<void> {
  await signOutCustomer({ config: velexisConfig, scope: "current" });
  redirect("/");
}

/** Save a traveller to the account (AmadeusTraveler field names; document numbers are stored encrypted). */
export async function createSavedTravelerAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = (k: string) => String(form.get(k) ?? "").trim();
  try {
    const vx = await customerClient();
    await vx.account.savedTravelers.create({
      label: s("label") || undefined,
      isAccountHolder: form.get("isAccountHolder") === "on" || undefined, // optional, default false
      name: { firstName: s("firstName").toUpperCase(), lastName: s("lastName").toUpperCase() },
      dateOfBirth: s("dateOfBirth"),
      gender: (s("gender") || undefined) as Schemas["SavedTravelerCreateRequest"]["gender"],
      documents: s("documentNumber")
        ? [{ documentType: "PASSPORT", number: s("documentNumber"), expiryDate: s("expiryDate") || undefined, issuanceCountry: s("issuanceCountry").toUpperCase() || undefined, nationality: s("nationality").toUpperCase() || undefined, holder: true }]
        : undefined,
      loyaltyPrograms: s("loyaltyAirline") && s("loyaltyNumber") ? [{ programOwner: s("loyaltyAirline").toUpperCase(), id: s("loyaltyNumber") }] : undefined,
    });
  } catch (e) {
    if (isVelexisError(e, "SAVED_TRAVELER_LIMIT_REACHED")) return { message: "You can save up to 20 travellers." };
    return { ok: false, error: toActionError(e) };
  }
  revalidatePath("/account/travelers");
  return { ok: true, message: "Traveller saved." };
}

/** Delete a saved traveller. */
export async function deleteSavedTravelerAction(savedTravelerId: string): Promise<void> {
  const vx = await customerClient();
  await vx.account.savedTravelers.delete({ savedTravelerId }).catch((e: unknown) => {
    if (!isVelexisError(e, "NOT_FOUND")) throw e;
  });
  revalidatePath("/account/travelers");
}
