# PrecisePricing_V2

### 1 Document Description
#### 1.1 Function Description
Through PrecisePricing API, the precise price will be shown with specific flight details, including booking code and availability seat. If specific cabin class is requested (cabin class should be specified in all segments), the lowest fare corresponding to the specified class will be shown. If the cabin class is not provided in all segments (or partially provided), a lowest available fare will be shown.
PrecisePricing service is able to check flight price basing on cabin class. 

`Note` PrecisePricing_V2 has same request structure as PrecisePricing. But PrecisePricing_V2 response includes structuralized fare rule and baggage information. The after-sale penalty you collect in PrecisePricing_V2 is for reference only. Please refer to Penalty API if you need to make a reservation.
`Note`Although BookingCode is an optional field in PrecisePricing_V2 requests, it is still highly recommended to fill BookingCode value in PrecisePricing requests if your search starts from Shopping requests, because this will avoid price change between Shopping and PrecisePricing to the maximum extent possible. And the the BookingCode you use shall be the one in our Shopping response . 
If your first PrecisePrcing request with BookingCode fail and you receive error code B020 or B021, it is recommonded to send us another PrecisePricing request without BookingCode value.
If your search starts from PrecisePricing, it is recommonded to leave BookingCode field empty in your PrecisePricng request.

#### 1.2 Target Reader
The PrecisePricing API document targets people who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of following programming language, such as ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: https://api.pkfare.com/precisePricing_V2
Address in production environment: https://pending.com/precisePricing_V2
`Note` PKFARE will provide production domain after Buyer Partners finish integration and co-test. Please replace 'pending.com' with the domain which PKFARE provides individually.
</br>
### 2 Request Parameter
#### 2.1 Parameter Construction
Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted.

##### 2.1.1 Authentication
| Name      | Type   | Required or Not | Description                     | Sample |
| --------- | ------ | --------------- | ------------------------------- | ------ |
| partnerId | String | Yes             | partner ID                      | -      |
| sign      | String | Yes             | signature, refer to 4.1 and 4.2 | -      |

##### 2.1.2 Pricing
| Name     | Type    | Required or Not | Description                                                  | Sample |
| -------- | ------- | --------------- | ------------------------------------------------------------ | ------ |
| journeys | Object  | Yes             | specified flight data, all the journeys in one solution must be included, refer to 2.1.3 | -      |
| adults   | Integer | Yes             | adult passenger number                                       | 1      |
| children | Integer | Yes             | child[age 2-12] passenger number                             | 1      |
| cabin    | String  | No              | cabin class ["" - the lowest cabin, C - business class, F - first class] if both 'cabin' and 'bookingCode' is valued, precisePricing service would base on 'bookingCode'. | C      |
| solutionKey | String | No             | Special usage, it is not required if you are not suggested to use it. SolutionKey in the return of previous call                             | a2ba983f73364c359420a12faf67179d     |

##### 2.1.3 Journey
| Name          | Type   | Required or Not | Description                    | Sample     |
| ------------- | ------ | --------------- | ------------------------------ | ---------- |
| airline       | String | Yes             | airline code                   | SA         |
| flightNum     | String | Yes             | flight number                  | 102        |
| arrival       | String | Yes             | destination[IATA airport code] | CPT        |
| arrivalDate   | String | Yes             | arrival Date[yyyy-MM-dd]       | 2015-11-11 |
| arrivalTime   | String | Yes             | arrival Time[HH:mm]            | 11:45      |
| departure     | String | Yes             | origin[IATA airport code]      | BKK        |
| departureDate | String | Yes             | departure Date[yyyy-MM-dd]     | 2015-11-30 |
| departureTime | String | Yes             | departure Time[HH:mm]          | 07:05      |
| bookingCode   | String | No              | cabin code                     | N          |

#### 2.2 Request Sample
##### 2.2.1 JSON Format Sample
`Case 1` : round trip or open jaw journey sample as following
```
{
    "authentication": {
        "partnerId": "sVSX7PfZmWYsCD7M4=",
        "sign": "e707b5d9dae8459065dbb139e5f1bd"
    },
    "pricing": {
        "adults": 1,
        "children": 1,
        "solutionKey":"a2ba983f73364c359420a12faf67179d",
        "journeys": {
            "journey_0": [{
                "airline": "SA",
                "arrival": "JNB",
                "arrivalDate": "2015-11-20",
                "arrivalTime": "07:45",
                "bookingCode": "N",
                "departure": "CPP",
                "departureDate": "2015-11-20",
                "departureTime": "05:45",
                "flightNum": "378"
            },
            {
                "airline": "SA",
                "arrival": "CPT",
                "arrivalDate": "2015-11-20",
                "arrivalTime": "12:40",
                "bookingCode": "N",
                "departure": "CPP",
                "departureDate": "2015-11-20",
                "departureTime": "10:45",
                "flightNum": "3654"
            }],
            "journey_1": [{
                "airline": "SA",
                "arrival": "CPT",
                "arrivalDate": "2015-11-25",
                "arrivalTime": "08:10",
                "bookingCode": "N",
                "departure": "JNB",
                "departureDate": "2015-11-25",
                "departureTime": "06:00",
                "flightNum": "303"
            }]
        }
    }
}
```

`Case 2` : one way trip sample as following
```
{
    "authentication": {
        "partnerId": "sVSX7PfZm1yF0BWYsCD7M4=",
        "sign": "e707b5d9dae8459065dbb139e5f1bd"
    },
    "pricing": {
        "adults": 1,
        "children": 1,
        "journeys": {
            "journey_0": [{
                "airline": "SA",
                "arrival": "JNB",
                "arrivalDate": "2015-11-20",
                "arrivalTime": "07:45",
                "bookingCode": "N",
                "departure": "CPT",
                "departureDate": "2015-11-20",
                "departureTime": "05:45",
                "flightNum": "378"
            }]
        }
    }
}
```

##### 2.2.2 Base64 Encryption
Use BASE64 to encode results from Case 1:
```
eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sInByaWNpbmciOnsiYWR1bHRzIjoxLCJjaGlsZHJlbiI6MCwiaW5mYW50cyI6MCwiam91cm5leXMiOnsiam91cm5leV8wIjp7InNlZ21lbnRfMCI6eyJhaXJsaW5lIjoiU0EiLCJhcnJpdmFsIjoiSk5CIiwiYXJyaXZhbERhdGUiOiIyMDE1LTExLTIwIiwiYXJyaXZhbFRpbWUiOiIwNzo0NSIsImJvb2tpbmdDb2RlIjoiTiIsImRlcGFydHVyZSI6IkNQVCIsImRlcGFydHVyZURhdGUiOiIyMDE1LTExLTIwIiwiZGVwYXJ0dXJlVGltZSI6IjA1OjQ1IiwiZmxpZ2h0TnVtIjoiMzc4In19LCJqb3VybmV5XzEiOnsic2VnbWVudF8wIjp7ImFpcmxpbmUiOiJTQSIsImFycml2YWwiOiJDUFQiLCJhcnJpdmFsRGF0ZSI6IjIwMTUtMTEtMjUiLCJhcnJpdmFsVGltZSI6IjA4OjEwIiwiYm9va2luZ0NvZGUiOiJOIiwiZGVwYXJ0dXJlIjoiSk5CIiwiZGVwYXJ0dXJlRGF0ZSI6IjIwMTUtMTEtMjUiLCJkZXBhcnR1cmVUaW1lIjoiMDY6MDAiLCJmbGlnaHROdW0iOiIzMDMifX19fX0=
```

##### 2.2.3 Encryption Request Sample
This sample is for reference only:
```
http://pending.pkfare.com/precisePricing?param=eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sInByaWNpbmciOnsiYWR1bHRzIjoxLCJjaGlsZHJlbiI6MCwiaW5mYW50cyI6MCwiam91cm5leXMiOnsiam91cm5leV8wIjp7InNlZ21lbnRfMCI6eyJhaXJsaW5lIjoiU0EiLCJhcnJpdmFsIjoiSk5CIiwiYXJyaXZhbERhdGUiOiIyMDE1LTExLTIwIiwiYXJyaXZhbFRpbWUiOiIwNzo0NSIsImJvb2tpbmdDb2RlIjoiTiIsImRlcGFydHVyZSI6IkNQVCIsImRlcGFydHVyZURhdGUiOiIyMDE1LTExLTIwIiwiZGVwYXJ0dXJlVGltZSI6IjA1OjQ1IiwiZmxpZ2h0TnVtIjoiMzc4In19LCJqb3VybmV5XzEiOnsic2VnbWVudF8wIjp7ImFpcmxpbmUiOiJTQSIsImFycml2YWwiOiJDUFQiLCJhcnJpdmFsRGF0ZSI6IjIwMTUtMTEtMjUiLCJhcnJpdmFsVGltZSI6IjA4OjEwIiwiYm9va2luZ0NvZGUiOiJOIiwiZGVwYXJ0dXJlIjoiSk5CIiwiZGVwYXJ0dXJlRGF0ZSI6IjIwMTUtMTEtMjUiLCJkZXBhcnR1cmVUaW1lIjoiMDY6MDAiLCJmbGlnaHROdW0iOiIzMDMifX19fX0=
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
| data      | Object | returned data, will not be empty when error code is "0". Data is in JSON format, including solutions (refer to 3.1.2), flights (refer to 3.1.3), segments (refer to3.1.4) | -      |

##### 3.1.2 Solution
| Name               | Type       | Parameter Description                                     | Sample                           |
| ------------------ | ---------- | --------------------------------------------------------- | -------------------------------- |
| solutionId         | String     | unique identification                                     | 25a061970d8a7ebeb5e63391b9788f36 |
| solutionKey        | String     | unique identification                                     | 0357301bf213453389fcb55c379a4667 |
| fareType           | String     | fare type, refer to 5.2 Fare Type                         | PUBLIC                           |
| currency           | String     | currency                                                  | CNY                              |
| adtFare            | BigDecimal | adult fare                                                | 1011                             |
| adtTax             | BigDecimal | adult tax                                                 | 527                              |
| chdFare            | BigDecimal | children [age 2-12] fare                                  | 500                              |
| chdTax             | BigDecimal | children [age 2-12] tax                                   | 250                              |
| infFare            | BigDecimal | infant[age 0-2] fare, not supported yet                   | 0                                |
| infTax             | BigDecimal | infant[age 0-2] tax, not supported yet                    | 0                                |
| qCharge            | BigDecimal | Q charge, bunker adjustment surcharge, for reference only | 0                                |
| tktFee             | BigDecimal | ticketing service fee                                     | 0                                |
| platformServiceFee | BigDecimal | platform service fee, defaults to 0                       | 0                                |
| journeys           | String[]   | JSON format string array. Content: flightID(3.1.3)        | -                                |
| platingCarrier     | String     | ticketing airline                                         | CA                               |
| merchantFee        | BigDecimal | payment transaction fee                                   | 7.39                             |
| baggages           | String[]   | baggage rule. Refer to 3.1.2.1                            | -                                |
| baggageMap         | Object     | baggage rule. For reference only. Including 'ADT' and 'CHD'. If the request does not include children, 'CHD' would be NULL. Refer to 3.1.5 | -                                |
| MiniRuleMap        | Object     | penalty rule. For reference only, please find precise penalty rule on Penalty API. Refer to 3.1.6 | -                                |
| bookingWithoutCard        | Integer    | Travel document require indicator, 0 - need travel document for booking, 1 - no need travel document for booking | -                                |

##### 3.1.2.1 Baggages
| Name    | Type    | Description                                                  | Sample            |
| ------- | ------- | ------------------------------------------------------------ | ----------------- |
| index   | Integer | index of journey sequence number 1 corresponds to Journey_0, 2 corresponds to Journey_1. | 1                 |
| baggage | String  | free baggage allowance. The field would be null if the information is failed to collected. Different segment baggage rule would be separated by ',' | 23KG              |
| carryOn | String  | free carry-on bag allowance. The field would be null if the information is failed to collected. Different segment baggage rule would be separated by ','. Part of carry-on info would be included size limitation, as sample | 55\*45\*25cm 10kg |

##### 3.1.3 Flights
| Name          | Type     | Description                                                  | Sample                           |
| ------------- | -------- | ------------------------------------------------------------ | -------------------------------- |
| flightId      | String   | flight ID， unique identification                            | 9ef88fd9dae30560c683911f534c6c49 |
| journeyTime   | Long     | journey time， unit: minute                                  | 350                              |
| transferCount | Integer  | count of transfer                                            | 1                                |
| lastTktTime   | String   | latest ticketing time (GMT)                                  | 2015-10-28 23:59:00              |
| segmentIds    | String[] | number of segment arrays (please note that this field has corrected typo in PrecisePricing\_V2) | -                                |

##### 3.1.4 Segments
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
| strDepartureDate  | String  | departure date[yyyy-MM-dd], local time          | 2016-08-27                       |
| strDepartureTime  | String  | departure time[HH:mm], local time               | 09:30                            |
| strArrivalDate    | String  | arrival date[yyyy-MM-dd], local time            | 2016-08-27                       |
| strArrivalTime    | String  | arrival time[HH:mm], local time                 | 11:50                            |
| fareBasis         | String  | Fare basis code                                 | SLCPWFR                          |

##### 3.1.5 baggageMap
| Name             | Type     | Parameter Description                                        | Sample |
| ---------------- | -------- | ------------------------------------------------------------ | ------ |
| segmentIndexList | String[] | segment index list for baggage. Index begins with '1'. If 1st segment has same baggage allowance with 3rd segment, please refer to sample | [1,3]  |
| baggageAmount    | String   | free baggage amount allowance. '1PC' for 1 piece             | 1PC    |
| baggageWeight    | String   | free baggage weight allowance                                | 15KG   |
| carryOnAmount    | String   | free carry-on baggage amount allowance. '1PC' for 1 piece    | 1PC    |
| carryOnWeight    | String   | free carry-on baggage weight allowance                       | 7KG    |

##### 3.1.6 MiniRuleMap
| Name         | Type     | Parameter Description                                        | Sample |
| ------------ | -------- | ------------------------------------------------------------ | ------ |
| segmentIndex | String[] | segment index list for penalty. Index begins with '1'. If 1st segment has same penalty rule with 3rd segment, please refer to sample | [1,3]  |
| miniRules    | Object   | refer to 3.1.6.1                                             | -      |

##### 3.1.6.1 miniRules
| Name           | Type       | Parameter Description                                        | Sample |
| -------------- | ---------- | ------------------------------------------------------------ | ------ |
| penaltyType    | Integer    | penalty type. [0 - refund, 1 - noShow refund, 2 - change, 3 - noShow change] | 0      |
| isPermited     | Integer    | allow refund/change or not. [0 - not allow, 1 - allow, 2 - unknown] | 1      |
| when           | Integer    | 0 - Both Outbound and Inbound are not used, 1- Outbound Flight used, 2 - all Situation] | 2      |
| noShowTime     | String     | noShow definition. Apply with 'noShowTimeUnit'               | 2      |
| noShowTimeUnit | String     | noShow Unit. Apply with 'noShowTime'. [H - hour, M - minute] | H      |
| amount         | BigDecimal | penalty                                                      | 300    |
| currencyCode   | String     | penalty currency                                             | CNY    |
| percent        | BigDecimal | penalty percentage. Apply with 'baseType'. Penalty and penalty percentage would not go into effect at the same. Please take the strict one. Unit: % | 10     |
| baseType       | Integer    | apply with 'percent'.  Multiply corresponding value of 'baseType' by 'percent' would be the penalty. [0 - fare, 1 - fare+tax+ticketingFee, 2 - cabin basic fare] | 0      |

#### 3.2 Response Example
##### 3.2.1 Normal Response
```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "solution": {
            "solutionKey": "a2ba983f73364c350a12faf67179d",
            "solutionId": "05a03ed12c3f7c5dbbb7460e5e8aa",
            "fareType": "PUBLIC",
            "currency": "EUR",
            "adtFare": 192.8,
            "adtTax": 84.44,
            "chdFare": 0,
            "chdTax": 0,
            "tktFee": 0,
            "platformServiceFee": 0,
            "comments": null,
            "journeys": {
                "journey_0": [
                    "17c6098b6e755c44abbffd9e9c298a3"
                ]
            },
            "fareRule": null,
            "rule": null,
            "platingCarrier": "MU",
            "prices": null,
            "merchantFee": 0,
            "adults": 2,
            "baggages": {
                "1": {
                    "carryOn": "1P",
                    "baggage": "1P"
                }
            },
            "baggageMap": {
                "ADT": [
                    {
                        "segmentIndexList": [
                            1
                        ],
                        "baggageAmount": "1 PC",
                        "baggageWeight": null,
                        "carryOnAmount": "1 PC",
                        "carryOnWeight": null
                    }
                ]
            },
            "afterSaleRule": null,
            "latestTktTime": "2019-06-21 12:59:00",
            "bookingWithoutCard": 0,
            "productType": "",
            "flag": 0
        },
        "flights": [
            {
                "flightId": "17c6098b6e755c44abbffd9e9c298a3",
                "journeyTime": 290,
                "transferCount": 0,
                "segmentIds": [
                    "96e184cb678736b199634861076e449"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "96e184cb678736b199634861076e449",
                "airline": "MU",
                "flightNum": "2072",
                "equipment": "333",
                "cabinClass": "ECONOMY",
                "bookingCode": "S",
                "availabilityCount": 9,
                "departure": "BKK",
                "arrival": "PEK",
                "departureTerminal": null,
                "arrivalTerminal": "2",
                "departureDate": 1561050300000,
                "arrivalDate": 1561071300000,
                "flightTime": 290,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": "",
                "stopover": null,
                "fareBasis": "SLSRWSA",
                "strDepartureDate": "2019-06-21",
                "strDepartureTime": "01:05",
                "strArrivalDate": "2019-06-21",
                "strArrivalTime": "06:55"
            }
        ]
    }
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
| errorCode | errorMsg                                                     | Description                                                  |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 0         | ok                                                           | Request has been processed successfully.                      |
| S001      | System error.                                                 | System error.                                                 |
| B002      | Partner is not exists.                                                            | PartnerID does not exist.                                              |
| B003      | Illegal sign.                                          | Illegal sign. Please check your signature.         |
| B035      | Concurrency limited. Please contact PKFARE API support team for assistant. | Concurrency exceeded system limits.       |
| P001      | XXX is illegal.                                        | The field of XXX is illegal.                                     |
| P002      | XXX is missing.                                                 | The field of XXX is missing.                  |
| P003      | Not support Inf yet. | Wrong parameter. Infant booking is not supported yet. |
| P004      | The maximum number of passengers is 9.                               | Wrong parameter. The maximum number of passengers is 9.                                  |
| P005      | There should be at least one adult.      | Wrong parameter. There should be at least one adult.     |
| B013      | Interface is limited, please contact the system administrator.      | The route that you request is limited, please contact system administrator.  |
| B015      | Pricing failed.                                                 | Pricing failed for other reason.                  |
| B016      | Flight near take-off, can’t offer pricing service.                                                 | Pricing fail. Can not pricing for flights that is near taking off.                  |
| B018      | Airline or flight restriction.                                                 | Airline or flight restriction.                  |
| B019      | Can not find any supplier for current search.                                                 | Can not find any supplier for current search.                  |
| B020      | Can not find any price for this flight.                                                 | Pricing fail. Can not find any price for this flight option.                  |
| B021      | The booking code you choose has only 0 seat available.                                                 | Pricing fail. The booking code you choose has 0 seat left. Please choose other booking code or flight.                  |
| B026      | LatestTktTime: yyyy-mm-dd hh : mm: ss.                                                 | Last ticketing time is not enough to issue ticket.                  |
| B024      | Pricing TimeOut.                                                 | Pricing TimeOut.                  |
| B035      |Concurrency limited. Please contact PKFARE API support team for assistant.| Concurrent users contral. Please contact PKFARE API support for assistant.|
| B039      | Can't find the related data of XXX.              | Wrong parameter. Can't find the related data of XXX, like illegal city/country/area/airline.     |
| B046      |Interface is limited, the routing is offlined by PKFARE.| Look to book control. If you need this routing, please contact PKFARE API for assistant.|
| B121      | Supplier is offline                   | Supplier is not at working time, please contact PKFARE API support. |


#### 5.2 Fare Type
| Enum    | Description  |
| ------- | ------------ |
| PUBLIC  | public fare  |
| PRIVATE | private fare |

#### 5.3 Cabin Class
| Enum           | Description           |
| -------------- | --------------------- |
| Economy        | economy class         |
| PremiumEconomy | premium economy class |
| Business       | business class        |
| First          | first class           |

</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>