# RefundPricing

## 1 Document Description

### 1.1 Function

This API is used for price inquiries for refunded tickets. The purchaser request initiates an application according to the order number and the ticket number for which the refund is to be processed. After the application and verification is successful, the system will generate a Refund Pricing inquiry record in the system.
<br>
`Note`  This API provides Postman examples, which you can obtain by contacting your account manager.

### 1.2 Target Reader

The RefundRequest interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Node.js, and a basic knowledge of HTTP network protocols.
### 1.3 Charater Encoding

The character code of this API is  `UTF-8` .  
### 1.4 URL

|Environment |URL |
| :--- | :---: | ---: |
|Test environment |http://open.pkfare.com/refundPricing/generate |
|Prod environment |http://{{apiHost}}/refundPricing/generate |


`Notes`  The production environment call address is provided after you finish the API development and testing, and before the official launch. You can replace the {{apiHost}} in the production environment call address with the provided domain name.

### 1.5 Http mehtod

POST
### 1.6 Request Header


|key |value |
| :--- | :---: | ---: |
|Content-Type |application/x-www-form-urlencoded |

## 2 Request

### 2.1 Schema

|name |type |description |
| :--- | :---: | ---: |
|param |The value after Base64 encoding the Basic Request. The Basic Request is a JSON-structured data, and the detailed explanation is provided in the following text. |Text |

 
#### 2.1.1 Basic Request

sample

```
{
    "authentication": {
        "partnerId": "sIxxcsRCtssslnHt+BiT4bwONbMw=",
        "sign": "234f554590789459af1e610e872896a3c6"
    },
    "data": {
        "allPaxOfOrder": 0,
        "refundReason": "2",
        "refundType": "1",
        "uploadedFileIds": [
            "d0asisuddfjasld",
            "asdfasdasdas158"
        ],
        "orderNum": "916783592892089401",
        "pnrList": [
            {
                "arrival": "SEA",
                "bookingCode": "string",
                "cabinClass": "string",
                "departure": "LAX",
                "flightNum": "DL1473",
                "segmentNo": 1,
                "ticketNums": [
                    {
                        "birthday": "2003-05-11",
                        "cardNum": "string",
                        "cardType": "string",
                        "firstName": "Joshua",
                        "pnr": "AB8SED",
                        "airPnr": "AB8SED",
                        "lastName": "Perez",
                        "sex": "M",
                        "ticketNum": "123456"
                    }
                ]
            }
        ]
    }
}
```
 

|name |type |required |description |
| :--- | :---: | ---: |
|authentication |Object |yes |Identity information, refer to 2.1.2. |
|data |Object |yes |File information，refer to 2.1.3 |

#### 2.1.2 Authentication

|name |type |required |description |
| :--- | :---: | ---: |
|partnerId |String |yes |partnerID |
|sign |String |yes |Signature, refer to sections 4.1 and 4.2 for the signature method. |

#### 2.1.3 Data

|name |type |required |description |
| :--- | :---: | ---: |
|allPaxOfOrder |Integer |yes |tag for all passengers，0-No，1-Yes。If the value is “1”, system will check whether pnrlist includes all passengers. |
|orderNum |String |yes |order number |
|refundType |Integer |yes |Refund Type：0-Voluntary, 1-Involuntary |
|refundReason|String|Yes|Refund reason：0-Personal Reason, 1-Illness Reason, 2-Schedule Change Reason, 3-Crisis Reason， 4-Visa Refusal|
|uploadedFlieIds |Array(String) |no |File ID, At most 99 files are supported. |
|pnrList |Array |yes |PNR list and ticket number list. |
|canceledReservationBeforeDeparture|Integer|No|PNR has been canceled. 0-PNR has not yet been canceled. 1-PNR has been canceled before departure. If the element was not indicated, it will be consider as 0-PNR has not yet been canceled.|

#### 2.1.4 pnrList


|name |type |required |description |
| :--- | :---: | ---: |
|segmentNo |Integer |yes |segment sequence |
|departure |String |yes |departure airport |
|arrival |String |yes |arrival airport |
|flightNum |String |yes |flight number |
|cabinClass |String |yes |cabin code |
|bookingCode |String |yes |booking code |
|pnr |String |no |PNR |
|airPnr |String |no |airlines PNR |
|ticketNums |Array |yes |passengers and ticket numbers |

#### 2.1.5 ticketNums

|name |type |required |description |
| :--- | :---: | ---: | ---: |
|ticketNum |String |no |ticket number |
|lastName |String |yes |last name |
|firstName |String |yes |first name |
|cardType |String |no |ID type |
|cardNum |String |no |ID number |
|sex |String |yes |sex |
|birthday |String |yes |date of birth，format[YYYY-MM-DD] |

 
### 2.2 Sample of Request Construction Process

#### 2.2.1 Request Sample


```
{
    "authentication": {
        "partnerId": "sIxxcsRCtSIlnHt+BiT4bwONbMw=",
        "sign": "234f55459079289af1e610e872896a3c6"
    },
    "data": {
        "allPaxOfOrder": 0
        "refundReason": "2",
        "refundType": "1",
        "uploadedFileIds": [
            "d0asisuddfjasld",
            "asdfasdasdas158"
        ],
        "orderNum": "916783592892089401",
        "pnrList": [
            {
                "arrival": "SEA",
                "bookingCode": "string",
                "cabinClass": "string",
                "departure": "LAX",
                "flightNum": "DL1473",
                "segmentNo": 1,
                "ticketNums": [
                    {
                        "birthday": "2003-05-11",
                        "cardNum": "string",
                        "cardType": "string",
                        "firstName": "Joshua",
                        "lastName": "Perez",
                        "sex": "M",
                        "ticketNum": "123456"
                    }
                ]
            }
        ]
    }
}
```
#### 2.2.2 Base64 Encryption

 `eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJzSXh4Y3NSQ3RTSWxuSHQrQmlUNGJ3T05iTXc9Iiwic2lnbiI6IjIzNGY1NTQ1OTA3OTI4OWFmMWU2MTBlODcyODk2YTNjNiJ9LCJkYXRhIjp7ImFsbFBheE9mT3JkZXIiOjAsInJlZnVuZFJlYXNvbiI6IjIiLCJyZWZ1bmRUeXBlIjoiMSIsInVwbG9hZGVkRmlsZUlkcyI6WyJkMGFzaXN1ZGRmamFzbGQiLCJhc2RmYXNkYXNkYXMxNTgiXSwib3JkZXJOdW0iOiI5MTY3ODM1OTI4OTIwODk0MDEiLCJwbnJMaXN0IjpbeyJhcnJpdmFsIjoiU0VBIiwiYm9va2luZ0NvZGUiOiJzdHJpbmciLCJjYWJpbkNsYXNzIjoic3RyaW5nIiwiZGVwYXJ0dXJlIjoiTEFYIiwiZmxpZ2h0TnVtIjoiREwxNDczIiwic2VnbWVudE5vIjoxLCJ0aWNrZXROdW1zIjpbeyJiaXJ0aGRheSI6IjIwMDMtMDUtMTEiLCJjYXJkTnVtIjoic3RyaW5nIiwiY2FyZFR5cGUiOiJzdHJpbmciLCJmaXJzdE5hbWUiOiJKb3NodWEiLCJsYXN0TmFtZSI6IlBlcmV6Iiwic2V4IjoiTSIsInRpY2tldE51bSI6IjEyMzQ1NiJ9XX1dfX0=` 
 
 #### 2.2.3  Post Request


```
POST http://open.pkfare.com/refundPricing/generate
Content-Type: application/x-www-form-urlencoded


param=eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJzSXh4Y3NSQ3RTSWxuSHQrQmlUNGJ3T05iTXc9Iiwic2lnbiI6IjIzNGY1NTQ1OTA3OTI4OWFmMWU2MTBlODcyODk2YTNjNiJ9LCJkYXRhIjp7ImFsbFBheE9mT3JkZXIiOjAsInJlZnVuZFJlYXNvbiI6IjIiLCJyZWZ1bmRUeXBlIjoiMSIsInVwbG9hZGVkRmlsZUlkcyI6WyJkMGFzaXN1ZGRmamFzbGQiLCJhc2RmYXNkYXNkYXMxNTgiXSwib3JkZXJOdW0iOiI5MTY3ODM1OTI4OTIwODk0MDEiLCJwbnJMaXN0IjpbeyJhcnJpdmFsIjoiU0VBIiwiYm9va2luZ0NvZGUiOiJzdHJpbmciLCJjYWJpbkNsYXNzIjoic3RyaW5nIiwiZGVwYXJ0dXJlIjoiTEFYIiwiZmxpZ2h0TnVtIjoiREwxNDczIiwic2VnbWVudE5vIjoxLCJ0aWNrZXROdW1zIjpbeyJiaXJ0aGRheSI6IjIwMDMtMDUtMTEiLCJjYXJkTnVtIjoic3RyaW5nIiwiY2FyZFR5cGUiOiJzdHJpbmciLCJmaXJzdE5hbWUiOiJKb3NodWEiLCJsYXN0TmFtZSI6IlBlcmV6Iiwic2V4IjoiTSIsInRpY2tldE51bSI6IjEyMzQ1NiJ9XX1dfX0=
```
 
## 3 Response

### 3.1 Response Sample


```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "needUploadFileId": 0,
        "orderNum": "916777559161841201",
        "refundPriceId": "16786066309484323",
        "refundPricingStatus": "refund pricing",
        "refundReason": 0,
        "refundType": 0,
        "lastComfirmTime": "2022-02-03 13:00:00"
        "passengerPriceList": [
            {
                "birthday": "2003-06-05",
                "cardNum": "G47350571",
                "cardType": "P",
                "firstName": "Justin",
                "lastName": "Lopez",
                "sex": "M",
                "ticketNum": "123456",
                "solutions": {
                    "currency": "USD",
                    "paidAmount": 1.00,
                    "usedAmount": 1.00,
                    "nonRefundableAmount": 1.00,
                    "refundServiceFee": 1.00,
                    "refundAmount": 1.00,
                    "FormOfPayment": "PrePay"
                },
                "segmentList": [
                    {
                        "arrival": "SIN",
                        "bookingCode": "Z",
                        "cabinClass": "ECONOMY",
                        "departure": "KUL",
                        "flightNum": "AK703",
                        "pnr": "YMERBD",
                        "airPnr": "YMERBD",
                        "segmentNo": 1,
                        "ticketNum": "1677755872384"
                    }
                ]
            }
        ]
    }
}
```
 
### 3.2 Response Parameters


|name |type |required |description |
| :--- | :---: | ---: | ---: |
|errorCode |String |Yes |error code，refer to error code list |
|errorMsg |String |No |error message |
|warningMsg |String |No |warning message |
|data |Object |No |The returned data, this parameter is not empty only when the error code returns "0", refer to section 3.2.1. |

#### 3.2.1 data


|name |type |required |description |
| :--- | :---: | ---: | ---: |
|refundPriceId |String |yes |refund price ID |
|refundPricingStatus |String |yes |refund status： 1-Refund Pricing和Supplier Pricing，2-Refund Priced， 3-Canceled |
|orderNum |String |yes |PKFARE order number |
|lastComfirmTime |String |no |last mintue to confirm refund; YYYY-MM-DD HH:MM (UTC+0) |
|passengerPriceList |Array |yes |the flight segments that are refunded and price information |
|refundType |String |yes |refund type：0-Voluntary, 1-Involuntary - |
|refundReason |Integer |yes |reasons for refund：0-Personal Reason, 1-Illness Reason, 2-Schedule Change Reason, 3-Crisis Reason， 4-Visa Refusal |
|needUploadFileId |Integer |yes |When submit refund request, sometimes the supporting documents are needed, including passport photo and so on; 0-no need; 1-need |

#### 3.2.2 passengerPriceList


|name |type |required |description |
| :--- | :---: | ---: | ---: |
|segmentList |Array |yes |segment information，refer to 3.2.4 |
|lastName |String |yes |last name |
|firstName |String |yes |first name |
|cardType |String |no |identification type |
|cardNum |String |no |ID number |
|sex |String |yes |sex |
|birthday |String |yes |birthday, format [yyyy-MM-dd]|
|solutions |Object |no |Refund amount details, refer to 3.2.4 |

#### 3.2.3 segmentList


|name |type |required |description |
| :--- | :---: | ---: | ---: |
|segmentNo |Integer |yes |segment sequence |
|departure |String |yes |departure airport |
|arrival |String |yes |arrival airport |
|flightNum |String |yes |flight number |
|cabinClass |String |yes |cabin class |
|bookingCode |String |yes |booking code |
|pnr |String |no |PNR |
|airPnr |String |no |airlines PNR |
|ticketNum |String |no |ticket number |

 
#### 3.2.4 solutions


|name |type |required |description |
| :--- | :---: | ---: | ---: |
|currency |String |yes |currency |
|paidAmount |BigDecimal |yes |paid amount |
|usedAmount |BigDecimal |yes |used amount |
|nonRefundableAmount |BigDecimal |yes |non-refundable amount（Includes airline penalties, non-refundable taxes, and supplier refund service fees） |
|refundServiceFee |BigDecimal |yes |refund service fees（PKFARE） |
|refundAmount |BigDecimal |yes |refundable amount |
|FormOfPayment |String |yes |payment method：Depends on payment method， Airline voucher， Depends on refund result， EMD |

 
## 4 sign

### 4.1 Parameters

partnerId，partnerKey
### 4.2 sign

Combine partnerId and partnerKey to make an MD5 encryption on final value.
Sign = MD5 (partnerId + partnerKey).

```
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
## 5 Appendix

### 5.1 Error Code List


|error code |error message |description |
| :--- | :---: | ---: |
|0 |Ok |success |
|P001 |xxx is illegal |invalid parameters |
|B002 |Partner is not exists |invalid partner |
|B003 |Illegal sign |Illegal sign |
|B048 |Invalid buyer |Invalid buyer |
|B037 |Order is not exist |Order is not exist |
|S001 |System error |system error |
|B134 |Refund is not applicable for passenger [pax name] |The passenger and ticket in the application already have an associated voided ticket or refund order and the status of the voided ticket or refund order is valid, and it is not allowed to initiate another refund offer application. |
|B142 |Passenger or ticket number is not in the order |The order number in the request does not match the passenger or ticket number |
|B143 |Involuntary Refund is not applicable to check refundable price, please request refund request directly. |Refund Pricing does not provide quotes for Involuntary Refund. |
|B136 |This is not all passengers and routings of the order, please kindly check. |The parameter "allPaxOfOrder" is 1, but part of the ticket information is missing from the pnrList. |
|B146 |Order#[Order number] is not applicable for refund. |The order in the request is not a ticket issuance or change order and cannot be requested for a refund. |
|B140 |Refund is not applicable for ticket number [ticket number] |The ticket in the application is found to have a status of USED for all segments after the ticket is extracted, and it is not allowed to initiate a refund offer request again. |
|B147 |Ticket(s) [ticket number] is No-show, refund is not applicable. |The ticket in the application has exceeded the No-show time limit and no refunds are allowed. |
|B145 |Passenger(s) must request to refund same routing for one time. If routing is varies, please request per passenger. |In the case of multiple passengers, the itineraries for which refunds are requested must be the same. If the itineraries are not identical, the itinerary must be as requested by the passenger |
|B148 |UploadFileId is not exist. |The Upload Filed ID in the request does not exist |
|B150 |This order was changed, please kindly use change order number. |The order number specified in the request is the original order, and the passenger+segment specified in the PnrList already has a change order |
|B152 |pnrList information is not same as order, please kindly check. |In the request, the journey of the order number and the information of the pnrList do not match |