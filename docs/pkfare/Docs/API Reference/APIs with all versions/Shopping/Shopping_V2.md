# Shopping_V2

### 1 Document Description
#### 1.1 Function Description
Through Shopping API, users can check flight availability and its price by using relevant parameters. Shopping service supports one-way trip, round trip and open jaw (2 journeys max).

`Note` The amount of data returned by shopping API is huge. In regards to network transmission and other factors, we compressed it with GZIP. Please decompress it before data analysis.
`Note` You could use routes: HKG - SIN, HKG - MEL, HKG - BKK, HKG - LON, HKG - LAX, HKG - TYO, MEL - LAX for test. Please test with departure date that is far away from today to collect data.
`Note` Shopping\_V2 has same request structure as Shopping. But Shopping\_V2 response includes structuralized fare rule. The baggage rule and penalty you collect in Shopping\_V2 is for reference only. Please refer to baggage and penalty from PrecisePricing API and Penalty API if you need to make a reservation.

#### 1.2 Target Reader
The Shopping\_V2 API document targets developers who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of following programming language: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: https://api.pkfare.com/shoppingV2
Address in production environment: https://pending.com/shoppingV2
`Notes` PKFARE will provide production domain after Buyer Partners finish integration and co-test. Please replace 'pending.com' with the domain which PKFARE provides individually.
</br>
### 2 Request Parameter
#### 2.1 Parameter Construction
Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. Response would be compressed by GZIP. Please decompress response.

##### 2.1.1 Authentication
| Name      | Type   | Required or Not | Parameter Description                                        | Sample |
| --------- | ------ | --------------- | ------------------------------------------------------------ | ------ |
| partnerId | String | Yes             | Partner ID                                                   | -      |
| sign      | String | Yes             | signature, sign=MD5(partnerId+partnerKey), refer to 4.1 and 4.2 | -      |

##### 2.1.2 Search
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
| adults        | Integer | Yes               | adult passenger number                       | 1      |
| children      | Integer | No                | children [age 2-12] passenger number         | 1      |
| nonstop       | Integer | No                | only search for non-stop flight[0- No 1-Yes] | 0      |
| airline       | String  | No                | specified airline. Support one airline only  | CA     |
| solutions     | Integer | not supported yet | suggested quantity of returned solutions     | 0      |
| searchAirLegs | Array   | Yes               | journey object array, refer to 2.1.3         | -      |

##### 2.1.3 SearchAirLegs
| Name          | Type   | Required or not | Parameter Description                      | Sample     |
| ------------- | ------ | --------------- | ------------------------------------------ | ---------- |
| cabinClass    | String | No              | cabin class[default : Economy]refer to 5.3 | Economy    |
| destination   | String | Yes             | destination [IATA airport/city code]       | SIN        |
| origin        | String | Yes             | origin [IATA airport/city code ]           | HKG        |
| departureDate | String | Yes             | departure date [yyyy-MM-dd]                | 2015-10-22 |

#### 2.2 Request Sample
##### 2.2.1 JSON Format Sample
`Case 1` : One way request sample as following:
```
{
    "authentication": {
        "partnerId": "sVSX7PfZm1yF04adBWYsCD7M4=",
        "sign": "e707b5d9dae8459065dbb139e5f1bd"
    },
    "search": {
        "adults": 1,
        "airline": "",
        "children": 1,
        "nonstop": 0,
        "searchAirLegs": [
            {
                "cabinClass": "Economy",
                "departureDate": "2019-01-16",
                "destination": "MEL",
                "origin": "HKG"
            }
        ],
        "solutions": 0
    }
}
```

`Case 2` : Round trip request sample as following:
```
{
    "authentication": {
        "partnerId": "sVSX7PfZm1yF04adBWYsCD7M4=",
        "sign": "e707b5d9dae8459065dbb139e5f1bd"
    },
    "search": {
        "adults": 1,
        "airline": "",
        "children": 1,
        "nonstop": 0,
        "searchAirLegs": [
            {
                "cabinClass": "Economy",
                "departureDate": "2019-01-16",
                "destination": "LAX",
                "origin": "HKG"
            },
            {
                "cabinClass": "Economy",
                "departureDate": "2019-01-23",
                "destination": "HKG",
                "origin": "LAX"
            }
        ],
        "solutions": 0
    }
}
```

`Case 3` : Open jaw request sample as following:
```
{
    "authentication": {
        "partnerId": "sVSX7PfZm1yF04adBWYsCD7M4=",
        "sign": "e707b5d9dae8459065dbb139e5f1bd"
    },
    "search": {
        "adults": 1,
        "airline": "",
        "children": 1,
        "nonstop": 0,
        "searchAirLegs": [
            {
                "cabinClass": "Economy",
                "departureDate": "2019-01-16",
                "destination": "LAX",
                "origin": "HKG"
            },
            {
                "cabinClass": "Economy",
                "departureDate": "2019-01-23",
                "destination": "SEA",
                "origin": "LAX"
            }
        ],
        "solutions": 0
    }
}
```

##### 2.2.2 Base64 Encryption
Use BASE64 to encode results from 2.2.1 Case 1:
```
eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sInNlYXJjaCI6eyJhZHVsdHMiOjEsImFpcmxpbmUiOiIiLCJjaGlsZHJlbiI6MCwiaW5mYW50cyI6MCwibm9uc3RvcCI6MSwic2VhcmNoQWlyTGVncyI6W3siY2FiaW5DbGFzcyI6IkVjb25vbXkiLCJkZXBhcnR1cmVEYXRlIjoiMjAxNi0wMS0xNiIsImRlc3RpbmF0aW9uIjoiSEtHIiwib3JpZ2luIjoiQkpTIn0seyJjYWJpbkNsYXNzIjoiRWNvbm9teSIsImRlcGFydHVyZURhdGUiOiIyMDE2LTAxLTIzIiwiZGVzdGluYXRpb24iOiJCSlMiLCJvcmlnaW4iOiJIS0cifV0sInNvbHV0aW9ucyI6MjB9fQ=
```

##### 2.2.3 Encryption Request Sample
This sample is for reference only:
```
http://api.pkfare.com/shopping?param=eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sInNlYXJjaCI6eyJhZHVsdHMiOjEsImFpcmxpbmUiOiIiLCJjaGlsZHJlbiI6MCwiaW5mYW50cyI6MCwibm9uc3RvcCI6MSwic2VhcmNoQWlyTGVncyI6W3siY2FiaW5DbGFzcyI6IkVjb25vbXkiLCJkZXBhcnR1cmVEYXRlIjoiMjAxNi0wMS0xNiIsImRlc3RpbmF0aW9uIjoiSEtHIiwib3JpZ2luIjoiQkpTIn0seyJjYWJpbkNsYXNzIjoiRWNvbm9teSIsImRlcGFydHVyZURhdGUiOiIyMDE2LTAxLTIzIiwiZGVzdGluYXRpb24iOiJCSlMiLCJvcmlnaW4iOiJIS0cifV0sInNvbHV0aW9ucyI6MjB9fQ
```
</br>
### 3 Response Parameter
#### 3.1 Response Parameter Construction
After decompressing the returned data by `GZIP`, you would get the `JSON` data. About concrete fields, please refer to following tables.

__Price breakdown description: __
__Individual Adult Price = Adult Ticket Fare [adtFare] + Adult Ticket Tax [adtTax] + Ticketing Fee [tktFee]__
__Individual Child Price = Child Ticket Fare [chdFare] + Child Ticket Tax [chdTax] + Ticketing Fee [tktFee]__
__Total Price = Individual Adult Price \* adult passenger number [adults] + Individual Child Price] \* child passenger number [children] + Platform Service Fee [platformServiceFee] + Payment Transaction Fee [merchantFee]__
`Notes`
1 There is no charge for "platformServiceFee" at present; it can be ignored.
2 No payment transaction fee ("merchantFee") will be charged if the mode of payment is "Prepaid". "Alipay" will charge 0.1% of the Total Price.

##### 3.1.1 Basic Parameter
| Name      | Type   | Parameter Description                                        | Sample |
| --------- | ------ | ------------------------------------------------------------ | ------ |
| errorCode | String | error number, refer to 5.1                                   | 0      |
| errorMsg  | String | error message                                                | OK     |
| data      | Object | only if the errorCode returns "0", returned data would not be null. Data is in JSON format, which contains three collection objects: solutions (3.1.2), flights (3.1.3), segments (3.1.4) | -      |

##### 3.1.2 Solutions
| Name               | Type       | Parameter Description                                        | Sample                           |
| ------------------ | ---------- | ------------------------------------------------------------ | -------------------------------- |
| solutionId         | String     | unique identification                                        | 25a061970d8a7ebeb5e63391b9788f36 |
| solutionKey        | String     | unique identification                                        | 0357301bf213453389fcb55c379a4667 |
| fareType           | String     | fare type, refer to 5.2 Fare Type                            | PUBLIC                           |
| currency           | String     | currency                                                     | CNY                              |
| adtFare            | BigDecimal | adult fare                                                   | 1011                             |
| adtTax             | BigDecimal | adult tax                                                    | 527                              |
| chdFare            | BigDecimal | children [age 2-12] fare                                     | 500                              |
| chdTax             | BigDecimal | children [age 2-12] tax                                      | 250                              |
| infFare            | BigDecimal | infant[age 0-2] fare, not supported yet                      | 0                                |
| infTax             | BigDecimal | infant[age 0-2] tax, not supported yet                       | 0                                |
| qCharge            | BigDecimal | Q charge, bunker adjustment surcharge, for reference only    | 0                                |
| tktFee             | BigDecimal | ticketing service fee                                        | 0                                |
| baggageMap         | Object     | baggage rule. For reference only. Including 'ADT' and 'CHD'. If the request does not include children, 'CHD' would be NULL. Refer to 3.1.5 | -                                |
| MiniRuleMap        | Object     | penalty rule. For reference only, please find precise penalty rule on Penalty API. Refer to 3.1.6 | -                                |
| platformServiceFee | BigDecimal | platform service fee, defaults to 0                          | 0                                |
| comments           | String     | comments                                                     | -                                |
| journeys           | Object     | content: flightID(3.1.3)                                     | -                                |
| fareRule           | Object     | supplier rule, not supported yet                             | -                                |
| rule               | Object     | PKFARE API rule, not supported yet                           | -                                |
| platingCarrier     | String     | ticketing airline                                            | CA                               |
| merchantFee        | BigDecimal | payment transaction fee                                      | 7.39                             |
| afterSaleRule      | Object     | not supported yet.                                           | -                                |

##### 3.1.3 Flights
| Name          | Type     | Parameter Description                                        | Sample                           |
| ------------- | -------- | ------------------------------------------------------------ | -------------------------------- |
| flightId      | String   | flight ID, unique identification                             | 9ef88fd9dae30560c683911f534c6c49 |
| journeyTime   | Long     | journey time, unit: minute                                   | 350                              |
| transferCount | Integer  | transfer times                                               | 1                                |
| lastTktTime   | String   | last ticketing time (GMT)                                    | 2015-10-28 23:59:00              |
| segmengtIds   | String[] | Including segment [segmentId] array, refer to 3.1.4 (please note the segmengtIds is a typo due to history edition) | -                                |

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
| stopover          | String  | stopover airport                                | PVG                              |
| strDepartureDate  | String  | departure date[yyyy-MM-dd], local time          | 2016-08-27                       |
| strDepartureTime  | String  | departure time[HH:mm], local time               | 09:30                            |
| strArrivalDate    | String  | arrival date[yyyy-MM-dd], local time            | 2016-08-27                       |
| strArrivalTime    | String  | arrival time[HH:mm], local time                 | 11:50                            |
| fareBasis         | String  | fare basis code                                 | SLCPWFR                          |

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
| when           | Integer    | appropriate situation. [0 - Both Outbound and Inbound are not used, 1- Outbound Flight used, 2 - all Situation] | 2      |
| noShowTime     | String     | noShow definition. Apply with 'noShowTimeUnit'               | 2      |
| noShowTimeUnit | String     | noShow Unit. Apply with 'noShowTime'. [H - hour, M - minute] | H      |
| amount         | BigDecimal | penalty                                                      | 300    |
| currencyCode   | String     | penalty currency                                             | CNY    |
| percent        | BigDecimal | penalty percentage. Apply with 'baseType'. Penalty and penalty percentage would not go into effect at the same. Please take the strict one. Unit: % | 10     |
| baseType       | Integer    | apply with 'percent'.  Multiply corresponding value of 'baseType' by 'percent' would be the penalty. [0 - fare, 1 - fare+tax+ticketingFee, 2 - cabin basic fare] | 0      |

#### 3.2 Response Sample
##### 3.2.1 Normal Response
```
{
    "errorCode" : "0",
    "errorMsg" : "ok",
    "data" :
    {
        "searchKey" : "HKGSEL20181019Y110**0",
        "shoppingKey" : "cache-9707df4692624f659b3363f8e8dc7f0c",
        "solutions" : [
            {
                "solutionKey" : "501e714f0978d39c4c50106c0a83328d",
                "solutionId" : "1882074142ecb4d1e6ecb244dd9cd03c",
                "fareType" : "PUBLIC",
                "currency" : "CNY",
                "adtFare" : 411,
                "adtTax" : 207.0,
                "chdFare" : 329,
                "chdTax" : 110.0,
                "infFare" : 0,
                "infTax" : 0,
                "qCharge" : 0,
                "tktFee" : 0,
                "platformServiceFee" : 0,
                "comments" : null,
                "journeys" :
                {
                    "journey_0" : ["644d51948ae2a86f63627db172b991e7"]
                },
                "fareRule" : null,
                "rule" : null,
                "platingCarrier" : "RS",
                "prices" : null,
                "merchantFee" : 0.00,
                "baggageMap" :
                {
                    "CHD" : [
                        {
                            "segmentIndexList" : [1],
                            "baggageAmount" : "0PC",
                            "baggageWeight" : null,
                            "carryOnAmount" : null,
                            "carryOnWeight" : null
                        }
                    ],
                    "ADT" : [
                        {
                            "segmentIndexList" : [1],
                            "baggageAmount" : "1PC",
                            "baggageWeight" : null,
                            "carryOnAmount" : null,
                            "carryOnWeight" : null
                        }
                    ]
                },
                "miniRuleMap" :
                {
                    "CHD" : [
                        {
                            "segmentIndex" : [1],
                            "miniRules" : [
                                {
                                    "penaltyType" : 2,
                                    "isPermited" : 1,
                                    "when" : 0,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 192,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                },
                                {
                                    "penaltyType" : 2,
                                    "isPermited" : 1,
                                    "when" : 1,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 192,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                },
                                {
                                    "penaltyType" : 0,
                                    "isPermited" : 1,
                                    "when" : 0,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 192,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                },
                                {
                                    "penaltyType" : 0,
                                    "isPermited" : 1,
                                    "when" : 1,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 192,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                }
                            ]
                        }
                    ],
                    "ADT" : [
                        {
                            "segmentIndex" : [1],
                            "miniRules" : [
                                {
                                    "penaltyType" : 2,
                                    "isPermited" : 1,
                                    "when" : 0,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 192,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                },
                                {
                                    "penaltyType" : 2,
                                    "isPermited" : 1,
                                    "when" : 1,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 192,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                },
                                {
                                    "penaltyType" : 0,
                                    "isPermited" : 1,
                                    "when" : 0,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 192,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                },
                                {
                                    "penaltyType" : 0,
                                    "isPermited" : 1,
                                    "when" : 1,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 192,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                }
                            ]
                        }
                    ]
                },
                "afterSaleRule" : null
            },
            {
                "solutionKey" : "8980dcce4049a73fa3d3d25427edc16d",
                "solutionId" : "9cedd014ef3a50baacf41ec7bb72e1e9",
                "fareType" : "PRIVATE",
                "currency" : "CNY",
                "adtFare" : 732,
                "adtTax" : 207.0,
                "chdFare" : 553,
                "chdTax" : 110.0,
                "chnFare" : 0,
                "chnTax" : 0,
                "infFare" : 0,
                "infTax" : 0,
                "qCharge" : 0,
                "tktFee" : 0,
                "platformServiceFee" : 0,
                "comments" : null,
                "journeys" :
                {
                    "journey_0" : ["36d73b2362981379b4468393111fc65b"]
                },
                "fareRule" : null,
                "rule" : null,
                "platingCarrier" : "LJ",
                "prices" : null,
                "merchantFee" : 0.00,
                "baggageMap" :
                {
                    "CHD" : null,
                    "ADT" : [
                        {
                            "segmentIndexList" : [1],
                            "baggageAmount" : null,
                            "baggageWeight" : "15KG",
                            "carryOnAmount" : null,
                            "carryOnWeight" : null
                        }
                    ]
                },
                "miniRuleMap" :
                {
                    "CHD" : [
                        {
                            "segmentIndex" : [1],
                            "miniRules" : null
                        }
                    ],
                    "ADT" : [
                        {
                            "segmentIndex" : [1],
                            "miniRules" : [
                                {
                                    "penaltyType" : 2,
                                    "isPermited" : 1,
                                    "when" : 0,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 163,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                },
                                {
                                    "penaltyType" : 0,
                                    "isPermited" : 1,
                                    "when" : 0,
                                    "noShowTime" : null,
                                    "noShowTimeUnit" : null,
                                    "amount" : 203,
                                    "currencyCode" : "CNY",
                                    "percent" : null,
                                    "baseType" : null
                                }
                            ]
                        }
                    ]
                },
                "afterSaleRule" : null
            }
        ],
        "flights" : [
            {
                "flightId" : "644d51948ae2a86f63627db172b991e7",
                "journeyTime" : 220,
                "transferCount" : 0,
                "lastTktTime" : null,
                "segmengtIds" : ["23fe9e63f16bffcb78664a583151ee47"]
            },
            {
                "flightId" : "36d73b2362981379b4468393111fc65b",
                "journeyTime" : 225,
                "transferCount" : 0,
                "lastTktTime" : "2018-05-10 23:59:00",
                "segmengtIds" : ["58bc78d6d810133978b00f94d843f2f3"]
            }
        ],
        "segments" : [
            {
                "segmentId" : "23fe9e63f16bffcb78664a583151ee47",
                "airline" : "RS",
                "flightNum" : "532",
                "equipment" : "321",
                "cabinClass" : "ECONOMY",
                "bookingCode" : "U",
                "availabilityCount" : 9,
                "departure" : "HKG",
                "arrival" : "ICN",
                "departureTerminal" : "0",
                "arrivalTerminal" : "1",
                "departureDate" : 1539881400000,
                "arrivalDate" : 1539898200000,
                "flightTime" : 220,
                "stayTime" : null,
                "codeShare" : "N",
                "opFltNo" : null,
                "opFltAirline" : null,
                "stopover" : null,
                "strDepartureDate" : "2018-10-19",
                "strDepartureTime" : "00:50",
                "strArrivalDate" : "2018-10-19",
                "strArrivalTime" : "05:30",
                "fareBasis" : "KNNDJ"
            },
            {
                "segmentId" : "58bc78d6d810133978b00f94d843f2f3",
                "airline" : "LJ",
                "flightNum" : "114",
                "equipment" : "738",
                "cabinClass" : "ECONOMY",
                "bookingCode" : "N",
                "availabilityCount" : 9,
                "departure" : "HKG",
                "arrival" : "ICN",
                "departureTerminal" : "1",
                "arrivalTerminal" : "1",
                "departureDate" : 1539926400000,
                "arrivalDate" : 1539943500000,
                "flightTime" : 225,
                "stayTime" : null,
                "codeShare" : "N",
                "opFltNo" : null,
                "opFltAirline" : "",
                "stopover" : null,
                "strDepartureDate" : "2018-10-19",
                "strDepartureTime" : "13:20",
                "strArrivalDate" : "2018-10-19",
                "strArrivalTime" : "18:05",
                "fareBasis" : "KNNDJ"
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
#### 5.1  Error Code List
| errorCode | errorMsg                                                     | Description                                                  |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 0         | ok                                                           | Request has been processed successfully.                      |
| S001      | System error.                                                 | System error.                                                 |
| B002      | Partner is not exists.                                                            | PartnerID does not exist.                                              |
| B003      | Illegal sign.                                          | Illegal sign. Please check your signature.         |
| P001      | XXX is illegal.                                        | The field of XXX is illegal.                                     |
| P002      | XXX is missing.                                                 | The field of XXX is missing.                  |
| P003      | Not support Inf yet. | Wrong parameter. Infant booking is not supported yet. |
| P004      | The maximum number of passengers is 9.                               | Wrong parameter. The maximum number of passengers is 9.                                  |
| P005      | There should be at least one adult.      | Wrong parameter. There should be at least one adult.     |
| B013      | Interface is limited, please contact the system administrator.      | The route that you request is limited, please contact system administrator.  |
| B014      | Shopping failed.            | Shopping failed caused by other reasons.     |
| B024      | Time-out, please try later.       | Time-out. You can try the second searching after a few seconds.|
| B034      | Shopping interface is offline.             | Shopping service is limited.     |
| B035      |Concurrency limited. Please contact PKFARE API support team for assistant.| Concurrent users contral. Please contact PKFARE API support for assistant.|
| B038      | Departure date must be today to a year.      | Wrong parameter. Departure date must be today to a year.     |
| B039      | Can't find the related data of XXX.              | Wrong parameter. Can't find the related data of XXX, like illegal city/country/area/airline.     |
| B046      |Interface is limited, the routing is offlined by PKFARE.| Look to book control. If you need this routing, please contact PKFARE API for assistant.|
| B059      | Shopping failed from upstream.                         | Shopping failed, shopping error from upstream. Please contact PKFARE API support.|
| B060      | Interface is limited, please contact PKFARE.                         | Interface is limited, due to restriction rules, please contact PKFARE API support. |
| B009      | Supplier is offline                   | Supplier is not at working time, please contact PKFARE API support. |
| B066      | Only 2 journeys can be supported, please check your itinerary.                         | System support maximum 2 journeys shopping at this moment. |

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