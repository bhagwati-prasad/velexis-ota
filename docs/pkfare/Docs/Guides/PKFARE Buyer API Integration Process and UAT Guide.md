# PKFARE Buyer API Integration Process and UAT Guide

## 1. Purpose

This document summarizes the overall process for a buyer to integrate with the PKFARE API and explains how to complete and submit the UAT file. The UAT file is attached to this guide for the buyer to download, complete, and return to PKFARE for certification.

[Download the PKFARE Pre-booking UAT file](https://docs.google.com/spreadsheets/d/1Im3QIWZD01C9pHaOswV5wFAUwTpXqYM5hKHzblVk9mE/edit?usp=sharing)

This document only summarizes the business information in the source materials. Operational instructions contained in the attachments are treated as integration and UAT requirements. They do not authorize any production configuration or order operation.

## 2. Integration Process Overview

| Stage | Main Tasks | Recommended Duration |
| --- | --- | ---: |
| 1. Review API documents | Review the API documentation and conduct Q&A by email, Slack, Skype, or WeChat | 2-3 days |
| 2. Kick-off meeting | Review the buyer's interface; introduce the APIs and integration tools; propose the API solution; conduct Q&A | 1 day |
| 3. API development | Develop the Shopping-to-ticketing flow, Ancillary APIs, and Post-booking APIs; resolve integration questions through the API documentation or Zendesk | 2-5 weeks |
| 4. Sandbox Co-test / UAT | Download and complete the attached UAT file; complete successful Sandbox bookings for the required scenarios; submit the completed file to PKFARE for certification; resolve test issues | 1-3 days |
| 5. Production Co-test | Top up the account and complete a test booking; issue a round-trip ticket; complete CS Portal training; confirm the financial statement | 1-3 days |
| 6. Go-live | The buyer prepares the target markets, airlines, and ODs; PKFARE configures suppliers and resources | 1-2 days |

## 3. Stage Activities, Responsibilities, and Deliverables

### 3.1 API Document Review

Buyer responsibilities:

- Review the PKFARE API documentation.
- Consolidate questions about interfaces, fields, authentication, error handling, and business flows.
- Complete Q&A through the communication channels agreed by both parties.

Deliverables:

- Documentation questions are clarified.
- The buyer is ready to discuss the integration solution.

### 3.2 Kick-off Meeting

Both parties jointly:

- Review the buyer's existing interface and business process.
- Introduce the PKFARE APIs and integration tools.
- Confirm the API integration solution and business workflow.
- Confirm the scope, scenarios, and open actions.

Deliverables:

- Confirmed integration scope covering the main booking flow, Ancillary APIs, and Post-booking APIs.
- Confirmed API integration scope for the buyer's actual business scenarios.

### 3.3 API Development

The development scope has three parts:

1. Shopping to ticketing: shopping, precise pricing, booking, order payment/ticketing, and order details.
2. Ancillary services: baggage and seat services as required by the business.
3. Post-booking: cancellation of unpaid orders or orders affected by payment failure, plus other agreed post-booking capabilities.

Unless PKFARE confirms a specific exception, the buyer must integrate with the latest API version currently published by PKFARE.

Deliverables:

- The buyer's system can execute an end-to-end flow in the Sandbox environment.
- The buyer can explain which PKFARE API is triggered by each business action.
- The project is ready for Sandbox Co-test / UAT.

### 3.4 API Integration Issue Handling

When the buyer encounters an API integration question or error:

1. Review the relevant PKFARE API documentation first, including the endpoint, API version, request fields, response fields, error codes, and workflow notes.
2. If the topic is covered by the API documentation, follow the documented requirement and retest the request.
3. If the topic is not mentioned in the API documentation, or the documented behavior does not explain the actual result, submit a support ticket through Zendesk for PKFARE to investigate.
4. Include sufficient evidence in the Zendesk ticket:
   - API name, version, endpoint, and environment.
   - Request timestamp and timezone.
   - `requestId`, `traceId`, session ID, or order number, when available.
   - Sanitized request and response payloads.
   - Original error code and error message.
   - Expected result, actual result, and reproducible steps.

Do not include passwords, API keys, access tokens, payment information, or unnecessary passenger personal information in a Zendesk ticket.

### 3.5 Sandbox Co-test / UAT

Important information from the UAT file:

- Sandbox content is limited and is used only to test API functionality.
- Recommended airlines for testing are `AK`, `UO`, and `TG`.
- Production testing can begin after Sandbox certification is completed.
- The order number for each successful scenario must be provided for certification.

Required tasks for this stage:

1. Download the UAT file attached to this guide.
2. Complete the Sandbox tests defined in the UAT file.
3. Complete the UAT file with the test results, including `Order Number`, `AirPNR`, and `Ticket Number`.
4. Submit the completed UAT file to PKFARE for certification.
5. Provide additional information or resolve failed scenarios based on PKFARE's certification feedback.

Deliverables:

- Successful orders covering the agreed passenger combinations, trip types, and ancillary scenarios.
- Completed `Order Number`, `AirPNR`, and `Ticket Number` fields.
- The completed UAT file is submitted to PKFARE.
- PKFARE confirms Sandbox UAT certification.

### 3.6 Production Co-test

The roadmap requires the following activities:

1. Top up the account and complete a test booking.
2. Issue a round-trip ticket.
3. Complete CS Portal training.
4. Confirm the financial statement.

The UAT file explicitly states: `A live co-test is Required`.

Deliverables:

- The specified Production scenario is completed.
- The order, airline PNR, and ticket number are confirmed.
- Customer service and financial workflows are confirmed.

### 3.7 Go-live

Buyer responsibilities:

- Prepare the target markets, airlines, and ODs for traffic enablement.

PKFARE responsibilities:

- Configure suppliers and resources.

Deliverables:

- The go-live scope and resource configuration are confirmed.
- API traffic is enabled according to the scope agreed by both parties.

## 4. UAT File

The attached UAT workbook is the reference for the test scenarios, required fields, and business-flow information that the buyer must provide. These details are not repeated in this guide.

The buyer must download the workbook, follow the instructions in the file, complete the required fields, and submit the completed workbook to PKFARE for certification. Do not change the template structure or the predefined test content.

[Download the PKFARE Pre-booking UAT file](https://docs.google.com/spreadsheets/d/1Im3QIWZD01C9pHaOswV5wFAUwTpXqYM5hKHzblVk9mE/edit?usp=sharing)

## 5. Recommended UAT Execution and Result Submission

1. Download the attached UAT workbook and complete the tests exactly as instructed in the file.
2. Use a separate test order for each scenario where applicable. Do not reuse an expired Offer, Pricing Session, or Booking Session.
3. Complete all required customer-input and result fields without changing the workbook structure or predefined test content.
4. Retain the `requestId`, `traceId`, order number, and timestamp for each test request so that PKFARE can investigate any issue.
5. For a failed test, record the failure stage, API name/version, error code, original error message, and whether the request can be retried. Follow the API documentation and Zendesk process described in Section 3.4.
6. Submit the completed UAT workbook to PKFARE for certification. Arrange the Production live co-test only after certification is confirmed.

## 6. Recommended Acceptance Criteria

| Check | Recommended Acceptance Criteria |
| --- | --- |
| UAT completion | All required tests and fields in the attached UAT workbook are completed without changing the template structure |
| Result evidence | Submitted results can be verified using the provided order references and technical identifiers |
| Issue handling | Failed tests include sufficient evidence and follow the API documentation and Zendesk support process |
| UAT submission and certification | The completed UAT file has been submitted to PKFARE and Sandbox UAT certification has been confirmed |
| Production co-test | The required Production test, ticket issuance, CS Portal training, and financial confirmation are completed |
| Go-live readiness | The buyer confirms the markets, airlines, and ODs; PKFARE confirms the supplier and resource configuration |
