// The server actions of the storefront settings (OAD-014; routes.md §9, api-changes part 2 §2.3, README §7, OADR-0018
// points 4 and 5, OADR-0012 points 1, 4 and 6, OADR-0004): one action per section of `StorefrontSettingsUpdate`, each
// a `console.settings.storefront.update` of that one section with `ifMatch` = the version the page displayed, through
// the SDK's console namespace with the client `requireStaff` hands back (the staff token of the request, the service
// key, the environment of the switch, the end-user headers). The settings are shared by the test and live
// environments, so the environment changes nothing here.
//
//   saveBrand        brand         saveFeatures     features      saveSupport      support
//   saveBranding     branding      savePolicies     policies      saveSeo          seo
//   saveLocales      locales       saveAirlineCard  airlineCard   saveConsent      consent
//   saveCurrencies   currencies    saveLegal        legal         saveOperations   operations
//   saveMarkets      markets
//
// Each starts with `requireStaff("settings:write")` (owners and admins; an agent's, a finance member's or a viewer's
// forged POST gets "You do not have permission to do this (settings:write)" before any call; the API decides and
// audits all the same), then reads the hidden version (a form without the page's: "This form is out of date"), then
// validates the section with its Zod mirror (settings-rules.ts `sectionChangesOf`, naming every problem at once), then
// sends that section complete, as the API replaces it. The `PATCH` has no idempotency key (the contract has none:
// `If-Match` makes a replay a `412`), so its answers bring no new one.
//
// A success answers the API's `warnings[]` as the API sent them (`airline_card_net_price`: the airline card is on while
// markup or fee rules add an amount, and airline-card bookings are sold at the airline's price, OADR-0004), which the
// form shows, and revalidates the page, whose new render brings the new version for every section's form. The API's
// codes become the form's state, never `error.tsx`: its field errors and a `422 UNPROCESSABLE`'s `details.path` on the
// field that caused them, with this page's words for `details.reason` (a saved market that the currencies or locales
// sent no longer support, which the API points at in the markets, on the list staff changed, naming the market);
// `403 FEATURE_DISABLED` (the airline card in
// live while the platform's switch is off) on the live switch; `412 PRECONDITION_FAILED` asks for a reload. Only
// redirects and bugs are thrown.
"use server";

import type { StaffPermission, StorefrontSettingsUpdateResult } from "@velexis/ota-sdk";
import { revalidatePath } from "next/cache";

import { fromZod, type ActionState } from "@/lib/action-state";
import { fieldNameOfPointer, fromVelexisError, type VelexisErrorLike } from "@/lib/errors";
import { requireStaff, type StaffContext } from "@/lib/session";

import {
  STOREFRONT_SETTINGS_PATH,
  UNPROCESSABLE_REASONS,
  VERSION_FIELD,
  VERSION_PATTERN,
  sectionChangesOf,
  settingsFieldOf,
  type PostedRows,
  type SettingsActionState,
  type SettingsSection,
} from "./settings-rules";

/** The permission of every write here (scope §1.3: owner and admin). */
const WRITE_PERMISSION: StaffPermission = "settings:write";

const STRINGS = Object.freeze({
  saved: "Saved. The storefront shows the change within 5 minutes.",
  staleForm: "This form is out of date. Reload the page and try again.",
  changed:
    "The storefront settings changed since this page was loaded (another section was saved, or someone else changed them). Reload the page to see them; this section was not saved.",
  liveAirlineCard:
    "The airline card cannot be turned on in live yet: the platform turns it on after its security review. The test environment can use it already.",
  marketUses: (market: number, what: "currency" | "locale") =>
    `Market ${market} (under Markets) uses a ${what} this list no longer includes. Keep that ${what} here, or give the market another one and save the markets first.`,
});

/**
 * A saved market that a sent `currencies` or `locales` section no longer supports: the API points at the market
 * (`/markets/list/<n>/currency` or `/locale`, a section this form does not show), so the refusal belongs to the list
 * staff changed, with the market named by its position as the markets form shows it.
 */
const MARKET_POINTER = /^markets\.list\.(\d{1,3})\.(currency|locale)$/;

/** The form's hidden fields: an error on one means the form is not the page's any more. */
const HIDDEN_FIELDS: ReadonlySet<string> = new Set(["ifMatch", VERSION_FIELD]);

/** The staff context of an action, or the state of its refusal (a missing permission, an ended or refused session). */
async function staffFor(
  permission: StaffPermission,
): Promise<{ readonly context: StaffContext } | { readonly state: ActionState }> {
  try {
    return { context: await requireStaff(permission) };
  } catch (error) {
    return { state: fromVelexisError(error) };
  }
}

/**
 * The state of a failed update of `section`: lib/errors.ts's message, request id and field errors, the field errors on
 * the form's fields (`settingsFieldOf`: a code list's item on its list, a row's position on the row the form posted),
 * and this page's words for the codes it knows. Redirects and bugs are thrown again (`fromVelexisError`).
 */
function failureOf(error: unknown, section: SettingsSection, rows: PostedRows): ActionState {
  const base = fromVelexisError(error);
  const apiError = error as VelexisErrorLike;
  const fieldErrors: Record<string, string> = {};
  for (const [name, message] of Object.entries(base.fieldErrors ?? {})) {
    const field = settingsFieldOf(name, rows);
    if (!Object.hasOwn(fieldErrors, field)) {
      fieldErrors[field] = message;
    }
  }
  let message = base.message ?? STRINGS.staleForm;
  if (Object.keys(fieldErrors).some((name) => HIDDEN_FIELDS.has(name))) {
    message = STRINGS.staleForm;
  }
  const details = apiError.details ?? {};
  const reason = details["reason"];
  const path = details["path"];
  if (apiError.code === "UNPROCESSABLE" && typeof reason === "string") {
    const text = UNPROCESSABLE_REASONS[reason];
    if (text !== undefined) {
      message = text;
    }
    const pointed = typeof path === "string" ? fieldNameOfPointer(path) : undefined;
    const market = pointed === undefined ? null : MARKET_POINTER.exec(pointed);
    if (market !== null && (section === "currencies" || section === "locales")) {
      message = STRINGS.marketUses(Number(market[1]) + 1, market[2] === "currency" ? "currency" : "locale");
      fieldErrors[`${section}.supported`] = message;
    } else if (pointed !== undefined) {
      const field = settingsFieldOf(pointed, rows);
      if (!Object.hasOwn(fieldErrors, field)) {
        fieldErrors[field] = message;
      }
    }
  } else if (apiError.code === "FEATURE_DISABLED" && details["feature"] === "airlineCard") {
    message = STRINGS.liveAirlineCard;
    fieldErrors["airlineCard.enabledLive"] = STRINGS.liveAirlineCard;
  } else if (apiError.code === "PRECONDITION_FAILED") {
    message = STRINGS.changed;
  }
  const { fieldErrors: _apiFieldErrors, ...rest } = base;
  return {
    ...rest,
    message,
    ...(Object.keys(fieldErrors).length === 0 ? {} : { fieldErrors: Object.freeze(fieldErrors) }),
  };
}

/** Saves one section of the settings: the form's values, complete, with `ifMatch` = the displayed version. */
async function saveSection(section: SettingsSection, form: FormData): Promise<SettingsActionState> {
  const staff = await staffFor(WRITE_PERMISSION);
  if ("state" in staff) {
    return staff.state;
  }
  const version = form.get(VERSION_FIELD);
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    return { ok: false, code: "VALIDATION_FAILED", message: STRINGS.staleForm };
  }
  const parsed = sectionChangesOf(section, form);
  if (!parsed.success) {
    return fromZod(parsed.error);
  }

  let saved: StorefrontSettingsUpdateResult;
  try {
    saved = await staff.context.console.settings.storefront.update({
      ifMatch: Number(version),
      ...parsed.changes,
    });
  } catch (error) {
    return failureOf(error, section, parsed.rows);
  }
  revalidatePath(STOREFRONT_SETTINGS_PATH);
  const warnings = saved.warnings;
  return { ok: true, message: STRINGS.saved, ...(warnings.length === 0 ? {} : { warnings }) };
}

/** "Save" of the brand: name, legal name, time zone. */
export async function saveBrand(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("brand", form);
}

/** "Save" of the branding and theme: logos, favicon, colours, fonts, corner radius. */
export async function saveBranding(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("branding", form);
}

/** "Save" of the locales: the default and the supported ones. */
export async function saveLocales(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("locales", form);
}

/** "Save" of the currencies: the default and the supported ones. */
export async function saveCurrencies(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("currencies", form);
}

/** "Save" of the markets: the list and the default one. */
export async function saveMarkets(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("markets", form);
}

/** "Save" of the storefront's features. */
export async function saveFeatures(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("features", form);
}

/** "Save" of the policies: ticketing, 3-D Secure, card brands, e-mail verification, offer and checkout lifetimes. */
export async function savePolicies(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("policies", form);
}

/** "Save" of the airline card per environment; the API warns when markup or fee rules add an amount. */
export async function saveAirlineCard(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("airlineCard", form);
}

/** "Save" of the legal versions and links. */
export async function saveLegal(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("legal", form);
}

/** "Save" of the support contact. */
export async function saveSupport(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("support", form);
}

/** "Save" of the SEO defaults. */
export async function saveSeo(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("seo", form);
}

/** "Save" of the cookie consent. */
export async function saveConsent(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("consent", form);
}

/** "Save" of the operations: the staff alert e-mail and the booking queue. */
export async function saveOperations(_state: ActionState, form: FormData): Promise<SettingsActionState> {
  return saveSection("operations", form);
}
