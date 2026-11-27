# Recipients list: the template of the dated list

Draft for counsel. Not legal advice. Nothing here is in force.

Part 4 of the [privacy pack](README.md). Plan §4.14 says that Velexis needs a dated list of the recipients of traveller data (the plan's reading, for counsel to confirm). This part is the template of that list. It names no supplier and holds no real value: every value is in square brackets.

The legal name, address, country, privacy contact and agreement date of a row come from the recipient fields that the platform admin will keep per Velexis supplier account (PBE-099, step 2). The disclosure answer of [part 2](disclosure-procedure.md) reads the same fields. PBE-099 keeps only their current values (its step 2), so the earlier values are kept in the dated versions of this list.

## 1. The template

> **Recipients of traveller data under Velexis supply**
>
> List of `[date]`. Version `[n]`. It replaces the list of `[date of the previous version]`.
>
> Velexis: `[legal name]`, `[address]`, `[country]`. Privacy contact: `[privacy contact]`.
>
> This list names the companies to which Velexis passes traveller data when a travel agency that uses Velexis supply books a flight. Velexis does not show on a booking which of them served it; it names it on request (`[where the notice text block says how]`).
>
> | # | Recipient | Kind | Address | Country | Privacy contact | Traveller data received | Purpose | Agreement on traveller data, dated | Safeguard for a transfer | Recipient since | Recipient until |
> |---|---|---|---|---|---|---|---|---|---|---|---|
> | 1 | `[legal name]` | Flight supplier | `[address]` | `[country]` | `[privacy contact]` | `[as in the notice text block]` | `[booking and ticketing the flights]` | `[date]` | `[none needed / the safeguard]` | `[date]` | `[date, or empty]` |
> | 2 | `[legal name]` | Flight supplier | `[address]` | `[country]` | `[privacy contact]` | `[as in the notice text block]` | `[booking and ticketing the flights]` | `[date]` | `[none needed / the safeguard]` | `[date]` | `[date, or empty]` |
> | … | The airline of each booked flight | Airline | — | `[the airline's country]` | `[the airline's own privacy notice]` | `[as above]` | `[flying and ticketing the traveller]` | — | `[the safeguard]` | — | — |
>
> **Changes**
>
> | Date | Change | Recorded by |
> |---|---|---|
> | `[date]` | `[recipient added, removed, or a field changed]` | `[name of the platform admin]` |

## 2. How the list is kept (draft)

- One row per supplier that receives traveller data through a Velexis supplier account: Amadeus Enterprise and PKFare (ADR-0030 items 3, 5 and 10). Velexis's Amadeus account has one row per environment, test and live ([ADR-0012](../adr/0012-amadeus-account-model.md)), and PBE-099 keeps the recipient fields per account. `[Counsel or the owner to state whether a test account is listed.]`
- A new version, with a new date, each time a Velexis supplier account starts or stops receiving traveller data, or one of its recipient fields changes. Earlier versions are kept unchanged.
- The list never holds a supply id. The link between a supply id and a supplier stays in the id history of the platform ([PADR-0020](../../../platform/docs/adr/0020-supplier-registry-switches-and-suppliers-page.md) item 5), so the list does not undo the hidden supplier.
- An OTA's own supplier accounts are not on the list. As the lead reads counsel's relayed answer, the OTA takes the controller role there (ADR-0030 question 4); those accounts come after the launch, in M8.
- `[Counsel to state who keeps the list, where, who may see it, and how long its versions are kept.]`

## 3. Notes for counsel

- **Whether the list is needed.** The plan reads the law as asking for it (plan §4.14; the plan's reading, for counsel to confirm). Counsel's relayed answer does not mention it, and ADR-0030 question 19 does not ask about it; [part 1](questions.md) asks as question 19e.
- **Other recipients.** Velexis's own service providers (hosting, e-mail, card payments) are outside this pack. Should the list name them too?
- **The airline row.** Each booking also reaches an airline, which differs per booking. Is one row for "the airline of each booked flight" enough?
- **Who sees it.** If OTAs or travellers see the list, they learn which suppliers Velexis uses, though not which one served a booking. Is that acceptable under the owner's decision that an OTA is not shown which supplier Velexis uses ([`decisions.md`](../decisions.md) §2)?
