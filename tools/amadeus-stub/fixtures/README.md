# Amadeus stub fixtures

The responses the [Amadeus stub](../README.md) serves. Each fixture is one JSON file per operation and scenario, either written by hand (**synthetic**) or captured once from the Amadeus test environment and scrubbed of personal data (**recorded**, task X-034). They are committed and served as they are: Prettier never rewrites this folder (`.prettierignore`), so a recorded file stays byte for byte what the recorder wrote.

## Layout

```text
fixtures/
  <operation>/            the API in kebab case: flight-offers-search, flight-offers-price, flight-create-orders, …
    <scenario>.json       success, sold-out, price-changed, … (the X-Stub-Scenario name, or a variant the handler picks)
```

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
- Recording (`pnpm --filter @velexis/amadeus-stub record <operation>`) and the personal-data scan of every committed fixture (`test/fixtures-scan.test.ts`) arrive with task X-034. Until then every fixture is synthetic.

## Fixtures

| File | Source | Served for | Content |
|---|---|---|---|
| `flight-offers-search/success.json` | synthetic | Every valid Flight Offers Search, GET and POST, whatever the itinerary (destination `ZZZ` excepted) | Five one-way offers Madrid to Paris on 2027-01-15 for one adult in EUR, cheapest first: `1` TAP via Lisbon to Orly (92.15), `2` Iberia to Orly (98.47), `3` Air Europa to Orly (109.32), `4` Air France to Charles de Gaulle (131.86), `5` Air France business class (558.94); segment ids `1` to `6`; dictionaries of locations, aircraft, currencies and carriers |

## Known defects of the specifications

- **Flight Offers Search `Dictionaries`**: `LocationEntry` and `CurrencyEntry` require a property `key`, which no Amadeus response has (the codes are the keys: `"locations": { "MAD": { … } }`). Fixtures follow Amadeus's real responses; the schema test tolerates exactly this defect.
- **Flight Offers Search** references `#/definitions/LoyaltyProgram` and `#/definitions/commissionValue`, which the document does not define. The validator accepts anything there (`AmadeusSpecs.danglingRefs()`).
