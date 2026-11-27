# CheckRefundPricing

## 1 Document Description

### 1.1 Function

This API is used through RefundPricingId returned by the RefundPricing interface for the active query of the refund price.

> `Note` This API provides Postman examples, which you can obtain by contacting your account manager.
### 1.2 Target Reader

The CheckRefundPricing interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Node.js, and a basic knowledge of HTTP network protocols.

### 1.3 Charater Encoding

The character code of this API is `UTF-8`.   

### 1.4 URLs
|Environment|URL
|:----|:----|
|Test environment|http://api.pkfare.com/refundPricing/check|
|Prod  environment|http://{{apiHost}}/refundPricing/check|

> `Notes` The production environment call address is provided after you finish the API development and testing, and before the official launch. You can replace the {{apiHost}} in the production environment call address with the provided domain name.
### 1.5 Http Method

POST

### 1.6 Request Header

|key|value|
|:----|:----|
|Content-Type|application/x-www-form-urlencoded|

### 1.7 Response Header

|key|value|
|:----|:----|
|Content-Type|application/json|

## 2 Request

### 2.1 schema

|Param name|Description|Type|
|:----|:----|:----|
|param|The value after Base64 encoding the Basic Request. The Basic Request is a JSON-structured data, and the detailed explanation is provided in the following text.|Text|

#### 2.1.1 Basic Request

sample

```json
{
    "authentication": {
        "sign": "sign",
        "partnerId": "partnerId="
    },
    "data": {
        "refundPricingId": "16786982431662414"
    }
}
```

|name|type|required|description|
|:----|:----|:----|:----|
|authentication|Object|yes|Identity information, refer to 2.1.2.|
|data|Object|yes|File information，refer to 2.1.3|

#### 2.1.2 Authentication

|name|type|required|description|
|:----|:----|:----|:----|
|partnerId|String|yes|partnerID|
|sign|String|yes|Signature, refer to sections 4.1 and 4.2 for the signature method.|

#### 2.1.3 Data

|name|type|required|description|
|:----|:----|:----|:----|
|refundPricingId|String|yes|refundPricingId that returnd by refundPricing API|

### 2.2 Sample of Request Construction Process

#### 2.2.1 Request Sample

```json
{
    "authentication": {
        "sign": "sign",
        "partnerId": "partnerId="
    },
    "data": {
        "refundPricingId": "16786982431662414"
    }
}
```
#### 2.2.2 Base64 Encryption

```json
eyJhdXRoZW50aWNhdGlvbiI6eyJzaWduIjoiMzhkZTNjMTYyZGZhYjJjZmIwNWZlMDdkNzMzMDhhODAiLCJwYXJ0bmVySWQiOiJvalJ3Nkh2V0VEWWFGNkJQY0lDb1FHSlNYaHc9In0sImRhdGEiOnsicmVmdW5kUHJpY2luZ0lkIjoiMTY3ODY5ODI0MzE2NjI0MTQifX0=
```
#### 2.2.3  Post Request

```plain
POST http://open.pkfare.com/refundPricing/check
Content-Type: application/x-www-form-urlencoded

param=eyJhdXRoZW50aWNhdGlvbiI6eyJzaWduIjoiMzhkZTNjMTYyZGZhYjJjZmIwNWZlMDdkNzMzMDhhODAiLCJwYXJ0bmVySWQiOiJvalJ3Nkh2V0VEWWFGNkJQY0lDb1FHSlNYaHc9In0sImRhdGEiOnsicmVmdW5kUHJpY2luZ0lkIjoiMTY3ODY5ODI0MzE2NjI0MTQifX0=
```

## 3 Response

### 3.1 Response Sample

```json
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "needUploadFileId": 0,
        "orderNum": "916777559161841201",
        "refundPriceId": "16786982431662414",
        "refundPricingStatus": "refund pricing",
        "refundReason": 0,
        "refundType": 0,
        "lastComfirmTime": "2022-02-03 13:00:00",
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

|name|type|required|description|
|:----|:----|:----|:----|
|errorCode|String|Yes|error code，refer to error code list|
|errorMsg|String|No|error message|
|warningMsg|String|No|warning message|
|data|Object|No|The returned data, this parameter is not empty only when the error code returns "0", refer to section 3.2.1.|

#### 3.2.1 data

|name|type|required|description|
|:----|:----|:----|:----|
|refundPriceId|String|yes|refund price ID|
|refundPricingStatus|String|yes|refund status： 1-Refund Pricing and Supplier Pricing，2-Refund Priced， 3-Canceled|
|orderNum|String|yes|PKFARE order number|
|lastComfirmTime|String|no|last mintue to confirm refund; YYYY-MM-DD HH:MM (UTC+0)|
|passengerPriceList|Array|yes|the flight segments that are refunded and price information|
|refundType|Integer|yes|refund type：0-Voluntary, 1-Involuntary - |
|refundReason|Integer|yes|reasons for refund：0-Personal Reason, 1-Illness Reason, 2-Schedule Change Reason, 3-Crisis Reason， 4-Visa Refusal|
|needUploadFileId|Integer|yes|When submit refund request, sometimes the supporting documents are needed, including passport photo and so on; 0-no need; 1-need|

#### 3.2.2 passengerPriceList

|name|type|required|description|
|:----|:----|:----|:----|
|segmentList|Array|yes|segment information，refer to 3.2.4|
|lastName|String|yes|last name|
|firstName|String|yes|first name|
|cardType|String|no|identification type|
|cardNum|String|no|ID number|
|sex|String|yes|ID expirate date|
|birthday|String|yes|nationality【2-letter code】|
|solutions|Array|no|passenger type|

#### 3.2.3 segmentList

|name|type|required|description|
|:----|:----|:----|:----|
|segmentNo|Integer|yes|segment sequence|
|departure|String|yes|departure airport|
|arrival|String|yes|arrival airport|
|flightNum|String|yes|flight number|
|cabinClass|String|yes|cabin class|
|bookingCode|String|yes|booking code|
|pnr|String|no|PNR|
|airPnr|String|no|airlines PNR|
|ticketNum|String|no|ticket number|

#### 3.2.4 solutions

|name|type|required|description|
|:----|:----|:----|:----|
|currency|String|yes|currency|
|paidAmount|BigDecimal|yes|paid amount|
|usedAmount|BigDecimal|yes|used amount|
|nonRefundableAmount|BigDecimal|yes|nonrefundable amount（Includes airline penalties, non-refundable taxes, and supplier ticketing service fees）|
|refundServiceFee|BigDecimal|yes|refund service fees（PKFARE）|
|refundAmount|BigDecimal|yes|refundable amount|
|FormOfPayment|String|yes|payment method：Depends on payment method， Airline voucher， Depends on refund result， EMD|

## 4 sign

### 4.1 Parameters

partnerId，partnerKey

### 4.2 sign

Combine partnerId and partnerKey to make an MD5 encryption on final value.

Sign = MD5 (partnerId + partnerKey).

```plain
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
## 5 Appendix

### 5.1 Error Code List

|error code|error message|description|
|:----|:----|:----|
|0|Ok|success|
|P001|xxx is illegal|invalid parameters|
|B002|Partner is not exists|Partner is not exists|
|B003|Illegal sign|Illegal sign|
|B048|Invalid buyer|Invalid buyer|
|B137|RefundPricingId is not exist|RefundPricingId is not exist|
|S001|System error|System error|

   

