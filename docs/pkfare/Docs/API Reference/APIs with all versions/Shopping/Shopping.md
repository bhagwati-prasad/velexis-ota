# Shopping

### 1 Document Description
#### 1.1 Function Description
Through Shopping API, users can check flight availability and its price by using relevant parameters. Shopping service supports one-way trip, round trip and open jaw (2 journeys max).

`Note` The amount of data returned by shopping API is huge. In regards to network transmission and other factors, we compressed it with `GZIP`. Please decompress it before data analysis.
`Note` You could use routes: HKG - SIN, HKG - MEL, HKG - YTO, HKG - LAX, HKG - BKK, HKG - LON, HKG - SEA, HKG - DXB for test. Please test with departure date that is far away from today to collect data.

#### 1.2 Target Reader
The Shopping API document targets developers who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of following programming language: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: https://api.pkfare.com/shopping
Address in production environment: https://pending.com/shopping
`Notes` PKFARE will provide production domain after Buyer Partners finish integration and co-test. Please replace 'pending.com' with the domain which PKFARE provides individually.
</br>
### 2 Request Parameter
#### 2.1 Parameter Construction
Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. Response would be compressed by GZIP. Please decompress response.
##### 2.1.1 Authentication
| Name      | Type   | Required or Not | Parameter Description                                        | Sample |
| --------- | ------ | --------------- | ------------------------------------------------------------ | ------ |
| partnerId | String | Yes             | partner ID                                                   | -      |
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
| Name          | Type   | Required or not | Parameter Description                        | Sample     |
| ------------- | ------ | --------------- | -------------------------------------------- | ---------- |
| cabinClass    | String | No              | cabin class [default : Economy] refer to 5.3 | Economy    |
| destination   | String | Yes             | destination [IATA airport/city code]         | SIN        |
| origin        | String | Yes             | origin [IATA airport/city code ]             | HKG        |
| departureDate | String | Yes             | departure date [yyyy-MM-dd]                  | 2015-10-22 |

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
| comments           | String     | comments                                                  | -                                |
| journeys           | Object   | JSON format string array. Content: flightID(3.1.3)        | -                                |
| fareRule           | Object     | supplier rule, not supported yet                          | -                                |
| rule               | Object     | PKFARE API rule, not supported yet                        | -                                |
| platingCarrier     | String     | ticketing airline                                         | CA                               |
| merchantFee        | BigDecimal | payment transaction fee                                   | 7.39                             |
| afterSaleRule      | Object     | after sale rule, not supported yet                        | -                                |

##### 3.1.3 Flights
| Name          | Type     | Parameter Description                                        | Sample                           |
| ------------- | -------- | ------------------------------------------------------------ | -------------------------------- |
| flightId      | String   | flight ID, unique identification                             | 9ef88fd9dae30560c683911f534c6c49 |
| journeyTime   | Long     | flight time. Unit: minute                                    | 350                              |
| transferCount | Integer  | transfer count                                               | 1                                |
| lastTktTime   | String   | last ticketing time (GMT)                                    | 2015-10-28 23:59:00              |
| segmengtIds   | String[] | Including segment [segmentId] array, refer to 3.1.4 (please note the segmengtIds is a typo due to history edition) | -                                |

##### 3.1.4 Segments
| Name              | Type    | Parameter Description                           | Sample                           |
| ----------------- | ------- | ----------------------------------------------- | -------------------------------- |
| segmentId         | String  | segment ID, unique identification               | 4ee200cb7feab403d6babbf797ac92aa |
| airline           | String  | airline code                                    | CA                               |
| flightNum         | String  | flight number                                   | 6509                             |
| equipment         | String  | equipment                                       | 737                              |
| cabinClass        | String  | cabin class, refer to 5.3 CabinClass            | Economy                          |
| bookingCode       | String  | cabin code                                      | E                                |
| availabilityCount | Integer | available seats, for reference only             | 7                                |
| departure         | String  | departure airport                               | BKK                              |
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

#### 3.2 Response Sample
##### 3.2.1 Normal Response
```
{ 
  "errorCode":"0",
  "errorMsg":"ok",
  "data":{
    "searchKey":"HKGMEL20170618Y1001",
    "shoppingKey":"be50c09dcfaa45dd9fb29999ca6f5f7f",
    "solutions":[
      {
        "solutionKey":"90aead224d604137a32772a2efd614fb",
        "solutionId":"c0c2af782e9f174c7787f989a5add296",
        "fareType":"PRIVATE",
        "currency":"CNY",
        "adtFare":6847,
        "adtTax":396.0,
        "chdFare":0,
        "chdTax":0,
        "infFare":0,
        "infTax":0,
        "qCharge":0,
        "tktFee":0.0,
        "platformServiceFee":0,
        "comments":null,
        "journeys":{
          "journey_0":[
            "7c4702a50486a54c8b97e70aa58accce"
          ]
        },
        "fareRule":null,
        "rule":null,
        "platingCarrier":null,
        "merchantFee":0,
        "afterSaleRule":{
          "currency":"CNY",
          "refundServiceFee":145.0,
          "refundNotes":null,
          "changeServiceFee":290.0,
          "changeNotes":null,
          "voidServiceFee":-1.0,
          "voidNotes":null,
          "remark":"remark"
        }
      },
    ],
    "flights":[
      {
        "flightId":"7c4702a50486a54c8b97e70aa58accce",
        "journeyTime":485,
        "transferCount":0,
        "lastTktTime":"2017-06-06 23:59:00",
        "segmengtIds":[
          "5b7cf91867b292a422358e6996a3808a"
        ]
      },
    ],
    "segments":[
      {
        "segmentId": "5b7cf91867b292a422358e6996a3808a",
        "airline": "CX",
        "flightNum": "105",
        "equipment": "359",
        "cabinClass": "ECONOMY",
        "bookingCode": "E",
        "availabilityCount": 7,
        "departure": "HKG",
        "arrival": "MEL",
        "departureTerminal": "1",
        "arrivalTerminal": "2",
        "departureDate": 1497715800000,
        "arrivalDate": 1497755700000,
        "flightTime": 485,
        "stayTime": null,
        "codeShare": "N",
        "opFltNo": null,
        "opFltAirline": null,
        "stopover": null,
        "strDepartureDate": "2017-06-18",
        "strDepartureTime": "00:10",
        "strArrivalDate": "2017-06-18",
        "strArrivalTime": "11:15"
      },
    ],
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
| B066      | Only 2 journeys can be supported, please check your itinerary.                         | System support maximum 2 journeys shopping at this moment. |
| B009      | Supplier is offline                   | Supplier is not at working time, please contact PKFARE API support. |


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