# Notice text block: flight suppliers that Velexis does not name

Draft for counsel. Not legal advice. Nothing here is in force.

Part 3 of the [privacy pack](README.md). It drafts the notice text that tells a reader that Velexis passes traveller data to flight suppliers it does not name, and names one on request. [ADR-0030](../adr/0030-suppliers-supply-sources-and-ingestion-engine.md) question 19 calls it "the traveller notice".

**Where the approved text goes.** PBE-100 puts counsel's approved text, word for word, into the portal's legal pages (`LEGAL_STRINGS`), which PFE-031 publishes. The plan's "portal documents" is read as those pages (PBE-100, step 5; Proposed (lead)). This draft goes into no page. PBE-100 does not start before the owner hands over the approved text with its date (its step 1).

## 1. The draft

Text in square brackets is for counsel to choose or fill in. The facts behind each sentence are in [part 1](questions.md) §2.

> **Flight suppliers**
>
> When you book a flight with a travel agency that uses Velexis supply, Velexis buys the flight from a flight supplier and supplies it to the travel agency. A flight supplier is a company that sells airline seats and tickets to travel sellers and passes each booking to the airline. `[Counsel to state Velexis's role for this processing (question 19b).]`
>
> To book the flight, Velexis passes these data to the flight supplier, which passes them to the airline:
>
> - each traveller's names, date of birth, gender and nationality;
> - each traveller's travel documents, such as a passport or a visa, with the details they hold, where the airline needs them;
> - frequent flyer numbers, discount cards, an emergency contact and special requests, where you give them;
> - `[the contact details you give at booking / for some suppliers, Velexis's own contact details instead of yours]`;
> - the flights, fares, bags and seats booked, and the booking's references.
>
> `[If you pay the airline by card through the travel agency: your card details go to the airline through the flight supplier for that payment only, and Velexis does not keep them.]` No other payment card details are passed to a flight supplier.
>
> Velexis does not show the name of the flight supplier on the booking. It names it on request: the supplier's legal name, country and privacy contact at the date of the booking. `[Counsel to state who may ask and how: the travel agency's owner or admin, on the Suppliers page of the Velexis portal; and a traveller, through the travel agency or by writing to [privacy contact of Velexis].]` Velexis answers within `[three working days]`.
>
> Velexis keeps a dated list of the flight suppliers it uses. `[Counsel to state who may see it.]`
>
> `[Counsel to state, where a supplier is outside [region]: the country and the safeguard for the transfer.]`
>
> `[Counsel to state how long the supplier keeps the data, or where to find it.]`

## 2. Notes for counsel

- **The reader.** The portal's legal pages are read by the people who run OTAs, not by travellers. A traveller reads the OTA's own storefront. Does the OTA's own notice to its travellers need a matching block, and who gives the OTA its text?
- **The words "travel agency".** The draft says "travel agency" for an OTA, which is the word a traveller knows.
- **The contacts line.** On PKFare, every contact e-mail and phone number Velexis sends is Velexis's own (plan §3, A35, the plan's assumption, proposed). On Amadeus, the contacts are the traveller's (part 1 §2.4 and §2.5). Choose one line, or keep both.
- **The card line.** It holds only for the airline-card payment, which Amadeus supports and PKFare does not (part 1 §2.4).
- **The name on request.** The sentence follows the owner's decision (ADR-0030 item 9) and the draft procedure of [part 2](disclosure-procedure.md). It changes if counsel changes the procedure.
- **The dated list.** The sentence refers to [part 4](recipients-list.md). Drop it if counsel does not want the list.
