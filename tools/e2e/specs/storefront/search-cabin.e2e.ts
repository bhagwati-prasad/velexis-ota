// The storefront's search form and the OTA's default cabin (KI-018, lead decision (39n) of 2026-11-23,
// FIX-W70-STOREFRONT): the cabin select starts on "No preference", which sends no cabin, so the server applies the
// OTA's `storefront_settings.search_defaults.cabin` to the search; a cabin the traveller chooses is sent instead; a
// search without a cabin comes back without one ("Change search" and the address). The proof is what the OTA API
// asked Amadeus for: the path of the search's Flight Offers Search call in `supplier_requests`, which carries
// `travelClass` (the stub answers every search with the same offers, whatever the cabin).
//
// Fixture (no API reaches it): the OTA admin edits only `search_defaults.maxResults` (OAD-021), so this spec sets the
// demo OTA's default cabin with `tenantTx` as velexis_ota_app (support/ota.ts `withTenantTx`), merging the key into
// the column, and removes the key again afterwards, leaving every other key (a `maxResults` another journey set) as it
// is. flights.search reads the column per request (no cache), and the stub ignores the cabin, so a journey that
// searches without a cabin meanwhile gets the same offers.
import type { Page } from "@playwright/test";
import { sql } from "@velexis/db";
import { DEMO_TENANT_SCHEMA, departureDate, searchIdOf, withTenantTx } from "../../support/ota";
import { expect, test } from "../../support/storefront-guards";

/** The departures of this spec, days from today: dates no other journey searches (searches are shared for 30 s). */
const NO_CABIN_DAYS_AHEAD = 74;
const ECONOMY_DAYS_AHEAD = 75;

/** The demo OTA's default cabin while this spec runs: not the Economy the form used to send. */
const DEFAULT_CABIN = "BUSINESS";

/** The `cabin` of the demo OTA's `search_defaults` before this spec set it (`null`: the key was not there). */
let previousCabin: string | null = null;

/** Sets (or, with `null`, removes) the `cabin` key of the demo OTA's `search_defaults`, keeping its other keys. */
async function setDefaultCabin(cabin: string | null): Promise<void> {
  await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    await trx
      .updateTable("storefront_settings")
      .set({
        search_defaults:
          cabin === null
            ? sql`coalesce(search_defaults, '{}'::jsonb) - 'cabin'`
            : sql`coalesce(search_defaults, '{}'::jsonb) || jsonb_build_object('cabin', ${cabin}::text)`,
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .execute();
  });
}

/** The `cabin` of the demo OTA's `search_defaults` now, or `null`. */
async function defaultCabin(): Promise<string | null> {
  return await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    const row = await trx
      .selectFrom("storefront_settings")
      .select(sql<string | null>`search_defaults ->> 'cabin'`.as("cabin"))
      .executeTakeFirst();
    return row?.cabin ?? null;
  });
}

/** The `travelClass` the OTA API sent Amadeus for the search `searchId` (`null`: none), once its call is recorded. */
async function sentTravelClass(searchId: string): Promise<string | null> {
  let path: string | undefined;
  await expect
    .poll(
      async () => {
        path = await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
          const row = await trx
            .selectFrom("supplier_requests")
            .select("path")
            .where("search_id", "=", searchId)
            .where("amadeus_api", "=", "FlightOffersSearch")
            .orderBy("created_at")
            .executeTakeFirst();
          return row?.path;
        });
        return path !== undefined;
      },
      { message: `the Flight Offers Search call of ${searchId} is recorded` },
    )
    .toBe(true);
  return new URL(path ?? "", "https://amadeus.invalid").searchParams.get("travelClass");
}

/** Types `typed` into the location combobox `name` and picks its first suggestion of `code`. */
async function chooseLocation(page: Page, name: string, typed: string, code: string): Promise<void> {
  const field = page.getByRole("combobox", { name });
  await field.fill(typed);
  await page
    .getByRole("listbox", { name })
    .getByRole("option", { name: new RegExp(`^${code} `) })
    .first()
    .click();
  await expect(field).toHaveValue(new RegExp(`\\(${code}\\)$`));
}

/** Fills the home page's form for a one-way trip from Madrid to Paris `daysAhead` days from today. */
async function fillOneWay(page: Page, daysAhead: number): Promise<void> {
  const form = page.getByRole("form", { name: "Search flights" });
  await form.getByRole("radio", { name: "One way" }).check();
  await chooseLocation(page, "From", "Madrid", "MAD");
  await chooseLocation(page, "To", "Paris", "PAR");
  await form.getByRole("textbox", { name: "Departure" }).fill(departureDate(daysAhead));
}

test.describe("the search form's cabin and the OTA's default cabin (KI-018)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    previousCabin = await defaultCabin();
    await setDefaultCabin(DEFAULT_CABIN);
  });

  test.afterAll(async () => {
    await setDefaultCabin(previousCabin);
  });

  test("the form sends no cabin unless the traveller chooses one, and the OTA's default cabin applies [FIX-W70-STOREFRONT AC3]", async ({
    page,
    guards,
  }) => {
    await page.goto("/");
    const form = page.getByRole("form", { name: "Search flights" });
    const cabin = form.getByRole("combobox", { name: "Cabin" });
    // The first, preselected choice claims no cabin.
    await expect(cabin).toHaveValue("");
    await expect(cabin.locator("option:checked")).toHaveText("No preference");
    await guards.checkA11y(page);

    await fillOneWay(page, NO_CABIN_DAYS_AHEAD);
    await form.getByRole("button", { name: "Search flights" }).click();
    await page.waitForURL(/\/search\.html\?.*search=srch_/);
    const address = new URL(page.url());
    expect(address.searchParams.has("cabin"), "no cabin in the address").toBe(false);
    const results = page.getByRole("region", { name: /flights?$/ });
    await expect(results.getByRole("heading", { level: 2, name: /^\d+ flights?$/ })).toBeVisible();
    // The OTA API applied the OTA's default cabin to the search the form sent without one.
    expect(await sentTravelClass(searchIdOf(page.url()))).toBe(DEFAULT_CABIN);
    // "Change search" keeps "No preference": no cabin round-trips as no cabin.
    await page.locator("main details[data-search-panel] > summary").click();
    await expect(page.locator("main #search-cabin")).toHaveValue("");
    await guards.checkA11y(page);
  });

  test("a cabin the traveller chooses is sent and preselected again from the address [FIX-W70-STOREFRONT AC3]", async ({
    page,
    guards,
  }) => {
    await page.goto("/");
    const form = page.getByRole("form", { name: "Search flights" });
    await fillOneWay(page, ECONOMY_DAYS_AHEAD);
    await form.getByRole("combobox", { name: "Cabin" }).selectOption("ECONOMY");
    await form.getByRole("button", { name: "Search flights" }).click();
    await page.waitForURL(/\/search\.html\?.*search=srch_/);
    expect(new URL(page.url()).searchParams.get("cabin")).toBe("ECONOMY");
    const results = page.getByRole("region", { name: /flights?$/ });
    await expect(results.getByRole("heading", { level: 2, name: /^\d+ flights?$/ })).toBeVisible();
    expect(await sentTravelClass(searchIdOf(page.url()))).toBe("ECONOMY");
    // The address preselects it in "Change search", and on the home page as a deep link.
    await page.locator("main details[data-search-panel] > summary").click();
    await expect(page.locator("main #search-cabin")).toHaveValue("ECONOMY");
    const query = new URL(page.url()).searchParams;
    query.delete("search");
    await page.goto(`/?${query.toString()}`);
    await expect(
      page.getByRole("form", { name: "Search flights" }).getByRole("combobox", { name: "Cabin" }),
    ).toHaveValue("ECONOMY");
    await guards.checkA11y(page);
  });
});
