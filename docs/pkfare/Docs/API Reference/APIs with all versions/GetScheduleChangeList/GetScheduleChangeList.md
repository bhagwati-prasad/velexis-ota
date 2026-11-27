# GetScheduleChangeList

### 1 Document Description
#### 1.1 Function Description
After the order is generated, the airline may send the flight change information. Types of message include:
- Flight cancelled
- Flight cancelled, with protected flight(s)
- Flight schedule changed, it could be time change, equipment change, terminal change, etc.

Through GetScheduleChangeList API, you are able to request by a time schedule to get the schedule change information.
`Note` When you requested AcknowledageScheduleChange and AcceptScheduleChange API, we will clear this message. Then, you will not get same message again.
`Note` If the flight has token off, the message will be cleared automatically. So you will not get its message.
`Note` If you request with a order number to get schedule change information, we will response the message for this order only. In this case, you has a order for issuing ticket, then passenger requested to change, you will got the second order which is change order. Multiple Schedule change messages existed and belongs to two orders. If you want to receive all messages of 1 request by indicating the order number for issuing ticket, you may contact PKFARE's implementor to change the setting.
`Note` To limited the size of response, the duration of "messageCreateTimeStart" and "messageCreateTimeEnd" should be within 24 hours.

#### 1.2 Target Reader
The GetScheduleChangeList API document targets developers who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: http://api.pkfare.com/scheduleChange/getScheduleChangeList

Address in production environment: http://pending.com/scheduleChange/getScheduleChangeList
`Note` PKFARE will provide production domain after Buyer Partners finish integration and co-test. Please replace 'pending.com' with the domain which PKFARE provides individually.

#### 1.5 Request Type
POST

#### 1.6 Request Header
|  key      |  value      |
|----|----|
|  Content-Type      |  application/x-www-form-urlencoded;charset=UTF-8      |

### 2.Request Parameter
#### 2.1 Parameter Construction
Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted
##### 2.1.1 Basic Request
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   authentication       |   object       |   Yes        |   Partner ID and signature, refer to 2.1.2.             |   -          |
|   data            |   object      |   Yes        |  request, refer to 2.1.3.       |   -          |

##### 2.1.2 Authentication
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   partnerId       |   String       |   Yes        |   Partner ID                   |   -          |
|   sign            |   String       |   Yes        |  Signature, refer to 4.1 and 4.2       |   -          |


##### 2.1.3 Data
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   messageId       |   String       |   No    |  PKFARE message ID. You can get specific message by indicating the messageId       |   1075841601001          |
|  orderNum    |  String    |  No     |  PKFARE order number  | 915690623484957501   |
|   messageType    |   String       |   No      |   Message type: <br>1-Flight changed<br> 2-Flight canceled with protect flight<br>3-Flight canceled<br>4-Flight resumed. <br>5- Flight overbooking.<br> You can speicfic a message type to get the message list.  |   1    |
|  sensitivityLevel    |  String    |  No     |  Message sensitivity level: <br>0-This level is not eligible to request involuntary refund or changes, and it is not required to be accepted by passenger.<br>1-This level may not be eligible to request involuntary refund or changes, but it is required to be accepted by passenger. <br>2-This level is eligible to request involuntary refund or changes and it is required to be accepted by passenger. <br>You can spcific a sensitivity level to get the message list. | 0   |
|  messageCreateTimeStart   |  String    |  Yes     |  Schedule change message create time,[yyyy-mm-dd hh:mm:ss]. You can get message list which created in a time duration, this element is start time. The time is refer to Beijing time, which timezone is at GMT+8.  | 2023-02-22 15:00:00   |
|  messageCreateTimeEnd   |  String    |  Yes     |  Schedule change message create time,[yyyy-mm-dd hh:mm:ss]. You can get message list which created in a time duration, this element is end time. The time is refer to Beijing time, which timezone is at GMT+8.  | 2023-02-22 16:00:00   |


#### 2.2 Request Sample
##### 2.2.1 JSON Format Sample

```
{
    "data": {
        "messageCreateTimeStart": "2023-02-20 00:00:00",
        "messageCreateTimeEnd": "2023-02-20 20:00:00",
        "orderNum": "916766125109920601",
        "messageId":"123456",
        "messageType":"2",
        "sensitivityLevel":"2"

    },
    "authentication": {
        "partnerId": "sVSX7PfZmWYsCD7M4=",
        "sign": "e707b5d9dae8459065dbb139e5f1bd"
    }
}
```
##### 2.2.2 Base64 Encryption
Use BASE64 to encode request, and get result as below:
```
ewogICAgImRhdGEiOiB7CiAgICAgICAgIm1lc3NhZ2VDcmVhdGVUaW1lU3RhcnQiOiAiMjAyMy0wMi0yMCAwMDowMDowMCIsCiAgICAgICAgIm1lc3NhZ2VDcmVhdGVUaW1lRW5kIjogIjIwMjMtMDItMjAgMjA6MDA6MDAiLAogICAgICAgICJvcmRlck51bSI6ICI5MTY3NjYxMjUxMDk5MjA2MDEiLAogICAgICAgICJtZXNzYWdlSWQiOiIxMjM0NTYiLAogICAgICAgICJtZXNzYWdlVHlwZSI6IjIiLAogICAgICAgICJzZW5zaXRpdml0eUxldmVsIjoiMiIKCiAgICB9LAogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiUmtzVlNYN1BmWm1XWXNDRDdNND0iLAogICAgICAgICJzaWduIjogIjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIgogICAgfQp9
```

##### 2.2.3 Sending Encrypted Request Sample
This sample is for reference only:
```
POST http://pending.com/scheduleChange/getScheduleChangeList
Content-Type: application/x-www-form-urlencoded

param=ewogICAgImRhdGEiOiB7CiAgICAgICAgIm1lc3NhZ2VDcmVhdGVUaW1lU3RhcnQiOiAiMjAyMy0wMi0yMCAwMDowMDowMCIsCiAgICAgICAgIm1lc3NhZ2VDcmVhdGVUaW1lRW5kIjogIjIwMjMtMDItMjAgMjA6MDA6MDAiLAogICAgICAgICJvcmRlck51bSI6ICI5MTY3NjYxMjUxMDk5MjA2MDEiLAogICAgICAgICJtZXNzYWdlSWQiOiIxMjM0NTYiLAogICAgICAgICJtZXNzYWdlVHlwZSI6IjIiLAogICAgICAgICJzZW5zaXRpdml0eUxldmVsIjoiMiIKCiAgICB9LAogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiUmtzVlNYN1BmWm1XWXNDRDdNND0iLAogICAgICAgICJzaWduIjogIjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIgogICAgfQp9
```

### 3. Response Parameter
#### 3.1 Response Parameter Construction
Response in structuralized in `JSON` format. For concrete fields, please refer to the following tables.


##### 3.1.1 Basic Parameter
| Name          | Type    | Parameter Description                        | Sample |
| ------------- | ------- |  -------------------------------------------- | ------ |
|   errorCode       |   String       |   Error Code, refer to 5.1                              |   0          |
|   errorMsg        |   String       |   Error Message                                    |   OK         |
|   data            |   Object       |   Return data, will not be empty when error code is "0". Refer to 3.1.2   |   -          |

##### 3.1.2 Data
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|  orderNum    |  String    |  Yes     |  PKFARE order number  | 915690623484957501   |
|  buyerOrder    |  String    |  No     |  Buyer partner's order number. If you would like to receive a buyerOrder, please send it in the request of preciseBooking API. The buyer order number will be record and send it back when schedule change happened.  | 111111   |
|  messageId   |  String    |  Yes     |  PKFARE message id  |  2222222   |
|  messageCreateTime   | String   | Yes   | Schedule change message create time [ yyyy-mm-dd hh:mm:ss(GMT+8)]   | 2023-02-21 19:15:10(GMT+8)  |
|  sensitivityLevel    |  String    |  Yes     |  Message sensitivity level: <br>0-This level is not eligible to request involuntary refund or changes, and it is not required to be accepted by passenger.<br>1-This level may not be eligible to request involuntary refund or changes, but it is required to be accepted by passenger. <br>2-This level is eligible to request involuntary refund or changes and it is required to be accepted by passenger.  | 0   |
|  orderPnr    |  String    |  Yes     |  PNR of this order, the booking reference of reservation system  | Y78UJK   |
|  orderAirlinePnr    |  String    |  Yes     |  Airline PNR of this order, the booking reference of airline system  | CX/8IJ7LN   |
|  pnrList   |  Array   |  No     |  PNR List of this order.Refer to 3.1.2.  |  -      |
|  passengers    | Array    | Yes   | passengers of this order. Refer to 3.1.3.  | -  |
|  originFlightList    | Array    | Yes   | Journey and segment information before this schedule change. Refer to 3.1.4. | -  |
|  changeFlightList    | Array    | Yes   | Journey and segment information after this schedule change. Refer to 3.1.5.  | -  |

##### 3.1.2 PnrList
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   segmentNo     |   Integer      |   Yes      |   The segment sequency of the journey       | 1      |
|   departure    |   String       |   Yes      |   Departure airport code, 3 letters IATA code        | HKG      |
|   arrival    |   String       |   Yes      |  Arrival airport code, 3 letters IATA code        | BKK      |
|   flightNum    |   String       |   Yes      |   Flight number, format:Airline code and flight number       | CX618      |
|   cabinClass    |   String       |   Yes      |   Cabin class. Refer to 5.2       | ECONOMY     |
|   bookingCode    |   String       |   Yes      |   Booking code       | E      |
|   pnr    |   String       |   No     |   PNR of this segment, the booking reference of reservation system. It will be blank if the reservation made for the whole order.       | Y78UJK     |
|   airPnr    |   String       |   No     |   PNR of this segment, the booking reference of airline system. It will be blank if the reservation made for the whole order.       | CX/8IJ7LN     |
|   ticketNums    |   Array       |   No     |   Passesger and ticket number information. Refer to 2.1.8.       | -      |

##### 3.1.3 Passengers
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   lastName     |   String       |   Yes      |   Last name       | wang       |
|   firstName       |   String        |   Yes      |  First name    | jia    |
|   birthday     |   String       |   No    |  Date of birth [yyyy-mm-dd]       | 1988-10-10     |
|   sex     |   String       |   No      |   Gender, M - male, F - Female. Refer to 5.5    |   M     |
|   psgType     |   String       |   Yes      |   ADT - adult, CHD - child , INF-Infant. Refer to 5.4   |   CHD     |
|   cardType    |   String       |   No      |   Travel document type. Refer to 5.3    |   P     |
|   cardNum    |   String       |   No      |   Travel document number    |   P78921345     |
|   cardExpiredDate    |   String       |   No      |   Travel document expiration date, [yyyy-mm-dd]    |   2025-03-03     |
|   nationality    |   String       |   No      |   Nationality of the passenger, 2 letters country code    |   CN     |
|   ticketNum    |   String       |   No      |   Ticket number. If multiple ticket numbers, it will be separted by slash[/]    |   9991234567890/9991234567891     |

##### 3.1.4 OriginFlightList
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   journeys     |   Array       |   Yes      |   Journey information. Refer to 3.1.6.       | -       |

##### 3.1.5 changeFlightList
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   journeys     |   Array       |   Yes      |   Journey information. Refer to 3.1.6.       | -       |

##### 3.1.6 journeys
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   journeySeq     |   Integer       |   Yes      |   Journey sequency, outbound refer to 1, inbound refer to 2.      | 1       |
|   segments     |   Array       |   Yes      |   flight information. Refer to 3.1.7.       | -       |

##### 3.1.7 segments
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   airline    |   String       |   Yes      |   Airline code       | CX      |
|   flightNum       |   String        |   Yes      |  Flight number    | 618    |
|   equipment     |   String       |   No    |  Equipment code       | 777     |
|   cabinClass    |   String       |   Yes      |   Cabin class. Refer to 5.2       | ECONOMY     |
|   bookingCode    |   String       |   Yes      |   Booking code    |   E     |
|   departure    |   String       |   Yes      |   Departure airport code, 3 letters IATA code    |   HKG     |
|   arrival    |   String       |   Yes      |  Arrival airport code, 3 letters IATA code        | BKK      |
|   departureTerminal    |   String       |   No      |  Departure terminal       | 1      |
|   arrivalTerminal    |   String       |   No      |  Arrival terminal       | 1      |
|   departureDate    |   String       |   Yes      |   Departure date, [yyyy-mm-dd], local time of departure city    |   2025-03-03     |
|   arrivalDate    |   String       |   Yes      |   Arrival date, [yyyy-mm-dd], local time of arrival city    |   2025-03-03     |
|   departureTime    |   String       |   Yes      |   Departure time, [hh:mm],local time of departure city     |   10:10    |
|   arrivalTime    |   String       |   Yes      |   Arrival time, [hh:mm], local time of arrival city    |   10:10    |
|   flightTime    |   Integer       |   No      |   Flight time, unit: minutes    |   890    |
|   stayTime    |   Integer       |   No      |   Stay time for stopover flight, unit: minutes    |   120    |
|   codeShare    |   String       |   No      |   Code share flight flag, Y - Code share flight, N - Not code share flight    |   N    |
|   opFltNo    |   String       |   No      |   Operation flight number    |   160    |
|   opFltAirline    |   String       |   No      |   Operation airline    |   KA    |
|   stopover    |   String       |   No      |   Stopover airport code, 3 letters IATA code    |   CNX    |
|   messageType    |   String       |   No      |   Message type: <br>1-Flight changed<br> 2-Flight canceled with protect flight<br>3-Flight canceled<br>4-Flight resumed. <br>5- Flight overbooking.<br>For type 3, 4 and 5, there is no ChangeFlightList information.    |   1    |

##### 3.1.8 ticketNums
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   ticketNum     |   String       |   No      |   Ticket number       | -       |
|   lastName     |   String       |   Yes      |   Last name       | wang       |
|   firstName       |   String        |   Yes      |  First name    | jia    |
|   birthday     |   String       |   Yes    |  Date of birth [yyyy-mm-dd]       | 1988-10-10     |
|   sex     |   String       |   Yes      |   Gender, M - male, F - Female. Refer to 5.5    |   M     |
|   cardType    |   String       |   No      |   Travel document type. Refer to 5.3    |   P     |
|   cardNum    |   String       |   No      |   Travel document number    |   P78921345     |

#### 3.2 Response Example
##### 3.2.1 Normal Response
```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": [
        {
            "orderNum": "916766125109920601",
            "messageId": "2944668",
            "messageCreateTime": "2023-02-22 15:07:10",
            "sensitivityLevel": "1",
            "orderPnr": "TGBYHN",
            "orderAirlinePnr": "TGBYHN",
            "pnrList": [
                {
                    "segmentNo": 1,
                    "departure": "PEK",
                    "arrival": "HKG",
                    "flightNum": "391",
                    "cabinClass": "ECONOMY",
                    "bookingCode": "B",
                    "pnr": "TGBYHN",
                    "airPnr": "TGBYHN",
                    "ticketNums": [
                        {
                            "ticketNum": "123321",
                            "lastName": "YANGUJM",
                            "firstName": "TIFFANY",
                            "cardType": "PP",
                            "cardNum": "E07700466",
                            "sex": "F",
                            "birthday": "1990-08-23"
                        }
                    ]
                },
                {
                    "segmentNo": 2,
                    "departure": "HKG",
                    "arrival": "BKK",
                    "flightNum": "617",
                    "cabinClass": "ECONOMY",
                    "bookingCode": "A",
                    "pnr": "TGBYHN",
                    "airPnr": "TGBYHN",
                    "ticketNums": [
                        {
                            "ticketNum": "456456",
                            "lastName": "YANGUJM",
                            "firstName": "TIFFANY",
                            "cardType": "PP",
                            "cardNum": "E07700466",
                            "sex": "F",
                            "birthday": "1990-08-23"
                        }
                    ]
                }
            ],
            "passengers": [
                {
                    "birthday": "1990-08-23",
                    "cardType": "PP",
                    "cardNum": "E07700466",
                    "cardExpiredDate": "2024-03-17",
                    "lastName": "YANGUJM",
                    "firstName": "TIFFANY",
                    "nationality": "CN",
                    "psgType": "ADT",
                    "sex": "F",
                    "ticketNum": "123321"
                }
            ],
            "originFlightList": [
                {
                    "journeySeq": "1",
                    "segments": [
                        {
                            "airline": "CX",
                            "flightNum": "391",
                            "equipment": "333",
                            "cabinClass": "ECONOMY",
                            "bookingCode": "S",
                            "departure": "PEK",
                            "arrival": "HKG",
                            "departureDate": "2023-03-31",
                            "arrivalDate": "2023-03-31",
                            "departureTime": "13:40",
                            "arrivalTime": "17:35",
                            "flightTime": 235,
                            "stayTime": 0,
                            "codeShare": "N",
                            "messageType": "1"
                        },
                        {
                            "airline": "CX",
                            "flightNum": "617",
                            "equipment": "333",
                            "cabinClass": "ECONOMY",
                            "bookingCode": "S",
                            "departure": "HKG",
                            "arrival": "BKK",
                            "departureDate": "2023-03-31",
                            "arrivalDate": "2023-03-31",
                            "departureTime": "21:50",
                            "arrivalTime": "23:50",
                            "flightTime": 180,
                            "stayTime": 0,
                            "codeShare": "N",
                            "messageType": "1"
                        }
                    ]
                }
            ],
            "changeFlightList": [
                {
                    "journeySeq": "1",
                    "segments": [
                        {
                            "airline": "CX",
                            "flightNum": "391",
                            "equipment": "333",
                            "cabinClass": "ECONOMY",
                            "bookingCode": "B",
                            "departure": "PEK",
                            "arrival": "HKG",
                            "departureDate": "2023-03-31",
                            "arrivalDate": "2023-03-31",
                            "departureTime": "13:40",
                            "arrivalTime": "17:35",
                            "stayTime": 0,
                            "codeShare": "N",
                            "stopover": ""
                        },
                        {
                            "airline": "CX",
                            "flightNum": "617",
                            "equipment": "333",
                            "cabinClass": "ECONOMY",
                            "bookingCode": "A",
                            "departure": "HKG",
                            "arrival": "BKK",
                            "departureDate": "2023-03-31",
                            "arrivalDate": "2023-03-31",
                            "departureTime": "21:50",
                            "arrivalTime": "23:50",
                            "stayTime": 0,
                            "codeShare": "N",
                            "stopover": ""
                        }
                    ]
                }
            ]
        }
    ]
}
```
##### 3.2.2 Error Response
```
{
    "errorCode": "P001",
    "errorMsg": "Invalid authentication."
}
```
### 4 Signature
#### 4.1 Parameters for Signature
partnerId,partnerKey

#### 4.2 Signature
Combine partnerId and partnerKey to make MD5 encryption on the final value.

Sign = MD5(partnerId+partnerKey)

```
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
### 5 Appendix
#### 5.1 Error Code List
|   errorCode       |   errorMsg                        |    Description                             |
|----|----|----|
|   0               |   ok                                             |   Request has been processed successfully.                       |
|   S001            |   System error                                   |   System error.                          |
|   P001            |   xxx is illegal                          |   Request parameter is illegal, xxx will display request parameter           |
|   B002            |   Partner is not exists                                 |   Partner does not exist.                    |
|   B003            |   Illegal sign                                   |   Illegal sign.               |
| B035      |Concurrency limited. Please contact PKFARE API support team for assistant.| Concurrent users contral. Please contact PKFARE API support for assistant.|
|   B037            |    Order is not exist.       |   Order does not exist.                 |
|   B048            |    Invalid buyer       |   Buyer is invalid.                 |
|   B130            |    Message is not exist.       |   Schedule change message does not exist.                 |

#### 5.2 Cabin Class
| Enum   | Description   |
|----|----|
|   ECONOMY              |  Economy Class         |
|   PREMIUM ECONOMY       |   Premium Economy Class       |
|   BUSINESS             |   Business Class         |
|   FIRST                |   First Class         |

#### 5.3 Type of Travel Document
| Enum   | Description   |
|----|----|
|  P       |  Passport    |
|  N       |  Chinese Identity    |
|  O       | Others    |

#### 5.4 Passenger Type
| Enum   | Description   |
|----|----|
|  ADT     |  adult         |
|  CHD     |  children[2-12 years old]  |

#### 5.5 Gender
| Enum   | Description   |
|----|----|
|  M       |  Male    |
|  F       |  Female    |


</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>