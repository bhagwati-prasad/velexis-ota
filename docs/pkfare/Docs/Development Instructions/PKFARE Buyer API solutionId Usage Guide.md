# PKFARE Buyer API solutionId Usage Guide

# PKFARE Buyer API solutionId Usage Guide

Version: 1.0  
Last updated: 2026-05-19  
Applicable APIs: `Shopping`, `PrecisePricing_V11` (`/json/precisePricing_V11`), `PreciseBooking_V7` (`/json/preciseBooking_V7`)

## 1. Purpose

This guide explains how buyer-side systems should use `solutionId` across Shopping, PrecisePricing, and PreciseBooking.

The objective is to ensure that buyers call Pricing and Booking APIs in the correct sequence, preserve the correct solution context, and use direct pricing only as an appropriate fallback mechanism.


## 2. Core Principle

`solutionId` is the unique identifier of a specific flight solution. It should be treated as an opaque, immutable value. Buyers should not parse, shorten, decode, rewrite, or reuse it outside the API flow for which it was returned.

The standard API flow is:

```text
Shopping -> PrecisePricing -> PreciseBooking
```

In this flow:

1. Shopping returns available flight solutions and their corresponding `solutionId`.
2. PrecisePricing uses the selected Shopping `solutionId` together with the same itinerary details to verify the real-time price and availability.
3. PreciseBooking uses the `solutionId` returned by the successful PrecisePricing response to create the order.

Booking should not be called directly from a Shopping result without a successful PrecisePricing call.

## 3. Standard Usage Flow

### 3.1 Shopping

When a buyer receives a Shopping response, the buyer should store the complete selected solution context, including:

| Field | Usage |
| --- | --- |
| `solutionId` | Identifies the selected Shopping solution. |
| `solutionKey` | Recommended for data quality monitoring and issue tracing. |
| `journeys` / segment details | Must be reused consistently in Pricing. |
| `bookingCode` | Should be preserved for normal Pricing to improve price stability and pricing success rate. |
| `tag` | Product tag, if returned or selected for a tagged product. |
| passenger counts | Adult, child, and infant counts must remain consistent through Pricing and Booking. |

The buyer should store `solutionId` as a complete string. Some `solutionId` values may contain special characters such as `+`, `/`, or `=`, so the value must not be truncated or transformed.

### 3.2 PrecisePricing

For normal Pricing, the buyer should call PrecisePricing using the selected Shopping `solutionId`.

The Pricing request should preserve the same itinerary details from the selected Shopping solution:

| Field group | Requirement |
| --- | --- |
| `solutionId` | Use the selected Shopping solution's `solutionId`. |
| `journeys` | Use the same journey order and segment sequence. |
| segment details | Preserve airline, flight number, departure, arrival, departure date/time, arrival date/time. |
| `bookingCode` | Preserve the Shopping `bookingCode` where available. |
| `solutionKey` | Recommended for monitoring and troubleshooting. |
| `tag` | Use only valid PKFARE-defined product tags when applicable. |

Buyers should not manually modify or rebuild segment details. The Pricing request should be generated from the selected Shopping solution data.

If both `cabin` and `bookingCode` are provided and they are not inconsistent, PrecisePricing uses `bookingCode` as the pricing basis. Therefore, for normal Shopping-based Pricing, preserving `bookingCode` is recommended.

### 3.3 PreciseBooking

PreciseBooking must be called after a successful PrecisePricing response.

For Booking:

| Field | Requirement |
| --- | --- |
| `booking.solution.solutionId` | Use the `solutionId` returned by the successful PrecisePricing response. |
| `booking.solution.journeys` | Use the journey and segment details aligned with the successful Pricing result. |
| fares and taxes | Use the latest successful Pricing result. |
| passenger count and type | Must match the Pricing request and result. |

Each Booking-stage `solutionId` should only be used once during the booking process. If the Booking attempt fails or the user changes itinerary, passenger count, product, or ancillary selection, the buyer should perform PrecisePricing again and use the newly returned Pricing result for Booking.

PreciseBooking must be invoked within 30 minutes after PrecisePricing. As a best practice, buyers should avoid waiting until the 30-minute boundary. If the Pricing result is old, or the route is highly availability-sensitive, buyers should re-price before Booking.

## 4. Direct Pricing Usage

Direct pricing should not be used as the default integration flow. It should be used only as a fallback when the original Shopping-based solution is no longer available, or when PKFARE has explicitly confirmed that the buyer's use case should call direct pricing.

Typical fallback scenarios include:

| Scenario | Recommended action |
| --- | --- |
| `B020` - no price found for the selected flight option | Retry with direct pricing fallback if the buyer still wants alternatives for the same itinerary. |
| `B021` - selected booking code has no seats available | Retry with direct pricing fallback if the buyer accepts alternative booking codes or prices. |

The direct pricing trigger depends on the PrecisePricing API version:

| PrecisePricing version | Direct pricing trigger |
| --- | --- |
| `PrecisePricing_V5` and earlier | Send the Pricing request with an empty `bookingCode`. |
| `PrecisePricing_V6` and later | Set `solutionId` to `direct pricing`. |

For `PrecisePricing_V6` and later versions, buyers should not use `solutionId = 000` as the direct pricing trigger. The correct trigger value is `direct pricing`.

Important notes:

1. Direct pricing may return a different `bookingCode`, price, product tag, or fare condition.
2. A direct pricing result should be treated as a new offer, not the same offer as the original Shopping solution.
3. The buyer should present the updated price and conditions to the customer before Booking.
4. If the buyer proceeds to Booking, the Booking request must use the `solutionId` returned by the successful direct Pricing response.
5. Buyers should avoid repeated blind direct-pricing retries for the same failed request.

## 5. Buyer-Side Implementation Checklist

Before calling PrecisePricing:

- Confirm the selected `solutionId` comes from the current Shopping response.
- Confirm the full journey and segment details are taken from the same selected solution.
- Preserve `bookingCode` for normal Pricing.
- Preserve `solutionKey` where available.
- Do not modify segment order, date/time, route, airline, or flight number.

Before calling PreciseBooking:

- Confirm PrecisePricing returned `errorCode = 0`.
- Use the `solutionId` returned by the successful PrecisePricing response.
- Confirm passenger count and passenger type are unchanged from Pricing.
- Confirm the latest price has been accepted by the customer if price changed.
- Confirm the Pricing result is still within the valid time window.
- Do not reuse a Booking-stage `solutionId` that has already been used.

For fallback handling:

- Use direct pricing only when standard Pricing cannot return the selected offer and the buyer accepts alternatives.
- Trigger direct pricing according to the PrecisePricing API version: empty `bookingCode` for V5 and earlier, `solutionId = direct pricing` for V6 and later.
- Treat direct-pricing output as a new offer.
- Reconfirm price, booking code, product tag, baggage, and fare conditions before Booking.
- Use the new `solutionId` returned by direct Pricing for Booking.

## 6. Recommended Buyer-Side Controls

To maximize API efficiency and reduce avoidable failures, buyers are recommended to implement the following controls:

| Control | Recommendation |
| --- | --- |
| Data persistence | Store the complete selected Shopping solution, not only display fields. |
| Request generation | Generate Pricing and Booking requests from API response objects, not from manually rebuilt UI data. |
| Validity timer | Start a timer after successful Pricing and re-price before the 30-minute limit. |
| Idempotency control | Prevent duplicate Booking attempts with the same Pricing `solutionId`. |
| Error routing | Route solution-related errors according to the separate error handling guide. |
| Logging | Log `solutionId`, `solutionKey`, journey details, passenger counts, API stage, timestamp, and error code for troubleshooting. |

## 7. Summary

The best-practice flow is:

```text
Shopping selected solution
  -> PrecisePricing with the same solutionId, journey details, and bookingCode
  -> Use successful Pricing response as the source of truth
  -> PreciseBooking within the valid Pricing window
```

Buyers should preserve `solutionId` consistency across the flow, use the latest PrecisePricing result for Booking, avoid reusing stale or consumed IDs, and reserve direct pricing for controlled fallback scenarios.

Following this approach helps maintain offer continuity, improve Pricing and Booking success rates, and reduce customer-experience issues caused by uncontrolled direct-pricing results.
