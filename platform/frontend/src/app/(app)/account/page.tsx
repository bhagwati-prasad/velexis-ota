import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ProfileForm } from "@/app/(app)/account/profile-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { timeZoneOptions, type SelectOption } from "@/lib/reference-options";
import { ACCOUNT_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: ACCOUNT_STRINGS.title };

/**
 * The languages of the profile: Velexis is in English (ADR-0014; e-mail templates are `en` in the MVP), so the choice
 * is between its English variants. The account's own value stays offered when it is another valid tag, so a save does
 * not change it unasked.
 */
const LOCALE_CODES: readonly string[] = ["en", "en-GB", "en-US"];
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** The language options, named in English with `Intl.DisplayNames`, the account's own included. */
function localeOptions(current: string): SelectOption[] {
  const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "code" });
  const codes = new Set(LOCALE_CODES);
  if (current.length <= 35 && LOCALE_PATTERN.test(current)) {
    codes.add(current);
  }
  return [...codes].map((code) => {
    let label = code;
    try {
      label = names.of(code) ?? code;
    } catch {
      // A tag `Intl` refuses keeps its code as its name.
    }
    return { value: code, label };
  });
}

/**
 * `/account` (README §2 Signed in; PF-07): the profile of the signed-in account. The page reads `getMe` (the account's
 * name, address, locale, time zone and version) and renders `ProfileForm` with the language and time zone lists built
 * here, on the server, so the server's markup and the browser's hydration agree. An ended session goes to sign-in and
 * back here; any other failure shows the portal's message for its code.
 */
export default async function AccountPage() {
  const api = await platformApi();
  const me = await api.GET("/v1/me");
  if (me.error !== undefined) {
    if (me.error.code === "UNAUTHENTICATED" || me.error.code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: "/account" }).toString()}`);
    }
    return (
      <div className="mx-auto grid max-w-2xl gap-8">
        <h1 className="text-3xl font-semibold tracking-tight">{ACCOUNT_STRINGS.title}</h1>
        <Alert variant="destructive">
          <AlertTitle>{ACCOUNT_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(me.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const account = me.data;
  return (
    <div className="mx-auto grid max-w-2xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{ACCOUNT_STRINGS.title}</h1>
        <p className="text-muted-foreground">{ACCOUNT_STRINGS.intro}</p>
      </div>
      <ProfileForm
        account={{
          fullName: account.fullName,
          email: account.email,
          locale: account.locale,
          timeZone: account.timeZone,
          version: account.version,
        }}
        locales={localeOptions(account.locale)}
        timeZones={timeZoneOptions(account.timeZone)}
      />
    </div>
  );
}
