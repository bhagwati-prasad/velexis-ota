# Release Note

# August 2026

## Brand Fare & MultiTag Support Enhanced Across Shopping, Pricing, Booking and Order APIs  
*2026/08/13*

:::info Update

**Air ticket shopping APIs**
- json/shoppingV10

**Air ticket pricing APIs**
- json/precisePricing_V12

**Air ticket booking APIs**
- json/preciseBooking_V8

**Ancillary pricing APIs**
- json/ancillaryPricingV7
- json/penaltyV4

**Air ticket order APIs**
- json/orderPricingV6
- json/orderDetail/v14

:::

The APIs have been updated to provide a unified **Brand Fare** and **MultiTag** model across the entire booking workflow. This release introduces standardized request and response fields, replacing legacy product tag parameters while enabling richer product representation and improved compatibility across shopping, pricing, booking, ancillary, and order management APIs.

### What's New

- **Shopping V10**
  - Replaced `tag` with `brandFare`.
  - Replaced `returnTagPrice` with `returnBrandFarePrice`.
  - Added `multiTags` and `returnMultiTagPrice` to request.
  - Added `brandFare` and `multiTags` to response.

- **PrecisePricing V12**
  - Added `brandFare` and `multiTags` to both request and response.
  - Added `returnMultiTagPrice` to request.

- **PreciseBooking V8**
  - Added `brandFare` and `multiTags` to both request and response.

- **AncillaryPricing V7 & Penalty V4**
  - Added `brandFare` and `multiTags` to request.

- **OrderPricing V6 & OrderDetail V14**
  - Added `brandFare` and `multiTags` to response.

### Key Benefits

- **Unified Product Model:** Standardizes Brand Fare and MultiTag support across the complete shopping, pricing, booking, and order lifecycle.
- **Improved Extensibility:** Supports multiple product tags alongside airline branded fares, making it easier to introduce new product types without API redesign.
- **Simplified Integration:** Replaces legacy tag-based fields with a more consistent data model, reducing implementation complexity and improving maintainability.
- **Better Product Representation:** Enables more accurate transmission of airline branded fares and PKFARE-defined product attributes across all APIs.

---
# January 2026

## MiniRules with Time-tiered Fare Rules Supported  
*2026/01/30*

:::info Update  
***JSON APIs:***  
- Shopping V9  
- precisePricing V10  
:::

The APIs have been updated to support more **precisely structured fare rules** through the introduction of **miniRules with time tiers**, enabling clearer and more granular rule definitions.

### Key Benefits:

- **Time-tiered Rule Accuracy:** Fare rules can now be defined and interpreted based on specific time ranges, improving alignment with airline rule logic.  
- **Structured MiniRules Output:** Simplified yet structured rule data makes it easier for downstream systems to parse, display, and apply fare conditions.  
- **Improved Pricing Consistency:** Reduces ambiguity between shopping and pricing stages by using unified, time-aware fare rule definitions.




## Procurement-side End-to-end Change Automation Supported  
*2026/01/13*

:::info Update
***Change APIs:***  
- /json/change/reshop  
- /json/change/reprice  
- /json/change/changeRequest  
- /json/orderDetail/v13  
- ChangeRepricePush  
:::


A new feature has been launched and enhanced to support **end-to-end automation of the change (reissue) process** on the procurement side, covering the full workflow from change shopping to final result notification.

### Key Benefits:

- **End-to-end Change Automation:** Enables a complete automated flow including reshop, reprice, change request submission, and result retrieval.  
- **Real-time & Asynchronous Pricing:** Supports both synchronous pricing responses and asynchronous push notifications to handle complex or delayed repricing scenarios.  
- **Unified Change Result Interaction:** Standardized APIs and push mechanisms allow downstream systems to reliably track and consume change operation results.

---


# April 2025

## Branded Fare & Custom Product Tag Support Launched  
*2025/04/23*

:::info Update 
***Air ticket booking APIs & Ancillary booking APIs:***  
- json/shoppingV8  
- json/pricingV10  
- json/penaltyV3  
- json/ancillaryPricingV6  
- json/bookingV7  
- json/orderPricingV5  
- json/orderdetailV10  
:::

A new feature has been launched across multiple APIs to support differentiated pricing and booking based on various **product tags**, including **PKFARE-defined special product types** and **airline-standard branded fares**.

### Key Benefits:

- **Rich Product Differentiation:** Enables more accurate representation of both airline fare brands and internal product categories tailored by PKFARE.  
- **Smarter Pricing & Booking Logic:** Improved support for upsell and fare rule alignment across all stages from shopping to post-booking.  
- **Unified Access:** Consistent support across all major modules—shopping, pricing, penalty check, ancillary pricing, booking, and order management.

---

## Virtual Interlining Product Support Released  
*2025/04/10*

:::info Update  
***Air ticket booking APIs:***  
-  json/shoppingV7  
-  json/precisePricing_V9  
:::

The APIs have been updated to support one-way Virtual Interlining products that are highly customizable and competitively priced.

Key Benefits:

- **More Flight Combinations:** Provides travelers with more flexible and diverse flight options by combining carriers across traditional boundaries.  
- **Better Fares:** Enables access to more competitively priced flights through Virtual Interlining content, helping reduce overall travel costs.

---

# August 2024

## Enhanced Ticket Issuance Notifications
*2024/08/29*

:::info Update
***Air ticket booking APIs:***
-  `TicketIssuanceNotify_V2`

:::

The API has been updated to provide more detailed information about ticket issuance failures. By incorporating failure reasons, you can now gain a deeper understanding of the underlying causes of ticketing issues.

Key Benefits:

- **Improved Troubleshooting:** Quickly identify the root cause of ticketing failures.
- **Enhanced Error Handling:** Implement effective error recovery strategies.
- **Better Customer Experience:** Provide clear and informative messages to customers about the reasons for ticketing failures.

This enhancement empowers you to proactively address ticketing challenges and maintain a seamless user experience.

---

# July 2024

## Deeper Insights into Schedule Change History
*2024/07/16*

:::info Update
***Air ticket booking APIs:***
-  `json/orderDetail/v8`

:::

The API has been upgraded to provide more granular information on schedule change history. Now, you can access detailed insights, including message IDs and acceptance statuses, for each schedule change event associated with an order.

This enhanced level of detail empowers you to:

- **Troubleshoot issues:** Easily identify the root cause of schedule change problems.
- **Improve decision-making:** Make informed choices based on a comprehensive understanding of schedule change history.
- **Enhance customer service:** Provide accurate and timely information to customers regarding schedule changes.

By leveraging this API, you can gain a deeper understanding of your order history and optimize your operations accordingly.

---

# June 2024

## Take Control of Test Order: Modify Order Status API
*2024/06/02*

:::tip Launch
***Air ticket booking APIs:***
-  [`ModifyOrderStatus`](http://apifox.pkfare.com/apidoc/project-345083/api-3469955)

:::
The API empowers you to manage test orders effectively. With this API, you can easily update the order status of a "Paid, to be issued" flight order to "ISSUED" in the sandbox environment.

This feature provides greater flexibility and control over your flight bookings test, allowing you to streamline processes.

---

# April 2024

## JSON-Powered APIs: Streamlined Integrations
*2024/04/10 & 2024/04/10*
:::info Update
***Flight schedule change APIs:***
- `json/GetScheduleChangeList_V2`
- `json/AcknowledgeScheduleChange_V2`
- `json/AcceptScheduleChange_V2`

***Refund APIs:***
- `json/Refund Pricing_V2`
- `json/CheckRefundPricing_V2`
- `json/RefundRequest_V2`
- `json/CheckRefund_V2`
- `json/CheckReimbursed_V2`
- `json/DownloadAttachmentFile API_V2`
- `json/UploadAttachmentFile API_V2`

***Change APIs :***
- `json/ChangeReshop_V2`
- `json/ChangeRequest_V2`
- `json/ChangePassenger Info_V2`

***Void APIS :***
- `json/VoidRequest_V2`

***Ancillary booking APIs :***
- `json/ancillaryPricingV5`
- `json/ancillaryBookingV2`
- `json/cancelAncillaryOrder`
- `json/ancillaryTicketingV2`
- `json/ancillaryOrderDetail`

:::


Multiple APIs now support JSON for both requesting and responding data. This simplifies integration and data exchange.

---

## Air Ticket Booking APIs: Now Smarter & More User-Friendly
*2024/04/06*

:::info Update
***Air ticket booking APIs:***
-  `precisePricing_V6`
- `json/precisePricing_V6`
- `json/penaltyV2`
- `json/preciseBooking_V5`
- `json/orderPricingV4`
- `json/ticketing`
- `json/cancelOrder`
- `json/OrderDetail/V7`
- `json/requestTicketing`
:::
This update brings several improvements to our air ticket booking APIs, focusing on traceability, data visibility, and user experience.

Here's a breakdown of the key changes:

- **SolutionID**: All APIs now include a solutionId field. This allows developers to track requests and improve troubleshooting.
- **JSON Support**: APIs now support JSON for both requesting and responding data. This simplifies integration and data exchange.
- **Enhanced Functionality**: Specific updates include:
- - `precisePricing_V6`: Now supports checking seat prices.


These updates make the APIs more robust and user-friendly, allowing developers to build more efficient and informative travel booking applications.


---

# February 2024

## Introducing GetScheduleChangeReply
*2024/2/26*

:::tip Launch
***Flight schedule change APIs:***
- [`GetScheduleChangeReply`](http://apifox.pkfare.com/apidoc/project-345083/doc-338123)
:::
This API allows you to receive confirmation results for flight schedule changes that you have previously confirmed. This provides real-time updates on the status of your flight schedule adjustments.

---

## Enhanced Traceability with Solution ID for Key APIs
*2024/02/07 & 2024//02/16*


To improve the traceability and visibility of API requests, we have introduced the "solutionId" field in the following APIs:

:::info Update
***Ancillary booking APIs:***
- `ancillaryPricingV5`

***Air ticket booking APIs:***
- `penaltyV2`
- `PreciseBooking_V5`
:::

By implementing "solutionId" in these APIs, we aim to:

- Improve troubleshooting: Easily track the origin and flow of requests.
- Enhance data analysis: Gain better insights into API usage patterns.
- Provide better support: Offer more efficient and effective customer support.

This update will significantly improve the overall user experience by making API interactions more transparent and manageable.

---

## An Enhanced PrecisePricing API
*2024/02/05*

:::info Update
***Air ticket booking APIs:***
- `PrecisePricing_V5`
:::

This updated parameter allow buyers to get the infomation of availability of ancillary services before they call `Ancillarypricing` API.

---

# January 2024
## Introducing CancelAncillaryOrder API
*2024/01/30*

:::tip Update
***Ancillary booking APIs:***
- [`cancelAncillaryOrder`](http://apifox.pkfare.com/apidoc/project-345083/api-3469933)
:::

**Key Use Case:**

If a passenger decides to change their mind about an ancillary product (e.g., baggage allowance, seat selection) after initially adding it to their booking, this API can be used to cancel the order and avoid unnecessary charges.

**Note:** This API should be used before initiating the ancillary ticketing process.

---

## Power Up Your Bookings: Ancillary Order related APIs
*2024/01/05*

:::tip Launch
***Ancillary booking APIs:***
- [`ancillaryOrderDetail`](http://apifox.pkfare.com/apidoc/project-345083/api-3469936)
:::
:::info Update
***Ancillary booking APIs:***
- `ancillaryBookingV2`
:::

This suite of APIs provides comprehensive support for managing ancillary orders within the PKFARE system.

---