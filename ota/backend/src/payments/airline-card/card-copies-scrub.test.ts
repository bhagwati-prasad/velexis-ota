// The scrub of the card copies stored before FIX-W29-SECURITY (FIX-W30-OTA; card-copies-scrub.ts and the arguments of
// scrub-card-copies.command.ts): the copies as the current redactor keeps them, the preview of a truncated body, and a
// second scrub that changes nothing. Pure functions over made-up values: the card number is Stripe's documented test
// card, the holder and expiry are invented. The run against PostgreSQL is
// test/integration/payments/scrub-card-copies.int.test.ts.
import { redactPayload } from "@velexis/logger";
import { describe, expect, it } from "vitest";
import {
  CARD_COPY_KEY_PATTERN,
  copyChanged,
  scrubbedFormOfPayments,
  scrubbedOrderSnapshot,
  scrubbedPreview,
  scrubbedSupplierBody,
} from "./card-copies-scrub";
import { SCRUB_TENANT_STATUSES, scrubArgumentsOf } from "./scrub-card-copies.command";

const HOLDER = "ANNA BERG";
const EXPIRY = "2030-12";

/** An airline card as a copy of before 2026-10-24 kept it: brand, holder, last 4 and expiry. */
const oldCard = { brand: "VISA", holder: HOLDER, number: "4242", expiryDate: EXPIRY };

/** An order (Flight Create Orders' answer) with a traveller's passport and the airline card, as stored before. */
const oldOrder = {
  type: "flight-order",
  id: "eJzTd9f3NjIJdgMADeQCtg",
  travelers: [
    {
      id: "1",
      name: { firstName: "TESTA", lastName: "SAMPLE" },
      documents: [{ documentType: "PASSPORT", number: "7731", expiryDate: "2031-04-14", holder: true }],
    },
  ],
  formOfPayments: [{ creditCard: { ...oldCard, flightOfferIds: ["1"] } }],
};

describe("the scrubbed copies (FIX-W30-OTA)", () => {
  it("[FIX-W30-OTA AC5] keep a card's brand and last 4 only, wherever the holder and expiry sat", () => {
    expect(scrubbedFormOfPayments([{ creditCard: { ...oldCard, flightOfferIds: ["1"] } }])).toEqual([
      { creditCard: { brand: "VISA", number: "4242", flightOfferIds: ["1"] } },
    ]);
    // A flattened card in a form of payment, and Velexis's own field names, go too.
    expect(
      scrubbedFormOfPayments([
        {
          method: "airline_card",
          brand: "VISA",
          last4: "4242",
          holderName: HOLDER,
          expiryMonth: 12,
          expiryYear: 2030,
        },
      ]),
    ).toEqual([{ method: "airline_card", brand: "VISA", last4: "4242" }]);
    const order = scrubbedOrderSnapshot(oldOrder);
    expect(order).toEqual({
      ...oldOrder,
      formOfPayments: [{ creditCard: { brand: "VISA", number: "4242", flightOfferIds: ["1"] } }],
    });
    // The traveller's passport keeps its expiry and its holder flag: they are not a card's.
    expect(JSON.stringify(order)).toContain("2031-04-14");
    expect(JSON.stringify(order)).not.toContain(HOLDER);
    expect(JSON.stringify(order)).not.toContain(EXPIRY);
  });

  it("[FIX-W30-OTA AC5] scrub the bodies of supplier_requests, a request and an answer of Flight Create Orders", () => {
    const request = { data: { ...oldOrder, contacts: [{ emailAddress: "a***@example.com" }] } };
    expect(scrubbedSupplierBody(request)).toEqual({
      data: {
        ...request.data,
        formOfPayments: [{ creditCard: { brand: "VISA", number: "4242", flightOfferIds: ["1"] } }],
      },
    });
    expect(scrubbedSupplierBody(null)).toBeNull();
  });

  it("[FIX-W30-OTA AC5] cut the preview of a truncated body before the card that holds a holder or an expiry", () => {
    const text = JSON.stringify({ data: oldOrder });
    const preview = text.slice(0, text.indexOf(HOLDER) + 4);
    const cut = scrubbedPreview(preview);
    expect(cut).toBe(text.slice(0, text.indexOf('"formOfPayments"')));
    expect(cut).toContain("2031-04-14");
    expect(cut).not.toContain("ANNA");
    expect(scrubbedSupplierBody({ truncated: true, bytes: 70_000, preview })).toEqual({
      truncated: true,
      bytes: 70_000,
      preview: cut,
    });
    // A preview without a card's holder or expiry stays as it is: one cut before the card, or a card already redacted.
    expect(scrubbedPreview(cut)).toBe(cut);
    const redacted = JSON.stringify(redactPayload({ data: oldOrder }));
    expect(scrubbedPreview(redacted)).toBe(redacted);
    expect(scrubbedPreview(redacted.slice(0, 120))).toBe(redacted.slice(0, 120));
  });

  it("[FIX-W30-OTA AC5] change nothing the second time, nor a copy written since 2026-10-24", () => {
    const once = {
      fop: scrubbedFormOfPayments(oldOrder.formOfPayments),
      order: scrubbedOrderSnapshot(oldOrder),
      body: scrubbedSupplierBody({ data: oldOrder }),
    };
    expect(copyChanged(oldOrder, once.order)).toBe(true);
    expect(copyChanged(once.fop, scrubbedFormOfPayments(once.fop))).toBe(false);
    expect(copyChanged(once.order, scrubbedOrderSnapshot(once.order))).toBe(false);
    expect(copyChanged(once.body, scrubbedSupplierBody(once.body))).toBe(false);
    // What the record step writes today.
    const current = redactPayload(oldOrder);
    expect(copyChanged(current, scrubbedOrderSnapshot(current))).toBe(false);
  });

  it("[FIX-W30-OTA AC5] read only rows whose copies name a holder or an expiry key", () => {
    const pattern = new RegExp(CARD_COPY_KEY_PATTERN, "i");
    expect(pattern.test(JSON.stringify(oldOrder))).toBe(true);
    // The escaped text of a truncated body's preview, as jsonb's text shows it.
    expect(pattern.test(JSON.stringify({ preview: JSON.stringify(oldOrder) }))).toBe(true);
    expect(pattern.test(JSON.stringify([{ creditCard: { brand: "VISA", number: "4242" } }]))).toBe(false);
  });
});

describe("the arguments of tenants:scrub-card-copies (FIX-W30-OTA)", () => {
  it("[FIX-W30-OTA AC5] take one tenant or --all, and a batch size", () => {
    expect(scrubArgumentsOf(["--tenant", "alpha"])).toEqual({
      target: { kind: "tenant", key: "alpha" },
      batchSize: 100,
    });
    expect(scrubArgumentsOf(["--tenant=alpha", "--batch-size", "2"])).toEqual({
      target: { kind: "tenant", key: "alpha" },
      batchSize: 2,
    });
    expect(scrubArgumentsOf(["--all", "--batch-size=500"])).toEqual({
      target: { kind: "all" },
      batchSize: 500,
    });
    for (const args of [
      [],
      ["--all", "--tenant", "alpha"],
      ["--tenant"],
      ["--tenant", "Alpha"],
      ["--tenant", "tenant_alpha;drop"],
      ["--all", "--all"],
      ["--all", "--batch-size", "0"],
      ["--all", "--batch-size", "-1"],
      ["--all", "extra"],
    ]) {
      expect([args, scrubArgumentsOf(args)]).toEqual([args, undefined]);
    }
    expect(SCRUB_TENANT_STATUSES).toEqual(["active", "suspended"]);
  });
});
