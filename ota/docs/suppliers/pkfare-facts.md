# PKFare facts

This page holds every fact about PKFare that the [multi-supplier plan](../../../docs/mvp/plans/multi-supplier-plan.md) and its task blocks rely on, with its source and its status, and the list of questions that the developer sends to PKFare (plan §8). Task OBE-107 wrote it on 2026-11-27 from the owner's copy of PKFare's Flight Buyer API pages, [`docs/pkfare/`](../../../docs/pkfare/README.md) (commit 4f740863, 146 pages downloaded that day), and from the workflow image that the owner gave the same day.

Related:

- [ADR-0030](../../../docs/mvp/adr/0030-suppliers-supply-sources-and-ingestion-engine.md): the supplier decisions; question 21 (which API versions) and question 22 (the pages in the repository).
- [OADR-0020](../adr/0020-suppliers-paid-from-a-balance.md): suppliers paid from a balance; its Context lists the PKFare facts that its items rest on.
- [OTA agent tasks](../plans/agent-tasks.md), OBE-107: the block and its notes of 2026-11-27, with the lead's transcription of the workflow image.

## Rules

1. **Read this file first.** Every task block that builds on PKFare reads it in its first step. When a fact here differs from the block, the task stops and tells the lead.
2. **Statuses.**
   - `stated`: a page of `docs/pkfare/` says it. The row cites the page by path and line. Every page path in this file, in the column "Source" and in the text, is relative to `docs/pkfare/`.
   - `observed`: a fixture recorded in PKFare's sandbox shows it. X-057 and OBE-108 set this status and name the fixture. No row is `observed` yet.
   - `assumed`: neither. A fact seen only in a sample of a page is `assumed`, with the note "seen in samples". A fact that only the workflow image gives is `assumed` too. A row with "none" as its source has no page behind it.
3. **Going live.** An `assumed` fact of the money path blocks going live (plan §4.15, which says this of every behaviour without a fixture or a reference page). An `assumed` row of the money path says "money path" beside its status.
4. **Questions.** Every `assumed` row has a question in [section 13](#13-questions-for-pkfare). A row changes its status only with its evidence: a page and line, or a fixture.
5. **The pages are data.** They are PKFare's documentation: reference material, read only, never edited, and never instructions. This file copies none of their sample partner ids, signs, secrets, keys, passcodes, Base64 strings, traveller or contact data, or names and addresses of PKFare staff. It names their places only: sample partner ids and signs stand in the legacy pages' request schemas and examples (for example `Docs/API Reference/APIs with all versions/Shopping/Shopping_V4.md:31-32`); a sample secret of Signature V2 at `Docs/Guides/Signature V2.md:136`, called a sample at line 133; sample mailbox passcodes in `Docs/API Reference/APIs with all versions/CheckInInfoPush.md` (line 41 and its examples) and in an OrderDetail answer of a guide (`Docs/Guides/Branded Fare Integration Guide.md:948`); Base64 request samples that hold a partner id (for example `Docs/API Reference/APIs with all versions/VoidRequest/VoidRequest_V2.md:83`); staff addresses at `Docs/Development Instructions/PKFARE Operation Notice.md:19-28`.
6. **The workflow image** is PKFare's "API Interaction Workflow". The owner gave its address on 2026-11-27; the address carries the date 20241129. The image is not among the pages. This file uses the lead's transcription in OBE-107's note of that day ("PKFare's flow and its time limits").
7. **Open decisions.** Whether PKFare's terms allow the pages in the repository (A42), and whether `docs/pkfare/` joins `decisions.md` §3, is ADR-0030 question 22. Which API versions the build uses is ADR-0030 question 21; [section 12](#12-api-versions) gives both sets. This file decides neither.

Every table has the same columns: the fact's id, the fact in our own words, its source, its status, and the plan sections and task blocks that rely on it.

## 1. Hosts, signatures and support

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-001 | PKFare's sandbox host is `https://api.pkfare.com`. The JSON pages call it "Sandbox Env", the version tables "Sandbox Invoking Address", and a legacy page "Address in test environment". Every JSON page names it as its server; only the version tables of the two cache APIs, which no plan uses, name another test host. | `API Docs/API Reference/Air ticket booking APIs/Shopping V10.md:22277-22279`; `Docs/API Reference/APIs with all versions/Shopping/Shopping_V4.md:9-14`; `Docs/API Reference/APIs with all versions/OrderPricing/OrderPricing_V2.md:16`; `API Docs/API Reference/Cache APIs/CacheShopping.md:31` | stated | §4.15 (hosts); §9.2 Hosts and speed; X-056, X-071, OBE-159 |
| PKF-002 | PKFare gives the production address after the buyer's development and testing, before the launch. No page names the production host; a legacy page shows a placeholder. | `Docs/API Reference/APIs with all versions/CheckRefundPricing/CheckRefundPricing.md:22-24`; `Docs/API Reference/APIs with all versions/OrderPricing/OrderPricing_V2.md:17` | stated | §4.15 (hosts); §9.2 Hosts and speed; X-073 |
| PKF-003 | PKFare's production host. | none | assumed | §4.15 (hosts); §9.2 Hosts and speed; X-073, OBE-206 |
| PKF-004 | The legacy signature: every request carries `sign`, the MD5 of the partner id followed by the partner key, in the body's `authentication` object. It is the same on every request; Signature V2's page calls it static. | `Docs/Development Instructions/Signature.md:3`; `Docs/Guides/Signature V2.md:5-7, 380` | stated | §4.6; §4.15; §9.4; OBE-159, PBE-083 |
| PKF-005 | Signature V2: six `X-PK-*` headers on every request. `X-PK-Signature` is an HMAC-SHA256, keyed with the decoded secret, over the path, the query, the partner id, the key id, the timestamp, the request id and the SHA-256 of the exact body. The timestamp must be within 300 seconds of PKFare's clock. Every request, retries included, gets a new timestamp, request id and signature. | `Docs/Guides/Signature V2.md:5, 58-71, 79-98, 105, 431` | stated | §4.6; §9.4; OBE-159, PBE-079, PBE-083, PBE-084, X-056, X-058 |
| PKF-006 | PKFare's account manager sets the authentication mode per Partner ID: Legacy (the default for existing buyers; Signature V2 is refused with S205), Migration (both are accepted) or Signature (the legacy `sign` is refused with B003). A change takes effect in about a minute. | `Docs/Guides/Signature V2.md:21-36` | stated | §4.6; OBE-159, PBE-083, X-056, X-058 |
| PKF-007 | The mode of Velexis's Partner ID in the sandbox and in production, and so whether Velexis signs with the fixed `sign` or with Signature V2. No page says which mode a new Partner ID gets. | none | assumed; money path | §4.6; §9.4; OBE-159, PBE-079, PBE-083, PBE-084, X-056, X-058 |
| PKF-008 | With Signature V2 the body's `authentication` object is optional. If it is kept, its `partnerId` must equal `X-PK-Partner-Id`, or the call is refused with B003. In Signature mode a request without the V2 headers is refused with B003. | `Docs/Guides/Signature V2.md:377-381` | stated | OBE-159, PBE-083 |
| PKF-009 | The secret and the `X-PK-Signature` header are never logged. The body is not serialised again, compressed or changed after it is signed. | `Docs/Guides/Signature V2.md:53, 128, 434` | stated | §4.6; §4.15; OBE-159, PBE-083, X-056 |
| PKF-010 | Signature V2 keys: a key arrives by a one-time link and a code sent to the technical contact; up to two keys are valid at a time; the old key keeps working for a retirement period of 1 hour to 7 days; a revoked key stops within about a minute. | `Docs/Guides/Signature V2.md:40-56, 385-391` | stated | §9.2 Wallet and key; PBE-084, X-072 |
| PKF-011 | How a legacy partner key is rotated. | none | assumed | §9.2 Wallet and key; X-072 |
| PKF-012 | Signature V2 errors come with an HTTP error status: S201 to S205 with 401, S206 with 403, S207 with 400. S001 with 503 means "retry later". | `Docs/Guides/Signature V2.md:395-417` | stated | OBE-159, PBE-083 |
| PKF-013 | In a support ticket PKFare asks for the API, version, environment, request time, request or trace id, order number and error code, and asks that the ticket hold no passwords, API keys, tokens or payment data. Signature V2 adds `X-PK-Request-Id` for this. | `Docs/Guides/PKFARE Buyer API Integration Process and UAT Guide.md:74-82, 153`; `Docs/Guides/Signature V2.md:73` | stated | OBE-159 |
| PKF-014 | PKFare's response times per operation and its rate limits in numbers. The pages give none; Shopping and PrecisePricing refuse with B035 (concurrency) and B046 (look-to-book) without numbers. | none (the codes: `API Docs/API Reference/Air ticket booking APIs/Shopping V10.md:112-114, 122-124`; `API Docs/API Reference/Air ticket booking APIs/PrecisePricing V12.md:100-101, 149-151`) | assumed | §9.2 Hosts and speed; OBE-108, OBE-167 |

## 2. Search and offers

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-015 | Shopping takes at most 2 journeys (B066) and at most 9 travellers with a seat (P004). Infants may not outnumber adults (P009). | `API Docs/API Reference/Air ticket booking APIs/Shopping V10.md:20-22, 92-93, 98-100, 135-136`; `Docs/API Reference/APIs with all versions/Shopping/Shopping_V4.md:5, 902, 904, 916` | stated | §4.10; OBE-160 |
| PKF-016 | A Shopping request has no currency field, in Shopping_V4 and in Shopping V10. Each solution of the answer carries its currency. | `Docs/API Reference/APIs with all versions/Shopping/Shopping_V4.md:28-45, 160`; `API Docs/API Reference/Air ticket booking APIs/Shopping V10.md:153-369, 407-409` | stated | §4.10; §9.2 Currency; OBE-160, OBE-161 |
| PKF-017 | Which currencies Velexis's account quotes, and whether they are the wallet's currency. | none | assumed; money path | §4.10; §9.2 Currency; OBE-160, OBE-165, OBE-170 |
| PKF-018 | Shopping's baggage and miniRules, and PrecisePricing_V6's penalty, are for reference only. The Penalty API gives the fare rules. | `Docs/API Reference/APIs with all versions/Shopping/Shopping_V4.md:169-170`; `Docs/Guides/Book air tickets with ancillaries.md:84, 205` | stated | §4.10; §9.2 Offers; OBE-161, OBE-164 |
| PKF-019 | Whether PKFare's bags and fare conditions compare with Amadeus's. PrecisePricing gives free bags and carry-on per journey, and Penalty gives refund and change penalties, but no page says how complete or binding they are. | none (the fields: `Docs/API Reference/APIs with all versions/PrecisePricing/PrecisePricing_V6.md:208-215`; `Docs/API Reference/APIs with all versions/Penalty/Penalty.md:5`) | assumed | §9.2 Offers; OBE-161, OBE-164 |
| PKF-020 | PKFare keeps a time to live for Shopping answers, which the buyer may set shorter. It advises a buyer-side cache, refreshed by each Shopping answer and by a price or booking class change in PrecisePricing. | `Docs/Guides/Tricks for Playing with PKFARE API.md:18-20, 69-70` | stated | OBE-160, OBE-161 |
| PKF-021 | The length of Shopping's time to live, and whether an older offer may still be priced. | none | assumed | OBE-160, OBE-161, OBE-162 |
| PKF-022 | `solutionId` is opaque, may contain "+", "/" and "=", and is stored whole. | `Docs/Development Instructions/PKFARE Buyer API solutionId Usage Guide.md:18, 49` | stated | OBE-161, OBE-162 |

## 3. Pricing and fare rules

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-023 | PreciseBooking needs a successful PrecisePricing. PKFare strongly advises PrecisePricing again right before PreciseBooking; a price change during booking fails the booking. On a price change the customer chooses whether to go on. | `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:11`; `Docs/Guides/Book air tickets with ancillaries.md:219, 379`; `Docs/Guides/Tricks for Playing with PKFARE API.md:30-32` | stated | §4.9 step 2; §4.10 rule 1; OBE-162, OBE-169 |
| PKF-024 | The `solutionId` of a PrecisePricing answer is used once in booking. A failed booking or a changed selection needs a new PrecisePricing. PKFare asks buyers to prevent two bookings with the same `solutionId`. | `API Docs/API Reference/Air ticket booking APIs/PreciseBooking V8.md:160-167`; `Docs/Development Instructions/PKFARE Buyer API solutionId Usage Guide.md:83, 151` | stated | §4.10 rules 1 and 2; OBE-162, OBE-169 |
| PKF-025 | PreciseBooking must follow PrecisePricing within 30 minutes, or it is refused with B005. PKFare advises not to wait for the limit, and to start a timer after pricing that prices again before it. | `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:11, 1271`; `Docs/Development Instructions/PKFARE Buyer API solutionId Usage Guide.md:85, 150` | stated | §4.10 rule 1; OBE-162, OBE-169 |
| PKF-026 | PrecisePricing gives no validity time for its price. Its `latestTktTime` (GMT, per flight) is the latest ticketing time. It can refuse with B026: the last ticketing time is not enough. | `Docs/API Reference/APIs with all versions/PrecisePricing/PrecisePricing_V6.md:220`; `API Docs/API Reference/Air ticket booking APIs/PrecisePricing V12.md:137-138, 877-879` | stated | OBE-162 (step 7, `supplier_valid_until`) |
| PKF-027 | On B020 (no price) or B021 (no seat in the booking class), PKFare advises one retry with `solutionId` "direct pricing" (PrecisePricing V6 and later). Its answer is a new offer, possibly with another booking class, price or conditions, shown to the customer before booking. No blind retries. | `Docs/Development Instructions/PKFARE Buyer API solutionId Usage Guide.md:91-113`; `Docs/Guides/Tricks for Playing with PKFARE API.md:10-11, 72-76` | stated | OBE-162 |
| PKF-028 | Penalty is called within 30 minutes after PrecisePricing, best 10 seconds after its answer, and returns the refund and change rules of the flight. | `Docs/API Reference/APIs with all versions/Penalty/Penalty.md:5`; `API Docs/API Reference/Air ticket booking APIs/Penalty V4.md:20-24` | stated | §4.10 (no sale without readable rules); OBE-164 |
| PKF-029 | Calls follow one another: each waits for the answer of the call before it. Calls made at the same time cause errors. | `Docs/Development Instructions/Booking errors explanation and suggestions.md:18, 28` | stated | OBE-162, OBE-169 |

## 4. Creating the order

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-030 | PreciseBooking answers PKFare's order number (`orderNum`) and a `pnr`. For GDS content the `pnr` is the GDS's; for low-cost and NDC content it is PKFare's own reference. The airline's reference (`airPNR`) is another field. | `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:650-651`; `Docs/Guides/Book air tickets with ancillaries.md:459-466` | stated | §4.9 step 3; ADR-0030 item 17; OBE-154, OBE-169 |
| PKF-031 | The booking request takes `buyerOrder`, "your order number if you want to store at PKFARE side": a nullable string, with no length or character set. | `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:43`; `API Docs/API Reference/Air ticket booking APIs/PreciseBooking V8.md:306-309` | stated | OBE-169, OBE-182 |
| PKF-032 | The longest `buyerOrder` that PKFare stores, and the characters it allows. | none | assumed | OBE-169, OBE-182 |
| PKF-033 | The booking request carries the fares and taxes per traveller type of the last PrecisePricing. A changed price is refused with B017. | `Docs/Guides/Book air tickets with ancillaries.md:268-275`; `Docs/Development Instructions/PKFARE Buyer API solutionId Usage Guide.md:80`; `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:60-65, 1278` | stated | §4.10 rule 1; OBE-165, OBE-169 |
| PKF-034 | A second booking of the same passenger on the same segment is refused with B029. PKFare advises cancelling the unpaid order first (CancelOrder), or paying it. | `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:1284`; `Docs/Development Instructions/Booking errors explanation and suggestions.md:72-82`; `Docs/Guides/Tricks for Playing with PKFARE API.md:50-52` | stated | §4.10 rule 2; OBE-169 |
| PKF-035 | PKFare can be set to return the earlier order number on a duplicate booking. The buyer then tells the customer and cancels that order before booking again. | `Docs/Guides/Tricks for Playing with PKFARE API.md:55` | stated | OBE-169, OBE-198, OBE-200 |
| PKF-036 | Whether that setting is on for Velexis's Partner ID, and whether the earlier order number may be used to find an order whose booking answer was lost. | none | assumed; money path | §4.10 (a lost order answer); A33; OBE-169, OBE-198, OBE-200 |
| PKF-037 | Booking codes: B005 also follows changed parameters, calls made at the same time, a booking milliseconds after the pricing answer, or a booking after a pricing error; B006 means the booking failed but an order was created, and gives its number; B008 means the itinerary differs (maybe a schedule change) and is never retried, as that may lead to an ADM; B087 means churning was detected, and bookings of that passenger are then restricted. | `Docs/Development Instructions/Booking errors explanation and suggestions.md:9-20`; `API Docs/API Reference/Air ticket booking APIs/PreciseBooking V8.md:16, 1961-1976`; `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:1271-1272` | stated | §4.10 rule 2; OBE-169 |
| PKF-038 | Where B006's order number comes: the page names a field `Other.OrderNum`, and the message text also carries the number. Whether the field is always there, and where it sits in the JSON answer. | none | assumed; money path | §4.10 rule 2; OBE-169, OBE-198 |
| PKF-039 | B012 ("Create PNR time out", "wait some minutes") and B028 ("Booking time out from GDS") are time-outs from the GDS. | `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:1277, 1283` | stated | §4.10 rule 2; OBE-169 |
| PKF-040 | Whether an order exists, or appears later, after B012, B028 or a booking request without an answer. | none | assumed; money path | §4.9 (Create order `unknown`); §4.10 rule 2; A33; OBE-169, OBE-198 |
| PKF-041 | How long to wait after the PrecisePricing answer before PreciseBooking, so that B005 does not follow a call that comes too soon. | none (`API Docs/API Reference/Air ticket booking APIs/PreciseBooking V8.md:1966-1969` says "milliseconds" only) | assumed | OBE-169 |
| PKF-042 | What counts as churning for B087 (how many bookings and cancellations, over what time), and how long a passenger stays restricted. | none | assumed; money path | §4.10 rule 4 (release by CancelOrder); OBE-169, OBE-171 |
| PKF-043 | The booking answer gives `lastTktTime`, the latest ticketing time (GMT), per flight. OrderPricing refuses with B026 when it is less than an hour away, and with B115 once it has passed. | `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:675`; `API Docs/API Reference/Air ticket booking APIs/PreciseBooking V8.md:956-958`; `Docs/API Reference/APIs with all versions/OrderPricing/OrderPricing_V2.md:347, 360` | stated | §4.10 rules 3 and 4; OBE-170, OBE-171 |
| PKF-044 | How long an unpaid order lives (the hold of plan §4.10). The pages give only the ticketing deadline of PKF-043; the image gives 60 minutes from the order to payment (PKF-111). | none | assumed; money path | §4.10 (the hold; rule 4); §9.2 Orders; OBE-171, OBE-170 |
| PKF-045 | CancelOrder cancels an order and its PNR before ticketing, only while the order is TO_BE_PAID (else B009). A repeat answers B041, already cancelled. The order goes from TO_BE_PAID to CNCL. | `Docs/API Reference/APIs with all versions/CancelOrder/CancelOrder.md:5, 85, 87`; `API Docs/API Reference/Air ticket booking APIs/CancelOrder.md:20-21`; `Docs/Development Instructions/Order Status Explanation.md:39` | stated | §4.10 rule 4; A8; OBE-170, OBE-171 |
| PKF-046 | Whether an unpaid order is ever debited, in writing. Ticketing deducts the money (PKF-055), CancelOrder works before ticketing (PKF-045), and PKFare runs OrderPricing itself when a Ticketing request comes without one. | none (the context: `API Docs/API Reference/Air ticket booking APIs/Ticketing.md:20-22`; `Docs/API Reference/APIs with all versions/OrderPricing/OrderPricing_V2.md:5`) | assumed; money path | §4.10 (A33); §9.2 Orders; OADR-0020 Context; OBE-198, OBE-206 |
| PKF-047 | OrderDetail reads an order by PKFare's order number. Its answer has no `buyerOrder` field (a search of the OrderDetail pages finds none). | `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:217-219` | stated | §4.10 (a lost order answer); §9.2 Orders; §9.4; OBE-174, OBE-198 |
| PKF-048 | Whether any other way, PKFare's portal included, finds an order by our own reference, or by traveller and flight. | none | assumed; money path | §4.9 (Find order); §4.10; §9.2 Orders; A33; OBE-198, OBE-200 |
| PKF-049 | PKFare's buyer portal has order management and the after-sales requests (change, refund, void). The live co-test includes the customer service portal training. | `Docs/Development Instructions/PKFARE Operation Notice.md:31-49`; `Docs/Guides/PKFARE Buyer API Integration Process and UAT Guide.md:19` | stated | §4.10 (a lost order answer); §4.12; OBE-198, OBE-200 |

## 5. Check payable, the wallet and ticketing

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-050 | OrderPricing checks the PNR and the order's price before payment. It is mandatory before Ticketing, and Ticketing must follow it within 30 minutes. Without it PKFare runs it itself. | `API Docs/API Reference/APIs with all versions/OrderPricing/OrderPricing V4.md:16`; `Docs/API Reference/APIs with all versions/OrderPricing/OrderPricing_V2.md:5-6`; `Docs/Guides/Book air tickets with ancillaries.md:390` | stated | §4.9 step 4; §4.10 rules 3 and 4; OBE-170, OBE-171 |
| PKF-051 | OrderPricing right after booking can fail with B103, B107 or B109 while the GDS makes the PNR: retry, or call it two minutes after booking. Codes 310 and B119 also say "try again". B107 and B109 also say that the fare changed; B108 says the fare is not guaranteed. | `Docs/Guides/Tricks for Playing with PKFARE API.md:62`; `Docs/API Reference/APIs with all versions/OrderPricing/OrderPricing_V2.md:342, 350, 354-356, 364` | stated | §4.9 (steps 3 and 4 in one request, A31); OBE-108, OBE-170 |
| PKF-052 | OrderPricing refuses with B112 when the order was paid before. | `API Docs/API Reference/Air ticket booking APIs/OrderPricing V6.md:16`; `Docs/API Reference/APIs with all versions/OrderPricing/OrderPricing_V2.md:357` | stated | §4.10 rule 5; OBE-172 |
| PKF-053 | Whether OrderPricing may be repeated after a success, and whether the repeat starts the 30 minutes to Ticketing again. After an error a repeat is allowed (PKF-051). | none | assumed; money path | §4.10 rule 5; §9.2 Orders; OBE-171, OBE-172 |
| PKF-054 | OrderPricing's answer gives the currency, the fares, taxes and fees per traveller type, and the extras with their own currency and price. It has no total (a search of the page finds none). Its exchange rate is "not supported yet". | `API Docs/API Reference/Air ticket booking APIs/OrderPricing V6.md:93-116, 182-209, 475-480, 562-567` | stated | §4.10 rule 3; OBE-165, OBE-170 |
| PKF-055 | Ticketing asks PKFare to deduct the order from the buyer's credit: Prepay or Alipay only. Ticket numbers come later, by the push or by OrderDetail. | `API Docs/API Reference/Air ticket booking APIs/Ticketing.md:20-22` | stated | §4.6; §4.9 step 7; OBE-172 |
| PKF-056 | PKFare quotes net fares only. The total is fare plus tax plus `tktFee` per traveller, times the numbers of travellers, plus `platformServiceFee` (not charged now) and `merchantFee` (not charged when prepaid). `qCharge` is for reference only. | `Docs/Development Instructions/Price Breakdown Explanation.md:6, 10-17, 21-22`; `Docs/API Reference/APIs with all versions/PrecisePricing/PrecisePricing_V6.md:202` | stated | §4.10 (the expected debit); A15; OBE-165, OBE-170, OBE-172 |
| PKF-057 | Ticketing's answer gives `orderAmount`, `transactionExpense` (the merchant fee) and `payAmount`, with no currency. The JSON page types `orderAmount` as an integer, and its example gives the other two amounts with decimals; the legacy page types all three as BigDecimal, with decimals in its sample. | `API Docs/API Reference/Air ticket booking APIs/Ticketing.md:151-162, 185-187`; `Docs/API Reference/APIs with all versions/Ticketing/Ticketing.md:65-68` | stated | §4.10 (the expected debit; rule 5); OBE-172 |
| PKF-058 | Ticketing refuses with B022 when the balance is not enough, and with B024 when the order is already paid. The same codes mean other things elsewhere: B022 a child's age in PreciseBooking, B024 a time-out in PrecisePricing. | `API Docs/API Reference/Air ticket booking APIs/Ticketing.md:64-67`; `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:1280`; `API Docs/API Reference/Air ticket booking APIs/PrecisePricing V12.md:140` | stated | §4.6; §4.10 rules 5 and 8; OBE-169, OBE-172, X-057 |
| PKF-059 | WalletBalance (`/json/walletBalance`) reads the wallet of the main buyer and of its sub-buyers: currency, status, and the available, withdrawable, cash, credit, temporary credit and deposit balances. B207 means the wallet is not activated. | `API Docs/API Reference/Air ticket booking APIs/WalletBalance.md:12, 18, 26, 92-113` | stated | §4.6; §4.9 step 4; A21; PBE-083, PBE-087, OBE-170 |
| PKF-060 | Which balance Ticketing debits, and whether the debit includes the bags and seats booked with the order. | none | assumed; money path | §4.6; §4.10 rules 3 and 5; §4.11; OBE-170, OBE-172, OBE-180 |
| PKF-061 | How often the balance may be read: the wallet watch every five minutes, and one read per checkout. | none | assumed | §4.6 (A26); §9.2 Wallet and key; PBE-083, PBE-087, OBE-170 |
| PKF-062 | A sub-buyer's wallet is SEPARATE from the main buyer's, or SHARED with it. | `API Docs/API Reference/Air ticket booking APIs/WalletBalance.md:135-149` | stated | §4.6; §9.2 Wallet and key |
| PKF-063 | Whether a sub-buyer has its own credentials (Partner ID and key). | none | assumed | §4.6; §9.2 Wallet and key; PBE-079 |
| PKF-064 | Ticketing's contact e-mail receives PKFare's notices (schedule changes, a payment failure, a reimbursement). PKFare advises a company address, or none, and never the traveller's. For the e-mails that cannot be configured, the address of the original booking is the recipient. | `API Docs/API Reference/Air ticket booking APIs/Ticketing.md:93-95`; `Docs/Guides/Book air tickets with ancillaries.md:426-431`; `Docs/Development Instructions/PKFARE Operation Notice.md:56, 73-76` | stated | A35; §9.2 After-sales; OBE-169, OBE-172 |

## 6. Issuance, statuses and tickets

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-065 | Final statuses include ISSED, RSV_FAIL, CNCL and CNCL_REIMED. Not final: ISS_PRC, TO_BE_PAID, HOLD (held by hand, PKFare's customer service acts), UNDER_REVIEW, CLOSED, CNCL_TO_BE_REIM and VOID. An issued order goes TO_BE_PAID, ISS_PRC, ISSED; a cancelled PNR TO_BE_PAID, CNCL; a failed issue TO_BE_PAID, ISS_PRC, CNCL_TO_BE_REIM, CNCL_REIMED. | `Docs/Development Instructions/Order Status Explanation.md:5-31, 38-40` | stated | §4.10 rule 6; §4.12; OBE-173, OBE-174 |
| PKF-066 | PKFare advises polling OrderDetail every 5 to 10 minutes, and using the push and polling together. | `Docs/Guides/Book air tickets with ancillaries.md:449, 453`; `Docs/Guides/Tricks for Playing with PKFARE API.md:46` | stated | §4.9 step 8; §4.10 rule 6; OBE-173 |
| PKF-067 | RequestTicketing reminds PKFare of an order that is issuing: once per order in 10 minutes (else B179), and only for an issuing order (else B180). | `API Docs/API Reference/Air ticket booking APIs/RequestTicketing.md:20-28, 73-76` | stated | OBE-173 |
| PKF-068 | OrderDetail gives the airline's reference only once the status is ISSED. The airline's reference exists only after issuance and may change while issuing. | `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:290-293`; `Docs/Guides/Book air tickets with ancillaries.md:463-466` | stated | §4.11; §9.2 Low-cost; ADR-0030 item 17; OBE-154, OBE-174 |
| PKF-069 | An OrderDetail example of an order that is still issuing (ISS_PRC) shows airline references. Seen in samples. | none (the sample: `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:2741, 2895, 2906`) | assumed | §9.2 Low-cost; OBE-173, OBE-174 |
| PKF-070 | PKFare has an e-mail for an update of the airline's reference or the ticket numbers. | `Docs/Development Instructions/PKFARE Operation Notice.md:98, 198` | stated | OBE-174, OBE-198 |
| PKF-071 | Reading tickets: take `pnrList` first (per segment: the airline's reference and each traveller's ticket numbers) and ignore the order-level `pnr`. Without `pnrList`, take `airPnr`, split each traveller's `ticketNum` on "/" and match the tickets to the segments in order. The how-to says this of the push; OrderDetail has the same fields. | `Docs/Development Instructions/How to retrieve airlines'PNR and ticket numbers.md:6, 12-25, 28-30, 50-60, 74-77`; `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:953-1023` | stated | §4.9 step 8; §4.10 rule 6; OBE-174 |
| PKF-072 | A traveller can have several ticket numbers, joined by "/". | `Docs/API Reference/Air ticket booking APIs/TicketIssuanceNotify_V3.md:65`; `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:395-396` | stated | OBE-174 (its acceptance has one ticket row per traveller), OBE-181 |
| PKF-073 | An order can hold several airline references, joined by "\|" at order level. Seen in samples. | none (the samples: `Docs/API Reference/Air ticket booking APIs/TicketIssuanceNotify_V3.md:89`; `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:2512`) | assumed | OBE-154, OBE-174 |
| PKF-074 | PKFare advises checking that a ticket number has 13 digits. The how-to says this of the push. | `Docs/Development Instructions/How to retrieve airlines'PNR and ticket numbers.md:6, 80` | stated | §4.10 rule 6; §4.11; OBE-174, OBE-181 |

## 7. The push from PKFare

Of the owner's eight APIs, TicketIssuanceNotify is the one call that PKFare makes to us. OBE-182 receives it.

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-075 | TicketIssuanceNotify: PKFare sends a POST to a URL that the buyer gives, with the ticket numbers and the airline's references once tickets are issued, or with a reason when the request was refused. | `Docs/API Reference/Air ticket booking APIs/TicketIssuanceNotify_V3.md:7, 13-18, 26` | stated | §4.10 (notifications); OBE-182, X-057 |
| PKF-076 | Signature V2 does not cover the notices that PKFare pushes. | `Docs/Guides/Signature V2.md:16` | stated | §4.10 (notifications are not authenticated); OBE-182 |
| PKF-077 | Whether a push can be authenticated at all (its source addresses, a secret or a signature). No push page describes any. | none | assumed | §4.10 (notifications are not authenticated); OBE-182 |
| PKF-078 | The push carries a status ISSUED, CHANGED or REJECTED (not OrderDetail's ISSED), a reason when refused, and for a cancelled order an `orderStatus` such as CNCL_TO_BE_REIM. | `Docs/API Reference/Air ticket booking APIs/TicketIssuanceNotify_V3.md:34-36, 79` | stated | OBE-173, OBE-182 |
| PKF-079 | The push body holds passport numbers, birthdays and document expiry dates. | `Docs/API Reference/Air ticket booking APIs/TicketIssuanceNotify_V3.md:55-58` | stated | §4.15 (secrets by value); OBE-182, X-057 |
| PKF-080 | The push schema lists `buyerOrder`; neither of its two examples carries it. | `Docs/API Reference/Air ticket booking APIs/TicketIssuanceNotify_V3.md:51, 84-171, 174-259` | stated | OBE-182 |
| PKF-081 | Whether every push carries the `buyerOrder` sent with PreciseBooking. | none | assumed | OBE-182 |
| PKF-082 | The buyer answers `{"errorCode":0,"errorMsg":"ok"}`. An older push page says that PKFare pushes 4 more times after any other answer; the V3 page gives no retry rule. | `Docs/API Reference/Air ticket booking APIs/TicketIssuanceNotify_V3.md:262-275`; `Docs/API Reference/APIs with all versions/TicketNumPush/TicketingNumPush.md:56` | stated | OBE-182 |
| PKF-083 | How Velexis registers its push URL per environment, which push version its Partner ID gets, and how often and for how long PKFare retries. | none | assumed | OBE-182, X-057; plan §8 |
| PKF-084 | PKFare pushes other notices too, among them ScheduleChangeNotify, RefundResultNotify and ChangeResultPush. For ScheduleChangeNotify PKFare sets the buyer's URL in its own system. | `Docs/Guides/Signature V2.md:16`; `README.md:21-43`; `Docs/API Reference/Flight schedule change APIs/ScheduleChangeNotify.md:10-11` | stated | §9.6 item 4; OBE-182, X-072 |
| PKF-085 | Check-in data carry a booking mailbox, and CheckInInfoPush also its passcode. OrderDetail can be asked without the check-in data. | `Docs/API Reference/APIs with all versions/CheckInInfoPush.md:7, 40-41`; `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:1203-1205, 220-222` | stated | §4.15; OBE-174, OBE-182 |
| PKF-086 | OrderDetail's check-in data can carry the mailbox passcode too. Its schema lists the mailbox only; an OrderDetail V14 example has an empty `mailPassword`, and an OrderDetail answer in a guide has one with a value. Seen in samples. | none (the schema: `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:1177-1218`; the samples: `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:3357`, `Docs/Guides/Branded Fare Integration Guide.md:948`) | assumed | §4.15; OBE-174 |

## 8. Extras and low-cost content

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-087 | PrecisePricing (V5 and later) says whether paid bags and paid seats are available for the offer. | `Docs/API Reference/APIs with all versions/PrecisePricing/PrecisePricing_V6.md:16, 266-268` | stated | §4.11; OBE-180 |
| PKF-088 | Bags and seats priced by AncillaryPricing go into the same PreciseBooking as the flight. Pricing, extras pricing and booking stay within 30 minutes. AncillaryPricing results are valid for half an hour. | `Docs/Guides/Book air tickets with ancillaries.md:217, 377-380`; `API Docs/API Reference/Ancillary booking APIs/AncillaryPricing V7.md:16`; `Docs/Development Instructions/Booking errors explanation and suggestions.md:14, 24` | stated | §4.11; OBE-180 |
| PKF-089 | At most one paid checked bag and one paid carry-on per traveller and journey, and one seat per traveller and flight (B192, B193). If several bags are sent, only the heaviest is booked. | `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:7, 9`; `Docs/Guides/Book air tickets with ancillaries.md:378`; `API Docs/API Reference/Air ticket booking APIs/PreciseBooking V8.md:16` | stated | §4.11; A35; OBE-180 |
| PKF-090 | Paid bags after the booking need their own AncillaryPricing (for an order that is issuing or issued), an ancillary order and its own payment. | `Docs/Guides/Add Paid Bags after the Booking.md:7-15, 29` | stated | §4.11 (A30) |
| PKF-091 | PKFare's airline list marks each carrier LCC or FSC. | `Docs/Development Instructions/Airlines available from PKFARE.md:3, 5` | stated | §4.11; §9.1; §9.2 Low-cost; OBE-161, OADR-0020 question 1 |
| PKF-092 | Shopping V10 can filter offers by product tags, among them a tag type ContentSource (a request example excludes GDS). The tag types and codes come from PKFare's Tag Information API, which is not among the pages. Shopping_V4's solution has no such tag. | `API Docs/API Reference/Air ticket booking APIs/Shopping V10.md:250-256, 258-263, 272-275, 361-368`; `Docs/API Reference/APIs with all versions/Shopping/Shopping_V4.md:156-175` | stated | §4.11; OBE-161 |
| PKF-093 | An answer of Shopping V10 tags a solution ContentSource THIRD_API. Seen in samples. | none (the sample: `API Docs/API Reference/Air ticket booking APIs/Shopping V10.md:22144-22146`) | assumed | OBE-161 |
| PKF-094 | Which field marks low-cost content reliably for each offer: the carrier's LCC mark, the ContentSource tag or another, and whether THIRD_API means low-cost. | none | assumed; money path | §4.11; §9.1; §9.2 Low-cost; OBE-161, OBE-181, OADR-0020 question 1 |
| PKF-095 | Whether low-cost orders get e-ticket numbers. In the samples of VJ and UO, which the airline list marks LCC, `ticketNum` equals the airline's reference. Seen in samples. | none (the samples: `API Docs/API Reference/APIs with all versions/OrderDetail/OrderDetail V9.md:1321, 1335`; `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:3278, 3282, 3437, 3447`; the list: `Docs/Development Instructions/Airlines available from PKFARE.md:474, 488`) | assumed; money path | §4.10 rule 6; §4.11; §9.2 Low-cost; OBE-174, OBE-181 |

## 9. After-sales

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-096 | A schedule change reaches the buyer by ScheduleChangeNotify, by OrderDetail's schedule change data, and by e-mail to the booking's contacts. GetScheduleChangeList reads the changes of a time window, AcknowledgeScheduleChange removes a message from that list, and AcceptScheduleChange accepts a change for a traveller; the airline may cancel the seat of a traveller who does not accept. | `Docs/API Reference/Flight schedule change APIs/ScheduleChangeNotify.md:5-11`; `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:220-222`; `Docs/Development Instructions/PKFARE Operation Notice.md:56`; `API Docs/API Reference/Flight schedule change APIs/GetScheduleChangeList.md:33-34`; `API Docs/API Reference/Flight schedule change APIs/AcknowledgeScheduleChange.md:19-21`; `API Docs/API Reference/Flight schedule change APIs/AcceptScheduleChange.md:19-23` | stated | §4.12; §9.2 After-sales; §9.6 item 4; OBE-198, X-072 |
| PKF-097 | Whether the airline still reaches the traveller when the order holds only a Velexis mailbox and number. | none | assumed | A35; §9.2 After-sales; X-072 |
| PKF-098 | A refund runs RefundPricing (a quote, checked with CheckRefundPricing every 10 minutes until it is ready), then RefundRequest, then CheckRefund or the push RefundResultNotify, then CheckReimbursed or the push ReimbursedResultNotify. | `Docs/Guides/Raise refund requests.md:17-76` | stated | §4.12; A8; OBE-198, OBE-200 |
| PKF-099 | A successful RefundRequest cancels the order's PNR, whether or not the refund is approved; the tickets of that journey can no longer be used. | `Docs/Guides/Raise refund requests.md:46, 457` | stated | §4.12; OBE-198, OBE-200 |
| PKF-100 | Ticketing runs around the clock. Reissue and refund work runs from 09:00 to 00:30, UTC+8. | `Docs/Development Instructions/PKFARE Operation Notice.md:10, 14` | stated | §4.12 (case deadlines, A39); X-072 |
| PKF-101 | The format of PKFare's statement file. The co-test only asks to confirm "the financial statement". | none | assumed | §9.2 After-sales; §9.4; PBE-097, X-057 |

## 10. Going live, the sandbox and fixtures

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-102 | Certification: the buyer books the scenarios of PKFare's UAT workbook in the sandbox and returns the workbook with each order number, airline reference and ticket number. The live co-test follows certification: a top-up, a test booking, a round-trip ticket, the customer service portal training and the financial statement confirmed. | `Docs/Guides/PKFARE Buyer API Integration Process and UAT Guide.md:18-19, 84-123, 155` | stated | §8; P10; OBE-205, OBE-206 |
| PKF-103 | Sandbox content is limited. PKFare recommends the airlines AK, UO and TG for tests. | `Docs/Guides/PKFARE Buyer API Integration Process and UAT Guide.md:88-89` | stated | X-056, X-057 |
| PKF-104 | ModifyOrderStatus works in the sandbox only: it moves a flight order that is "Paid, to be issued" to ISSED. | `API Docs/API Reference/Air ticket booking APIs/ModifyOrderStatus.md:20-30` | stated | X-057, X-064 |
| PKF-105 | PreciseBooking refuses obviously fake names such as TEST with P008, and names with characters other than English letters and spaces. | `Docs/Development Instructions/Booking errors explanation and suggestions.md:37-50`; `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:51-52` | stated | X-056, X-057, OBE-163 |
| PKF-106 | The scenarios of PKFare's UAT workbook. It is an outside sheet, not among the pages. | none | assumed | §8; §9.2 Going live; OBE-205, OBE-206 |
| PKF-107 | Who travels on the co-test ticket. | none | assumed | §9.2 Going live; OBE-206 |
| PKF-108 | Whether the sample partner ids and signs in the pages are live credentials. The Signature V2 page calls its sample secret "a sample, not a real key". | none (`Docs/Guides/Signature V2.md:133` speaks of its own sample only) | assumed | §4.15; X-056, X-057 |

## 11. The flow and its time limits

The workflow image names ten operations; the owner's list of eight leaves out Ticketing and Penalty. Ticketing is the call that pays (PKF-055), so this file keeps both. The pages state these limits: PreciseBooking within 30 minutes of PrecisePricing (PKF-025), Penalty within 30 minutes of it (PKF-028), AncillaryPricing results valid for half an hour (PKF-088), Ticketing within 30 minutes of OrderPricing (PKF-050, which the image does not show), and a ticketing deadline per flight, with OrderPricing refused within an hour of it (PKF-043).

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-109 | The pages give the image's order of calls: Shopping; PrecisePricing with Penalty and, optionally, AncillaryPricing; PrecisePricing again and PreciseBooking, with CancelOrder for an unpaid or duplicate order; OrderPricing and Ticketing; then the push and OrderDetail. | `Docs/Guides/Book air tickets with ancillaries.md:11-17, 96, 205, 207, 217-219, 390, 441-453`; `Docs/API Reference/APIs with all versions/Penalty/Penalty.md:5`; `Docs/Development Instructions/Booking errors explanation and suggestions.md:81`; `Docs/Guides/Tricks for Playing with PKFARE API.md:55` | stated | §4.9; OBE-160 to OBE-174 |
| PKF-110 | The image puts 30 minutes between search and selection. Whether that is Shopping's time to live, a limit or advice. | workflow image | assumed | OBE-160, OBE-161 |
| PKF-111 | The image puts 60 minutes between the order and payment. Whether that is the hold of plan §4.10, a limit or advice. | workflow image | assumed; money path | §4.10 (the hold; rule 4); OBE-170, OBE-171 |
| PKF-112 | The image's note on references: the airline's reference is known only once the ticket is issued, and the airline may change it while issuing. The pages say the same. | workflow image; `Docs/Guides/Book air tickets with ancillaries.md:463-466` | stated | OBE-154, OBE-174 |

## 12. API versions

The image names PKFare's set of 2024. The pages' release of 2026/08/13 is newer (`Docs/Notice/Release Note.md:3-25`). PKFare's UAT guide asks for the latest version unless PKFare confirms an exception (PKF-123). Which set the build uses is ADR-0030 question 21; the lead recommends asking PKFare first and building on the newest set unless PKFare grants the image's set in writing. OBE-159 and the tasks after it need the answer.

| Id | Fact | Source | Status | Relied on by |
|---|---|---|---|---|
| PKF-113 | Shopping. The image: Shopping_V4 in JSON (`/json/shoppingV4`), which has only a row in a version table; the Shopping_V4 page shows the Base64 form. The newest: Shopping V10 (`/json/shoppingV10`, 2026/08/13). | `API Docs/API Reference/Air ticket booking APIs/Shopping V10.md:12, 44-47`; `Docs/API Reference/APIs with all versions/Shopping/Shopping_V4.md:14, 24`; `Docs/Notice/Release Note.md:6-11` | stated | OBE-159, OBE-160 |
| PKF-114 | PrecisePricing. The image: precisePricing_V6 in JSON (`/json/precisePricing_V6`), only a row in a version table; the PrecisePricing_V6 page shows the Base64 form. The newest: PrecisePricing V12 (`/json/precisePricing_V12`, 2026/08/13). | `API Docs/API Reference/Air ticket booking APIs/PrecisePricing V12.md:12, 55-58`; `Docs/API Reference/APIs with all versions/PrecisePricing/PrecisePricing_V6.md:17, 27`; `Docs/Notice/Release Note.md:13-14` | stated | OBE-159, OBE-162 |
| PKF-115 | Penalty. The image: "Penalty" with no version; Penalty_V2 is the first JSON version (`/json/penaltyV2`). The newest: Penalty V4 (`/json/penaltyV4`, 2026/08/13). | `API Docs/API Reference/Air ticket booking APIs/Penalty V4.md:12, 40, 48`; `Docs/Notice/Release Note.md:19-21` | stated | OBE-159, OBE-164 |
| PKF-116 | AncillaryPricing. The image: ancillaryPricing V5 in JSON (`/json/ancillaryPricingV5`). The newest: AncillaryPricing V7 (`/json/ancillaryPricingV7`, 2026/08/13). One error example of the V5 page says 60 minutes where its text says 30. | `API Docs/API Reference/APIs with all versions/AncillaryPricing/AncillaryPricing V5.md:12, 16, 4576`; `API Docs/API Reference/Ancillary booking APIs/AncillaryPricing V7.md:12`; `Docs/Notice/Release Note.md:19-20` | stated | OBE-159, OBE-180 |
| PKF-117 | PreciseBooking. The image: preciseBooking_V5 in JSON (`/json/preciseBooking_V5`, 2024/04/06), which appears only as a row of a version table and a line of the release note; the PreciseBooking_V5 page shows the Base64 form. The newest: PreciseBooking V8 (`/json/preciseBooking_V8`, 2026/08/13). | `Docs/API Reference/APIs with all versions/PreciseBooking/PreciseBooking_V5.md:21, 31`; `API Docs/API Reference/Air ticket booking APIs/PreciseBooking V8.md:12, 16`; `Docs/Notice/Release Note.md:16-17, 254, 261` | stated | OBE-159, OBE-169 |
| PKF-118 | OrderPricing. The image: orderPricing_V4 in JSON (`/json/orderPricingV4`). The newest: OrderPricing V6 (`/json/orderPricingV6`, 2026/08/13). | `API Docs/API Reference/APIs with all versions/OrderPricing/OrderPricing V4.md:12`; `API Docs/API Reference/Air ticket booking APIs/OrderPricing V6.md:12`; `Docs/Notice/Release Note.md:23-24` | stated | OBE-159, OBE-170, OBE-172 |
| PKF-119 | OrderDetail. The image: orderDetail_V9 in JSON (`/json/orderDetail/v9`). The newest: OrderDetail V14 (2026/08/13), whose path the page writes `/json/orderDetail/V14` and its version table and the release note `v14`. | `API Docs/API Reference/APIs with all versions/OrderDetail/OrderDetail V9.md:12`; `API Docs/API Reference/Air ticket booking APIs/OrderDetail V14.md:12, 92`; `Docs/Notice/Release Note.md:25` | stated | OBE-159, OBE-173, OBE-174 |
| PKF-120 | TicketIssuanceNotify. The image: V2 (released 2024/08/29). The newest page: TicketIssuanceNotify_V3, with no date. | `Docs/API Reference/APIs with all versions/TicketNumPush/TicketIssuanceNotify_V2.md:1`; `Docs/Notice/Release Note.md:152-157`; `Docs/API Reference/Air ticket booking APIs/TicketIssuanceNotify_V3.md:17-18` | stated | OBE-182 |
| PKF-121 | CancelOrder has one JSON version, `/json/cancel`. The release note of 2024/04/06 names it `json/cancelOrder`. | `API Docs/API Reference/Air ticket booking APIs/CancelOrder.md:12, 35`; `Docs/Notice/Release Note.md:254, 264` | stated | OBE-159, OBE-170, OBE-171 |
| PKF-122 | Ticketing has one JSON version, `/json/ticketing`. | `API Docs/API Reference/Air ticket booking APIs/Ticketing.md:12, 35` | stated | OBE-159, OBE-172 |
| PKF-123 | Unless PKFare confirms an exception, the buyer integrates with the latest published version. | `Docs/Guides/PKFARE Buyer API Integration Process and UAT Guide.md:59` | stated | ADR-0030 question 21; OBE-159 |
| PKF-124 | The set of versions that Velexis certifies on: the image's set of 2024, with PKFare's written exception, or the newest set. | none | assumed; money path | ADR-0030 question 21; OBE-159 to OBE-182 |

## 13. Questions for PKFare

The developer sends this list to PKFare (plan §8). It has one question for each `assumed` row, in the groups of plan §9.2. The push that PKFare sends to us is under "Hosts and speed"; the API versions are under "Going live".

### Orders

| # | Question | Rows |
|---|---|---|
| Q01 | How long does an unpaid order live before PKFare releases it, and what decides it: the ticketing deadline, a fixed time, or the airline? | PKF-044 |
| Q02 | The workflow image shows 60 minutes between creating an order and paying it. Is that a limit, the life of the unpaid order, or advice? | PKF-111 |
| Q03 | Can you confirm in writing that an order that was never paid by Ticketing is never debited from our wallet? | PKF-046 |
| Q04 | May OrderPricing be repeated after it succeeded, and does a repeat start the 30 minutes to Ticketing again? | PKF-053 |
| Q05 | Is there any way, in the API or in your portal, to find an order by our own reference (`buyerOrder`), or by traveller and flight, when a PreciseBooking answer is lost? | PKF-048 |
| Q06 | After B012, B028, or a PreciseBooking request that got no answer, can an order exist or appear later? How do we find out? | PKF-040 |
| Q07 | When PreciseBooking answers B006, is the order number always in a field (`Other.OrderNum`), and where does that field sit in the JSON answer? | PKF-038 |
| Q08 | Can you switch on, for our Partner ID, the option that returns the earlier order number on a duplicate booking (B029)? May we use that number to find an order whose booking answer was lost? | PKF-036 |
| Q09 | What is the longest `buyerOrder` that you store, and which characters may it hold? | PKF-032 |
| Q10 | How long must we wait after the PrecisePricing answer before PreciseBooking, so that it is not refused with B005? | PKF-041 |
| Q11 | What counts as churning for B087 (how many bookings and cancellations, over what time), and how long is a passenger then restricted? | PKF-042 |

### Low-cost

| # | Question | Rows |
|---|---|---|
| Q12 | Which field marks low-cost content reliably for each offer: the LCC mark of your airline list, the ContentSource tag of Shopping V10, or another? | PKF-094 |
| Q13 | Does the ContentSource tag THIRD_API mean low-cost content? Where are the tag types and codes of the Tag Information API documented? | PKF-093 |
| Q14 | Do low-cost orders get 13-digit e-ticket numbers, or does `ticketNum` then hold the airline's reference, as in your examples? | PKF-095 |
| Q15 | Can an order hold several airline references, and are they always joined by "\|" in `airPnr`? | PKF-073 |
| Q16 | Can the airline's reference appear in OrderDetail before the order is ISSED, as one of your examples of an issuing order shows? | PKF-069 |

### Currency

| # | Question | Rows |
|---|---|---|
| Q17 | In which currencies will our account quote, and is it always the currency of our wallet? | PKF-017 |

### Offers

| # | Question | Rows |
|---|---|---|
| Q18 | Are the free bags of PrecisePricing and the rules of Penalty the airline's binding conditions, and are they complete for every carrier? | PKF-019 |
| Q19 | What is the time to live of a Shopping answer, and may an offer older than it still be priced? | PKF-021 |
| Q20 | The workflow image shows 30 minutes between search and selection. Is that the Shopping time to live, a limit, or advice? | PKF-110 |

### Wallet and key

| # | Question | Rows |
|---|---|---|
| Q21 | Which authentication mode will our Partner ID have in the sandbox and in production (Legacy, Migration or Signature)? Can we start on Signature V2, and who receives the key link? | PKF-007 |
| Q22 | How is a legacy partner key rotated, and can two keys be valid during the change? | PKF-011 |
| Q23 | Does a sub-buyer get its own Partner ID and key? | PKF-063 |
| Q24 | How often may we call WalletBalance: every five minutes, plus once per checkout? | PKF-061 |
| Q25 | Which balance does Ticketing debit (available, cash, credit, temporary credit or deposit)? Does the debit include the bags and seats booked with the order, and does it always equal the total computed from OrderPricing's answer? | PKF-060 |
| Q26 | Are the sample partner ids and signs in your pages live credentials? | PKF-108 |

### Hosts and speed

| # | Question | Rows |
|---|---|---|
| Q27 | What is the production host, and when will you give it to us? | PKF-003 |
| Q28 | What response times do you target per operation, and what are the rate and concurrency limits behind B035 and B046? | PKF-014 |
| Q29 | How do we register the TicketIssuanceNotify URL for the sandbox and for production? Which push version will our Partner ID get? How often, and for how long, do you retry a push? How can we test pushes in the sandbox? | PKF-083 |
| Q30 | Can a push be authenticated: fixed source addresses, a shared secret or a signature? | PKF-077 |
| Q31 | Does every TicketIssuanceNotify carry the `buyerOrder` that we sent with PreciseBooking? | PKF-081 |

### After-sales

| # | Question | Rows |
|---|---|---|
| Q32 | If the order holds only our company mailbox and number, can the airline still reach the traveller, for example about a schedule change? | PKF-097 |
| Q33 | What is the format of your statement file, and does each line carry your order number and our `buyerOrder`? | PKF-101 |
| Q34 | Does OrderDetail's check-in data carry the booking mailbox's passcode, as your examples show although the schema lists no such field? | PKF-086 |

### Going live

| # | Question | Rows |
|---|---|---|
| Q35 | Which scenarios does the UAT workbook require, and can the sandbox produce each of them? | PKF-106 |
| Q36 | Who travels on the live co-test ticket: may it be a member of our staff? | PKF-107 |
| Q37 | May we certify on the versions of your workflow image of 2024 (Shopping_V4, precisePricing_V6, ancillaryPricing V5, preciseBooking_V5, orderPricing_V4, orderDetail_V9, TicketIssuanceNotify V2) with your written exception, or must we certify on the newest set (Shopping V10, PrecisePricing V12, Penalty V4, AncillaryPricing V7, PreciseBooking V8, OrderPricing V6, OrderDetail V14, TicketIssuanceNotify_V3)? Which Penalty version goes with each set? | PKF-124 |
