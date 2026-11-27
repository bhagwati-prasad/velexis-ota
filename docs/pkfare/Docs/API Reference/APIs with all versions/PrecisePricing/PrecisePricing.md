# PrecisePricing

### 1 Document Description
#### 1.1 Function Description
Through PrecisePricing API, the precise price will be shown with specific flight details, including booking code and availability seat. If specific cabin class is requested (cabin class should be specified in all segments), the lowest fare corresponding to the specified class will be shown. If the cabin class is not provided in all segments (or partially provided), a lowest available fare will be shown.
PrecisePricing service is able to check flight price basing on cabin class. 

`Note`Although BookingCode is an optional field in PrecisePricing_V2 requests, it is still highly recommended to fill BookingCode value in PrecisePricing requests if your search starts from Shopping requests, because this will avoid price change between Shopping and PrecisePricing to the maximum extent possible. And the the BookingCode you use shall be the one in our Shopping response . 
If your first PrecisePrcing request with BookingCode fail and you receive error code B020 or B021, it is recommonded to send us another PrecisePricing request without BookingCode value.
If your search starts from PrecisePricing, it is recommonded to leave BookingCode field empty in your PrecisePricng request.

#### 1.2 Target Reader
The PrecisePricing API document targets people who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of following programming language, such as ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: https://api.pkfare.com/precisePricing
Address in production environment: https://pending.com/precisePricing
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
        "partnerId": "sVSX7m1yF04adBWYsCD7M4=",
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
        "partnerId": "sVSX7PfZm1yF0dBWYsCD7M4=",
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
http://api.pkfare.com/precisePricing?param=eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sInByaWNpbmciOnsiYWR1bHRzIjoxLCJjaGlsZHJlbiI6MCwiaW5mYW50cyI6MCwiam91cm5leXMiOnsiam91cm5leV8wIjp7InNlZ21lbnRfMCI6eyJhaXJsaW5lIjoiU0EiLCJhcnJpdmFsIjoiSk5CIiwiYXJyaXZhbERhdGUiOiIyMDE1LTExLTIwIiwiYXJyaXZhbFRpbWUiOiIwNzo0NSIsImJvb2tpbmdDb2RlIjoiTiIsImRlcGFydHVyZSI6IkNQVCIsImRlcGFydHVyZURhdGUiOiIyMDE1LTExLTIwIiwiZGVwYXJ0dXJlVGltZSI6IjA1OjQ1IiwiZmxpZ2h0TnVtIjoiMzc4In19LCJqb3VybmV5XzEiOnsic2VnbWVudF8wIjp7ImFpcmxpbmUiOiJTQSIsImFycml2YWwiOiJDUFQiLCJhcnJpdmFsRGF0ZSI6IjIwMTUtMTEtMjUiLCJhcnJpdmFsVGltZSI6IjA4OjEwIiwiYm9va2luZ0NvZGUiOiJOIiwiZGVwYXJ0dXJlIjoiSk5CIiwiZGVwYXJ0dXJlRGF0ZSI6IjIwMTUtMTEtMjUiLCJkZXBhcnR1cmVUaW1lIjoiMDY6MDAiLCJmbGlnaHROdW0iOiIzMDMifX19fX0=
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

##### 3.1.2.2 Baggages
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
| segmengtIds   | String[] | number of segment arrays (please note that this field has been corrected typo in PrecisePricing\_V2) | -                                |

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

#### 3.2 Response Example
##### 3.2.1 Normal Response
```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "solution": {
            "solutionKey": "8ad7cf64d7fe824b1497056620d99",
            "solutionId": "155b375144b609a7538fcb25dbdf0",
            "fareType": "PRIVATE",
            "currency": "CNY",
            "adtFare": 6257,
            "adtTax": 771,
            "chdFare": 0,
            "chdTax": 0,
            "infFare": 0,
            "infTax": 0,
            "qCharge": 0,
            "tktFee": 0,
            "platformServiceFee": 0,
            "comments": null,
            "journeys": {
                "journey_0": [
                    "044985e3f04c7b4a0904d9d6b119c"
                ],
                "journey_1": [
                    "edac6cf5ae0760279192d6a54b637"
                ]
            },
            "fareRule": null,
            "rule": null,
            "platingCarrier": "AA",
            "merchantFee": 0,
            "adults": 1,
            "baggages": {
                "1": {
                    "carryOn": "2P,2P",
                    "baggage": "2P,2P"
                },
                "2": {
                    "carryOn": "2P,2P",
                    "baggage": "2P,2P"
                }
            },
            "afterSaleRule": null
        },
        "flights": [
            {
                "flightId": "044985e3f04c7b4a0904d9d6b119c",
                "journeyTime": 1139,
                "transferCount": 1,
                "lastTktTime": "2018-10-15 23:59:00",
                "segmengtIds": [
                    "74e40d94267c4fb06b065b3aad86e",
                    "20586009dd915138175f64f57730b"
                ]
            },
            {
                "flightId": "edac6cf5ae0760279192d6a54b637",
                "journeyTime": 1238,
                "transferCount": 1,
                "lastTktTime": "2018-10-15 23:59:00",
                "segmengtIds": [
                    "37a64fc8f679e5e444947ff9cb8c8",
                    "7ca0d7f810b7844e32a9930b88b4d"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "20586009dd915138175f64f57730b",
                "airline": "AA",
                "flightNum": "2781",
                "equipment": "32B",
                "cabinClass": "ECONOMY",
                "bookingCode": "H",
                "availabilityCount": 7,
                "departure": "DFW",
                "arrival": "SEA",
                "departureTerminal": null,
                "arrivalTerminal": null,
                "departureDate": 1554900000000,
                "arrivalDate": 1554908040000,
                "flightTime": 254,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": "AA",
                "stopover": null,
                "strDepartureDate": "2019-04-10",
                "strDepartureTime": "20:40",
                "strArrivalDate": "2019-04-10",
                "strArrivalTime": "22:54"
            },
            {
                "segmentId": "7ca0d7f810b7844e32a9930b88b4d",
                "airline": "AA",
                "flightNum": "125",
                "equipment": "77W",
                "cabinClass": "ECONOMY",
                "bookingCode": "M",
                "availabilityCount": 7,
                "departure": "DFW",
                "arrival": "HKG",
                "departureTerminal": "D",
                "arrivalTerminal": "1",
                "departureDate": 1555814100000,
                "arrivalDate": 1555920600000,
                "flightTime": 995,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": "",
                "stopover": null,
                "strDepartureDate": "2019-04-21",
                "strDepartureTime": "10:35",
                "strArrivalDate": "2019-04-22",
                "strArrivalTime": "16:10"
            },
            {
                "segmentId": "37a64fc8f679e5e444947ff9cb8c8",
                "airline": "AA",
                "flightNum": "368",
                "equipment": "32B",
                "cabinClass": "ECONOMY",
                "bookingCode": "M",
                "availabilityCount": 7,
                "departure": "SEA",
                "arrival": "DFW",
                "departureTerminal": null,
                "arrivalTerminal": null,
                "departureDate": 1555754100000,
                "arrivalDate": 1555775880000,
                "flightTime": 243,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": "AA",
                "stopover": null,
                "strDepartureDate": "2019-04-20",
                "strDepartureTime": "17:55",
                "strArrivalDate": "2019-04-20",
                "strArrivalTime": "23:58"
            },
            {
                "segmentId": "74e40d94267c4fb06b065b3aad86e",
                "airline": "AA",
                "flightNum": "126",
                "equipment": "77W",
                "cabinClass": "ECONOMY",
                "bookingCode": "H",
                "availabilityCount": 7,
                "departure": "HKG",
                "arrival": "DFW",
                "departureTerminal": "1",
                "arrivalTerminal": "D",
                "departureDate": 1554877200000,
                "arrivalDate": 1554883500000,
                "flightTime": 885,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": "",
                "stopover": null,
                "strDepartureDate": "2019-04-10",
                "strDepartureTime": "14:20",
                "strArrivalDate": "2019-04-10",
                "strArrivalTime": "16:05"
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
| B026      | LatestTktTime:yyyy-mm-dd hh:mm:ss.                                                 | Last ticketing time is not enough to issue ticket.                  |
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