// The pricing rules of a tenant against PostgreSQL 16 (OBE-020; OADR-0005; ADR-0004 tenant isolation). The file clones
// the @velexis/testing template (tenant_alpha and tenant_beta provisioned, reference fixture loaded), inserts markup
// and fee rules into both tenants as velexis_ota_app, and loads them through the RulesRepository of PricingModule
// inside tenant transactions of that role, then prices an offer with what each tenant's transaction returned.
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  createPool,
  createTenantDb,
  tenantTx,
  type Insertable,
  type TenantDatabase,
  type TenantDb,
} from "@velexis/db";
import { createTestDatabase, type TestDatabase } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { priceOffer } from "../../../src/pricing/pricing-engine";
import { PricingModule } from "../../../src/pricing/pricing.module";
import type { PricingInput } from "../../../src/pricing/pricing.types";
import { RulesRepository, type ActivePricingRules } from "../../../src/pricing/rules.repository";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";

const ALPHA = "tenant_alpha";
const BETA = "tenant_beta";
const NOW = new Date("2026-11-01T12:00:00.000Z");

/** Paris to New York and back, 2 adults and 1 child, 2 segments, net 1000.00 EUR. */
const INPUT: PricingInput = Object.freeze({
  at: NOW,
  currency: "EUR",
  minorUnits: 2,
  netTotal: "1000.00",
  origin: "CDG",
  destination: "JFK",
  originCountry: "FR",
  destinationCountry: "US",
  validatingCarriers: ["AF"],
  marketingCarriers: ["AF"],
  cabins: ["ECONOMY"],
  travelers: { ADULT: 2, CHILD: 1 },
  segmentCount: 2,
  tripType: "round_trip",
  source: "GDS",
  channel: "storefront",
});

const quietPoolLogger = { error: (): void => undefined };

type MarkupInsert = Insertable<TenantDatabase["markup_rules"]>;
type FeeInsert = Insertable<TenantDatabase["fee_rules"]>;

/** The ids of the rules this file inserts, by tenant. */
const IDS = {
  alpha: {
    default: "",
    tenPercent: newId("mkr", NOW),
    disabled: newId("mkr", NOW),
    expired: newId("mkr", NOW),
    unknownScopeField: newId("mkr", NOW),
    notANumberCap: newId("mkr", NOW),
    serviceFee: newId("fee", NOW),
    feeWithoutAmount: newId("fee", NOW),
    notANumberFee: newId("fee", NOW),
  },
  beta: {
    default: "",
    fiftyPercent: newId("mkr", NOW),
    serviceFee: newId("fee", NOW),
    ticketingFee: newId("fee", NOW),
  },
};

let db: TestDatabase;
let otaPool: ReturnType<typeof createPool>;
/** velexis_ota_app, the role of the OTA API and worker. */
let tenants: TenantDb;
let context: INestApplicationContext;
let repository: RulesRepository;

function markupRule(row: Partial<MarkupInsert> & Pick<MarkupInsert, "id" | "name">): MarkupInsert {
  return { calculation: "percentage", percentage: "0", ...row, scope: JSON.stringify(row.scope ?? {}) };
}

function feeRule(row: Partial<FeeInsert> & Pick<FeeInsert, "id" | "name" | "fee_type">): FeeInsert {
  return {
    label: row.name,
    calculation: "fixed",
    currency: "EUR",
    ...row,
    scope: JSON.stringify(row.scope ?? {}),
  };
}

/** The rules of `schema`, loaded in a transaction of their own. */
function loadRules(schema: string): Promise<ActivePricingRules> {
  return tenantTx(tenants, schema, (trx) => repository.loadActiveRules(trx));
}

beforeAll(async () => {
  db = await createTestDatabase();
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-api-test",
    logger: quietPoolLogger,
    max: 2,
  });
  tenants = createTenantDb(otaPool, { appEnv: "test" });
  context = await NestFactory.createApplicationContext(PricingModule, { logger: false });
  repository = context.get(RulesRepository);

  await tenantTx(tenants, ALPHA, async (trx) => {
    await seedDefaultMarkupRule(trx, NOW);
    await trx
      .insertInto("markup_rules")
      .values([
        markupRule({ id: IDS.alpha.tenPercent, name: "Alpha 10 %", percentage: "10" }),
        markupRule({
          id: IDS.alpha.disabled,
          name: "Alpha disabled",
          percentage: "90",
          priority: 1,
          is_active: false,
        }),
        markupRule({
          id: IDS.alpha.expired,
          name: "Alpha January",
          percentage: "70",
          priority: 3,
          active_from: new Date("2026-01-01T00:00:00.000Z"),
          active_until: new Date("2026-02-01T00:00:00.000Z"),
        }),
        markupRule({
          id: IDS.alpha.unknownScopeField,
          name: "Alpha routes",
          percentage: "50",
          priority: 2,
          scope: { routes: ["CDG-JFK"] },
        }),
        // A numeric column without a CHECK accepts 'NaN': as the base rule, it would fail every alpha price.
        markupRule({
          id: IDS.alpha.notANumberCap,
          name: "Alpha NaN cap",
          percentage: "40",
          priority: 4,
          fixed_currency: "EUR",
          min_amount: "NaN",
        }),
      ])
      .execute();
    await trx
      .insertInto("fee_rules")
      .values([
        feeRule({
          id: IDS.alpha.serviceFee,
          name: "Alpha service fee",
          fee_type: "booking_service",
          fixed_amount: "5.00",
        }),
        // fee_rules has no CHECK tying the calculation to its amounts: a fixed fee without an amount can be stored.
        feeRule({
          id: IDS.alpha.feeWithoutAmount,
          name: "Alpha ticketing",
          fee_type: "ticketing",
          fixed_amount: null,
        }),
        // 'NaN' passes the fixed_amount >= 0 CHECK: PostgreSQL orders NaN above every number.
        feeRule({
          id: IDS.alpha.notANumberFee,
          name: "Alpha NaN service fee",
          fee_type: "booking_service",
          fixed_amount: "NaN",
          priority: 1,
        }),
      ])
      .execute();
    const row = await trx
      .selectFrom("markup_rules")
      .select("id")
      .where("is_default", "=", true)
      .executeTakeFirstOrThrow();
    IDS.alpha.default = row.id;
  });

  await tenantTx(tenants, BETA, async (trx) => {
    await seedDefaultMarkupRule(trx, NOW);
    await trx
      .insertInto("markup_rules")
      .values(markupRule({ id: IDS.beta.fiftyPercent, name: "Beta 50 %", percentage: "50", priority: 50 }))
      .execute();
    await trx
      .insertInto("fee_rules")
      .values([
        feeRule({
          id: IDS.beta.serviceFee,
          name: "Beta service fee",
          fee_type: "booking_service",
          fixed_amount: "20.00",
        }),
        feeRule({
          id: IDS.beta.ticketingFee,
          name: "Beta ticketing fee",
          fee_type: "ticketing",
          fixed_amount: "3.00",
          applies_per: "traveler",
          priority: 110,
        }),
      ])
      .execute();
    const row = await trx
      .selectFrom("markup_rules")
      .select("id")
      .where("is_default", "=", true)
      .executeTakeFirstOrThrow();
    IDS.beta.default = row.id;
  });
});

afterAll(async () => {
  await context?.close();
  await otaPool?.end();
  await db?.drop();
});

describe("RulesRepository", () => {
  it("is provided by PricingModule", () => {
    expect(repository).toBeInstanceOf(RulesRepository);
  });

  it("loads only the rules of the transaction's tenant, and tenant B's rules never price tenant A's offers [OBE-020 AC3]", async () => {
    const alpha = await loadRules(ALPHA);
    const beta = await loadRules(BETA);

    const alphaIds = [...alpha.markupRules, ...alpha.feeRules].map((rule) => rule.id);
    const betaIds = [...beta.markupRules, ...beta.feeRules].map((rule) => rule.id);
    expect(alpha.markupRules.map((rule) => rule.id)).toEqual([
      IDS.alpha.expired,
      IDS.alpha.tenPercent,
      IDS.alpha.default,
    ]);
    expect(alpha.feeRules.map((rule) => rule.id)).toEqual([IDS.alpha.serviceFee]);
    expect(beta.markupRules.map((rule) => rule.id)).toEqual([IDS.beta.fiftyPercent, IDS.beta.default]);
    expect(beta.feeRules.map((rule) => rule.id)).toEqual([IDS.beta.serviceFee, IDS.beta.ticketingFee]);
    expect(alphaIds.filter((id) => betaIds.includes(id))).toEqual([]);

    const alphaPrice = priceOffer(INPUT, alpha.markupRules, alpha.feeRules, { kind: "pricing" });
    const betaPrice = priceOffer(INPUT, beta.markupRules, beta.feeRules, { kind: "pricing" });
    expect(alphaPrice).toMatchObject({
      markupRuleId: IDS.alpha.tenPercent,
      markupTotal: "100.00",
      feeTotal: "5.00",
      selling: "1105.00",
    });
    expect(alphaPrice.feeLines.map((line) => line.label)).toEqual(["Alpha service fee"]);
    expect(betaPrice).toMatchObject({
      markupRuleId: IDS.beta.fiftyPercent,
      markupTotal: "500.00",
      feeTotal: "29.00",
      selling: "1529.00",
    });
    const betaRuleIds = new Set(betaIds);
    expect(
      [...alphaPrice.markupLines, ...alphaPrice.feeLines].some((line) => betaRuleIds.has(line.ruleId)),
    ).toBe(false);
  });

  it("maps the stored rows as the engine reads them, leaving the validity window to the engine", async () => {
    const alpha = await loadRules(ALPHA);

    const expired = alpha.markupRules.find((rule) => rule.id === IDS.alpha.expired);
    expect(expired).toEqual({
      id: IDS.alpha.expired,
      name: "Alpha January",
      scope: {},
      calculation: "percentage",
      percentage: "70.0000",
      fixedAmount: null,
      fixedCurrency: null,
      appliesPer: "traveler",
      minAmount: null,
      maxAmount: null,
      priority: 3,
      stackable: false,
      isDefault: false,
      isActive: true,
      activeFrom: new Date("2026-01-01T00:00:00.000Z"),
      activeUntil: new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(alpha.feeRules[0]).toMatchObject({
      feeType: "booking_service",
      label: "Alpha service fee",
      calculation: "fixed",
      fixedAmount: "5.00",
      fixedCurrency: "EUR",
      appliesPer: "booking",
      refundable: false,
    });
    // Loaded, but outside its window on NOW: the engine skips it.
    expect(
      priceOffer(INPUT, alpha.markupRules, [], { kind: "search" }).markupLines.map((line) => line.ruleId),
    ).toEqual([IDS.alpha.tenPercent]);
  });

  it("leaves out disabled rules and reports enabled rows it cannot evaluate, by id and reason only", async () => {
    const alpha = await loadRules(ALPHA);

    expect(alpha.markupRules.map((rule) => rule.id)).not.toContain(IDS.alpha.disabled);
    expect(alpha.invalidRules).toEqual([
      {
        table: "markup_rules",
        id: IDS.alpha.unknownScopeField,
        reason: 'scope has the unknown field "routes"',
      },
      { table: "markup_rules", id: IDS.alpha.notANumberCap, reason: "min_amount is not a decimal number" },
      { table: "fee_rules", id: IDS.alpha.notANumberFee, reason: "fixed_amount is not a decimal number" },
      { table: "fee_rules", id: IDS.alpha.feeWithoutAmount, reason: "calculation fixed has no fixed_amount" },
    ]);
    expect((await loadRules(BETA)).invalidRules).toEqual([]);
  });

  it("queries once per transaction: later calls in the same transaction get the same result", async () => {
    await tenantTx(tenants, ALPHA, async (trx) => {
      const selectFrom = vi.spyOn(trx, "selectFrom");

      const first = await repository.loadActiveRules(trx);
      const second = await repository.loadActiveRules(trx);

      expect(second).toBe(first);
      expect(selectFrom.mock.calls.map(([table]) => table)).toEqual(["markup_rules", "fee_rules"]);
    });
  });

  it("loads again in the next transaction, which sees a rule committed meanwhile", async () => {
    const before = await loadRules(ALPHA);
    const added = newId("mkr", NOW);
    await tenantTx(tenants, ALPHA, (trx) =>
      trx
        .insertInto("markup_rules")
        .values(markupRule({ id: added, name: "Alpha added", priority: 500 }))
        .execute(),
    );
    try {
      const after = await loadRules(ALPHA);

      expect(after).not.toBe(before);
      expect(before.markupRules.map((rule) => rule.id)).not.toContain(added);
      expect(after.markupRules.map((rule) => rule.id)).toEqual([
        IDS.alpha.expired,
        IDS.alpha.tenPercent,
        added,
        IDS.alpha.default,
      ]);
    } finally {
      await tenantTx(tenants, ALPHA, (trx) =>
        trx.deleteFrom("markup_rules").where("id", "=", added).execute(),
      );
    }
  });

  it("reads a currency's minor units from reference.currencies inside the tenant transaction", async () => {
    const units = await tenantTx(tenants, ALPHA, async (trx) => ({
      eur: await repository.currencyMinorUnits(trx, "EUR"),
      unknown: await repository.currencyMinorUnits(trx, "XXX"),
    }));

    expect(units).toEqual({ eur: 2, unknown: null });
  });
});
