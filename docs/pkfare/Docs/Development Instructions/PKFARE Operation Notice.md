# PKFARE Operation Notice


# **1. PKFARE Operation Schedule**


||||
|:-- | :-- |:-- |
|**Type** |**Service Time** |**Tips** |
|Ticketing |7*24 | |
|Email Consult Channel |7*24 |aftersale@pkfare.com |
|Online Chat Service<br>(Air Ticket Consultation) |7*24 | |
|Online Chat Service<br>(Complaint and Suggestion) |Mon-Fri, 10:00-19:00, UTC+8 |Excluding official holidays |
|Reissue/Refund |09:00-00:30, UTC+8 | |

 
# **2. Escalation Matrix**

You can escalate the particular cases or any other operational questions to your operation manager (PIC) and cc [cs.coreteam@pkfare.com](https://qiye.aliyun.com/alimail/http:). We're glad to assist. 

| ||
|:--|:--|
|**Type** |**Email Adress** |
|Level 1 |cs.coreteam@pkfare.com |
|Level 2 |Zijun.chen@pkfare.com<br>cc cs.coreteam@pkfare.com|
||Yuki.zhang@pkfare.com<br>cc cs.coreteam@pkfare.com 
||Michelle.gong@pkfare.com<br>cc cs.coreteam@pkfare.com 
|Level 3 |Joe.wang@pkfare.com<br>cc cs.coreteam@pkfare.com |

 
# **3. PKFARE Portal**

To help you get a better understanding of the PKFARE portal, operational procedure, and related details, we hereby attach the following materials for your reference.
 
## **1) PKFARE Portal Guideline**

This document will guide you on how to use our Portal and provide a detailed introduction of each business scenario. Please check the link here: https://drive.google.com/file/d/18uPmPqsft9yBDoKGU4YKNBDQMzt_K2bm/view?usp=sharing
 
## **2) Video of  PKFARE Portal**

This video will provide a more intuitive demonstration of how to submit post-service requests on our portal. Please check the link here: https://drive.google.com/file/d/18o_6Q5Zm04ct4NtEtLBHF_fnILGh5Q23/view?usp=drive_link . 
 
**Training Contents**
(1) Introduction: 00:00 - 02:03
(2) Order Management: 02:03 - 03:44
(3) Ticket Change + Change Passenger Info: 03:44 - 09:50
(4) Ticket Refund: 09:50 - 15:14
(5) Ticket Void: 15:14 - 17:23
(6) Create Sub-user: 17:23 - End
 


## PKFARE Email Configuration


There will be email notifications sent out to inform you of the change in order status, schedule changes, check-in information, etc. Most of the email notifications are sent by the system automatically and generally, the email contacts in the booking will be the recipients. We also support the configuration of specific mailboxes as the recipients in some scenarios. 
 
## 1) Email Interaction Summary

 


- ### **Email Interaction Scenario**


Please kindly find the "PKFARE GBP Email Interaction Summary" spreadsheet below for your reference. The configuration-available scenarios are highlighted in green.

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338125/image-preview)

- ### **Mail Notification Recipients**


> **For non-configurable scenarios**:


- The email used when the original booking is generated via API will be the recipient. To avoid unnecessary misunderstandings, we strongly recommend you not transfer the passenger's personal email to the original booking through API.


- However, when you submit an after-sales order on the PKFARE portal platform, you can change the email information in the order. The system supports entering multiple emails separated by semicolons.


![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338126/image-preview)


>  **For configurable scenarios**:


- You can configure different email addresses as recipients for different scenarios.


- Except for the "Online Check-In Notification" scenario, you can configure multiple email addresses for each scenario. This flexibility ensures that different GBP within your network receives relevant information based on specific situations.


- The system supports sending email notifications to both configuration mailboxes and in-booking mailboxes.



## 2) Email Template for configurable scenarios



:::caution
### Ticket issuance failure
:::

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338127/image-preview)

---
 
:::caution
### Rejection of ticket void
:::


![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338128/image-preview)

---

:::caution
### Rejection of ticket change
:::

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338139/image-preview)

---

:::caution
### Rejection of ticket refund
:::


![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338138/image-preview)

---

:::caution
### Non-cash refund order pending to confirm
:::


![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338129/image-preview)

---

:::caution
### Non-cash refund order pending to pay and confirm
:::

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338137/image-preview)

---

:::caution
### Non-cash refund order completed
:::

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338136/image-preview)

---

:::caution
### Schedule Change (Need to confirm)
:::


![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338135/image-preview)

---

:::caution
### Schedule Change (No need to confirm)
:::


![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338131/image-preview)

---


:::caution
### Online check-in notification (General Version)
:::


![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338132/image-preview)

---

:::caution
### Online check-in notification (FR Version)
:::

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338133/image-preview)

---

:::caution
### Airline PNR/Ticket number update
:::

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338134/image-preview)
