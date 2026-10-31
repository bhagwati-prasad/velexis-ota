// `/settings/storefront` (README §5, routes.md §9, OAD-014): the storefront settings of the OTA, through
// `console.settings.storefront.get` (`settings:read`, every role), and the uploaded images its pickers offer, through
// `console.settings.assets.list` of each picker's kind (`logo`, `logo_dark`, `logo_square`, `favicon`, `og_image`; the
// newest 100 of each). The settings are shared by the test and live environments; the hosted storefront shows a change
// within 5 minutes.
//
// - Owners and admins (`settings:write`) get every section's form (sections.tsx), each saved on its own with
//   `console.settings.storefront.update` and `ifMatch` = the version shown here (actions.ts); the theme editor
//   (theme-editor.tsx) previews the colours and warns when a pair fails WCAG contrast, as the storefront then falls
//   back to its neutral colours (lib/contrast.ts).
// - Every other role (agent, finance, viewer) sees the same sections read only, with the permission that changing them
//   needs.
// - `?tab=` opens one of the tabs (brand, locales, features, policies, payments, legal, seo, operations).
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// page, an ended session to the portal (`redirectOnSessionError`), and every other API error of the settings renders
// the console's message for its code with the request id and "Try again". A failure of the images leaves the pickers
// with the current choices and says so; the settings stay editable.
import type { StaffPermission, StorefrontAsset, StorefrontSettings } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";

import { formatInstant, queryOf } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import { ASSETS_PATH, type AssetKind } from "../assets/asset-rules";
import { StorefrontSettingsSections } from "./sections";
import { STOREFRONT_SETTINGS_PATH, storefrontTabOf } from "./settings-rules";
import type { AssetsByKind } from "./theme-editor";

export const metadata: Metadata = { title: "Storefront settings" };

const PAGE_STRINGS = Object.freeze({
  title: "Storefront settings",
  intro:
    "The hosted storefront's brand, theme, languages, features and policies. They are shared by the test and live environments, and the storefront shows a change within 5 minutes.",
  version: (version: number, updated: string) => `Version ${version}, last changed ${updated}.`,
  readOnly: "Read only: changing the storefront settings needs the permission settings:write.",
  assetsLink: "Upload and manage the images on the Assets page.",
  unavailableTitle: "The storefront settings could not be loaded",
  forbiddenTitle: "You cannot open the storefront settings",
  retry: "Try again",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const READ_PERMISSION: StaffPermission = "settings:read";
const WRITE_PERMISSION: StaffPermission = "settings:write";

/** The kinds of the pickers: the logos and the favicon (branding) and the social sharing image (SEO). */
const PICKER_KINDS: readonly AssetKind[] = ["logo", "logo_dark", "logo_square", "favicon", "og_image"];
/** The images a picker lists: the newest of their kind (the API's largest page). */
const PICKER_LIMIT = 100;

/**
 * An error of the OTA API as the page's state: `TOKEN_EXPIRED` and an ended session redirect (Next.js's redirect is
 * thrown on), anything that is not an API error is thrown for the error boundary, and an API error is returned.
 */
async function apiFailure(error: unknown, here: string): Promise<VelexisErrorLike> {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  try {
    await redirectOnSessionError(error, here);
  } catch (thrown) {
    // `redirectOnSessionError` throws the same error back when it is not about the session.
    if (thrown !== error) {
      throw thrown;
    }
  }
  return error;
}

/** The IANA time zones to choose from: the server's list, `UTC`, and the saved zone when the list lacks it. */
function timeZonesWith(saved: string): string[] {
  const zones = new Set<string>(["UTC", ...Intl.supportedValuesOf("timeZone")]);
  zones.add(saved);
  return [...zones].sort((left, right) => left.localeCompare(right, "en"));
}

/** The images of the picker kinds, or `undefined` when a read failed (session failures redirect). */
async function pickerAssets(request: ConsoleRequest, here: string): Promise<AssetsByKind | undefined> {
  try {
    const pages = await Promise.all(
      PICKER_KINDS.map((kind) => request.console.settings.assets.list({ kind, limit: PICKER_LIMIT })),
    );
    return Object.fromEntries(
      PICKER_KINDS.map((kind, index): [AssetKind, readonly StorefrontAsset[]] => [
        kind,
        pages[index]?.data ?? [],
      ]),
    );
  } catch (error) {
    await apiFailure(error, here);
    return undefined;
  }
}

export default async function StorefrontSettingsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = queryOf(await searchParams);
  const tab = storefrontTabOf(query.get("tab"));
  // Where an expired session comes back to: this page and its tab (a tab that is not one is never put into the URL).
  const here = query.has("tab") ? `${STOREFRONT_SETTINGS_PATH}?tab=${tab}` : STOREFRONT_SETTINGS_PATH;

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff } = request;

  if (!can(staff, READ_PERMISSION)) {
    return (
      <ErrorState
        title={PAGE_STRINGS.forbiddenTitle}
        description={{
          message: errorMessage({
            code: "FORBIDDEN",
            status: 403,
            requestId: null,
            fieldErrors: [],
            retryable: false,
            details: { requiredPermission: READ_PERMISSION },
          }),
        }}
      />
    );
  }

  let settings: StorefrontSettings;
  try {
    settings = await request.console.settings.storefront.get();
  } catch (error) {
    const failure = await apiFailure(error, here);
    return (
      <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
        {/* The same URL again: the settings are read anew. */}
        <a href={here} className={LINK_CLASS}>
          {PAGE_STRINGS.retry}
        </a>
      </ErrorState>
    );
  }
  const assets = await pickerAssets(request, here);
  const canWrite = can(staff, WRITE_PERMISSION);

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="max-w-3xl text-muted-foreground">{PAGE_STRINGS.intro}</p>
        <p className="text-sm text-muted-foreground">
          {PAGE_STRINGS.version(settings.version, formatInstant(settings.updatedAt, staff.tenant.timeZone))}
        </p>
        {canWrite ? null : <p className="text-sm text-muted-foreground">{PAGE_STRINGS.readOnly}</p>}
        <p className="text-sm">
          <Link href={ASSETS_PATH} className={LINK_CLASS}>
            {PAGE_STRINGS.assetsLink}
          </Link>
        </p>
      </div>
      <StorefrontSettingsSections
        settings={settings}
        assets={assets ?? {}}
        assetsUnavailable={assets === undefined}
        timeZones={timeZonesWith(settings.brand.timeZone)}
        canWrite={canWrite}
        initialTab={tab}
      />
    </div>
  );
}
