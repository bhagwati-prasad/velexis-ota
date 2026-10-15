# Amadeus stub fixtures

The responses the [Amadeus stub](../README.md) serves. Each fixture is one JSON file per operation and scenario, either written by hand (**synthetic**) or captured once from the Amadeus test environment with `record` and scrubbed of personal data (**recorded**, task X-034). They are committed and served as they are: Prettier never rewrites this folder (`.prettierignore`), so a recorded file stays byte for byte what the recorder wrote.

## Layout

```text
fixtures/
  <operation>/            the API in kebab case: flight-offers-search, flight-offers-price, branded-fares-upsell,
                          flight-availabilities (Flight Availabilities Search), flight-create-orders, …
    <scenario>.json       success, sold-out, price-changed, … (the X-Stub-Scenario name, or a variant the handler picks)
```

The folder of each API is in `FIXTURE_FOLDERS` (`src/record.ts`) and the [stub README](../README.md#record-a-fixture-from-the-amadeus-test-environment). One exception to the kebab case: Flight Availabilities Search uses `flight-availabilities`, the name OBE-019 gives it.

## File format

```json
{
  "fixture": {
    "operation": "flight-offers-search",
    "scenario": "success",
    "source": "synthetic",
    "date": "2026-10-14",
    "scrubbed": true,
    "description": "What the fixture holds and when the stub serves it."
  },
  "status": 200,
  "body": { "meta": { "count": 5 }, "data": [ … ], "dictionaries": { … } }
}
```

| Field | Rule |
|---|---|
| `fixture.operation` | The folder name |
| `fixture.scenario` | The file name without `.json` |
| `fixture.source` | `synthetic` (hand-written) or `recorded` (captured, then scrubbed) |
| `fixture.date` | The day it was written or recorded, `YYYY-MM-DD` |
| `fixture.scrubbed` | Always `true`: the file holds no personal data |
| `fixture.description` | Optional; what it holds |
| `status` | The HTTP status the stub answers with |
| `body` | The Amadeus response body, exactly as Amadeus would send it |

`loadFixture(operation, scenario)` (`src/routes.ts`) refuses a file whose header is missing, does not match its path, or is not `scrubbed: true`, and returns a deep copy, so a handler may change what it got. The server reads the fixtures of its implemented operations when it starts (`STUB_FIXTURES`), so a broken fixture fails at start, not on the first request.

## Rules

- **No personal data, ever**: no real names, dates of birth, document numbers, e-mail addresses (use `@example.com`), phone numbers, postal addresses, record locators of real bookings, ticket numbers or card numbers ([AGENTS.md](../../../AGENTS.md) §8). Airports, carriers, flight numbers, fare bases, prices and offer ids are fine.
- **Money stays a decimal string** (`"98.47"`), as Amadeus sends it.
- **Date-times are local** (`2027-01-15T07:15:00`), as Amadeus sends them; the stub's validator accepts them.
- A success fixture **matches its operation's response schema** in `docs/amadeus-api/` (`AmadeusSpecs.validateResponse`, tested), apart from documented defects of the specification itself (below).
- **Synthetic values are marked**, so the scan can tell them from real ones: names come from `SYNTHETIC_GIVEN_NAMES` and `SYNTHETIC_FAMILY_NAMES` of `src/scrub.ts` (`ALEX TESTER`), e-mail addresses end in `@example.com`, phone numbers are in a reserved test range (`+44 7700 900nnn`, `+1 nnn 555 01nn`), and document, resident-card, loyalty and ticket numbers and any run of 13 to 19 digits start with `000`. A hand-written fixture follows the same rules.

## Recording, scrubbing and the scan

1. **Record** with your own Amadeus test credentials, never in CI: `pnpm --filter @velexis/amadeus-stub record <operation> --request <file.json> [--scenario <name>]` ([stub README](../README.md#record-a-fixture-from-the-amadeus-test-environment)). Send synthetic travellers in the request.
2. **Scrub**: `record` passes the response through `scrub` (`src/scrub.ts`), which replaces names, dates of birth (the year stays), document, resident-card and loyalty numbers, e-mail addresses, phone numbers, postal addresses, record locators, flight-order ids, ticket numbers and card data with deterministic synthetic values, also where they repeat in free text, and keeps airports, carriers, fare bases, prices and offer ids ([the table](../README.md#scrubbing-and-the-personal-data-scan)).
3. **Scan**: `record` writes nothing while `scanForPersonalData` finds anything in the scrubbed file, and `test/fixtures-scan.test.ts` runs the same scan over every `.json` file here in `pnpm test`. It fails on an e-mail address outside `example.com`, a run of 13 to 19 digits without the prefix `000`, a document, resident-card, loyalty or ticket number without it (or a passport number in free text), a phone number outside the reserved test ranges, and a name field with a word that is not a synthetic name. A finding names the file, the JSON pointer and the rule, never the value (a key that holds personal data appears as `<key n>`, its position in its object).
4. **Review** the file before you commit it, set its `description` if it needs more than the recorder wrote, and add it to the table below. Never edit a recorded value back to a real one; when the scan stops a recording, extend `src/scrub.ts` and its test.

## Fixtures

| File | Source | Served for | Content |
|---|---|---|---|
| `flight-offers-search/success.json` | synthetic | Every valid Flight Offers Search, GET and POST, whatever the itinerary (destination `ZZZ` excepted) | Five one-way offers Madrid to Paris on 2027-01-15 for one adult in EUR, cheapest first: `1` TAP via Lisbon to Orly (92.15), `2` Iberia to Orly (98.47), `3` Air Europa to Orly (109.32), `4` Air France to Charles de Gaulle (131.86), `5` Air France business class (558.94); segment ids `1` to `6`; dictionaries of locations, aircraft, currencies and carriers |
| `flight-offers-price/success.json` | synthetic | Every valid Flight Offers Price: the handler echoes the posted offers and takes the rest from here | The pricing of search offer 2 with `include=bags,other-services,detailed-fare-rules`: the offer unchanged; booking requirements (e-mail and mobile phone; gender and date of birth per traveller); checked bags (1 piece 30.00, 2 pieces 65.00), priority boarding (9.00) and penalty notes for fare basis `ADNNALB4`; Madrid and Orly locations |
| `flight-offers-price/credit-card-fees.json` | synthetic | Read for `include=credit-card-fees`: the fee of each brand | The same pricing with `include=credit-card-fees` and VISA (1.20), MASTERCARD (1.50) and AMERICAN_EXPRESS (3.95 EUR) payments for offer 2 |
| `branded-fares-upsell/success.json` | synthetic | Every valid Branded Fares Upsell, whatever offer is posted | The branded fares of search offer 2 (Iberia IB3436, segment `3`), cheapest first: `1` BASIC (98.47, no checked bag), `2` CLASSIC (126.47, one bag), `3` FLEXIBLE (189.47, one bag, refundable), with amenities; Madrid and Orly locations, aircraft, currencies and carriers |
| `flight-create-orders/success.json` | synthetic | Read by every Flight Create Orders, Management GET and PATCH and by-reference GET for its `dictionaries`; the handler answers the stored order | The 201 answer to booking priced offer 2 of `flight-offers-price/success.json` (Iberia IB3436, Madrid to Orly on 2027-01-15, BASIC, 98.47 EUR) for ALEX TESTER without `issue`: remark `VELEXIS VX7K2M9Q`, ticketing agreement `CONFIRM`, queue 50 category 0 of office `NCE1A0955`, cash form of payment; record locator `SYN001`, created 2026-10-15T09:00 (generated per order by the stub); Madrid and Orly locations |
| `flight-order-issue/success.json` | synthetic | Read by every Flight Order Issue for its `dictionaries`; the handler answers the issued order | The 200 answer to issuing the order of `flight-create-orders/success.json` with a cash form of payment: the same order with one e-ticket `000-0000000001` for traveller 1 on segment 3 |
| `flight-availabilities/success.json` | synthetic | Every valid Flight Availabilities Search, whatever the itinerary (destination `ZZZ` excepted) | One availability per search offer, in departure order (TAP via Lisbon, Iberia, Air France 08:45, Air Europa, Air France 16:50), segment ids `1` to `6`, seats by booking class with the class of each search offer open; dictionaries of locations, aircraft and carriers |

## Known defects of the specifications

- **`Dictionaries`** of Flight Offers Search, Flight Offers Price, Branded Fares Upsell and Flight Availabilities Search: `LocationEntry` and `CurrencyEntry` require a property `key`, which no Amadeus response has (the codes are the keys: `"locations": { "MAD": { … } }`). Fixtures follow Amadeus's real responses; the schema tests tolerate exactly this defect.
- **Flight Offers Price `detailed-fare-rules`** is declared as one `DetailedFareRules` object, but Amadeus answers a map keyed `"1"`, `"2"`, … like the other `included` dictionaries; the fixture follows Amadeus (the schema, which does not close its properties, accepts both).
- **Flight Availabilities Search**'s own response example writes `classAvailabilities` and `availabilty`; its schema (and Amadeus) say `availabilityClasses` and `numberOfBookableSeats`, which the fixture follows.
- **Flight Offers Price and Branded Fares Upsell request schemas** do not declare fields that the offers of Flight Offers Search (`isUpsellOffer`, `brandedFareLabel`) and Branded Fares Upsell (`amenities`) carry, although the client posts those offers back; the stub's unknown-field check knows them in `data.flightOffers` ([`../README.md`](../README.md#request-validation)).
- **Flight Offers Search** references `#/definitions/LoyaltyProgram` and `#/definitions/commissionValue`, which the document does not define. The validator accepts anything there (`AmadeusSpecs.danglingRefs()`).
- **Flight Create Orders**: the specification's own `201` example does not match its schema (`co2Emissions[].weight` written as strings, `sliceDiceIndicator: "ABCDEF"`). `record` reports such differences as a count; `test/scrub.test.ts` checks that scrubbing adds none. Its request example writes `formOfPayments[].other.flightOfferIds` as numbers, which the schema (strings) and so the stub refuse. The `Dictionaries` defect above applies to the order operations' answers as well.
- **Flight Order Management PATCH** reuses the `FlightOrder` schema, so `data.type` and `data.flightOffers` are mandatory even to change contacts only; its own example writes `fareDetailBySegment` for `fareDetailsBySegment`.
- **Queue List**: the schema's `creation.dateTime` has the unknown format `datetime` and its example writes `creation.datetime` and a single `travelers` object; the stub follows the schema (`creation.dateTime`, a `travelers` array of `{ names: [ … ] }`).
