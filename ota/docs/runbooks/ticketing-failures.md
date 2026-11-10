# Runbook: ticketing failures and airline-card bookings in manual review

For bookings that have an order but no tickets: the ticketing job that gave up, issuances that keep failing, and airline-card bookings in manual review (the airline-card order came back without every ticket, or its outcome is unknown). The behaviour behind it is [OADR-0008](../adr/0008-ticketing-policy.md), the [ticketing flow](../flows/ticketing-and-documents.md) (§3 steps 2 to 4 and §4) and, for the airline card, [OADR-0004](../adr/0004-airline-card-data-handling.md) and the [airline-card flow](../flows/checkout-airline-card.md#4-failure-handling); the console's actions are those of the [console flow](../flows/console-operations.md) §3 step 8. The levels of the escalation are those of the [runbooks README](README.md#3-escalation).

## 1. What the system does by itself

- **The first attempt** is made inside the completion request (`issue_after_payment`, the default policy) or by the order itself (`issue_at_booking`, airline card, `instantTicketingRequired`). A failure sets `ticketing_status = failed`.
- **Retries** (worker, `ticketing.scan` every 5 minutes, `ota-ticketing`): 5 minutes, 15 minutes and 1 hour after the failures of attempts 1 to 3, then every 2 hours, at most 8 attempts, never later than the ticketing deadline less 2 hours. Every attempt reads the order first (Flight Order Management GET), so tickets that a timed-out earlier call issued are recorded instead of issued twice. A failure for payment reasons (`PAYMENT_DECLINED`) is never retried. A booking whose cancellation is under way is skipped (`cancellation_pending`) and stays due.
- **Giving up**: when no retry is possible the booking keeps `ticketing_status = failed` without a next attempt, the staff get `staff.ticketing_failed` and the traveller `booking.ticketing_delayed`, once per booking. The worker never cancels.
- **Airline-card bookings are never retried by the job**: the card exists only for the one request ([OADR-0004](../adr/0004-airline-card-data-handling.md)), so an order that came back without every ticket goes to `ticketing_status = manual_review` with a staff alert, and the completion answers `201` with the warning `TICKETING_MANUAL_REVIEW`.
- **Booking sync** (every 10 minutes for due bookings) records tickets issued outside Velexis and a cancellation by the airline (the airline's time limit cancels an unticketed PNR at its deadline).

## 2. Signals

| Signal | Where | Means |
|---|---|---|
| "[Action needed] Ticketing failed for booking <reference>" (`staff.ticketing_failed`) | E-mail to the OTA's alert address (else its owners, else Velexis ops) | The job gave up on one booking |
| "[Action needed] Booking <reference> needs a review" (`staff.manual_review`) | Same | An airline-card order without every ticket; a capture that failed after the order (ticketing `manual_review` too, [`stripe-incidents.md`](stripe-incidents.md)) |
| `bookings.ticketing_given_up` (level 50, `code`, `reason`, `attempt`); `bookings.ticketing_retry_scheduled` (`nextAttemptAt`); `bookings.ticketing_job_failed`, `bookings.ticketing_resync_failed`, `bookings.ticketing_issue_unreadable`, `bookings.ticketing_skipped` (`cancellation_pending`) | Journal of `velexis-ota-worker` | Each attempt's outcome, the give-up, a job that failed as a whole |
| `bookings.issue_failed` (`code`) | Journal of `velexis-ota-api` (the completion) and of the worker (an issuance after a reconciliation found the order) | The issuance right after the order failed; the job takes over |
| The worker's `queues["ota-ticketing"]` (and `queues["ota-maintenance"]`, where `ticketing.scan` runs): `failedLastHour`, `oldestWaitingSeconds` | `curl -s http://127.0.0.1:4001/health/ready \| jq '.queues \| {"ota-ticketing", "ota-maintenance"}'`; e-mails `failed-jobs-velexis-ota-worker`, `queue-age-velexis-ota-worker`; the platform admin's `/queues/ota-ticketing` (failed jobs and their reasons) | Ticketing jobs failing or not running |
| Dashboard "Ticketing failed or in manual review", "Ticketing deadline within 24 h"; saved views Ticketing problems (`ticketingStatus=failed,manual_review`), Deadline within 24 h, To issue | OTA admin | The bookings to act on, the most urgent by deadline |
| Booking page banners: the ticketing reason and the deadline with Issue highlighted; "The airline card cannot be charged again: issue with another form of payment or cancel"; the timeline's `booking.ticketing_failed` and `booking.ticketing_manual_review` (the error code) | OTA admin, `/bookings/<bkg_…>` | One booking: why, until when |
| `/supplier-log?bookingId=<bkg_…>`: the issue calls with their Amadeus error codes (9112, 4926, …) | OTA admin | What the airline or Amadeus answered |

## 3. First checks

1. **One booking or many?** Many bookings failing with the same code or timing out at once point to Amadeus ([`supplier-timeout-and-reconciliation.md`](supplier-timeout-and-reconciliation.md)), to one office (its ticketing rights or its form of payment with the airline), or to the worker. Velexis ops count the outcomes of the day:

   ```bash
   journalctl -u velexis-ota-worker --since today -o cat \
     | jq -rR 'fromjson? | select(.msg == "bookings.ticketing_given_up" or .msg == "bookings.ticketing_retry_scheduled") | [.msg, .tenantId, .code] | @tsv' | sort | uniq -c | sort -rn
   ```

2. **Is the job running?** `ota-maintenance` (where `ticketing.scan` runs every 5 minutes) and `ota-ticketing` (the `ticketing.issue` jobs it queues) in the worker's readiness have a small `oldestWaitingSeconds` (or `null`), no `jobs.job_failed` line names `jobName: "ticketing.scan"`, and `systemctl status velexis-ota-worker` is `active`. A worker that was down retries from `ticketing_next_attempt_at` when it starts; nothing is lost.
3. **What did the airline say?** On the booking page, the reason of the newest `booking.ticketing_failed` and the supplier log's issue call. Typical codes: `TICKETING_FAILED` (Amadeus 9112, the airline refused to issue), `SUPPLIER_REJECTED` (4926 and other refusals, often data), `PAYMENT_DECLINED` (the form of payment), a timeout (the order may have been issued: the next attempt's read finds out).

## 4. What to do

### 4.1 Ticketing given up (Stripe payment or no payment)

On the booking's page, in this order:

1. **Resync** (`bookings:write`): it reads the order. Tickets issued meanwhile (a timed-out call that did issue, the airline, an agent in the terminal) are recorded and the booking becomes `ticketed`; nothing more to do.
2. **Issue** (`bookings:issue`): it captures an authorised Stripe payment first, reads the order again, then sends Flight Order Issue once. The dialog says what the issuance takes. Answers:
   - `402 PAYMENT_DECLINED` on the capture: the authorisation expired or was voided ("The authorisation has expired; contact the traveller"). The traveller pays again outside this booking, or the booking is cancelled.
   - The same airline refusal again: fix what the airline asks for (a traveller's data with Patch, the ticketing agreement), or ask the airline through the Amadeus helpdesk; then Issue again.
   - `409 BOOKING_NOT_MODIFIABLE` with `cancellation_pending` or `ticketing_in_progress`: a cancellation or another issuance holds the booking; wait for it (5 minutes at most for a claim) and reload.
   - Issue not offered with `deadline_passed`: the ticketing deadline is over and the airline will cancel the unticketed PNR at its time limit; the booking sync then records `cancelled_by = airline`. Contact the airline if the traveller must still fly.
3. **Or cancel** (`bookings:cancel`) with the refund that fits: an authorisation is voided or split, a capture refunded through Stripe. Tell the traveller.

Add a note with what was done. A `PAYMENT_DECLINED` ticketing error on **every** booking of an office means the office's form of payment with the airlines (`ACCOUNT`) is refused: escalate (§5).

### 4.2 Issuances failing for many bookings

- Amadeus timeouts or `5xx`: the [supplier runbook](supplier-timeout-and-reconciliation.md); the retries go on by themselves and stop at the deadline less 2 hours, so check the Deadline within 24 h view after the outage and issue what is left by hand.
- One office, one code (no ticketing rights, the form of payment refused): Velexis ops for a shared office, the OTA for its own credentials, with Amadeus support.
- The worker down or the ticketing queue failing as a whole (`bookings.ticketing_job_failed`, the platform admin's `/queues/ota-ticketing`): Velexis ops restart the worker (`sudo systemctl restart velexis-ota-worker`) and read the failed jobs' reasons; a code problem is a bug report with the reasons and booking ids.

### 4.3 Airline-card booking in manual review: an order without every ticket

The booking is `confirmed` with ticketing `manual_review`, its payment (`airline_card`) `processing`, and the banner "The airline card cannot be charged again: issue with another form of payment or cancel". The airline may or may not have charged the card; Velexis does not know, and the card is gone.

1. **Never ask for the card again.** No Velexis screen takes a card number, and none may be sent by e-mail, chat or phone to anyone ([OADR-0018](../adr/0018-ota-admin-consumes-the-sdk-server-side.md) point 8, [incident response plan §4.3](../pci/incident-response.md#43-card-data-found-where-it-must-not-be-12107)).
2. **Resync.** The airline may have issued the tickets after the answer: then the booking is `ticketed`. Its payment stays `processing` in Velexis (nothing but the completion and the reconciliation records an airline's charge), so the OTA's agent confirms the charge with the airline and adds a note.
3. **Still no tickets: decide with the airline** (the OTA's agent, or the Amadeus helpdesk) whether the card was charged.
   - **Issue** with the OTA's own settlement with the airline: the Issue dialog offers only `other` forms of payment, `CASH` or `ACCOUNT`. When the payment is not `captured` (the airline did not charge the card), the booking counts as unpaid and only an owner or an admin may issue it, with `allowUnpaid`; the OTA then collects the fare from the traveller itself.
   - **Or cancel**: the airline refunds whatever it charged to the card. The OTA admin never refunds an airline-card payment (`422 refund_via_airline`).
4. Tell the traveller and add a note.

An airline-card booking whose **outcome is unknown** and whose order the reconciliation did not find stays `pending` in the Reconciliation review view (`reason: airline_card_not_found`): that is the [supplier runbook §4.3](supplier-timeout-and-reconciliation.md#43-bookings-the-reconciliation-handed-to-the-staff).

**Live airline-card payments are off** (`AIRLINE_CARD_ENABLED=false`) until the [go-live gate](airline-card-go-live.md) is checked, so in production this section applies to the test environment until then. Repeated declines, the airline-card alerts (`staff.airline_card_alert`, `payments.airline_card_suspended`) and anything that looks like card testing are the [incident response plan §4.4](../pci/incident-response.md#44-a-card-testing-attack).

### 4.4 Bookings near their deadline

The Deadline within 24 h view, every working day: a booking still `confirmed` there is issued by hand (§4.1) or cancelled before the airline's time limit. The job stops retrying 2 hours before the deadline.

## 5. Escalation

| When | Who acts | Escalates to |
|---|---|---|
| One booking given up | The OTA's staff (§4.1) | The airline through the Amadeus helpdesk for a refusal they cannot fix; Velexis ops when the console answers an error its message does not explain (with the request id) |
| An airline-card booking in manual review (§4.3) | The OTA's owner or admin (issue unpaid), with the airline | Velexis ops if the airline reports a charge that no booking holds |
| Many bookings failing, one office or one code (§4.2) | Velexis ops (shared offices) or the OTA (own credentials) | Amadeus support with the office id and a failed call's `correlationId` |
| The ticketing queue not running or failing as a whole | Velexis ops | A bug report with the job reasons and booking ids; the product owner if tickets will miss deadlines |
| Tickets will miss their deadline for many travellers | Velexis ops | The product owner, who decides on messages to the OTAs |

## 6. After the incident

Check that the Ticketing problems and Deadline within 24 h views hold only bookings with a note and an owner, and record the bookings handled (ids only) with their outcome.
