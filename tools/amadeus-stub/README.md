# `@velexis/amadeus-stub`: the Amadeus stub server

A small Node `http` server (no framework) that stands in for Amadeus Enterprise in development, integration tests and end-to-end runs ([ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md), [ADR-0012](../../docs/mvp/adr/0012-amadeus-account-model.md)). It implements the OAuth token endpoint and routes the 12 Amadeus operations of the 9 specifications in [`docs/amadeus-api/`](../../docs/amadeus-api/), validates every request against its specification, serves synthetic or recorded-and-scrubbed fixtures, and fails on demand through scenarios.

- **Dev only.** It is a `devDependency` of whatever uses it ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md) item 2; `tools/ci/check-package-json.mjs` enforces it). The VM never runs it ([ADR-0025](../../docs/mvp/adr/0025-roadmap-scheduling-and-tracking.md) item 7): the CLI refuses to start when `APP_ENV` or `NODE_ENV` is `production`.
- **Tasks.** X-026 built the server, the token endpoint, the route table, validation, the generic scenarios and Flight Offers Search. OBE-019 added the shopping operations (price, upsell, availability), their scenarios `sold-out` and `price-changed`, and the refusal of unknown body fields. OBE-041 added the order operations (create, issue, management GET/PATCH/DELETE, by reference, queue list) on [in-memory orders](#orders), their scenarios `ticketing-failed`, `version-conflict` and `timeout-lost`, and the masking of card numbers in the request log; every operation now has a handler. X-027 added the in-process helper `@velexis/testing/amadeus`, X-034 [fixture recording](#record-a-fixture-from-the-amadeus-test-environment) with the [scrubber and the personal-data scan](#scrubbing-and-the-personal-data-scan).

## Run it

```bash
pnpm stub:amadeus                  # builds if needed, then listens on http://127.0.0.1:4900
STUB_PORT=4901 pnpm stub:amadeus   # another port (then point AMADEUS_BASE_URL_TEST at it)
```

The OTA backend and the platform worker reach it through `AMADEUS_BASE_URL_TEST=http://127.0.0.1:4900` ([`.env.example`](../../.env.example), [local development §5](../../docs/mvp/local-development.md#5-amadeus-stub)). The local database's Velexis test Amadeus account can hold any dummy client id and secret.

| Variable | Default | Read by |
|---|---|---|
| `STUB_PORT` | `4900` | `src/cli.ts`, through `@velexis/config`, after the development env files (root and package `.env.local`); commented out in the root `.env.example` |

The CLI binds `127.0.0.1` only. It prints one line when it listens and one line per request (`amadeus-stub: GET /v2/shopping/flight-offers 200 [rate-limited] 3 ms`): method, path without the query string, status (`-` when the client went away first), scenario and duration. It never prints a header, a query string, a body or a token. `Ctrl-C` (SIGINT) or SIGTERM stops it. Exit codes: `0` stopped, `1` could not start (port in use, invalid `STUB_PORT`, production).

## Use it from tests

Integration tests start it in-process on a free port (X-027 wraps this as `startAmadeusStub` in `@velexis/testing/amadeus`):

```ts
import { createStubServer } from "@velexis/amadeus-stub";

const stub = await createStubServer({ port: 0 });          // http://127.0.0.1:<free port>, in well under 1 s
process.env.AMADEUS_BASE_URL_TEST = stub.url;               // or pass stub.url to the config under test
await fetch(url, { headers: { "X-Stub-Scenario": "server-error" } });
stub.setDefaultScenario("rate-limited");                   // every request without the header, token requests included
expect(stub.requests().at(-1)).toMatchObject({ operation: "getFlightOffers", status: 429 });
await stub.close();                                         // frees the port, drops held responses and connections
```

| Option of `createStubServer` | Default | What for |
|---|---|---|
| `port` | (required) | `0` picks a free port |
| `host` | `127.0.0.1` | The interface to bind |
| `defaultScenario` | `success` | The scenario of requests without `X-Stub-Scenario`; `setDefaultScenario()` changes it later |
| `credentials` | any non-empty pair | `{ clientId, clientSecret }`: only this pair gets a token, others get `401 invalid_client` |
| `clock` | system clock | `{ now(): Date }` (the `FakeClock` of `@velexis/testing` fits): token expiry, `receivedAt`, the creation time of [orders](#orders) and when their `DELAYED` queue placements fall due |
| `timers` | global timers | `{ setTimeout, clearTimeout }` of the `timeout` scenario, so a test fires the 30 s hold itself |
| `specs` | one `AmadeusSpecs` per process | The loaded specifications and compiled validators; pass `new AmadeusSpecs()` for a cold start |
| `onResponse` | none | Called once per request when it is answered or the client went away (the CLI prints its line) |

`requests()` returns the recorded requests, oldest first, at most the last 1000: `method`, `path`, `query`, `headers` (lower-case names; `authorization`, `proxy-authorization` and `cookie` are `[REDACTED]`), `operation` (`oauth2Token`, an operation name, or `undefined` for a 404), `scenario`, `status` (`undefined` while held or after the client went away), `receivedAt` and `durationMs`. Bodies are never recorded, so a client secret, a token or a card number never lands in the log; a run of 13 to 19 digits (single spaces, hyphens or a path's `%20` allowed between them) in the path, a query parameter or a header is masked to its last 4 (`XXXXXXXXXXXX1111`) as well, so a card number sent where none belongs does not land there either. `clearRequests()` empties it. The CLI's line per request prints the same masked path.

`orders.list()` returns the [orders](#orders) the server stored, oldest first, cancelled ones included (copies: `id`, `recordLocator`, `createdAt`, `status`, `version`, the order's fields, `queues` and `tickets`); `orders.reset()` forgets them, as a restarted stub would. Each server has its own orders.

## Record a fixture from the Amadeus test environment

`record` captures one response of the real Amadeus Enterprise test environment, scrubs it of personal data and writes it as a fixture ([ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md)). It is a developer's manual step with the developer's own test credentials (OBE-027): **it never runs in CI** and refuses to start when `CI` is set (to any non-empty value: an empty value counts as unset, as for every variable read through `@velexis/config`) and, like the stub, when `APP_ENV` or `NODE_ENV` is `production`.

```bash
# AMADEUS_RECORD_CLIENT_ID and AMADEUS_RECORD_CLIENT_SECRET: your Amadeus test credentials, in the git-ignored
# .env.local (root or tools/amadeus-stub) or exported by your shell; never typed on a command line.
pnpm --filter @velexis/amadeus-stub record quoteAirOffers --request ~/amadeus/price.json
pnpm --filter @velexis/amadeus-stub record getFlightOrder --request order.json --scenario cancelled
```

| Variable | Default | What for |
|---|---|---|
| `AMADEUS_RECORD_CLIENT_ID` | (required) | The client id of your Amadeus test application |
| `AMADEUS_RECORD_CLIENT_SECRET` | (required) | Its secret. Sent only in the token request body; never printed |
| `AMADEUS_RECORD_BASE_URL` | `https://test.travel.api.amadeus.com` | The Amadeus Enterprise test host. `https` only; plain `http` only to `127.0.0.1`/`localhost` (the tests point it at the stub). No user, password, query or fragment |

The variables come from the environment only: your shell, or the root or package `.env.local` (git-ignored), which the CLI loads like every app ([local development §5](../../docs/mvp/local-development.md#5-amadeus-stub)). Never a flag, never the request file, never a committed file. A missing or empty credential stops the command with the variable's name.

**Arguments.**

| Argument | What |
|---|---|
| `<operation>` | An operation name of the [route table](#routes) (`searchFlightOffers`, `createFlightOrders`, …), or the fixture folder of an API with a single operation (`flight-create-orders`, `flight-offers-price`) |
| `--request`, `-r` `<file.json>` | The request, relative to the directory you started `pnpm` in: `{ "query"?: { … }, "pathParams"?: { … }, "body"?: { … } }`. Query values are strings, numbers, booleans or arrays (sent comma-separated) |
| `--scenario`, `-s` `<name>` | The fixture's name, default `success`; lower-case words joined by hyphens (`sold-out`, `price-changed`) |

```json
{ "query": { "originLocationCode": "MAD", "destinationLocationCode": "PAR", "departureDate": "2027-01-15", "adults": 1, "max": 5 } }
```

```json
{ "pathParams": { "flight-orderId": "eJzTd9f3NjIJdgMADeQCtg" }, "query": { "include": "bags" } }
```

```json
{ "body": { "data": { "type": "flight-offers-pricing", "flightOffers": [ … ] } } }
```

Use synthetic travellers in the requests you send (`ALEX TESTER`, `person1@example.com`, `+44 7700 900123`): the scrubber is the second line of defence, not the first. Keep request files outside the repository, or delete them after recording.

**What it does, in order.** Anything that fails stops it with exit code 1 and writes nothing.

1. Refuses when `CI` is set or in production; checks the arguments (exit code 2 with the usage) and the variables.
2. Validates the request against the operation's specification in [`docs/amadeus-api/`](../../docs/amadeus-api/), like the stub does, so a malformed request never reaches Amadeus.
3. Requests a token (`client_credentials` at `/v1/security/oauth2/token`), then sends the request with `Authorization: Bearer`, `application/vnd.amadeus+json` and, for the POST searches, `X-HTTP-Method-Override: GET`. Each call may take 60 s. Neither call follows a redirect, so the secret and the token reach the configured host only, and an `access_token` that is not an RFC 6750 bearer token is refused before it goes into a header.
4. Refuses a non-2xx answer under the default scenario `success`: record an error response under its own name (`--scenario invalid-data`).
5. Scrubs the body ([below](#scrubbing-and-the-personal-data-scan)), builds the fixture with its header (`operation`: the folder, `scenario`, `source: "recorded"`, `date`: today in UTC, `scrubbed: true`, a `description` naming the operation and host) and scans the whole file. Any finding stops it: extend `src/scrub.ts` rather than editing the response by hand.
6. Writes `fixtures/<folder>/<scenario>.json` (2-space JSON, replacing an existing file) and prints the status, the duration, the counts of replaced values per category, the file and, when the body differs from the specification's response schema, how many places differ ([known defects](fixtures/README.md#known-defects-of-the-specifications)).

It prints the operation, the host, the status, durations, counts and file names. It never prints the secret, the token, a header, a request or response body, a value the scan found, or an argument it did not understand. Exit codes: `0` written, `1` refused or failed, `2` usage.

| API (operations) | Fixture folder |
|---|---|
| FlightOffersSearch (`getFlightOffers`, `searchFlightOffers`) | `flight-offers-search` |
| FlightAvailabilitiesSearch (`searchFlightAvailabilities`) | `flight-availabilities` (the name OBE-019 uses) |
| BrandedFaresUpsell (`upsellAirOffers`) | `branded-fares-upsell` |
| FlightOffersPrice (`quoteAirOffers`) | `flight-offers-price` |
| FlightCreateOrders (`createFlightOrders`) | `flight-create-orders` |
| FlightOrderIssue (`issueFlightOrder`) | `flight-order-issue` |
| FlightOrderManagement (`getFlightOrder`, `patchFlightOrder`, `cancelFlightOrder`) | `flight-order-management` |
| GetFlightOrderByRecordLocator (`getFlightOrderByReference`) | `get-flight-order-by-record-locator` |
| QueueList (`listQueue`) | `queue-list` |

After recording: read the file, list it in the [fixtures table](fixtures/README.md#fixtures), and run `pnpm --filter @velexis/amadeus-stub test`, whose fixture scan covers it from now on.

## Scrubbing and the personal-data scan

`src/scrub.ts` holds both. `scrub(body)` returns a scrubbed copy and the number of replaced values per category; the same input always gives the same output, and a synthetic value is numbered by the order in which its original first appears, so nothing of the original reaches the fixture.

| Personal data (where Amadeus puts it) | Becomes |
|---|---|
| Names: `firstName`, `middleName` / `lastName`, `secondLastName`, and the words of `addresseeName` and a card `holder` | A name of `SYNTHETIC_GIVEN_NAMES` (`ALEX`, `BLAKE`, …) / `SYNTHETIC_FAMILY_NAMES` (`TESTER`, `SAMPLE`, …), word by word; titles (`MR`, `MRS`, …) stay. One family keeps one family name |
| `dateOfBirth` | The same year, `-01-01` (the passenger type depends on the age) |
| `documents[].number`, `formOfIdentifications[].number` | `000000001`, `000000002`, … |
| `discountEligibility[].cardNumber` / `certificateNumber`, `loyaltyPrograms[].id` | `00000001Z`, … / `0000000001`, … (valid for their patterns) |
| `birthPlace`, `issuanceLocation` | `EXAMPLE CITY` |
| `emailAddress` | `person1@example.com`, … (upper case stays upper case) |
| `phones[]` (`countryCallingCode` + `number`), `emergencyContact.number` | `44` + `7700900001`, … (Ofcom's drama range); an emergency contact's `countryCode` becomes `GB` |
| `address` (`lines`, `postalCode`, `cityName`, `stateName`, `postalBox`) | `1 EXAMPLE STREET`, `00000`, `EXAMPLE CITY`, `EXAMPLE STATE`, `BP 1`; `countryCode` stays |
| `associatedRecords[].reference`, the locator in a Queue List PNR id | `SYN001`, … |
| A flight-order `id` (base64 of record locator, name and date) | base64url of `SYNTHETIC-ORDER-1`, … |
| `tickets[].documentNumber` | `000` and zeros with the same separators (`000-0000000001`) |
| A card's `number`, `expiryDate`, `securityCode` | `XXXXXXXXXXXX0000`, `2099-12`, removed |
| In every other string: e-mail addresses (also the SSR form `NAME//MAIL.COM`), `+` phone numbers, runs of 13 to 19 digits, passport numbers after `PASSPORT`/`PPT` or in `P/GBR/<number>/`, and any value above (a name in a remark, a record locator or order id in a link) | The same synthetic values |

It keeps what the tests need: airports, carriers, flight and segment numbers, fare bases, booking classes, prices, currencies, offer, segment and traveller ids, dates of travel, offices, genders, document types, expiry dates and countries. A three-letter string equal to a traveller's name (`LIS`) stays a code; in free text the name is replaced. A longer string equal to a name is replaced wherever it stands, because privacy comes first: a traveller called `YOUNG` also changes a `travelerType` `YOUNG`. `record`'s note on schema differences shows such a change; record with synthetic travellers whose names are no Amadeus code.

`scanForPersonalData(value)` checks a whole fixture file, header included, and returns one finding per JSON pointer and rule, never the value (a key that holds personal data appears in the pointer as `<key n>`, its position in its object):

| Rule | Fails on |
|---|---|
| `email` | An e-mail address (or SSR form) whose domain is not `example.com` |
| `digit-run` | A run of 13 to 19 digits (single spaces or hyphens allowed between them) not starting with the synthetic prefix `000`, and any 13 to 19 digit JSON number |
| `document-number` | A document, resident-card, loyalty or ticket number without the prefix `000`, and a passport number after `PASSPORT`/`PPT` or in an SSR `DOCS` text |
| `phone` | A phone number (phone objects, emergency contacts, `phone`/`mobile`/`fax` fields, `+` numbers in text) outside the reserved ranges of `RESERVED_TEST_PHONE_RANGES`: UK 07700 900xxx, 020 7946 0xxx and 01632 960xxx (Ofcom, drama), North American 555-0100 to 555-0199 |
| `name` | A `firstName`, `middleName`, `lastName`, `secondLastName`, `addresseeName` or card `holder` with a word outside the synthetic name lists and titles |

`test/fixtures-scan.test.ts` runs it over every `.json` file under `fixtures/` in `pnpm test`; `record` runs it before it writes.

## Routes

The base URL is the stub's URL; every path is the one of Amadeus's test host (`https://test.travel.api.amadeus.com`).

| Operation (`name`) | Method and path | Specification (`api`) | Status |
|---|---|---|---|
| OAuth token | `POST /v1/security/oauth2/token` | Amadeus authorization guide | Implemented (X-026) |
| `getFlightOffers` | `GET /v2/shopping/flight-offers` | FlightOffersSearch v2 | Implemented (X-026) |
| `searchFlightOffers` | `POST /v2/shopping/flight-offers` (+ `X-HTTP-Method-Override: GET`) | FlightOffersSearch v2 | Implemented (X-026) |
| `searchFlightAvailabilities` | `POST /v1/shopping/availability/flight-availabilities` (+ `X-HTTP-Method-Override: GET`) | FlightAvailabilitiesSearch | Implemented (OBE-019) |
| `upsellAirOffers` | `POST /v1/shopping/flight-offers/upselling` | BrandedFaresUpsell | Implemented (OBE-019) |
| `quoteAirOffers` | `POST /v1/shopping/flight-offers/pricing` | FlightOffersPrice | Implemented (OBE-019) |
| `createFlightOrders` | `POST /v1/booking/flight-orders` | FlightCreateOrders | Implemented (OBE-041) |
| `issueFlightOrder` | `POST /v1/booking/flight-orders/{flight-orderId}/issuance` | FlightOrderIssue | Implemented (OBE-041) |
| `getFlightOrder` | `GET /v1/booking/flight-orders/{flight-orderId}` | FlightOrderManagement | Implemented (OBE-041) |
| `patchFlightOrder` | `PATCH /v1/booking/flight-orders/{flight-orderId}` | FlightOrderManagement | Implemented (OBE-041) |
| `cancelFlightOrder` | `DELETE /v1/booking/flight-orders/{flight-orderId}` | FlightOrderManagement | Implemented (OBE-041) |
| `getFlightOrderByReference` | `GET /v1/booking/flight-orders/by-reference` | GetFlightOrderByRecordLocator | Implemented (OBE-041) |
| `listQueue` | `GET /v1/office/queues/{queue-id}` | QueueList (OpenAPI 3.0) | Implemented (OBE-041) |

- The operation names are the `AmadeusClient` method names of the OTA plan (OBE-018): the specifications' own `operationId`s are not unique (two `getFlightOrder`) and Queue List's is a path. `STUB_OPERATIONS` keeps both. A test checks that the table equals the `x-amadeus` entries of [`ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`](../../ota/backend/openapi/velexis-ota-booking-api.openapi.yaml), and that each path is its specification's base path plus path key, with the specification's method and `operationId`.
- Queue List's path is `/v1/office/queues/{queue-id}`: its specification's server URL ends in `/v1` and its path key is written `GET/office/queues/{queue-id}`. The OTA document's `x-amadeus` entry says `/office/queues/{queue-id}`, without the `/v1`.
- Every operation has a handler since OBE-041. An operation without one would answer `501` (stub code 90002, naming the task in `plannedBy`).
- Any other method and path answers `404` with Amadeus code 38196, like Amadeus's gateway. A request target that is not a URL at all (`GET http://[::1 HTTP/1.1`) answers `400` code 477, and the stub keeps serving.

**Flight Offers Search** answers the fixture [`fixtures/flight-offers-search/success.json`](fixtures/README.md) for every valid request, whatever the itinerary, cut to `max` (GET) or `searchCriteria.maxFlightOffers` (POST) offers. The destination `ZZZ` (GET `destinationLocationCode`, or any POST `originDestinations[].destinationLocationCode`) answers `{ "meta": { "count": 0 }, "data": [] }`.

**Flight Offers Price** (`src/handlers/pricing.ts`) prices whatever it is sent. It echoes the posted `data.flightOffers` unchanged and adds the `bookingRequirements` of [`fixtures/flight-offers-price/success.json`](fixtures/README.md), one `travelerRequirements` entry per traveller of the posted offers. Each value of the `include` query parameter adds one `included` dictionary built for the posted offers (`included` is absent without `include`):

| `include` | `included` entry, keyed `"1"`, `"2"`, … like Amadeus |
|---|---|
| `bags`, `other-services` | The fixture's checked bags (1 piece 30.00, 2 pieces 65.00 EUR) and priority boarding (9.00 EUR), with the posted segment and traveller ids |
| `detailed-fare-rules` | The fixture's penalty notes, one entry per fare basis of the posted offers with the first segment it prices |
| `credit-card-fees` | One fee per posted payment (`data.payments[]` with a `brand`) and flight offer it pays (its `flightOfferIds`, or every posted offer), with the fee of the brand in [`fixtures/flight-offers-price/credit-card-fees.json`](fixtures/README.md): VISA 1.20, MASTERCARD 1.50, AMERICAN_EXPRESS 3.95 EUR, any other brand 0.00 |

Pricing offer 2 of the search fixture with `include=bags,other-services,detailed-fare-rules` answers exactly `success.json`; with `include=credit-card-fees` and VISA, MASTERCARD and AMERICAN_EXPRESS payments for it, exactly `credit-card-fees.json`. `forceClass` is accepted and changes nothing. The `dictionaries` are the fixture's (Madrid and Orly).

**Branded Fares Upsell** (`src/handlers/upselling.ts`) answers [`fixtures/branded-fares-upsell/success.json`](fixtures/README.md) for every valid request, whatever offer is posted: the branded fares BASIC (98.47), CLASSIC (126.47) and FLEXIBLE (189.47 EUR) of search offer 2, cheapest first.

**Flight Availabilities Search** (`src/handlers/availability.ts`) answers [`fixtures/flight-availabilities/success.json`](fixtures/README.md) for every valid request, whatever the itinerary: the seats by booking class on the flights of the search fixture. The destination `ZZZ` in any `originDestinations[]` answers `{ "meta": { "count": 0 }, "data": [] }`.

## Orders

`src/orders.ts` keeps the flight orders in memory, per server (`OrderStore`; tests read them with `orders.list()` and empty them with `orders.reset()`). Flight Create Orders stores an order; the other order operations read and change the same orders, which is what the OTA backend's ticketing jobs and its reconciliation after a timeout need ([architecture-booking §4](../../ota/docs/architecture-booking.md#4-supplier_timeout-recovery)).

| An order keeps | How |
|---|---|
| `id` | base64url of the record locator and the creation day joined by a vertical bar (`SYN001\|2026-10-15`; Amadeus's ids are base64 of the locator, a name and the day; the stub leaves the name out) |
| `recordLocator` | 6 random letters and digits, unique per server; random so that the orders of different stub runs never collide in a test database. Answered as `associatedRecords[0]` `{ reference, creationDate, originSystemCode: "GDS", flightOfferId }` |
| `createdAt` | The server's clock (`clock` option); answered in UTC without an offset, as Amadeus writes local times (`2026-10-15T09:00:00.000`) |
| Offices, flight offers, travellers, remarks, contacts, ticketing agreement, automated processes, commissions, forms of identification | As posted; a ticketing agreement with a `delay` such as `6D` is answered with the `dateTime` (a day) it gives |
| Forms of payment | `other` and `b2bWallet` (without `virtualCreditCardDetails`) as posted; a `creditCard` as `{ brand, number: "XXXXXXXXXXXX1111", flightOfferIds }`, the way Amadeus masks a card. The number, the security code, the expiry date, the holder and the payment operation context are never stored |
| `queues` | One placement per `automatedProcess` entry: queue `queue.number`, category `queue.category` (default 0), office `officeId` (else the order's `queuingOfficeId`), from creation (`IMMEDIATE` or no code), from `dateTime` or after `delay` (`DELAYED`), never (`ERROR`) |
| `tickets` | One `ETICKET` per traveller (`documentNumber` `000-0000000001`, `000-0000000002`, … per server, the synthetic prefix of the [fixture rules](fixtures/README.md#rules); `documentStatus: ISSUED`; the traveller's segments) |
| `status`, `version` | `active` until DELETE cancels the order, then it is gone for every operation; version 1 at creation, +1 per issue, PATCH and cancel |

| Operation | Answer |
|---|---|
| **Flight Create Orders** (`src/handlers/create-orders.ts`) | `201` `{ data: <the stored order>, dictionaries }` with the dictionaries of [`fixtures/flight-create-orders/success.json`](fixtures/README.md#fixtures). With `issue=true` the order is issued at once. Creating the order of that fixture (priced offer 2 for ALEX TESTER) answers exactly the fixture apart from the generated id, record locator and creation time. The test card `4000000000000002` is refused with `400` code 1304 `CREDIT CARD NOT ACCEPTED` (`source.pointer` names the card's field, never its number) and nothing is stored |
| **Flight Order Issue** (`src/handlers/issue.ts`) | Issues one e-ticket per traveller without one, replaces the forms of payment with the posted ones (cards masked as above) and answers `200` `{ data, dictionaries }` ([`fixtures/flight-order-issue/success.json`](fixtures/README.md#fixtures) for the fixture's order with a cash payment). The declined test card answers `400` 1304; an order whose travellers all have tickets answers `400` 9112 `The flight order is already issued`, so a second issue call fails loudly |
| **Flight Order Management GET** | `200` `{ data, dictionaries }`; `include` and `fareRules` are accepted and add nothing |
| **Flight Order Management PATCH** | Replaces `contacts` and `remarks` with those of `data` when it has them, `200` with the order. The specification makes `data.type` and `data.flightOffers` mandatory: send the order's offers back; the stub changes no offer |
| **Flight Order Management DELETE** | Cancels the order, `204` without a body |
| **By-reference GET** | `reference` is the record locator (any case) and `originSystemCode` must be `GDS` (else `400` 4926): `200` `{ data: [<the order>], dictionaries }` |
| **Queue List** (`src/handlers/queue-list.ts`) | The active orders placed on `queue-id` with `category` (default 0) by now, of the office `officeId` when given (a placement without any office is in every office: the stub does not know the caller's), oldest first, at most `max`: `{ meta: { count }, data: [ { type: "pnrList", id: "<locator>-<creation day>", creation: { dateTime: "2026-10-15T09:00" }, travelers: [ { names: [ { firstName, lastName } ] } ], products: [ { airSegment: { segment: { carrierCode, number, arrival: { iataCode, localDateTime } } } } ] } ] }`. `creation.dateTime` is to the minute in UTC without an offset, the specification's form |

An unknown or cancelled order (id or record locator) answers `404` code 1797 `NOT FOUND`. Flight Create Orders and Management PATCH refuse body fields their specification does not declare, with the fields of the shopping offers and of the created order's offers known in `data.flightOffers[]`; Flight Order Issue refuses them too.

## How a request is answered

1. **Route**: the token endpoint or one of the 12 operations; otherwise `404` (`400` for a request target that is not a URL).
2. **Scenario**: the `X-Stub-Scenario` header, or the default scenario. An unknown name is a `400` (stub code 90001) that names the header and lists the known scenarios.
3. **Token endpoint**: grant and credentials are checked (below). **Operations**: the bearer token is checked (`401`), an operation without a handler answers `501` (stub code 90002, naming the task that adds it), then the request is validated against the specification (`400`), unknown body fields included for the operations that refuse them.
4. **Generic scenario**: `server-error`, `rate-limited` or `timeout` (below). An order write (create, issue, PATCH, DELETE) applies `timeout` in its handler instead, after the write.
5. **Answer**: the token, or the operation's handler, which applies the operation-specific scenarios it knows (`sold-out`, `price-changed`, `ticketing-failed`, `version-conflict`, `timeout-lost`) and answers now or holds its answer.

Authentication and validation come before the scenario, so a request without a token or with a malformed body fails whatever the scenario says.

### OAuth

```http
POST /v1/security/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<id>&client_secret=<secret>
```

| Request | Answer |
|---|---|
| Valid | `200` `{ "type": "amadeusOAuth2Token", "application_name", "client_id", "token_type": "Bearer", "access_token", "expires_in": 1799, "state": "approved", "scope": "" }` |
| No `grant_type` (or not a form body) | `400` `{ "error": "invalid_request", "error_description", "code": 38187, "title": "Invalid parameters" }` |
| Another grant | `400` `error: "unsupported_grant_type"` |
| Missing or empty client id or secret, or not the configured pair | `401` `error: "invalid_client"`, `error_description: "Client credentials are invalid"` |

Tokens live in memory, per server, and expire after 1799 s on the injected clock. A restarted stub knows none of the old tokens, like a real token that was revoked.

| API call | Answer (`{ "errors": [ … ] }`) |
|---|---|
| No `Authorization: Bearer <token>` header (or another scheme) | `401` code 38191 `Invalid HTTP header` |
| A token this server did not issue | `401` code 38190 `Invalid access token` |
| An expired token | `401` code 38192 `Access token expired` |

### Scenarios

| `X-Stub-Scenario` | Applies to | Answer |
|---|---|---|
| `success` (default) | everything | Normal behaviour; lets one request opt out of a default scenario |
| `server-error` | every route, token endpoint included | `500` code 141 `SYSTEM ERROR HAS OCCURRED` |
| `rate-limited` | every route, token endpoint included | `429` code 38194 `Too many requests` |
| `timeout` | every route, token endpoint included | Holds the response until the client aborts (the timer is cancelled) or 30 s pass, then `504`. At an order write (Flight Create Orders, Flight Order Issue, Management PATCH and DELETE) the write happens first: the order is stored (issued, changed, cancelled) although the client never hears so, and reconciliation or a resync finds it |
| `timeout-lost` | the order writes | Holds the response like `timeout`, then `504`, **without** the write: no order is stored (no ticket issued, nothing changed or cancelled). Every other route answers as for `success` |
| `sold-out` | Flight Offers Price, Branded Fares Upsell, Flight Create Orders | `400` code 34651 `SEGMENT SELL FAILURE`, `detail` `Could not sell segment <id>` naming the first posted segment; no order is stored |
| `ticketing-failed` | Flight Order Issue, Flight Create Orders with `issue=true` | Issue: `400` code 9112 `TICKETING - TKT`, no ticket. Create with `issue=true`: the order is stored without tickets and answered `201` with `warnings: [{ "status": 201, "code": 9112, "title": "TICKETING - TKT", … }]` |
| `version-conflict` | Flight Order Management PATCH | `409` code 2552 `SIMULTANEOUS UPDATE`; the order is unchanged |
| `price-changed` | Flight Offers Price | `200` with a higher price: the `base` and `total` of each traveller pricing raised by 10.00, the offer's `base`, `total` and `grandTotal` by 10.00 per traveller pricing (98.47 becomes 108.47 for one adult), and `warnings: [{ "status": 200, "code": 37200, "title": "PRICE DISCREPANCY", … }]` |

The operation-specific scenarios (`sold-out`, `price-changed`, `ticketing-failed`, `version-conflict`, `timeout-lost`) change only the operations listed; every other route, the token endpoint included, answers as for `success`, so a default scenario can be set for a whole flow (search and token succeed, pricing fails; or the reconciler's Queue List and by-reference reads succeed while the order was lost). Amounts stay decimal strings: `price-changed` adds to their digits with `BigInt`, never through a JavaScript number.

| Magic value | Answer |
|---|---|
| Flight Offers Search or Flight Availabilities Search to destination `ZZZ` | `200` with no offers or availabilities |
| A credit card numbered `4000000000000002` (`DECLINED_TEST_CARD`) at Flight Create Orders or Flight Order Issue | `400` code 1304 `CREDIT CARD NOT ACCEPTED`, nothing stored |

`STUB_SCENARIOS` and the type `StubScenario` list the names the stub knows ([local development §5](../../docs/mvp/local-development.md#5-amadeus-stub)).

### Request validation

`src/validate.ts` validates each request of an implemented operation against its specification with Ajv 8 (`strict: false`, all errors, ajv-formats):

- query, header and path parameters (required, type, format, pattern, enum, range); query values are coerced by their declared type first (`integer`, `number`, `boolean`, arrays by `collectionFormat`); a repeated or undeclared query parameter is an error;
- the JSON body against the body parameter's schema, without coercion; a body operation needs `Content-Type: application/vnd.amadeus+json` or `application/json`;
- for the operations whose `spec.unknownBodyFields` is set (Flight Offers Price, Branded Fares Upsell, Flight Availabilities Search, Flight Create Orders, Flight Order Issue and Management PATCH), **unknown body fields**: JSON Schema lets an object carry fields its schema does not declare, these operations refuse them (`request body field /data/paymentz is not defined by the specification`). A field is known when a schema that applies at its place (through `$ref`, `allOf`, `anyOf`, `oneOf`) declares it in `properties`, or allows it with `additionalProperties` or `patternProperties`; a place whose schemas declare no `properties` is not checked. `alsoKnown` adds the schemas of other specifications at a place: Flight Offers Price and Branded Fares Upsell take back in `data.flightOffers[]` the offers that Flight Offers Search, Branded Fares Upsell and Flight Offers Price answered, whose `FlightOffer` schemas declare fields the request schema does not (`isUpsellOffer`, `brandedFareLabel`, `amenities`); Flight Create Orders and Management PATCH know those and the offers of Flight Create Orders' answer too. Flight Offers Search keeps X-026's behaviour (unknown body fields pass).

Each failure is one issue of a `400`, which names the parameter (`source.parameter`) or the body field (`source.pointer`, a JSON pointer) and the rule, never the value:

```json
{ "errors": [ { "status": 400, "code": 32171, "title": "MANDATORY DATA MISSING",
                "detail": "query parameter originLocationCode is required",
                "source": { "parameter": "originLocationCode" } } ] }
```

| Rule that failed | Code | Title |
|---|---|---|
| `required` (parameter, header, body field or body) | 32171 | `MANDATORY DATA MISSING` |
| `type`, `format`, `pattern`, Content-Type, invalid JSON | 477 | `INVALID FORMAT` |
| `enum` | 572 | `INVALID OPTION` |
| anything else (range, length, repeated or unknown parameter, unknown body field) | 4926 | `INVALID DATA RECEIVED` |

The specifications are loaded as they are, with four normalisations on a copy: draft-4 boolean `exclusiveMinimum`/`exclusiveMaximum` become the numeric form; a `$ref` that points nowhere becomes `{}` (FlightOffersSearch references the undefined `LoyaltyProgram` and `commissionValue`; `AmadeusSpecs.danglingRefs()` lists them); a schema with `properties` but no `type` gets `type: "object"` (FlightOffersSearch's `GetFlightOffersQuery` has none, so a body of `null`, `[]` or a double-encoded JSON string would otherwise find offers); `date-time` accepts the local date-times Amadeus uses (`2027-01-15T07:15:00`). At start the server `check()`s each implemented operation: it loads the specifications, looks up the operation, its parameters, its body schema and its `alsoKnown` schemas, and compiles the parameter validator, so a broken specification or reference fails there. The body validators, by far the costliest to compile, are compiled on the first request of their operation and cached (OBE-041: compiling all twelve at start took most of the 1 s start budget); `AmadeusSpecs.prepare()` compiles everything at once, which the route-table test does for every operation. `AmadeusSpecs.validateResponse()` checks a fixture against an operation's response schema.

### Errors the stub answers with

| Status | Code | When |
|---|---|---|
| 400 | 477, 572, 4926, 32171 | Validation (above); 477 also for a request target that is not a URL |
| 400 | 34651 | `sold-out` at Flight Offers Price, Branded Fares Upsell and Flight Create Orders |
| 400 | 1304 | The declined test card at Flight Create Orders or Flight Order Issue |
| 400 | 9112 | `ticketing-failed` at Flight Order Issue, or issuing an order that is already issued |
| 400 | 4926 | By-reference GET with an `originSystemCode` other than `GDS` |
| 400 | 90001 | Unknown `X-Stub-Scenario` |
| 401 | 38187 (OAuth format), 38190, 38191, 38192 | OAuth and bearer token (above) |
| 404 | 38196 | No route |
| 404 | 1797 | No active flight order with this id or record locator |
| 409 | 2552 | `version-conflict` at Management PATCH |
| 413 | 90003 | Request body over 5 MiB |
| 429 | 38194 | `rate-limited` |
| 500 | 141 | `server-error` |
| 500 | 90000 | A bug in the stub (`detail` has the message) |
| 501 | 90002 | Operation not stubbed yet (none since OBE-041) |
| 504 | 141 | `timeout` (and `timeout-lost` at an order write) after 30 s |
| 200 (warning) | 37200 | `price-changed` at Flight Offers Price, in `warnings` |
| 201 (warning) | 9112 | `ticketing-failed` at Flight Create Orders with `issue=true`, in `warnings` |

Codes from 90000 are the stub's own; Amadeus never sends them. API responses are `application/vnd.amadeus+json`, token endpoint responses `application/json`; the `204` of Management DELETE has no body.

## Adding or changing an operation

1. Add the fixtures under `fixtures/<api-in-kebab-case>/<scenario>.json` with the header of [`fixtures/README.md`](fixtures/README.md) (written by hand, or [recorded](#record-a-fixture-from-the-amadeus-test-environment)), and list the ones read at start in `STUB_FIXTURES`. The fixture scan must stay green.
2. Write the handler in `src/handlers/<operation>.ts` as a factory that takes the fixture loader (`(loadFixture: FixtureLoader) => OperationHandler`, so the handler imports only types from `src/routes.ts`), or as a plain `OperationHandler` when it reads no fixture, and set it on the operation in `STUB_OPERATIONS` (`src/routes.ts`). It gets the validated query and body, the path parameters, the scenario, the server's `orders` and the request time `now`; authentication, validation and the generic scenarios are already done. It returns a response, or a held answer (`timedOut()`). Pass `unknownBodyFields` to refuse body fields the specification does not declare, with `alsoKnown` for what the client takes back from other responses, and `writesOrder` for an order write (its handler then applies `timeout` itself, after the write).
3. Add operation-specific scenarios to `STUB_SCENARIOS` (`src/scenarios.ts`), make `applyScenario` continue to the handler for them, and handle them in the handler; error bodies come from `amadeusErrorResponse`.
4. Test the success fixture against the response schema (`AmadeusSpecs.validateResponse`), a 400 naming a parameter, and each scenario.

## Files

| Path | What |
|---|---|
| `src/index.ts` | Public API |
| `src/server.ts` | `createStubServer`: the HTTP server, the request steps, the request log, held responses |
| `src/oauth.ts` | Token endpoint and bearer-token check (`TokenStore`) |
| `src/routes.ts` | Route table of the 12 operations, route matching, fixture loading, the Flight Offers Search handler |
| `src/handlers/pricing.ts`, `upselling.ts`, `availability.ts` | The Flight Offers Price, Branded Fares Upsell and Flight Availabilities Search handlers (OBE-019) |
| `src/orders.ts` | `OrderStore`, the in-memory orders of a server; the `FlightOrder` answer; card masking (`maskCardNumbers`) and the declined test card (OBE-041) |
| `src/handlers/create-orders.ts`, `issue.ts`, `order-management.ts`, `by-reference.ts`, `queue-list.ts` | The Flight Create Orders, Flight Order Issue, Management GET/PATCH/DELETE, by-reference GET and Queue List handlers (OBE-041) |
| `src/scenarios.ts` | Scenario names and effects, magic values, the Amadeus error envelope and codes |
| `src/validate.ts` | `AmadeusSpecs`: loads the specifications, validates requests (and fixtures) with Ajv, refuses unknown body fields where asked |
| `src/cli.ts` | `pnpm stub:amadeus`, and `record` (`node dist/cli.js record …`) |
| `src/record.ts` | The `record` command (X-034) |
| `src/scrub.ts` | `scrub` and `scanForPersonalData`, the synthetic name lists, prefix, domain and phone ranges (X-034) |
| `fixtures/` | Response fixtures ([`fixtures/README.md`](fixtures/README.md)) |
| `test/server.test.ts` | The tests of the server, OAuth, validation, the generic scenarios and Flight Offers Search (in-process on free ports; nothing else needs to run) |
| `test/shopping.test.ts` | The tests of the shopping operations (OBE-019), the same way |
| `test/orders.test.ts` | The tests of the order operations, their scenarios, the declined card and the request log (OBE-041), the same way |
| `test/record.test.ts` | `record` against the stub and a fake `fetch` |
| `test/scrub.test.ts` | The scrubber on a recorded-style Flight Create Orders response |
| `test/fixtures-scan.test.ts` | The personal-data scan of every committed fixture |

## Commands

```bash
pnpm --filter @velexis/amadeus-stub build       # tsc -b to dist/
pnpm --filter @velexis/amadeus-stub test        # vitest run
pnpm --filter @velexis/amadeus-stub typecheck   # src and test
pnpm --filter @velexis/amadeus-stub lint
pnpm stub:amadeus                               # the root script: build, then node dist/cli.js
pnpm --filter @velexis/amadeus-stub record <operation> --request <file.json> [--scenario <name>]
```

The tests also read files outside this folder: the specifications in `docs/amadeus-api/` (the scrubber's test starts from Flight Create Orders' documented example), the OTA OpenAPI document (its `x-amadeus` entries) and the root `package.json` (the `stub:amadeus` script). They never call Amadeus: `record` is tested against the stub and a fake `fetch`. [`turbo.json`](../../turbo.json) lists them as inputs of `@velexis/amadeus-stub#test`, so a change to any of them re-runs the tests instead of replaying a cached pass.
