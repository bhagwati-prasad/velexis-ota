# RefundRequest

## 1 Document Description

### 1.1 Function Description

Through RefundRequest API, you are able to request with the passenger who wuold like to make a refund on which segment. System will create a refund request(which is refund order). If you have got a refund pricing ID, which is still valid, you can request with refund pricing ID. If you don't have refund pricing ID, you can make a refund request directly withou refund pricing ID. System will create refund request accordingly.

> `Note` This API provides Postman examples, which you can obtain by contacting your account manager.
### 1.2 Target Reader

The RefundRequest interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Node.js, and a basic knowledge of HTTP network protocols.

### 1.3 Character Encoding

The character code of this API is UTF-8.

### 1.4 URLs
|Environment|URL|
|:----|:----|
|Test environment|http://api.pkfare.com/refund-api/refundRequest|
|Prod environment|http://{{apiHost}}/refund-api/refundRequest|

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

### 2.1 Request Parameter

|Key|Parameter Descritpion|Type|
|:----|:----|:----|
|param|The value of ***Basic Request*** which is encoded by Base64. Basic Request is JSON data structure, please refer to details as following text.|Text|

#### 2.1.1 Basic Request

Sample

```json
{
    "authentication": {
        "partnerId": "GuLC2tDO2iox9partnerId",
        "sign": "994209932dd37a81csign"
    },
    "data": {
        "refundPricingId": "16783330658156729",
        "allPaxOfOrder": 1,
        "orderNum": "916783298501993901",
        "pnrList": [
            {
                "airPnr": "EDTCZP",
                "arrival": "SIN",
                "bookingCode": "E",
                "cabinClass": "ECONOMY",
                "departure": "HKG",
                "flightNum": "CX635",
                "pnr": "EDTCZP",
                "segmentNo": "1",
                "ticketNums": [
                    {
                        "birthday": "2003-01-09",
                        "cardNum": "P1234567",
                        "cardType": "P",
                        "firstName": "CHUN",
                        "lastName": "XIN",
                        "sex": "M",
                        "ticketNum": "EDTCAA"
                    }
                ]
            }
        ],
        "refundReason": 0,
        "refundType": 0,
        "uploadFilesIds": [
            "7a570c0877099e1faaaa"
        ]
    }
}
```
|Name|Type|Requried or Not|Parameter Description|
|:----|:----|:----|:----|
|authentication|Object|Yes|Partner ID and signature, refer to 2.1.2|
|data|Object|Yes|Request, refer to 2.1.3|

#### 2.1.2 Authentication

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|partnerId|String|Yes|Partner ID|
|sign|String|Yes|Signature, refer to 4.1 and 4.2|

#### 2.1.3 Data

|Name|Type|Required or not|Parameter Description|
|:----|:----|:----|:----|
|allPaxOfOrder<br>|Integer|Yes|Identifier for all passengers of the order, 0-No，1-Yes. If request with "1", system will validate whether the request contains all passengers and routings of the order.|
|refundPricingId|String|No|Refund Pricing ID which is returned in Refund Pricing API or Check Refund Pricing API.|
|orderNum|String|Yes|PKFARE order number, issued order and change order are supported.|
|refundType|String|Yes|Refund request type:0-Voluntary, 1-Involuntary.|
|refundReason|String|Yes|Refund reason：0-Personal Reason, 1-Illness Reason, 2-Schedule Change Reason, 3-Crisis Reason， 4-Visa Refusal|
|contactPerson|String|No|Contact person for refund order. The contact information from Origin Order will be used if contactPerson is not in the request.|
|email|String|No|Email for refund order. The email from Origin Order will be used if email is not in the request.|
|telNum|String|No|Contact telephone number for refund order. The contact information from Origin Order will be used if telNum is not in the request.|
|uploadedFlieIds|Array(String)|No|File Id, support 99 files per request|
|pnrList|Array|Yes|PNR and ticket information|
|canceledReservationBeforeDeparture|Integer|No|PNR has been canceled. 0-PNR has not yet been canceled. 1-PNR has been canceled before departure. If the element was not indicated, it will be consider as 0-PNR has not yet been canceled.|


#### 2.1.4 pnrList

|Name|Type|Requried or Not|Parameter Description|
|:----|:----|:----|:----|
|segmentNo|Integer|Yes|Segment sequence, start from "1"|
|departure|String|Yes|Departure airport code|
|arrival|String|Yes|Arrival airport code|
|flightNum|String|Yes|Flight number|
|cabinClass|String|Yes|Cabin calss|
|bookingCode|String|Yes|Booking code|
|pnr|String|No|PNR|
|airPnr|String|No|Airline PNR|
|ticketNums|Array|Yes|Passenger and ticket information|

#### 2.1.5 ticketNums

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|ticketNum|String|No|Ticket Number|
|lastName|String|Yes|Last Name|
|firstName|String|Yes|First Name|
|cardType|String|No|Travel document type|
|cardNum|String|No|Travel document number|
|sex|String|Yes|Gender|
|birthday|String|Yes|Birthday, format[yyyy-MM-dd]|

### 2.2 Request Parameter Construction

#### 2.2.1 Basic Request as JSON data structure

```json
{
    "authentication": {
        "partnerId": "GuLC2tDO2iox9iusign",
        "sign": "994209932dd37sign"
    },
    "data": {
        "refundPricingId": "16783330658156729",
        "allPaxOfOrder": 1,
        "orderNum": "916783298501993901",
        "pnrList": [
            {
                "airPnr": "EDTCZP",
                "arrival": "SIN",
                "bookingCode": "E",
                "cabinClass": "ECONOMY",
                "departure": "HKG",
                "flightNum": "CX635",
                "pnr": "EDTCZP",
                "segmentNo": "1",
                "ticketNums": [
                    {
                        "birthday": "2003-01-09",
                        "cardNum": "P1234567",
                        "cardType": "P",
                        "firstName": "CHUN",
                        "lastName": "XIN",
                        "sex": "M",
                        "ticketNum": "EDTCAA"
                    }
                ]
            }
        ],
        "refundReason": 0,
        "refundType": 0,
        "uploadFilesIds": [
            "7a570c0877099e1faaaa"
        ]
    }
}
```
#### 2.2.2 Encoding Basic Request by Base64

```json
eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiIyY0d1TEMydERPMmlveDlpdTQ1REtZU3I5bVE9Iiwic2lnbiI6ImM0OTk0MjA5OTMyZGQzN2E4MWM5NTFmMDA0YzcwYmU3In0sImRhdGEiOnsicmVmdW5kUHJpY2luZ0lkIjoiMTY3ODMzMzA2NTgxNTY3MjkiLCJhbGxQYXhPZk9yZGVyIjoxLCJvcmRlck51bSI6IjkxNjc4MzI5ODUwMTk5MzkwMSIsInBuckxpc3QiOlt7ImFpclBuciI6IkVEVENaUCIsImFycml2YWwiOiJTSU4iLCJib29raW5nQ29kZSI6IkUiLCJjYWJpbkNsYXNzIjoiRUNPTk9NWSIsImRlcGFydHVyZSI6IkhLRyIsImZsaWdodE51bSI6IkNYNjM1IiwicG5yIjoiRURUQ1pQIiwic2VnbWVudE5vIjoiMSIsInRpY2tldE51bXMiOlt7ImJpcnRoZGF5IjoiMjAwMy0wMS0wOSIsImNhcmROdW0iOiJQMTIzNDU2NyIsImNhcmRUeXBlIjoiUCIsImZpcnN0TmFtZSI6IkNIVU4iLCJsYXN0TmFtZSI6IlhJTiIsInNleCI6Ik0iLCJ0aWNrZXROdW0iOiJFRFRDQUEifV19XSwicmVmdW5kUmVhc29uIjowLCJyZWZ1bmRUeXBlIjowLCJ1cGxvYWRGaWxlc0lkcyI6WyI3YTU3MGMwODc3MDk5ZTFmYWFhYSJdfX0=
```
#### 2.2.3 Request Sample

```plain
POST http://open.pkfare.com/refund-api/refundRequest
Content-Type: application/x-www-form-urlencoded

param=eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiIyY0d1TEMydERPMmlveDlpdTQ1REtZU3I5bVE9Iiwic2lnbiI6ImM0OTk0MjA5OTMyZGQzN2E4MWM5NTFmMDA0YzcwYmU3In0sImRhdGEiOnsicmVmdW5kUHJpY2luZ0lkIjoiMTY3ODMzMzA2NTgxNTY3MjkiLCJhbGxQYXhPZk9yZGVyIjoxLCJvcmRlck51bSI6IjkxNjc4MzI5ODUwMTk5MzkwMSIsInBuckxpc3QiOlt7ImFpclBuciI6IkVEVENaUCIsImFycml2YWwiOiJTSU4iLCJib29raW5nQ29kZSI6IkUiLCJjYWJpbkNsYXNzIjoiRUNPTk9NWSIsImRlcGFydHVyZSI6IkhLRyIsImZsaWdodE51bSI6IkNYNjM1IiwicG5yIjoiRURUQ1pQIiwic2VnbWVudE5vIjoiMSIsInRpY2tldE51bXMiOlt7ImJpcnRoZGF5IjoiMjAwMy0wMS0wOSIsImNhcmROdW0iOiJQMTIzNDU2NyIsImNhcmRUeXBlIjoiUCIsImZpcnN0TmFtZSI6IkNIVU4iLCJsYXN0TmFtZSI6IlhJTiIsInNleCI6Ik0iLCJ0aWNrZXROdW0iOiJFRFRDQUEifV19XSwicmVmdW5kUmVhc29uIjowLCJyZWZ1bmRUeXBlIjowLCJ1cGxvYWRGaWxlc0lkcyI6WyI3YTU3MGMwODc3MDk5ZTFmYWFhYSJdfX0=
```
## 3 Response

### 3.1 Response Sample

```json
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "orderNum": "916777559161841202",
        "parentOrderNum": "916777559161841201",
        "refOrderNum": "9167775591618412",
        "createTime": "2023-03-12 17:45:28",
        "passengerPriceList": [
            {
                "segmentList": [
                    {
                        "segmentNo": 1,
                        "departure": "KUL",
                        "arrival": "SIN",
                        "flightNum": "AK703",
                        "cabinClass": "Economy",
                        "bookingCode": "Z",
                        "pnr": "YMERBD",
                        "ticketNum": "1677755872385"
                    }
                ],
                "lastName": "King",
                "firstName": "Vickie",
                "cardType": "PP",
                "cardNum": "G47321571",
                "cardExpiredDate": "2025-05-05",
                "nationality": "CN",
                "psgType": "CHD",
                "sex": "M",
                "birthday": "2015-05-08"
            }
        ],
        "refundType": "0",
        "refundReason": "0",
        "orderStatus": "Refund request",
        "pnr": "YMERBD",
        "platingCarrier": "AK",
        "journeys": [
            {
                "journeyTime": 75,
                "departureDate": "2023-11-20",
                "arrivalDate": "2023-11-20",
                "departureTime": "07:05",
                "arrivalTime": "08:20",
                "segments": [
                    {
                        "airline": "AK",
                        "flightNum": "703",
                        "equipment": "320",
                        "cabinClass": "Economy",
                        "bookingCode": "Z",
                        "departure": "KUL",
                        "arrival": "SIN",
                        "departureDate": "2023-11-20",
                        "arrivalDate": "2023-11-20",
                        "departureTime": "07:05",
                        "arrivalTime": "08:20",
                        "flightTime": 75,
                        "codeShare": "0",
                        "opFltNo": "",
                        "opFltAirline": ""
                    }
                ]
            }
        ]
    }
}
```
### 3.2 Response Parameter

|Name|Type|Required or Not|Paramter Description|
|:----|:----|:----|:----|
|errorCode|String|Yes|Error Code, 0-Success，Others-Failed|
|errorMsg|String|No|Error reason|
|warningMsg|String|No|Warning Message|
|data|Object|No|Return data, will not be empty when error code is "0". Refer to3.2.1|

#### 3.2.1 data

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|orderNum|String|Yes|PKFARE refund order number|
|parentOrderNum|String|No|PKFARE Parent Order number of this refund order, it could be issued order number or change order number|
|refOrderNum|String|Yes|PKFARE general order number, it may include more orders|
|createTime|String|Yes|Order creation time, format yyyy-MM-dd HH:mm:ss，Beijing time(UTC+0)|
|passengerPriceList|Array|Yes|Passenger and refund pricing information, refer to 3.2.2|
|refundType|Integer|Yes|Refund type：0-Voluntary, 1-Involuntary|
|refundReason|Integer|Yes|Refund reason：0-Personal Reason, 1-Illness Reason, 2-Schedule Change Reason, 3-Crisis Reason， 4-Visa Refusal|
|orderStatus|String|Yes|Order status|
|pnr|String|No|PNR of order|
|airPnr|String|No|Airline PNR of order|
|platingCarrier|String|Yes|Plating carrier|
|journeys|Array|Yes|Journey information, refer to 3.2.3|

#### 3.2.2 passengerPriceList

|Name|Type|Required or not|Parameter Description|
|:----|:----|:----|:----|
|segmentList|Array|Yes|Segment information, refer to 3.2.4|
|lastName|String|Yes|Last Name|
|firstName|String|Yes|First Name|
|cardType|String|No|Travel document type|
|cardNum|String|No|Travel document number|
|cardExpiredDate|String|No|Travel document expired date|
|nationality|String|Yes|Nationality【Country 2 letters code】|
|psgType|String|Yes|Passenger Type|
|sex|String|Yes|Gender|
|birthday|String|Yes|Birthday，Format[yyyy-MM-dd]|
|solutions|Array|No|Refund Pricing information, refer to 3.2.5|

#### 3.2.3 journeys

|Name|Type|Requried or Not|Parameter Description|
|:----|:----|:----|:----|
|journeyTime|Long|Yes|Journey Time, Unit：minutes|
|transferCount|Integer|No|Transfer count|
|departureDate|String|Yes|Departure date, format [yyyy-mm-dd]（local time）|
|arrivalDate|String|Yes|Arrival data, format [yyyy-mm-dd]（local time）|
|departureTime|String|Yes|Departure time, format[hh:mm]（local time）|
|arrivalTime|String|Yes|Arrival time, format[hh:mm]（local time）|
|segments|Array|Yes|Segment information, refer to 3.2.6|

#### 3.2.4 segmentList

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|segmentNo|Integer|Yes|Segment sequency, start from "1"|
|departure|String|Yes|Departure airport code|
|arrival|String|Yes|Arrival airport code|
|flightNum|String|Yes|Flight number|
|cabinClass|String|Yes|Cabin class|
|bookingCode|String|Yes|Booking code|
|pnr|String|No|PNR|
|airPnr|String|No|Airline PNR|
|ticketNum|String|No|Ticket number|

#### 3.2.5 solutions

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|currency|String|Yes|Currency|
|paidAmount|BigDecimal|Yes|Paid amount|
|usedAmount|BigDecimal|Yes|Used fare and tax amount|
|nonRefundableAmount|BigDecimal|Yes|nonrefundable amount（Includes airline penalties, non-refundable taxes, and supplier ticketing service fees）|
|refundServiceFee|BigDecimal|Yes|Refund service fee|
|refundAmount|BigDecimal|Yes|Refund amount|
|FormOfPayment|String|Yes|Refund form of payment：Depends on payment method， Airline voucher， Depends on refund result， EMD|
|voucherNumber|String|No|Voucher number, for refund form of payment as Airline voucher or EMD|
|voucherFileId|String|No|Voucher File ID, for refund form of payment as Airline voucher. You can download this file by DownloadFile API|
|voucherCurrency|String|No|Voucher currency, for refund form of payment as Airline voucher or EMD|
|voucherAmount|BigDecimal|No|Voucher amount, for refund form of payment as Airline voucher or EMD|
|voucherValidFrom|String|No|Voucher valid date from, for refund form of payment as Airline voucher or EMD|
|voucherValidEnd|String|No|Voucher valid date to, for refund form of payment as Airline voucher or EMD|
|useFor|Object[Integer]|No|Usage of Airline voucher or EMD：1-Issue ticket，2-Change ticket，3-Purchase ancillaries product|
|usageLimitation|Integer|No|Usage limitation: 0 - Uncertain， 1-Passenger only， 2-No limitation|

#### 3.2.6 segments

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|airline|String|Yes|Airline code|
|flightNum|String|Yes|Flight number|
|equipment|String|Yes|Equipment code|
|cabinClass|String|Yes|Cabin class|
|bookingCode|String|Yes|Booking code|
|departure|String|Yes|Departure airport code|
|arrival|String|Yes|Arrival airport code|
|departureTerminal|String|No|Departure terminal|
|arrivalTerminal|String|No|Arrival terminal|
|departureDate|String|Yes|Departure Date, format [yyyy-mm-dd]（local time）|
|arrivalDate|String|Yes|Arrival Date, format [yyyy-mm-dd]（local time）|
|departureTime|String|Yes|Departure time, format [hh:mm]（local time）|
|arrivalTime|String|Yes|Arrival time, format [hh:mm] （local time）|
|flightTime|Integer|Yes|Flying time, Unit: minutes|
|stayTime|Integer|No|Stay time, Unit: minutes|
|codeShare|String|Yes|Code-share flight identifier [Y-Yes, N-No]|
|opFltNo|String|No|Operating flight number|
|opFltAirline|String|No|Operating airline|
|stopover|String|No|Stopover airport code|

## 4 Signature

### 4.1 Parameters for Signature

partnerId，partnerKey

### 4.2 Signature

Combine partnerId and partnerKey to make MD5 encryption on the final value.

Sign = MD5(partnerId+partnerKey)

```plain
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
## 5 Appendix

### 5.1 Error Code List

|errorCode|errorMsg|Description|
|:----|:----|:----|
|0|ok|Success|
|S001|System error|System error|
|P001|xxx is illegal|Request parameter is illegal, xxx will display request parameter|
|P001|xxx is missing|Request parameter is required, xxx will display request parameter|
|B002|Partner is not exists|Partner is not exists.|
|B003|Illegal sign|Signature is illegal|
|B048|Invalid buyer|Buyer is invalid, please contact PKFARE account manager|
|B037|Order is not exist|Order is not exist|
|B035|Concurrency limited. Please contact PKFARE API support team for assistant.|Request is over the limiation of concurrency.|
|B134|Refund is not applicable for passenger [passenger name]|Passenger or segment in the request has already request for refund or void, which order status is processing or completed.|
|B135|Passenger or ticket number is not in the order|Passenger or ticket number in the request is not same as order.|
|B136|This is not all passengers and routings of the order, please kindly check|"allPaxOfOrder" is 1，but pnrList does not contains all passenger and routings.|
|B137|RefundPricing is not exist|Refund Pricing ID is not exist|
|B145|Passenger(s) must request to refund same routing for one time. If routing is varies, please request per passenger.|Multiple passengers request for refund different segments in this request. Please raise refund per passenger.|
|B146|Order#[Order number] is not applicable for refund.|Order number in the request is not issue order and not change order. Refund is not allowed.|
|B149|Refund Pricing ID#(Refund Pricing ID) has been expired. Please check refund pricing again.|Refund Pricing ID has been expired. |
|B150|This order was changed, please kindly use change order number.|Passenger and segment in PnrList has requested for change, please use change order number.|
|B152|pnrList information is not same as order, please kindly check.|pnrList in the request is not same as order.|
|B153|Duplicated refund request, please kindly check|Passenger and segment in the request has already submit refund, and the refund is still in processing. System does not allow to request again.|
|B154|pnrList information is not same as refund pricing ID, please kindly check|PnrList information in the request is not same as refund pricing ID, please kindly check.|

 

