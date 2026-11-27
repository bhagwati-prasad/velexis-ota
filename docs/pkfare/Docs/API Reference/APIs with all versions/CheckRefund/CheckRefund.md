# CheckRefund

## 1 Document Description

### 1.1 Function

This API is used to inquire about the progress of the refund order refund. The purchaser initiates a request based on the refund order number. After the application and verification is successful, the refund progress information will be returned.

> `Note` This API provides Postman examples, which you can obtain by contacting your account manager.
### 1.2 Target Reader

The RefundRequest interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Node.js, and a basic knowledge of HTTP network protocols.

### 1.3 Charater Encoding

The character code of this API is `UTF-8`. 

### 1.4 URLs

|Environment|URL|
|:----|:----|
|Test environment|http://api.pkfare.com/refund-api/checkRefund|
|Prod environment|http://{{apiHost}}/refund-api/checkRefund|

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

### 2.1 Schema

|Param name|Description|Type|
|:----|:----|:----|
|param|The value after Base64 encoding the ***Basic Request***. The Basic Request is a JSON-structured data, and the detailed explanation is provided in the following text.|Text|

#### 2.1.1 Basic Request

Sample

```json
{
    "authentication": {
        "partnerId": "GuLC2tpartnerId",
        "sign": "994209932ddsign"
    },
    "data": {
        "orderNum": "916783298501993902"
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
|orderNum|String|Yes|PKFARE order number- refund order|

### 2.2 Sample of Request Construction Process

#### 2.2.1 Request Sample

```json
{
    "authentication": {
        "partnerId": "GuLC2tDO2iox9iu4partnerId",
        "sign": "994209932dd3sign"
    },
    "data": {
        "orderNum": "916783298501993902"
    }
}
```
#### 2.2.2  Base64 Encryption

```json
eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiIyY0d1TEMydERPMmlveDlpdTQ1REtZU3I5bVE9Iiwic2lnbiI6ImM0OTk0MjA5OTMyZGQzN2E4MWM5NTFmMDA0YzcwYmU3In0sImRhdGEiOnsib3JkZXJOdW0iOiI5MTY3ODMyOTg1MDE5OTM5MDIifX0=
```
#### 2.2.3 Post Request

```plain
POST http://open.pkfare.com/refund-api/checkRefund
Content-Type: application/x-www-form-urlencoded

param=eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiIyY0d1TEMydERPMmlveDlpdTQ1REtZU3I5bVE9Iiwic2lnbiI6ImM0OTk0MjA5OTMyZGQzN2E4MWM5NTFmMDA0YzcwYmU3In0sImRhdGEiOnsib3JkZXJOdW0iOiI5MTY3ODMyOTg1MDE5OTM5MDIifX0=
```
## 3 Response

### 3.1 Response Sample

```json
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "orderNum": "916783298501993902",
        "parentOrderNum": "916783298501993901",
        "refOrderNum": "9167832985019939",
        "createTime": "2023-03-10 10:04:02",
        "passengerPriceList": [
            {
                "segmentList": [
                    {
                        "segmentNo": 2,
                        "departure": "YVR",
                        "arrival": "MEX",
                        "flightNum": "AC996",
                        "cabinClass": "ECONOMY",
                        "bookingCode": "P"
                    }
                ],
                "lastName": "YANG",
                "firstName": "TIFFANYBVC",
                "cardType": "P",
                "cardNum": "E07700466",
                "sex": "F",
                "birthday": "1990-08-23"
            }
        ],
        "refundType": "0",
        "refundReason": "0",
        "orderStatus": "Under review",
        "pnr": "NGLVYT",
        "platingCarrier": "AC",
        "journeys": [
            {
                "journeyTime": 815,
                "segments": [
                    {
                        "airline": "AC",
                        "flightNum": "996",
                        "equipment": "7M8",
                        "cabinClass": "ECONOMY",
                        "bookingCode": "P",
                        "departure": "YVR",
                        "arrival": "MEX",
                        "departureTerminal": "",
                        "arrivalTerminal": "",
                        "departureDate": "2023-02-17",
                        "arrivalDate": "2023-02-17",
                        "departureTime": "16:30",
                        "arrivalTime": "23:50",
                        "flightTime": 440,
                        "codeShare": "N"
                    }
                ],
                "departureTime": "10:15",
                "arrivalTime": "23:50",
                "departureDate": "2023-02-17",
                "arrivalDate": "2023-02-17"
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
|orderNum|String|yes|PKFARE order number|
|parentOrderNum|String|no|【PKFARE】The previous order before refunded; e.g. it can be a change order or an original order.|
|refOrderNum|String|yes|【PKFARE】reference order number, There may be multiple orders under this order, including after-sales orders|
|createTime|String|yes|The time when the order is created，format: yyyy-MM-dd HH:mm:ss，|
|passengerPriceList|Array|yes|Price information，refer to 3.2.2|
|refundType|Integer|yes|Refund Type：0-Voluntary, 1-Involuntary|
|refundReason|Integer|yes|Refund reasons：0-Personal Reason, 1-Illness Reason, 2-Schedule Change Reason, 3-Crisis Reason， 4-Visa Refusal|
|orderStatus|String|yes|order status|
|pnr|String|no|PNR|
|airPnr|String|no|airlines PNR|
|platingCarrier|String|yes|plating carrier|
|journeys|Array|yes|Journey information，refer to 3.2.3|

#### 3.2.2 passengerPriceList

|name|type|required|description|
|:----|:----|:----|:----|
|segmentList|Array|yes|segment information，refer to 3.2.4|
|lastName|String|yes|last name|
|firstName|String|yes|first name|
|cardType|String|no|identification type|
|cardNum|String|no|ID number|
|cardExpiredDate|String|no|ID expirate date|
|nationality|String|yes|nationality【2-letter code】|
|psgType|String|yes|passenger type|
|sex|String|yes|sex|
|birthday|String|yes|Date of birth，format[yyyy-MM-dd]|
|solutions|Array|no|information for refundable price，refer to 3.2.5|

#### 3.2.3 journeys

|name|type|required|description|
|:----|:----|:----|:----|
|journeyTime|Long|yes|journet time，unit：minute|
|transferCount|Integer|no|transfer count|
|departureDate|String|yes|departure date [yyyy-mm-dd]（local time）|
|arrivalDate|String|yes|arrival date [yyyy-mm-dd]（local time）|
|departureTime|String|yes|departure time [hh:mm]（local time）|
|arrivalTime|String|yes|arrival time [hh:mm]（local time）|
|segments|Array|yes|segment information，refer to 3.2.6|

#### 3.2.4 segmentList

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

#### 3.2.5 solutions

|name|type|required|description|
|:----|:----|:----|:----|
|currency|String|yes|currency|
|paidAmount|BigDecimal|yes|paid amount|
|usedAmount|BigDecimal|yes|used amount|
|nonRefundableAmount|BigDecimal|yes|nonrefundable amount（Includes airline penalties, non-refundable taxes, and supplier ticketing service fees）|
|refundServiceFee|BigDecimal|yes|refund service fees（PKFARE）|
|refundAmount|BigDecimal|yes|refundable amount|
|FormOfPayment|String|yes|payment method：Depends on payment method， Airline voucher， Depends on refund result， EMD|
|voucherNumber|String|no|EMD code if it is EMD|
|voucherFileId|String|no|The voucher's file ID will be responded based on the Voucher type.|
|voucherCurrency|String|no|currency for the voucher|
|voucherAmount|BigDecimal|no|refundable amount for the voucher|
|voucherValidFrom|String|no|For Airline Voucher or EMD, return the expiration starting date of the refund voucher|
|voucherValidEnd|String|no|For Airline Voucher or EMD, return the expiration ending date of the refund voucher|
|useFor|Object[Integer]|no|For Airline Voucher or EMD, return the subsequent use scenarios: 1 - ticketing, 2 - change, 3 - ancillary.|
|usageLimitation|Integer|no|user limitation： 0 - not confirmed， 1-only the previous passenger， 2-no limitation|

#### 3.2.6 segments

|name|type|required|description|
|:----|:----|:----|:----|
|airline|String|yes|airlines iata code|
|flightNum|String|yes|flight number|
|equipment|String|yes|equipment|
|cabinClass|String|yes|cabin code|
|bookingCode|String|yes|booking code|
|departure|String|yes|departure airport|
|arrival|String|yes|arrival airport|
|departureTerminal|String|no|departure airport terminal|
|arrivalTerminal|String|no|arrival airport terminal|
|departureDate|String|yes|departure date [yyyy-mm-dd]（local time）|
|arrivalDate|String|yes|arrival date [yyyy-mm-dd]（local time）|
|departureTime|String|yes|departure time [hh:mm]（local time）|
|arrivalTime|String|yes|arrival time [hh:mm]（local time）|
|flightTime|Integer|yes|flight time，unit：minute|
|stayTime|Integer|no|stay time，unit：minute|
|codeShare|String|yes|codeshared flight [Y-Yes, N-No]|
|opFltNo|String|no|operating flight number|
|opFltAirline|String|no|operating airlines|
|stopover|String|no|stopover airport|

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
|0|ok|success|
|S001|System error|System error|
|P001|xxx is illegal|illegal parameter|
|P001|xxx is missing|missing parameters|
|B002|Partner is not exists|Partner is not exists|
|B003|Illegal sign|Illegal signature|
|B048|Invalid buyer|invalid buyer|
|B035|Concurrency limited. Please contact PKFARE API support team for assistant.|Concurrency limited. Please contact PKFARE API support team for assistant.|
|B037|Order is not exist|Order is not exist|
|B141|Order is not a refund order.|Order is not a refund order.|

  

