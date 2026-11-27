# Order Status Explanation

# Order status/Item status[For ancillaries]

|Enum|Description|Final state|
|:----|:----|:----|
|ISS_PRC|Ticket is issuing.|No|
|CHG_PRC|Change order is proceeding.|No|
|REFD_PRC|Refund order is proceeding.|No|
|VOID_PRC|Ticket is voiding.|No|
|TO_BE_PAID|To be Paid.|No|
|ISSED|Ticket issued.|**Yes** :warning:|
|TO_BE_RSV|To be reserved.|No|
|UNDER_REVIEW|Under review.|No|
|HOLD|Order is holding manually, please contact customer service for further action.|No|
|RSV_FAIL|Reservation failed|**Yes** :warning:|
|CLOSED|Order closed.|No|
|CNCL|Order Cancelled.|**Yes** :warning:|
|CNCL_TO_BE_REIM|Order Cancelled, and reimbursement is under processing.|No|
|CNCL_REIMED|Order Cancelled, and payment has been reimbused.|**Yes** :warning:|
|CHG_RQ|Change Order is requested.|No|
|CHG_TO_BE_PAID|Change Order is to be paid.|No|
|CHG_REJ|Change Order is rejected.|**Yes** :warning:|
|CHGD|Change Order is changed.|**Yes** :warning:|
|REFD_REJ|Refund Order is rejected.|**Yes** :warning:|
|REFD_TO_BE_REIM|Refunded to be reimbursed.|No|
|REFD_REIMED|Refunded and reimbursed.|**Yes**  :warning:|
|VOID_REJ|Void request is rejected.|**Yes** :warning:|
|VOID_TO_BE_REIM|Void to be reimbursed.|No|
|VOID_REIMED|Void and reimbursed|**Yes** :warning:|
|VOID|Voided|No|




Scenarios :

1. Issued success: TO_BE_PAID > ISS_PRC > ISSED
2. PNR cancelling: TO_BE_PAID > CNCL
3. Issued Failed: TO_BE_PAID > ISS_PRC > CNCL_TO_BE_REIM > CNCL_REIMED
4. Refund Rejected: UNDER_REVIEW > REFD_REJ
5. Refund Success: UNDER_REVIEW > REFD_PRC > REFD_TO_BE_REIM > REFD_REIMED
6. Change Rejected: CHG_RQ > UNDER_REVIEW > CHG_REJ
7. Change Success:CHG_RQ > UNDER_REVIEW > CHG_TO_BE_PAID >  CHG_PRC > CHGD
