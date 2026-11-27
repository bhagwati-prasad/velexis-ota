# RefundResultNotify

## 1 Document Description

### 1.1 Function 

This API could push the refund result to your endpoint, once the ticket has been refunded.

If you will integrate this API, please kindly provide a reception service URL based on HTTP/HTTPS protocol to PKFARE. And we will pre-set it in the system.

### 1.2 Target Reader

The RefundResultNotify interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Node.js, and a basic knowledge of HTTP network protocols.

### 1.3 Character Encoding

The character code of this API is UTF-8.

### 1.4 URLs

The address URL is ***provided by buyer partner***, PKFARE will request it.

### 1.5 Http Method

POST

### 1.6 Request Header

|key|value|
|:----|:----|
|Content-Type|application/json|

### 1.7 Response Header

|key|value|
|:----|:----|
|Content-Type|application/json|

## 2 Request

### 2.1 Request Sample

```json
{
    "orderNum": "916749866867277805",
    "parentOrderNum": "916749866867277803",
    "refOrderNum": "9167498668672778",
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
    "orderStatus": "Refund, to be reimbursed",
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
```
### 2.2 Request Parameter

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|orderNum|String|Yes|PKFARE Refund Order number|
|parentOrderNum|String|No|PKFARE Parent Order number of this refund order, it could be issued order number or change order number|
|refOrderNum|String|Yes|PKFARE general order number, it may include more orders|
|createTime|String|Yes|Order creation time, format yyyy-MM-dd HH:mm:ss(GMT)|
|passengerPriceList|Array|Yes|Passenger and refund pricing information, refer to 2.2.1|
|refundType|Integer|Yes|Refund Type：0-Voluntary , 1-Involuntary|
|refundReason|Integer|Yes|Refund Reason：0-Personal Reason, 1-Illness Reason, 2-Schedule Change Reason, 3-Crisis Reason， 4-Visa Refusal|
|orderStatus|String|Yes|Order stauts|
|pnr|String|No|PNR of Order|
|airPnr|String|No|Airline PNR of order|
|platingCarrier|String|Yes|Plating carrier|
|journeys|Array|Yes|Journey information, refer to 2.2.2|

#### 2.2.1 passengerPriceList

|Name|Type|Requried or Not|Parameter Description|
|:----|:----|:----|:----|
|segmentList|Array|Yes|Segment information, refer to2.2.3|
|lastName|String|Yes|Last name|
|firstName|String|Yes|First name|
|cardType|String|No|Travel document type|
|cardNum|String|No|Travel document number|
|cardExpiredDate|String|No|Travel document expired date|
|nationality|String|Yes|Nationality【Country 2 letters code】|
|psgType|String|Yes|Passenger type|
|sex|String|Yes|Gender|
|birthday|String|Yes|Birthday，format [yyyy-MM-dd]|
|solutions|Array|No|Refund pricing information, refer to 2.2.4|

#### 2.2.2  journeys

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|journeyTime|Long|Yes|Journey Time，Unit：minutes|
|transferCount|Integer|No|Transfer count|
|departureDate|String|Yes|Departure date, format [yyyy-mm-dd]（local time）|
|arrivalDate|String|Yes|Arrival date, format [yyyy-mm-dd]（local time）|
|departureTime|String|Yes|Departure time, format [hh:mm]（local time）|
|arrivalTime|String|Yes|Arrival time, format [hh:mm]（local time）|
|segments|Array|Yes|Segment information, refer to 2.2.5|

#### 2.2.3 segmentList

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

#### 2.2.4 solutions

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

#### 2.2.5 segments

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


### 3 Response

### 3.1 Response Sample

```json
{
    "errorCode": "0",
    "errorMsg": "ok"
}
```
### 3.2 Response Parameter

This response is returned by the buyer partners. Please respond in the format we provided below. Otherwise system is not able to recognize the response. If the response is not with 'errorCode' 0, it will be recognized as failed.

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|errorCode|String|Yes|Error Code, 0-Success，Other-Failed；If returned as "Failed", system will repush for 5 times.|
|errorMsg|String|No|Error Message|

## 4.Repush

If the response is not able to recorgnized the response or the response is not with 'errorCode' 0, system will repush for 5 times.

 

