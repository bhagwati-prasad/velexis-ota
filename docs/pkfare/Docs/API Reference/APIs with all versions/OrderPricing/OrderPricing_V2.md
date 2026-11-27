# OrderPricing_V2

### 1 Document Description
#### 1.1 Function Description
Through OrderPricing_v2 API, users can check if the PNR and order price are available before doing the payment to ensure the validity of order price and PNR. It is mandatory to invoke OrderPricing before Ticketing. If there is no OrderPricing record before Ticketing, system would call OrderPricing service automatically.
Ticketing need to be done within `30 minutes` after OrderPricing.
`Note:` The difference from the OrderPricing interface is the ability to check the ancillary price.

#### 1.2 Target Reader
The OrderPricing_V2 API document targets people who work in the fields of network development, maintenance as well as management, and they should have the knowledge of at least one of following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: https://api.pkfare.com/orderPricingV2
Address in production environment: https://pending.com/orderPricingV2

### 2 Request Parameter
#### 2.1 Parameter Construction
##### 2.1.1 Authentication
| Name      | Type   | Required or Not | Description                     | Sample |
| --------- | ------ | --------------- | ------------------------------- | ------ |
| partnerId | String | Yes             | partner ID                      | -      |
| sign      | string | Yes             | signature, refer to 4.1 and 4.2 | -      |

##### 2.1.2 OrderPricing
| Name     | Type | Required or Not | Description  | Sample     |
| -------- | ---- | --------------- | ------------ | ---------- |
| orderNum | Long | Yes             | order Number | 1012694529 |

#### 2.2 Request Sample
##### 2.2.1 JSON Format Sample
`Case 1`  JSON format sample as below:
```
{
    "authentication": {
        "partnerId": "sVSX7PfZm1yF04adBWYsCD7M4:",
        "sign": "e707b5d9dae8459065dbb139e5f1bd"
    },
    "orderPricing": {
        "orderNum": 1012694529
    }
}
```

##### 2.2.2 Base64 Encryption
Use `Base64` to encode results from 2.2.1 Case 1:
```
eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWNDU5MDY1ZGJiMTM5ZTVmMWJkIn0sIm9yZGVyUHJpY2luZyI6eyJpbmRpY2F0b3JCSUMiOjAsImlzUmVCb29rIjowLCJvcmRlck51bSI6MTAxMjY5NDUyOX19
```

##### 2.2.3 Encryption Request Sample
This sample is for reference only:
```
http://api.pkfare.com/orderPricing?param:eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sIm9yZGVyUHJpY2luZyI6eyJpbmRpY2F0b3JCSUMiOjAsImlzUmVCb29rIjowLCJvcmRlck51bSI6MTAxMjY5NDUyOX19
```

### 3 Response Parameter
#### 3.1 Response Parameter Construction
The data returned is in `JSON` format. For specific fields, please refer to following charts.
##### 3.1.1 Basic Parameter
| Name      | Type   | Description                                                  | Sample |
| --------- | ------ | ------------------------------------------------------------ | ------ |
| errorCode | String | error code                                                   | 0      |
| errorMsg  | String | error message                                                | OK     |
| data      | Object | returned data will not be null only if the errorCode returns "0". Data is in JSON format, which contains two collections: pricingResult (3.1.2), orderResult (3.1.6) | -      |

##### 3.1.2 PricingResult
| Name     | Type   | Description    | Sample |
| -------- | ------ | -------------- | ------ |
| solution | Object | refer to 3.1.3 | -      |
| flights  | Array  | refer to 3.1.4 | -      |
| segments | Array  | refer to 3.1.5 | -      |
| ancillary | Object  | refer to 3.1.7 | - |

##### 3.1.3 Solution
| Name               | Type       | Description                                                  | Sample |
| ------------------ | ---------- | ------------------------------------------------------------ | ------ |
| currency           | String     | currency                                                     | USD    |
| buyerExchRate      | BigDecimal | buyer exchange rate, not supported yet                       | 0      |
| adtFare            | BigDecimal | fare for adult                                               | 139    |
| adtTax             | BigDecimal | taxes for adult                                              | 166    |
| chdFare            | BigDecimal | fare for child[age 2-12]                                     | 100    |
| chdTax             | BigDecimal | taxes for child[age 2-12]                                    | 100    |
| fareType           | String     | fare type, refer to 5.2                                      | PUBLIC |
| qCharge            | BigDecimal | Q Charge, for reference only                                 | 0      |
| tktFee             | BigDecimal | ticketing Fee                                                | 0      |
| platformServiceFee | BigDecimal | platform Service Fee, for reference only                     | 0      |
| journeys           | String[]   | Journeys. JSON format string array. Content: flight ID. The flight ID in journey is the specific one chose by users. Refer to 3.1.4 | -      |
| merchantFee        | BigDecimal | payment transaction fee                                      | 7.39   |

##### 3.1.4 Flights
| Name          | Type     | Description                                                  | Sample                           |
| ------------- | -------- | ------------------------------------------------------------ | -------------------------------- |
| flightId      | String   | flight ID, unique identification                             | 9ef88fd9dae30560c683911f534c6c49 |
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

##### 3.1.6 OrderResult
| Name     | Type   | Description  | Sample     |
| -------- | ------ | ------------ | ---------- |
| orderNum | Long   | order number | 1012694529 |
| pnr      | String | pnr          | EADADW     |

##### 3.1.7 Ancillary
| Name | Type | Description | Sample |
| ------------- | -------- | ------------------------------------------------------------ | -------------------------------- |
| lastName | String | last name | WANG |
| firstName | String | first name | JANGO |
| psgType | String | passenger type; ADT-Adult, CHD-Child[2-12 years old] | ADT |
| ancillaries | Object | ancillary data | - |

##### 3.1.8 Ancillaries
| Name | Type | Description | Sample |
| ------------- | -------- | ------------------------------------------------------------ | -------------------------------- |
| baggage | Object | baggage details | - |

##### 3.1.9 Baggage
| Name | Type | Description | Sample |
| ------------- | -------- | ------------------------------------------------------------ | -------------------------------- |
| ancillaryType | Integer | baggage details; 1-baggage | 1 |
| payBaggageType | Integer | baggage type; 1-checked baggage, 2-carry-on baggage | 1 |
| baggagePiece | Integer | baggage piece; -1 - no limit to baggage piece | 1 |
| baggageWeight | String | baggage weight | 20KG |
| baggageCurrency | String | currency | CNY |
| baggagePrice | bigDecimal | price | 198.00 |
| description | String | baggage description | - |
| journeys | Object | itinerary information | - |
| buyerOrder | String | buyer ancillary order number | - |

##### 3.1.10 Journey
| Name | Type | Description | Sample |
| ------------- | -------- | ------------------------------------------------------------ | -------------------------------- |
|airline |String |airline code |FD |
|departure |String |origin[IATA airport code] |DMK |
|departureDate |String |departure date[yyyy-MM-dd] |2022-10-01 |
|departureTime |String |departure time[hh:mm] |09:55 |
|arrival |String |destination[IATA airport code] |CNX |
|arrivalDate |String |arrival date[yyyy-MM-dd] |2022-10-01 |
|arrivalTime |String |arrival time[hh:mm] |11:25 |
|flightNum |String |flight number |513 |
|bookingCode |String |cabin code |N |

#### 3.2 Response Sample
##### 3.2.1 Normal Response
```
{
    "data": {
        "orderResult": {
            "orderNum": 1014766841,
            "pnr": "SQFTQJ"
        },
        "pricingResult": {
            "flights": [
                {
                    "flightId": "1068c6e4c8051cfd4e9ea8072e3189e2",
                    "journeyTime": 450,
                    "segmengtIds": [
                        "b8ea011c2f09f69cfe9311ceef3e3a5b",
                        "43ee963d98ef57314e55677c10b86ca0"
                    ],
                    "transferCount": 1
                }
            ],
            "segments": [
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
                },
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
                }
            ],
            "solution": {
                "adtFare": 1330,
                "adtTax": 753.00,
                "buyerExchRate": 0,
                "chdFare": 0,
                "chdTax": 0,
                "currency": "CNY",
                "fareType": "PUBLIC",
                "journeys": {
                    "journey_0": [
                        "1068c6e4c8051cfd4e9ea8072e3189e2"
                    ]
                },
                "merchantFee": 2.08,
                "platformServiceFee": 0,
                "qCharge": 0,
                "tktFee": 0.00
            }
            "ancillary": [
                {
                    "lastName": "NING",
                    "firstName": "YAO",
                    "psgType": "ADT",
                    "ancillaries": {
                        "baggage": [
                            {
                                "journeys": [
                                    {
                                        "airline": "MU",
                                        "arrival": "PVG",
                                        "arrivalDate": "2017-07-07",
                                        "arrivalTime": "07:20",
                                        "bookingCode": "R",
                                        "departure": "KUL",
                                        "departureDate": "2017-07-07",
                                        "departureTime": "02:10",
                                        "flightNum": "9862"
                                    },
                                    {
                                        "airline": "MU",
                                        "arrival": "HKG",
                                        "arrivalDate": "2017-07-07",
                                        "arrivalTime": "11:50",
                                        "bookingCode": "B",
                                        "departure": "PVG",
                                        "departureDate": "2017-07-07",
                                        "departureTime": "09:30",
                                        "flightNum": "501"
                                    }
                                ],
                                "ancillaryType": 1,
                                "baggageCurrency": "CNY",
                                "baggagePiece": 1,
                                "baggagePrice": 663,
                                "baggageWeight": "50KG",
                                "description": "extra 1 piece baggage",
                                "payBaggageType": 1,
                            }
                        ]
                    },
                }
            ],
        }
    },
    "errorCode": "0",
    "errorMsg": "ok"
}
```

##### 3.2.2 Error Response
```
{
    "errorCode": "B010",
    "errorMsg": "Order number not exist",
    "data": null
}
```

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

### 5 Appendix
#### 5.1 Error Code List

| errorCode | errorMsg                                                     | Description                                                  |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 0         | ok                                                           | Request has been processed successfully.                     |
| P001      | -                                                            | Wrong parameter                                              |
| S001      | System error                                                 | System error                                                 |
| 310       | Retrieve PNR failed, please try again.                       | Retrieve PNR failed                                          |
| B002      | Partner is not exists                                        | PartnerID does not exist                                     |
| B003      | Illegal sign                                                 | Illegal sign. Please check your signature                    |
| B009      | Order status is invalid                                      | Order status is invalid                                      |
| B010      | The order was not found                                      | The order was not found.                                     |
| B026      | Latest_tkt_time will be expired within 1 hour.               | Latest ticketing time will be expired within 1 hour.         |
| B101      | supplier status is invalid                                   | Supplier is offline.                                         |
| B102      | Segment status is invalid.                                   | Segment status is invalid.                                   |
| B103      | No airline PNR existed, please try again.                    | No airline PNR exist.                                        |
| B104      | Flight No. in PNR is not match with the one in the order     | Flight No. in PNR is not match with the one in the order .   |
| B105      | Passenger No. in PNR is not match with the one in the order  | Passenger No. in PNR is not match with the one in the  order. |
| B106      | No price                                                     | PNR has no filed fare.                                       |
| B107      | Fare changed, and update order failed. Please try again.     | Fare changed, and update order failed.                       |
| B108      | Supplier has cross the day, fare is not guaranteed.          | Supplier had crossed the day, fare is not guaranteed.        |
| B109      | Supplier has cross the day, and price has changed            | Supplier had crossed the day, and price has changed.         |
| B112      | The order has been paid before, please update status  accordingly. | The order had been paid before.                              |
| B113      | Filed fare in PNR is not match with the price in the order,  and price has changed. | Filed fare in PNR is not match with the price in the order,  and price had changed. |
| B114      | Flight changed                                               | Flight changed                                               |
| B115      | Latest_tkt_time has expired.                                 | Latest ticketing time is expired.                            |
| B116      | Price changed                                                | Price  had changed                                           |
| B117      | Order Pricing failed                                         | Caused  by other reasons, please connect administrator       |
| B118      | PNR status is invalid                                        | PNR status is invalid                                        |
| B119      | Order Pricing failed, please try again                       | LCC content: Pre-check before payment failed. Please try again |
| B120      | Order Pricing failed                                         | Supplier saved booking failed.                               |

#### 5.2 Fare Type
| Enum    | Description  |
| ------- | ------------ |
| PUBLIC  | public fare  |
| PRIVATE | private fare |

#### 5.3 Cabin Class
| Enum           | Description           |
| -------------- | --------------------- |
| ECONOMY        | economy class         |
| PREMIUM ECONOMY | premium economy class |
| BUSINESS       | business class        |
| FIRST          | first class           |

</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>