# PreciseBooking

### 1 Document Description
#### 1.1 Function Description
Through PreciseBooking API, users can create a PNR and an order in PKAFRE.
`Note` This interface depends on the result of precisePricing.
`Note` It is necessary to use PrecisePricing service before using this interface. The whole process should be limited to `30 mins`.

#### 1.2 Target Reader
The PreciseBooking API document targets people who work in the fields of network development, maintenance as well as management, and they should have the knowledge of at least one of following programming language: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: https://api.pkfare.com/preciseBooking
Address in production environment: https://pending.com/preciseBooking
</br>
### 2 Request Parameter
#### 2.1 Parameter Construction
##### 2.1.1 Authentication
| Name      | Type   | Required or Not | Description                     | Sample |
| --------- | ------ | --------------- | ------------------------------- | ------ |
| partnerId | String | Yes             | partner ID                      | -      |
| sign      | String | Yes             | signature, refer to 4.1 and 4.2 | -      |

##### 2.1.2 Booking
| Name       | Type   | Required or Not | Description                           | Sample |
| ---------- | ------ | --------------- | ------------------------------------- | ------ |
| passengers | Array  | Yes             | passenger information, refer to 2.1.3 | -      |
| solution   | Object | Yes             | journey information, refer to 2.1.4   | -      |
| buyerOrder   | String | No             | Your order number if you want to store at PKFARE side.   | -      |

##### 2.1.3 Passengers
| Name            | Type   | Required or Not | Description                           | Sample     |
| --------------- | ------ | --------------- | ------------------------------------- | ---------- |
| birthday        | String | Yes             | date of birth                         | 2015-01-10 |
| cardType        | String | No             | type of travel document, refer to 5.3. Passengers could make reservations with Chinese Identity if the itinerary is China domestic journey (NOT including Hong Kong, Macao and Taiwan). If using Chinese Identity please input 'N' into 'cardType' and input name in Chinese character.If bookingWithoutCard is 1 in responds of PrecisePricing_V2, you can leave it as blank. | P          |
| cardNum         | String | No             | travel document number. If bookingWithoutCard is 1 in responds of PrecisePricing_V2, you can leave it as blank.                | G2568574   |
| cardExpiredDate | String | No             | travel document expired date. If using Chinese Identity please input a fake cardExpiredDate to pass the parameter validation. If bookingWithoutCard is 1 in responds of PrecisePricing_V2, you can leave it as blank.          | 2020-05-06 |
| lastName        | String | Yes             | last name. Please use a real name and do not use "TEST"                             | Wang       |
| firstName       | String | Yes             | first name. Please use a real name and do not use "TEST"                            | Jango      |
| nationality     | String | Yes             | nationality [country code].        | CN         |
| psgType         | String | Yes             | passenger type, see 5.4               | ADT        |
| sex             | String | Yes             | gender, refer to 5.5                  | M          |

##### 2.1.4 Solution
| Name     | Type       | Required or Not | Description                     | Sample |
| -------- | ---------- | --------------- | ------------------------------- | ------ |
| fareType | String     | No              | the type of fare, refer to 5.6  | PUBLIC |
| adtFare  | BigDecimal | No              | adult fare                      | 1206   |
| adtTax   | BigDecimal | No              | adult tax                       | 1298   |
| chdFare  | BigDecimal | No              | child[age 2-12] fare            | 803     |
| chdTax   | BigDecimal | No              | child[age 2-12] tax             | 200     |
| comments | String     | No              | comments                        | -     |
| journeys | Object[]   | Yes             | journey, refer to 2.1.5 Journey | -      |

##### 2.1.5 Journey
| Name          | Type   | Required or Not | Description                    | Sample     |
| ------------- | ------ | --------------- | ------------------------------ | ---------- |
| airline       | String | Yes             | airline code                   | SA         |
| flightNum     | String | Yes             | flight No.                     | 102        |
| arrival       | String | Yes             | destination[IATA airport code] | CPT        |
| arrivalDate   | String | Yes             | arrival Date[yyyy-mm-dd]       | 2015-11-11 |
| arrivalTime   | String | Yes             | arrival Time[hh:mm]            | 11:45      |
| departure     | String | Yes             | departure[IATA airport code]   | BKK        |
| departureDate | String | Yes             | departure Date[yyyy-mm-dd]     | 2015-11-30 |
| departureTime | String | Yes             | departure Time[hh:mm]          | 07:05      |
| bookingCode   | String | Yes             | cabin code                     | N          |

#### 2.2 Request Sample
##### 2.2.1 JSON Format Sample
`Case 1` JSON format sample as below:
```
    {
        "authentication": {
            "partnerId": "sVSX7PfZm1yF04adBWYsCD7M4=",
            "sign": "e707b5d9dae8459065dbb139e5f1bd"
        },
        "booking": {
            "buyerOrder": "B1234567890",
            "passengers": [
                {
                    "birthday": "1988-10-22",
                    "cardExpiredDate": "2020-02-05",
                    "cardNum": "G65896223",
                    "cardType": "P",
                    "firstName": "JANGO",
                    "lastName": "WANG",
                    "nationality": "CN",
                    "psgType": "ADT",
                    "sex": "M"
                }
            ],
            "solution": {
                "adtFare": 1206,
                "adtTax": 1298,
                "chdFare": 1000,
                "chdTax": 1000,
                "journeys": {
                    "journey_0": [
                        {
                            "airline": "MU",
                            "arrival": "KMG",
                            "arrivalDate": "2015-09-18",
                            "arrivalTime": "00:05",
                            "bookingCode": "B",
                            "departure": "PEK",
                            "departureDate": "2015-09-17",
                            "departureTime": "20:35",
                            "flightNum": "5708"
                        },
                        {
                            "airline": "MU",
                            "arrival": "SIN",
                            "arrivalDate": "2015-09-19",
                            "arrivalTime": "02:00",
                            "bookingCode": "V",
                            "departure": "KMG",
                            "departureDate": "2015-09-18",
                            "departureTime": "22:40",
                            "flightNum": "5093"
                        }
                    ],
                    "journey_1": [
                        {
                            "airline": "MU",
                            "arrival": "PVG",
                            "arrivalDate": "2015-09-22",
                            "arrivalTime": "22:05",
                            "bookingCode": "V",
                            "departure": "SIN",
                            "departureDate": "2015-09-22",
                            "departureTime": "16:35",
                            "flightNum": "568"
                        },
                        {
                            "airline": "MU",
                            "arrival": "PEK",
                            "arrivalDate": "2015-09-23",
                            "arrivalTime": "15:10",
                            "bookingCode": "B",
                            "departure": "PVG",
                            "departureDate": "2015-09-23",
                            "departureTime": "12:25",
                            "flightNum": "564"
                        }
                    ]
                }
            }
        }
    }
```

##### 2.2.2 Base64 Encryption
Use `Base64` to encode results from Case 1:
```
eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sInByaWNpbmciOnsiYWR1bHRzIjoxLCJjaGlsZHJlbiI6MCwiaW5mYW50cyI6MCwiam91cm5leXMiOnsiam91cm5leV8wIjp7InNlZ21lbnRfMCI6eyJhaXJsaW5lIjoiU0EiLCJhcnJpdmFsIjoiSk5CIiwiYXJyaXZhbERhdGUiOiIyMDE1LTExLTIwIiwiYXJyaXZhbFRpbWUiOiIwNzo0NSIsImJvb2tpbmdDb2RlIjoiTiIsImRlcGFydHVyZSI6IkNQVCIsImRlcGFydHVyZURhdGUiOiIyMDE1LTExLTIwIiwiZGVwYXJ0dXJlVGltZSI6IjA1OjQ1IiwiZmxpZ2h0TnVtIjoiMzc4In19LCJqb3VybmV5XzEiOnsic2VnbWVudF8wIjp7ImFpcmxpbmUiOiJTQSIsImFycml2YWwiOiJDUFQiLCJhcnJpdmFsRGF0ZSI6IjIwMTUtMTEtMjUiLCJhcnJpdmFsVGltZSI6IjA4OjEwIiwiYm9va2luZ0NvZGUiOiJOIiwiZGVwYXJ0dXJlIjoiSk5CIiwiZGVwYXJ0dXJlRGF0ZSI6IjIwMTUtMTEtMjUiLCJkZXBhcnR1cmVUaW1lIjoiMDY6MDAiLCJmbGlnaHROdW0iOiIzMDMifX19fX0=
```

##### 2.2.3 Encryption Request Sample
This sample is for reference only:
```
http://api.pkfare.com/preciseBooking?param=eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sInByaWNpbmciOnsiYWR1bHRzIjoxLCJjaGlsZHJlbiI6MCwiaW5mYW50cyI6MCwiam91cm5leXMiOnsiam91cm5leV8wIjp7InNlZ21lbnRfMCI6eyJhaXJsaW5lIjoiU0EiLCJhcnJpdmFsIjoiSk5CIiwiYXJyaXZhbERhdGUiOiIyMDE1LTExLTIwIiwiYXJyaXZhbFRpbWUiOiIwNzo0NSIsImJvb2tpbmdDb2RlIjoiTiIsImRlcGFydHVyZSI6IkNQVCIsImRlcGFydHVyZURhdGUiOiIyMDE1LTExLTIwIiwiZGVwYXJ0dXJlVGltZSI6IjA1OjQ1IiwiZmxpZ2h0TnVtIjoiMzc4In19LCJqb3VybmV5XzEiOnsic2VnbWVudF8wIjp7ImFpcmxpbmUiOiJTQSIsImFycml2YWwiOiJDUFQiLCJhcnJpdmFsRGF0ZSI6IjIwMTUtMTEtMjUiLCJhcnJpdmFsVGltZSI6IjA4OjEwIiwiYm9va2luZ0NvZGUiOiJOIiwiZGVwYXJ0dXJlIjoiSk5CIiwiZGVwYXJ0dXJlRGF0ZSI6IjIwMTUtMTEtMjUiLCJkZXBhcnR1cmVUaW1lIjoiMDY6MDAiLCJmbGlnaHROdW0iOiIzMDMifX19fX0=
```
</br>
### 3 Response Parameter
#### 3.1 Response Parameter Construction
Response is structuralized in `JSON` format. About concrete fields, please refer to following tables.

__Price breakdown description: __
__Individual Adult Price = Adult Ticket Fare [adtFare] + Adult Ticket Tax [adtTax] + Ticketing Fee [tktFee]__
__Individual Child Price = Child Ticket Fare [chdFare] + Child Ticket Tax [chdTax] + Ticketing Fee [tktFee]__
__Total Price = Individual Adult Price \* adult passenger number [adults] + Individual Child Price] \* child passenger number [children] + Platform Service Fee [platformServiceFee] + Payment Transaction Fee [merchantFee]__
`Notes`
1 There is no charge for "platformServiceFee" at present; it can be ignored.
2 No payment transaction fee ("merchantFee") will be charged if the mode of payment is "Prepaid". "Alipay" will charge 0.1% of the Total Price.

##### 3.1.1 Basic Parameter
| Name      | Type   | Description                                                  | Sample |
| --------- | ------ | ------------------------------------------------------------ | ------ |
| errorCode | String | error code, refer to 5.1                                     | 0      |
| errorMsg  | String | error message                                                | OK     |
| data      | Object | return data, will not be empty when error code is "0". Refer to 3.1.2 | -      |

##### 3.1.2 Data
| Name     | Type   | Description    | Sample     |
| -------- | ------ | -------------- | ---------- |
| solution | Object | refer to 3.1.3 | -          |
| flights  | Array  | refer to 3.1.4 | -          |
| segments | Array  | refer to 3.1.5 | -          |
| pnr      | String | pnr            | KKXJS2     |
| orderNum | Long   | order number   | 1014766841 |

##### 3.1.3 Solution
| Name               | Type       | Parameter Description                                     | Sample                           |
| ------------------ | ---------- | --------------------------------------------------------- | -------------------------------- |
| solutionKey        | String     | unique identification                                     | 0357301bf213453389fcb55c379a4667 |
| fareType           | String     | fare type, refer to 5.2 Fare Type                         | PUBLIC                           |
| currency           | String     | currency                                                  | CNY                              |
| adtFare            | BigDecimal | adult fare                                                | 1011                             |
| adtTax             | BigDecimal | adult tax                                                 | 527                              |
| chdFare            | BigDecimal | children [age 2-12] fare                                  | 500                              |
| chdTax             | BigDecimal | children [age 2-12] tax                                   | 250                              |
| qCharge            | BigDecimal | Q charge, bunker adjustment surcharge, for reference only | 0                                |
| tktFee             | BigDecimal | ticketing service fee                                     | 0                                |
| platformServiceFee | BigDecimal | platform service fee, defaults to 0                       | 0                                |
| journeys           | String[]   | JSON format string array. Content: flightID(3.1.4)        | -                                |
| platingCarrier     | String     | ticketing airline                                         | CA                               |
| merchantFee        | BigDecimal | payment transaction fee                                   | 7.39                             |
| afterSaleRule      | Obejct     | after sale rule, not supported yet                        | -                                |

##### 3.1.4 Flights
| Name          | Type     | Description                                                  | Sample                           |
| ------------- | -------- | ------------------------------------------------------------ | -------------------------------- |
| flightId      | String   | flight ID， unique identification                            | 9ef88fd9dae30560c683911f534c6c49 |
| journeyTime   | Long     | journey Time, unit: minute                                   | 350                              |
| transferCount | Integer  | number of Transfer                                           | 1                                |
| lastTktTime   | String   | latest ticketing time (GMT)                                  | 2015-10-28 23:59:00              |
| segmengtIds   | String[] | number of segment arrays (please note the segmengtIds is a typo due to history edition) | -                                |

##### 3.1.5 Segments
| Name              | Type    | Parameter Description                           | Sample                           |
| ----------------- | ------- | ----------------------------------------------- | -------------------------------- |
| segmentId         | String  | segment ID, unique identification               | 4ee200cb7feab403d6babbf797ac92aa |
| airline           | String  | airline code                                    | CA                               |
| flightNum         | String  | flight number                                   | 6509                             |
| equipment         | String  | equipment                                       | 737                              |
| cabinClass        | String  | cabin class, refer to 5.3 Cabin Class           | Economy                          |
| bookingCode       | String  | cabin code                                      | E                                |
| availabilityCount | Integer | available seats, for reference only             | 7                                |
| departure         | String  | departure airport                               | PEK                              |
| arrival           | String  | arrival airport                                 | HKG                              |
| departureTerminal | String  | departure airport terminal                      | 3                                |
| arrivalTerminal   | String  | arrival airport terminal                        | 1                                |
| departureDate     | Long    | departure date [unix time]                      | 1446009600000                    |
| arrivalDate       | Long    | arrival date [unix time]                        | 1446017400000                    |
| flightTime        | Integer | flight time, unit: minute                       | 130                              |
| stayTime          | Integer | stay time, valid with 'stopover' , unit: minute | 60                               |
| codeShare         | String  | code share or not: [Y-yes, N-no]                | Y                                |
| opFltNo           | String  | flight number of operated carrier               | 202                              |
| opFltAirline      | String  | operated carrier                                | KA                               |
| stopover          | String  | stopover airport                                | PEK                              |
| strDepartureDate  | String  | departure date[yyyy-mm-dd], local time          | 2016-08-27                       |
| strDepartureTime  | String  | departure time[hh:mm], local time               | 09:30                            |
| strArrivalDate    | String  | arrival date[yyyy-mm-dd], local time            | 2016-08-27                       |
| strArrivalTime    | String  | arrival time[hh:mm], local time                 | 11:50                            |

#### 3.2 Response Example
##### 3.2.1 Normal Response
```
{
    "data": {
        "flights": [
            {
                "flightId": "ef8caaf829406399310863e678196849",
                "journeyTime": 450,
                "lastTktTime": "2017-07-07 23:59:00",
                "segmengtIds": [
                    "b8ea011c2f09f69cfe9311ceef3e3a5b",
                    "43ee963d98ef57314e55677c10b86ca0"
                ],
                "transferCount": 1
            }
        ],
        "orderNum": 1014766841,
        "pnr": "SQFTQJ",
        "segments": [
            {
                "airline": "MU",
                "arrival": "HKG",
                "arrivalDate": 1499399400000,
                "arrivalTerminal": "1",
                "availabilityCount": 1,
                "bookingCode": "B",
                "cabinClass": "ECONOMY",
                "codeShare": "N",
                "departure": "PVG",
                "departureDate": 1499391000000,
                "departureTerminal": "1",
                "equipment": "320",
                "flightNum": "501",
                "flightTime": 140,
                "opFltAirline": "",
                "segmentId": "43ee963d98ef57314e55677c10b86ca0",
                "strArrivalDate": "2017-07-07",
                "strArrivalTime": "11:50",
                "strDepartureDate": "2017-07-07",
                "strDepartureTime": "09:30"
            },
            {
                "airline": "MU",
                "arrival": "PVG",
                "arrivalDate": 1499383200000,
                "arrivalTerminal": "1",
                "availabilityCount": 1,
                "bookingCode": "R",
                "cabinClass": "ECONOMY",
                "codeShare": "Y",
                "departure": "KUL",
                "departureDate": 1499364600000,
                "departureTerminal": "M",
                "equipment": "738",
                "flightNum": "9862",
                "flightTime": 310,
                "opFltAirline": "FM",
                "opFltNo": "862",
                "segmentId": "b8ea011c2f09f69cfe9311ceef3e3a5b",
                "strArrivalDate": "2017-07-07",
                "strArrivalTime": "07:20",
                "strDepartureDate": "2017-07-07",
                "strDepartureTime": "02:10"
            }
        ],
        "solution": {
            "adtFare": 1330,
            "adtTax": 753.0,
            "afterSaleRule": {
                "changeNotes": null,
                "changeServiceFee": 84.0,
                "currency": "CNY",
                "refundNotes": null,
                "refundServiceFee": 42.0,
                "remark": "remark",
                "voidNotes": null,
                "voidServiceFee": -1.0
            },
            "buyerExchRate": 0,
            "chdFare": 0,
            "chdTax": 0,
            "currency": "CNY",
            "fareType": "PUBLIC",
            "journeys": {
                "journey_0": [
                    "ef8caaf829406399310863e678196849"
                ]
            },
            "merchantFee": 2.08,
            "platformServiceFee": 0,
            "platingCarrier": "MU",
            "qCharge": 0,
            "solutionKey": "3aed0b90f0c04b5ea51ad01f3470f254",
            "tktFee": 0.0
        }
    },
    "errorCode": "0",
    "errorMsg": "ok"
}
```

##### 3.2.2 Error Response
```
{
    "errorCode": "P001",
    "errorMsg": "Invalid authentication.",
    "data": null
}
```
</br>
### 4 Signature
#### 4.1 Parameters for Signature
partnerId, partnerKey

#### 4.2 Signature
Combine partnerId and partnerKey to make an MD5 encryption on final value.
Sign = MD5 (partnerId + partnerKey).
```
e.g.
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
</br>
### 5 Appendix
#### 5.1 Error Code List

| errorCode | errorMsg | Description |
| --------- | ------------------------ | -------------- |
| 0         | ok                                                           | Request has been processed successfully.                      |
| S001      | System error.                                                 | System error.                                                 |
| B002      | Partner is not exists.                                                            | PartnerID does not exist.                                              |
| B003      | Illegal sign.                                          | Illegal sign. Please check your signature.         |
| B035      | Concurrency limited. Please contact PKFARE API support team for assistant. | Concurrency exceeded system limits.       |
| P001      | XXX is illegal.                                        | The field of XXX is illegal.                                     |
| P002      | XXX is missing.                                                 | The field of XXX is missing.                  |
| P006      | Invalid parameter.                                                 | Value of request cannot pass the validation, please check on the request.                  |
| 0307      | Reservation failed - Booking class is sold out.                                                 | Reservation failed. Seats have been sold out.                  |
| B005      | Can not find any matching precisePricing result within 30 minutes.                                                 | Can not find the corresponding precisePricing record. Please check the itinerary and passenger numbers. PreciseBooking has to be invoked within 30 minutes after pricing.                  |
| B006      | Reservation failed - Other. OrderNum is XXX.                                                 | Booking fail for other reason. The order has been created which is indicated in Other.OrderNum field                 |
| B006      | Reservation failed.                                                 | Booking fail for other reason.                  |
| B007      | Reservation failed - Segment status is not HK.                                                 | Segment status is invalid from GDS. Please select other flight options.                  |
| B008      | Itinerary is different between PNR and order.                                                 | Itinerary in reservation is different from precisePricing. There might be a flight re-schedule. Please select other flight options.                  |
| B011      | Reservation failed - Fare is unavailable.                                                 | Fare is unavailable form GDS. Please select other flight options.                  |
| B012      | Reservation failed - Create PNR time out.                                                 | Create PNR time out from GDS. Please wait some minutes or select other flight options.               |
| B017      | Price is changed.                                                 | Price is changed.                   |
| B023      | Reservation failed - Save price fail.                                                 | Fail to save price from GDS.                  |
| B025      | Reservation failed - RT PNR fail.                                                 | Fail to retieve PNR from GDS.                  |
| B027      | Airline PNR is missing.                                                 | Airline PNR is missing from GDS.                  |
| B028      | Reservation failed - Time out.                                                 | Booking time out from GDS.                  |
| B029      | Duplicate reservations have been found for passenger XXX/XXX in order XXX, in pnr XXX.                                                 | Duplicated reservation is not allowed. If there is an order with same segment and passenger, system will block the second reservation and return error. Please cancel the last duplicated order or pay the last order directly.                  |
| B030      | Illegal passenger name, please use Chinese character.                                                 | Wrong passenger name. If passengers use Chinese ID card to make reservation for China domestic flight, please use Chinese character.                  |
| B031      | Illegal passenger name, please use correct Chinese character.                                                 | Wrong passenger name. If passengers use chinese ID card to make reservation, the chinese name length is over the limitation.                  |
| B032      | Illegal passport, please use 'N' as document type if you are using Chinese ID card to make reservation.                                                 | Illegal passport. If passengers book Chinese flight, please use correct passport.                 |
| B043      | Reservation failed: Create PNR failed.                                                | Booking failed from GDS.                  |
| B044      | Reservation failed - Create PNR failed, end transaction failed.                                                 | Booking failed from GDS.                  |
| B062      | The length of passenger name should be 40 English alphabet including / between last name and first name.                                                 | Passenger's name should be within 40 English alphabet, including "/" between last name and first name.                 |
| B064      | The lastName of passegner should be within 2-30 English alphabet.                                                 | Passenger's last name should be within 2-30 English alphabet.                 |
|B065|Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality.|Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality.Please contact PKFARE API support.|
| B069      | Reservation failed, this fare has passenger age limitation.                   | Reservation failed, because this fare has a passenger age limition. |
| B121      | Supplier is offline                   | Supplier is not at working time, please contact PKFARE API support. |



#### 5.2 Cabin Class
| Enum           | Description           |
| -------------- | --------------------- |
| ECONOMY        | economy class         |
| PREMIUM ECONOMY | premium economy class |
| BUSINESS       | business class        |
| FIRST          | first class           |

#### 5.3 Type of Travel Document
Passengers could make reservations with Chinese Identity if the itinerary is China domestic journey (NOT including Kong Kong, Macao and Taiwan).

| Enum | Description     |
| ---- | --------------- |
| P    | Passport        |
| N    | Chinese Identity |
| O    | Others          |

#### 5.4 Passenger Type
| Enum | Description               |
| ---- | ------------------------- |
| ADT  | adult                     |
| CHD  | children [2-12 years old] |

#### 5.5 Gender
| Enum | Description |
| ---- | ----------- |
| M    | Male        |
| F    | Female      |

#### 5.6 Fare Type
| Enum    | Description  |
| ------- | ------------ |
| PUBLIC  | public fare  |
| PRIVATE | private fare |
</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>