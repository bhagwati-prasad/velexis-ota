# GetScheduleChangeReply

## 1 Document Description

### 1.1 Function Description

Once you confirm the flight change, you can receive the confirmation results using the API GetScheduleChangeReply.

Please provide the URL for the API endpoint.

### 1.2 Target Reader

The GetScheduleChangeReply API document targets developers who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

### 1.3 Character Encoding

The character code of this API is UTF-8.

### 1.4  Invoking Address

This address URL is provided by the buyer partners.

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

### 2.1.1 Basic Request

|Name|Type|Required or not|Parameter Description|Sample|
|:----|:----|:----|:----|:----|
|orderNum|String|Yes|PKFARE order number|915690623484957501|
|messageId|String|Yes|PKFARE message id|4433422|
|passengers|Array|Yes|passengers of this order. Refer to 2.1.2.|-|
|originFlightList|Array|Yes|Journey and segment information before this schedule change. Refer to 2.1.3.|-|
|changeFlightList|Array|No|Journey and segment information after this schedule change. Refer to 2.1.4.|-|

### 2.1.2 passengers

|Name|Type|Required or not|Parameter Description|Sample|
|:----|:----|:----|:----|:----|
|lastName|String|Y|Last name|wang|
|firstName|String|Y|First name|jia|
|birthday|String|N|Date of birth [yyyy-mm-dd]|1988-10-10|
|sex|String|N|Gender, M - male, F - Female. Refer to 4.5|M|
|psgType|String|Y|ADT - adult, CHD - child , INF-Infant. Refer to 4.4|CHD|
|cardType|String|N|Travel document type. Refer to 4.3|P|
|cardNum|String|N|Travel document number|P78921345|
|cardExpiredDate|String|N|Travel document expiration date, [yyyy-mm-dd]|2025-03-03|
|nationality|String|N|Nationality of the passenger, 2 letters country code|CN|
|newTicketNum|String|N|New ticket number. If multiple ticket numbers, it will be separted by slash[/]|9991234567890/9991234567891|

### 2.1.3 originFlightList

|Name|Type|Required or not|Parameter Description|
|:----|:----|:----|:----|
|journeys|Array|Yes|Journey information. Refer to 2.1.5.|

### 2.1.4 changeFlightList

|Name|Type|Required or not|Parameter Description|
|:----|:----|:----|:----|
|journeys|Array|Yes|Journey information. Refer to 2.1.5.|

### 2.1.5 journeys

|Name|Type|Required or not|Parameter Description|
|:----|:----|:----|:----|
|journeySeq|Int|Yes|Journey sequency, outbound refer to 1, inbound refer to 2.|
|segments|Array|Yes|flight information. Refer to 2.1.6.|

### 2.1.6 segments

|Name|Type|Required or not|Parameter Description|Sample|
|:----|:----|:----|:----|:----|
|airline|String|Yes|Airline code|CX|
|flightNum|String|Yes|Flight number|618|
|equipment|String|No|Equipment code|777|
|cabinClass|String|Yes|Cabin class. Refer to 4.2|ECONOMY|
|bookingCode|String|Yes|Booking code|E|
|departure|String|Yes|Departure airport code, 3 letters IATA code|HKG|
|arrival|String|Yes|Arrival airport code, 3 letters IATA code|BKK|
|departureTerminal|String|No|Departure terminal|1|
|arrivalTerminal|String|No|Arrival terminal|1|
|departureDate|String|Yes|Departure date, [yyyy-mm-dd], local time of departure city|2025-03-03|
|arrivalDate|String|Yes|Arrival date, [yyyy-mm-dd], local time of arrival city|2025-03-03|
|departureTime|String|Yes|Departure time, [hh:mm],local time of departure city|10:10|
|arrivalTime|String|Yes|Arrival time, [hh:mm], local time of arrival city|10:10|
|flightTime|Integer|No|Flight time, unit: minutes|890|
|stayTime|Integer|No|Stay time for stopover flight, unit: minutes|120|
|codeShare|String|No|Code share flight flag, Y - Code share flight, N - Not code share flight|N|
|opFltNo|String|No|Operation flight number|160|
|opFltAirline|String|No|Operation airline|KA|
|stopover|String|No|Stopover airport code, 3 letters IATA code|CNX|
|messageType|String|No|Message type:<br>1-Flight changed<br>2-Flight canceled with protect flight<br>3-Flight canceled<br>4-Flight resumted.<br>5- Flight overbooking.<br>For type 3, 4 and 5, there is no ChangeFlightList information.|1|

### 2.2 Request Parameter Construction

```plain
{
  "changeFlightList":[
    {
        "journeySeq":"1",
        "segments":[
            {
              "airline":"OD",
              "arrival":"KUL",
              "arrivalDate":"2024-03-08",
              "arrivalTerminal":"1",
              "arrivalTime":"19:00",
              "bookingCode":"A",
              "cabinClass":"ECONOMY",
              "codeShare":"N",
              "departure":"HKG",
              "departureDate":"2024-03-08",
              "departureTerminal":"2",
              "departureTime":"15:10",
              "equipment":"7M8",
              "flightNum":"111",
              "flightTime":230
              }
            ]
          }
        ],
  "messageId":"4430826",
  "orderNum":"917086774832458201",
  "originFlightList":[
      {
        "journeySeq":"1",
        "segments":[
          {
              "airline":"OD",
              "arrival":"KUL",
              "arrivalDate":"2024-03-07",
              "arrivalTerminal":"1",
              "arrivalTime":"19:00:00",
              "bookingCode":"T",
              "cabinClass":"ECONOMY",
              "codeShare":"N",
              "departure":"HKG",
              "departureDate":"2024-03-07",
              "departureTerminal":"2",
              "departureTime":"15:10:00",
              "equipment":"7M8",
              "flightNum":"111",
              "flightTime":230,
              "messageType":"1"
            }
          ]
        }
      ],
  "passengers":[
      {
        "birthday":"2004-02-21",
        "cardExpiredDate":"2025-02-15",
        "cardNum":"G41501437",
        "cardType":"P",
        "firstName":"YANG",
        "lastName":"ZHANG",
        "nationality":"CN",
        "psgType":"ADT",
        "sex":"M"
      }
  ]
}
```
## 3 Response

### 3.1 Basic Parameter

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|errorCode|String|Yes|error code,refer  to Error Code List|
|errorMsg|String|NO|error message|

### 3.2 Response Sample

```plain
{
  "errorCode": "0",
  "errorMsg": "OK"
}
```
## 4 Appendix

### 4.1 Error Code List

|erroCode|erroMsg|Description|
|:----|:----|:----|
|0|ok|Request has been processed successfully.|

### 4.2 Cabin Class

|Enum|Description|
|:----|:----|
|ECONOMY|Economy Class|
|PREMIUM ECONOMY|Premium Economy Class|
|BUSINESS|Business Class|
|FIRST|First Class|

### 4.3 Type of Travel Document

|Enum|Description|
|:----|:----|
|P|Passport|
|N|Chinese Identity|
|O|Others|

### 4.4 Passenger Type

|Enum|Description|
|:----|:----|
|ADT|adult|
|CHD|children[2-12 years old]|
|INF|infant[0-2 years old]|

### 4.5 Gender

|Enum|Description|
|:----|:----|
|M|Male|
|F|Female|

