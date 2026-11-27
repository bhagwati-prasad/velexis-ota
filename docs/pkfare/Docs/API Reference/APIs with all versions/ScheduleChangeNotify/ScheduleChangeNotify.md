# ScheduleChangeNotify

### 1 Document Description
#### 1.1 Function Description
After the order is generated, the airline may send the flight change information. Types of message include:
- Flight cancelled
- Flight cancelled, with protected flight(s)
- Flight schedule changed, it could be time change, equipment change, terminal change, etc.

This API could push the schedule change information to your endpoint, once there is a schedule change happened. 
If you will integrate this API, please kindly provide a reception service  URL based on HTTP/HTTPS protocol to PKFARE. And we will pre-set it in the system. 
`Note:`The schedule change notifify will send the flight information on changed flights. If booking is a round trip, and the schedule change happened for outbound flights, then only outbound flights will be in this request.

#### 1.2 Target Reader
The ScheduleChangeNotify API document targets developers who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
This address URL is provided by the buyer partners.

#### 1.5 Request Type
POST

#### 1.6 Request Header
| key   | value   |
|:----|:----|
| Content-Type   | application/json;charset=UTF-8   |

### 2.Request Parameter
This request is sent by PKFARE API. The structure parameter is JSON format.

#### 2.1 Parameter Construction
##### 2.1.1 Basic parameter
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|  orderNum    |  String    |  Yes     |  PKFARE order number  | 915690623484957501   |
|  buyerOrder    |  String    |  No     |  Buyer partner's order number. If you would like to receive a buyerOrder, please send it in the request of preciseBooking API. The buyer order number will be record and send it back when schedule change happened.  | 111111   |
|  messageId   |  String    |  Yes     |  PKFARE message id  |  2222222   |
|  messageCreateTime   | String   | Yes   | Schedule change message create time [ yyyy-mm-dd hh:mm:ss]，Beijing Time(GMT+8)   | 2023-02-21 19:15:10 |
|  sensitivityLevel    |  String    |  Yes     |  Message sensitivity level: <br>0-This level is not eligible to request involuntary refund or changes, and it is not required to be accepted by passenger.<br>1-This level may not be eligible to request involuntary refund or changes, but it is required to be accepted by passenger. <br>2-This level is eligible to request involuntary refund or changes and it is required to be accepted by passenger.  | 0   |
|  orderPnr    |  String    |  Yes     |  PNR of this order, the booking reference of reservation system  | Y78UJK   |
|  orderAirlinePnr    |  String    |  Yes     |  Airline PNR of this order, the booking reference of airline system  | CX/8IJ7LN   |
|  pnrList   |  Array   |  No     |  PNR List of this order.Refer to 2.1.2.  |  -      |
|  passengers    | Array    | Yes   | passengers of this order. Refer to 2.1.3.  | -  |
|  originFlightList    | Array    | Yes   | Journey and segment information before this schedule change. Refer to 2.1.4. | -  |
|  changeFlightList    | Array    | No   | Journey and segment information after this schedule change. Refer to 2.1.5.  | -  |

##### 2.1.2 PnrList
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   segmentNo     |   Integer      |   Yes      |   The segment sequency of the journey       | 1      |
|   departure    |   String       |   Yes      |   Departure airport code, 3 letters IATA code        | HKG      |
|   arrival    |   String       |   Yes      |  Arrival airport code, 3 letters IATA code        | BKK      |
|   flightNum    |   String       |   Yes      |   Flight number, format:Airline code and flight number       | CX618      |
|   cabinClass    |   String       |   Yes      |   Cabin class. Refer to 4.1       | ECONOMY     |
|   bookingCode    |   String       |   Yes      |   Booking code       | E      |
|   pnr    |   String       |   No     |   PNR of this segment, the booking reference of reservation system. It will be blank if the reservation made for the whole order.       | Y78UJK     |
|   airPnr    |   String       |   No     |   PNR of this segment, the booking reference of airline system. It will be blank if the reservation made for the whole order.       | CX/8IJ7LN     |
|   ticketNums    |   Array       |   No     |   Passesger and ticket number information. Refer to 2.1.8.       | -      |

##### 2.1.3 Passengers
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   lastName     |   String       |   Yes      |   Last name       | wang       |
|   firstName       |   String        |   Yes      |  First name    | jia    |
|   birthday     |   String       |   Yes    |  Date of birth [yyyy-mm-dd]       | 1988-10-10     |
|   sex     |   String       |   Yes      |   Gender, M - male, F - Female. Refer to 4.4    |   M     |
|   psgType     |   String       |   Yes      |   ADT - adult, CHD - child , INF-Infant. Refer to 4.3   |   CHD     |
|   cardType    |   String       |   No      |   Travel document type. Refer to 4.2    |   P     |
|   cardNum    |   String       |   No      |   Travel document number    |   P78921345     |
|   cardExpiredDate    |   String       |   No      |   Travel document expiration date, [yyyy-mm-dd]    |   2025-03-03     |
|   nationality    |   String       |   Yes      |   Nationality of the passenger, 2 letters country code    |   CN     |
|   ticketNum    |   String       |   No      |   Ticket number. If multiple ticket numbers, it will be separted by slash[/]    |   9991234567890/9991234567891     |

##### 2.1.4 OriginFlightList
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   journeys     |   Array       |   Yes      |   Journey information. Refer to 2.1.6.       | -       |

##### 2.1.5 changeFlightList
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   journeys     |   Array       |   Yes      |   Journey information. Refer to 2.1.6.       | -       |

##### 2.1.6 journeys
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   journeySeq     |   Integer       |   Yes      |   Journey sequency, outbound refer to 1, inbound refer to 2.      | 1       |
|   segments     |   Array       |   Yes      |   flight information. Refer to 2.1.7.       | -       |

##### 2.1.7 segments
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   airline    |   String       |   Yes      |   Airline code       | CX      |
|   flightNum       |   String        |   Yes      |  Flight number    | 618    |
|   equipment     |   String       |   Yes    |  Equipment code       | 777     |
|   cabinClass    |   String       |   Yes      |   Cabin class. Refer to 4.1       | ECONOMY     |
|   bookingCode    |   String       |   Yes      |   Booking code    |   E     |
|   departure    |   String       |   Yes      |   Departure airport code, 3 letters IATA code    |   HKG     |
|   arrival    |   String       |   Yes      |  Arrival airport code, 3 letters IATA code        | BKK      |
|   departureTerminal    |   String       |   No      |  Departure terminal       | 1      |
|   arrivalTerminal    |   String       |   No      |  Arrival terminal       | 1      |
|   departureDate    |   String       |   Yes      |   Departure date, [yyyy-mm-dd], local time of departure city    |   2025-03-03     |
|   arrivalDate    |   String       |   Yes      |   Arrival date, [yyyy-mm-dd], local time of arrival city    |   2025-03-03     |
|   departureTime    |   String       |   Yes      |   Departure time, [hh:mm],local time of departure city     |   10:10    |
|   arrivalTime    |   String       |   Yes      |   Arrival time, [hh:mm], local time of arrival city    |   10:10    |
|   flightTime    |   Integer       |   Yes      |   Flight time, unit: minutes    |   890    |
|   stayTime    |   Integer       |   No      |   Stay time for stopover flight, unit: minutes    |   120    |
|   codeShare    |   String       |   Yes      |   Code share flight flag, Y - Code share flight, N - Not code share flight    |   N    |
|   opFltNo    |   String       |   No      |   Operation flight number    |   160    |
|   opFltAirline    |   String       |   No      |   Operation airline    |   KA    |
|   stopover    |   String       |   No      |   Stopover airport code, 3 letters IATA code    |   CNX    |
|   messageType    |   String       |   No      |   Message type: <br>1-Flight changed<br> 2-Flight canceled with protect flight<br>3-Flight canceled<br>4-Flight resumted. <br>5- Flight overbooking.<br>For type 3, 4 and 5, there is no ChangeFlightList information.    |   1    |

##### 2.1.8 ticketNums
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   ticketNum     |   String       |   No      |   Ticket number       | -       |
|   lastName     |   String       |   Yes      |   Last name       | wang       |
|   firstName       |   String        |   Yes      |  First name    | jia    |
|   birthday     |   String       |   Yes    |  Date of birth [yyyy-mm-dd]       | 1988-10-10     |
|   sex     |   String       |   Yes      |   Gender, M - male, F - Female. Refer to 4.4    |   M     |
|   cardType    |   String       |   No      |   Travel document type. Refer to 4.2    |   P     |
|   cardNum    |   String       |   No      |   Travel document number    |   P78921345     |

#### 2.2 Request Sample
##### 2.2.1 JSON request sample
```
{
    "messageId": "2944695",
    "messageCreateTime": "2023-02-22 15:07:10",
    "orderAirlinePnr": "CX/WCK5N6|AA/HMMRAK",
    "orderNum": "916727111389870001",
    "buyerOrder":"10387629"
    "orderPnr": "HMMRRJ",
    "sensitivityLevel": "1",
    "changeFlightList": [
                {
                    "airline": "AA",
                    "arrival": "DFW",
                    "arrivalDate": "2023-12-03",
                    "arrivalTime": "16:50",
                    "bookingCode": "C5",
                    "cabinClass": "FIRST",
                    "codeShare": "N",
                    "departure": "HKG",
                    "departureDate": "2023-11-24",
                    "departureTime": "14:20",
                    "equipment": "77W",
                    "flightNum": "126",
                    "stayTime": 0,
                    "stopover": ""
                }
            ]
        }
    ],
    "originFlightList": [
        {
            "journeySeq": "1",
            "segments": [
                {
                    "airline": "AA",
                    "arrival": "DFW",
                    "arrivalDate": "2023-12-02",
                    "arrivalTime": "16:50",
                    "bookingCode": "C5",
                    "cabinClass": "FIRST",
                    "codeShare": "N",
                    "departure": "HKG",
                    "departureDate": "2023-11-26",
                    "departureTime": "14:20",
                    "equipment": "77W",
                    "flightNum": "126",
                    "messageType": "2",
                    "stayTime": 0,
                    "stopover": "",
                    "messageType":2
                }
            ]
        }
    ],
    "passengers": [
        {
            "birthday": "2003-02-12",
            "cardExpiredDate": "2025-02-05",
            "cardNum": "89374924",
            "cardType": "PP",
            "firstName": "BLAKE",
            "lastName": "HUBBARD",
            "nationality": "US",
            "psgType": "ADT",
            "sex": "M",
            "ticketNum": "0063742676484"
        },
        {
            "birthday": "2003-04-01",
            "cardExpiredDate": "2025-03-25",
            "cardNum": "293874123",
            "cardType": "PP",
            "firstName": "DARRYL",
            "lastName": "COX",
            "nationality": "US",
            "psgType": "ADT",
            "sex": "F",
            "ticketNum": "0063742676484"
        }
    ]
}

```


### 3. Response Parameter
This response is returned by the buyer partners. Please respond in the format we provided below. Otherwise system is not able to recognize the response. If the response is not with 'errorCode' 0, it will be recognized as failed.

#### 3.1 Response Parameter Contruction
| Name          | Type    | Parameter Description                        | Sample |
| ------------- | ------- | -------------------------------------------- | ------ |
|  errorCode    |  String    |  Error code                           |  0       |
|  errorMsg     |  String    |  Error message                                 |  OK      |

#### 3.2 Response Sample
##### 3.2.1 Normal Response
```
{
    "errorCode":"0",
    "errorMsg":"ok"
}
```

##### 3.2.2 Error Response
```
{
    "errorCode": "1",
    "errorMsg": "Failure reason",
}
```
</br>
### 4 Appendix
#### 4.1 Cabin Class
| Enum   | Description   |
|----|----|
|  ECONOMY           |  Economy Class    |
|  PREMIUM ECONOMY   |  Premium Economy Class  |
|  BUSINESS          |  Business Class    |
|  FIRST             |  First Class    |

#### 4.2 Type of Travel Document
| Enum   | Description   |
|----|----|
|  P       |  Passport    |
|  N       |  Chinese Identity    |
|  O       | Others    |

#### 4.3 Passenger Type
| Enum   | Description   |
|----|----|
|  ADT     |  adult         |
|  CHD     |  children[2-12 years old]  |

#### 4.4 Gender
| Enum   | Description   |
|----|----|
|  M       |  Male    |
|  F       |  Female    |


</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>