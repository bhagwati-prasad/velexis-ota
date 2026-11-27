# PrecisePricing_V6

## 1 Function

Through PrecisePricing API, the precise price will be shown with specific flight details, including booking code and seat availability. If specific cabin class is requested (cabin class should be specified in all segments), the lowest fare corresponding to the specified class will be shown. If the cabin class is not provided in all segments (or partially provided), a lowest available fare will be shown.

PrecisePricing service is able to check flight price based on cabin class. We will respond the real-time price and availability.

## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|PrecisePricing|[https://api.pkfare.com/precisePricing](https://api.pkfare.com/precisePricing)|    |
|PrecisePricing_V2|[https://api.pkfare.com/precisePricing_V2](https://api.pkfare.com/precisePricing_V2)|Add baggageMap and miniRuleMap, only for reference. Offer BookingWithoutCard notification in response.|
|PrecisePricing_V4|[https://api.pkfare.com/precisePricing_V4](https://api.pkfare.com/precisePricing_V4)|Support infant (no seat) .|
|PrecisePricing_V5|[https://api.pkfare.com/precisePricing_V5](https://api.pkfare.com/precisePricing_V5)|Add Ancillary flag to indicate which ancillary service is available|
|PrecisePricing_V6|[https://api.pkfare.com/precisePricing_V](https://api.pkfare.com/precisePricing_V5)6|Add solutionId to enhance tracebility and data visibility|

*Below is the most updated version"

## 3 Character Encoding

The character code of this API is UTF-8.

## 4 Request

Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted.

### 4.1 Schema

|Name|Type|Required or Not|Parameter Description|Sample|
|:----|:----|:----|:----|:----|
|Authentication|    |    |    |    |
|partnerId|String|Yes|Partner ID|HJqiE05TYKcJlXjknkCkZKhzIis5o=|
|sign|String|Yes|Signature, sign=MD5(partnerId+partnerKey)|fed53d44ea413c40d5f1de69047b7c|
|Pricing|    |    |    |    |
|journeys|Object|Yes|Specified flight data, all the journeys in one solution must be included, refer to journey|-|
|adults|Integer|Yes|Number of adult passenger|1|
|children|Integer|Yes|Number of child[age 2-12] passenger|1|
|infants|Integer|Yes|Number of infant [age 0-2, no seat] passenger|1|
|cabin|String|No|Cabin class ["" - the lowest cabin, C - business class, F - first class] if both 'cabin' and 'bookingCode' is valued and not inconsistent, precisePricing service would base on 'bookingCode'.|C|
|solutionKey|String|No|Recommend to request with this parameters for the sake of data quality monitor.|a2ba983f73364c359420a12faf67179d|
|solutionId|String|Yes|Unique identification of each solution from Shopping API, request with it for associating with the Shopping solution and linking to the entire request process|25a061970d8a7ebeb5e63391b9788f36|
|Journey|    |    |    |    |
|airline|String|Yes|Airline code|SA|
|flightNum|String|Yes|Flight number|102|
|arrival|String|Yes|Destination[IATA airport code]|CPT|
|arrivalDate|String|Yes|Arrival Date[yyyy-MM-dd]|2023-11-11|
|arrivalTime|String|Yes|Arrival Time[HH:mm]|11:45|
|departure|String|Yes|Origin[IATA airport code]|BKK|
|departureDate|String|Yes|Departure Date[yyyy-MM-dd]|2023-11-30|
|departureTime|String|Yes|Departure Time[HH:mm]|07:05|
|bookingCode|String|No|Recommend to request with this parameter in order to keep the price stable and pricing success rate.|N|

### 4.2 Example

1. One Way Journey
```plain
{
    "authentication": {
        "partnerId": "HJqiE0cJlXjknkCkZKhzIis5o=",
        "sign": "fed53d44ea4130d5f1d18e69047b7c"
    },
    "pricing": {
        "adults": 1,
        "children": 0,
        "infants": 1,
        "solutionId": "1",
        "journeys": {
            "journey_0": [{
                "airline": "SA",
                "arrival": "JNB",
                "arrivalDate": "2023-11-20",
                "arrivalTime": "07:45",
                "bookingCode": "N",
                "departure": "CPT",
                "departureDate": "2023-11-20",
                "departureTime": "05:45",
                "flightNum": "378"
            }]
        }
    }
} 
```

2. Round Trip Journey
```plain
{
    "authentication": {
        "partnerId": "HJqE0YKcJlXjknkCkZKhzIis5o=",
        "sign": "fe53d44ea413c40d5f1d18e69047b7c"
    },
    "pricing": {
        "adults": 1,
        "children": 0,
        "infants": 1,
        "solutionKey":"a2ba983f73364c359420a12faf67179d",
        "solutionId": "1",
        "journeys": {
            "journey_0": [{
                "airline": "SA",
                "arrival": "CPT",
                "arrivalDate": "2023-11-20",
                "arrivalTime": "06:45",
                "bookingCode": "N",
                "departure": "CPP",
                "departureDate": "2023-11-20",
                "departureTime": "05:45",
                "flightNum": "378"
            },
            {
                "airline": "SA",
                "arrival": "JNB",
                "arrivalDate": "2023-11-20",
                "arrivalTime": "09:40",
                "bookingCode": "N",
                "departure": "JNB",
                "departureDate": "2023-11-20",
                "departureTime": "08:45",
                "flightNum": "3654"
            }],
            "journey_1": [{
                "airline": "SA",
                "arrival": "CPP",
                "arrivalDate": "2023-11-25",
                "arrivalTime": "08:10",
                "bookingCode": "N",
                "departure": "JNB",
                "departureDate": "2023-11-25",
                "departureTime": "06:00",
                "flightNum": "303"
            }]
        }
    }
}
```
3. Open Jaw Journey
```plain
{
    "authentication": {
        "partnerId": "HJqiE0YKcJlXjknkkZKhzIis5o=",
        "sign": "fed53d44ea413c40d5f1d18e690477c"
    },
    "pricing": {
        "adults": 1,
        "children": 0,
        "infants": 1,
        "solutionKey":"a2ba983f73364c359420a12faf67179d",
        "solutionId": "1",
        "journeys": {
            "journey_0": [{
                "airline": "SA",
                "arrival": "CPT",
                "arrivalDate": "2023-11-20",
                "arrivalTime": "06:45",
                "bookingCode": "N",
                "departure": "JNB",
                "departureDate": "2023-11-20",
                "departureTime": "05:45",
                "flightNum": "378"
            }],
            "journey_1": [{
                "airline": "SA",
                "arrival": "JNB",
                "arrivalDate": "2023-11-25",
                "arrivalTime": "08:10",
                "bookingCode": "N",
                "departure": "CPP",
                "departureDate": "2023-11-25",
                "departureTime": "06:00",
                "flightNum": "303"
            }]
        }
    }
}
```
### 4.3 PrecisePricing Request Breakdown Structure

[PricisePricing Request-V4.pdf](http://open.pkfare.com/api-agent/document/load/166464)

## 5 Response

### 5.1 Schema

|Name|Type|Parameter Description|Sample|
|:----|:----|:----|:----|
|Basic Parameters|    |    |    |
|errorCode|String|Error code, refer to Error Code List|0|
|errorMsg|String|Error message|OK|
|data|Object|Returned data, will not be empty when error code is "0". Data is in JSON format, which contains three collection objects: solutions, flights, segments.|-|
|Solution|    |    |    |
|solutionId|String|Unique identification|25a061970d8a7ebeb5e63391b9788f36|
|solutionKey|String|Unique identification|0357301bf213453389fcb55c379a4667|
|fareType|String|Fare type, including PUBLIC and PRIVATE|PUBLIC|
|currency|String|Currency|CNY|
|adtFare|BigDecimal|Adult fare|1011|
|adtTax|BigDecimal|Adult tax|527|
|chdFare|BigDecimal|Children [age 2-12] fare|500|
|chdTax|BigDecimal|Children [age 2-12] tax|250|
|infFare|BigDecimal|Infant[age 0-2, no seat] fare|0|
|infTax|BigDecimal|Infant[age 0-2, no seat] tax|0|
|qCharge|BigDecimal|Q charge, bunker adjustment surcharge, for reference only|0|
|tktFee|BigDecimal|Ticketing service fee|0|
|platformServiceFee|BigDecimal|Platform service fee, defaults to 0|0|
|journeys|String[]|JSON format string array. Content: flightID|-|
|platingCarrier|String|Ticketing airline|CA|
|merchantFee|BigDecimal|Payment transaction fee|7.39|
|baggages|String[]|Baggage rule. Refer to Baggages.|-|
|baggageMap|Object|Baggage rule. For reference only. Including 'ADT'、'CHD' and 'INF'. If the request does not include children or infants, 'CHD' or 'INF' would be NULL.|-|
|miniRuleMap|Object|Penalty rule. For reference only, please find precise penalty rule on Penalty API.|-|
|bookingWithoutCard|Integer|Travel document require indicator, 0 - need travel document for booking, 1 - no need travel document for booking|-|
|Baggages|    |    |    |
|index|Integer|Index of journey sequence number 1 corresponds to Journey_0, 2 corresponds to Journey_1.|1|
|baggage|String|Free baggage allowance. The field would be null if the information is failed to collected. Different segment baggage rule would be separated by ','|23KG|
|carryOn|String|Free carry-on bag allowance. The field would be null if the information is failed to collected. Different segment baggage rule would be separated by ','. Part of carry-on info would be included size limitation, as sample|55*45*25cm 10kg|
|Flights|    |    |    |
|flightId|String|Flight ID，unique identification|9ef88fd9dae30560c683911f534c6c49|
|journeyTime|Long|Journey time，unit: minute|350|
|transferCount|Integer|Count of transfer times|1|
|latestTktTime|String|Latest ticketing time (GMT)|2023-10-28 23:59:00|
|segmengtIds|String[]|Including segment [segmentId] array, refer to segmentId (please note the segmengtIds is a typo due to history edition)|-|
|Segments|    |    |    |
|segmentId|String|Segment ID, unique identification|4ee200cb7feab403d6babbf797ac92aa|
|airline|String|Airline code|CA|
|flightNum|String|Flight number|6509|
|equipment|String|Equipment|737|
|cabinClass|String|Cabin class including Economy, PremiumEconomy, Business, First|Economy|
|bookingCode|String|Cabin code|E|
|availabilityCount|Integer|Available seats, for reference only|7|
|departure|String|Departure airport|PEK|
|arrival|String|Arrival airport|HKG|
|departureTerminal|String|Departure airport terminal|3|
|arrivalTerminal|String|Arrival airport terminal|1|
|departureDate|Long|Departure date [unix time]|1446009600000|
|arrivalDate|Long|Arrival date [unix time]|1446017400000|
|flightTime|Integer|Flight time, unit: minute|130|
|stayTime|Integer|Stay time, valid with 'stopover' , unit: minute|60|
|codeShare|String|Code share or not: [Y-yes, N-no]|Y|
|opFltNo|String|Flight number of operated carrier|202|
|opFltAirline|String|Operated carrier|KA|
|stopover|String|Stopover airport|PEK|
|strDepartureDate|String|Departure date[yyyy-MM-dd], local time|2016-08-27|
|strDepartureTime|String|Departure time[HH:mm], local time|09:30|
|strArrivalDate|String|Arrival date[yyyy-MM-dd], local time|2023-08-27|
|strArrivalTime|String|Arrival time[HH:mm], local time|11:50|
|fareBasis|String|Fare basis code|SLCPWFR|
|baggageMap|    |    |    |
|segmentIndexList|String[]|Segment index list for baggage. Index begins with '1'. If 1st segment has same baggage allowance with 3rd segment, please refer to sample|[1,3]|
|baggageAmount|String|Free baggage amount allowance. '1PC' for 1 piece|1PC|
|baggageWeight|String|Free baggage weight allowance|15KG|
|carryOnAmount|String|Free carry-on baggage amount allowance. '1PC' for 1 piece|1PC|
|carryOnWeight|String|Free carry-on baggage weight allowance|7KG|
|miniRuleMap|    |    |    |
|segmentIndex|String[]|Segment index list for penalty. Index begins with '1'. If 1st segment has same penalty rule with 3rd segment, please refer to sample|[1,3]|
|miniRules|Object|Refer to miniRules|-|
|miniRules|    |    |    |
|penaltyType|Integer|Penalty type. [0 - refund, 1 - noShow refund, 2 - change, 3 - noShow change]|0|
|isPermited|Integer|Allow refund/change or not. [0 - not allow, 1 - allow, 2 - unknown]|1|
|when|Integer|0 - Both Outbound and Inbound are not used, 1- Outbound Flight used, 2 - all Situation]|2|
|noShowTime|String|NoShow definition. Apply with 'noShowTimeUnit'|2|
|noShowTimeUnit|String|NoShow Unit. Apply with 'noShowTime'. [H - hour, M - minute]|H|
|amount|BigDecimal|Penalty|300|
|currencyCode|String|Penalty currency|CNY|
|percent|BigDecimal|Penalty percentage. Apply with 'baseType'. Penalty and penalty percentage would not go into effect at the same. Please take the strict one. Unit: %|10|
|baseType|Integer|Apply with 'percent'. Multiply corresponding value of 'baseType' by 'percent' would be the penalty. [0 - fare, 1 - fare+tax+ticketingFee, 2 - cabin basic fare]|0|
|ancillaryAvailability|    |    |    |
|paidBag|Boolean|whether paid bag service is available, true-available, false-unavailable|true|
|paidSeat|Boolean|whether paid seat service is available, true-available, false-unavailable|true|

 

### 5.2 Example

Success Response


```plain
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "solution": {
            "solutionKey": "e3ec99ddb40ca6927370d10bbe104548",
            "solutionId": "8d05ecc310359bf462c33948d1de7915",
            "fareType": "PRIVATE",
            "currency": "USD",
            "adtFare": 30.150,
            "adtTax": 5.420,
            "chdFare": 30.150,
            "chdTax": 5.420,
            "infFare": 24.730,
            "infTax": 0.000,
            "tktFee": 0.000,
            "platformServiceFee": 0,
            "journeys": {
                "journey_0": [
                    "5de86573f580b1d3ce7356cd1b622a8a"
                ]
            },
            "platingCarrier": "FD",
            "merchantFee": 0.00,
            "adults": 1,
            "children": 1,
            "infants": 1,
            "baggages": {
                "1": {
                    "carryOn": "1PC7KG",
                    "baggage": "0PC"
                }
            },
            "baggageMap": {
                "CHD": [
                    {
                        "segmentIndexList": [
                            1
                        ],
                        "baggageAmount": "0PC",
                        "carryOnAmount": "1PC",
                        "carryOnWeight": "7KG"
                    }
                ],
                "ADT": [
                    {
                        "segmentIndexList": [
                            1
                        ],
                        "baggageAmount": "0PC",
                        "carryOnAmount": "1PC",
                        "carryOnWeight": "7KG"
                    }
                ],
                "INF": [
                    {
                        "segmentIndexList": [
                            1
                        ]
                    }
                ]
            },
            "miniRuleMap": {
                "CHD": [
                    {
                        "segmentIndex": [
                            1
                        ],
                        "miniRules": [
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            }
                        ]
                    }
                ],
                "ADT": [
                    {
                        "segmentIndex": [
                            1
                        ],
                        "miniRules": [
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            }
                        ]
                    }
                ],
                "INF": [
                    {
                        "segmentIndex": [
                            1
                        ],
                        "miniRules": [
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 0
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "H"
                            }
                        ]
                    }
                ]
            },
            "bookingWithoutCard": 1
        },
        "flights": [
            {
                "flightId": "5de86573f580b1d3ce7356cd1b622a8a",
                "journeyTime": 90,
                "transferCount": 0,
                "segmentIds": [
                    "f9178c24a76074bf5d97265558151378"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "f9178c24a76074bf5d97265558151378",
                "airline": "FD",
                "flightNum": "3027",
                "equipment": "32S",
                "cabinClass": "ECONOMY",
                "bookingCode": "E",
                "availabilityCount": 5,
                "departure": "DMK",
                "arrival": "HKT",
                "departureTerminal": "2",
                "arrivalTerminal": "D",
                "departureDate": 1711621200000,
                "arrivalDate": 1711626600000,
                "flightTime": 90,
                "codeShare": "N",
                "fareBasis": "YOW",
                "strDepartureDate": "2024-03-28",
                "strDepartureTime": "18:20",
                "strArrivalDate": "2024-03-28",
                "strArrivalTime": "19:50"
            }
        ],
        "ancillaryAvailability": {
            "paidBag": true,
            "paidSeat": true
        }
    }
}
```
1. 

Error Response


```plain
{
    "errorCode": "B020",
    "errorMsg": "Can not find any price for this flight.",
    "data": null
}
```
### 5.3 PrecisePricing Response Breakdown Structure

[PricisePricing Response-V4.pdf](http://open.pkfare.com/api-agent/document/load/166465)

## 6 Error Code List

|erroCode|erroMsg|Description|
|:----|:----|:----|
|0|ok|Request has been processed successfully.|
|S001|System error.|System error.|
|B002|Partner does not exists.|PartnerID does not exist.|
|B003|Illegal sign.|Illegal sign. Please check your signature.|
|B035|Concurrency limited. Please contact PKFARE API support team for assistant.|Concurrency exceeded system limits.|
|P001|XXX is illegal.|The field of XXX is illegal.|
|P002|XXX is missing.|The field of XXX is missing.|
|P004|The maximum number of passengers with seat is 9.|Wrong parameter. The maximum number of passengers with seat is 9.|
|P005|There should be at least one adult.|Wrong parameter. There should be at least one adult.|
|P009|The number of infant passengers can not exceed the number of adult passengers.|Wrong parameter. The number of infant passengers can not exceed the number of adult passengers.|
|B013|Interface is limited, please contact the system administrator.|The route that you request is limited, please contact system administrator.|
|B015|Pricing failed.|Pricing failed for other reason.|
|B016|Flight near take-off, can’t offer pricing service.|Pricing fail. Can not pricing for flights that is near taking off.|
|B018|Airline or flight restriction.|Airline or flight restriction.|
|B019|Can not find any supplier for current search.|Can not find any supplier for current search.|
|B020|Can not find any price for this flight.|Pricing fail. Can not find any price for this flight option.|
|B021|The booking code you choose has only 0 seat available.|Pricing fail. The booking code you choose has 0 seat left. Please choose other booking code or flight.|
|B026|LatestTktTime: yyyy-mm-dd hh : mm: ss.|Last ticketing time is not enough to issue ticket.|
|B024|Pricing TimeOut.|Pricing TimeOut.|
|B035|Concurrency limited. Please contact PKFARE API support team for assistant.|Concurrent users contral. Please contact PKFARE API support for assistant.|
|B039|Can't find the related data of XXX.|Wrong parameter. Can't find the related data of XXX, like illegal city/country/area/airline.|
|B046|Interface is limited, the routing is offlined by PKFARE.|Look to book control. If you need this routing, please contact PKFARE API for assistant.|
|B121|Supplier is offline|Supplier is not at working time, please contact PKFARE API support.|


