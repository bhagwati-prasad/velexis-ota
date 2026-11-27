# Branded Fare Integration Guide

# Overview

We have Branded Fare content from about 140+ airlines on GDS that are available through the most up-to-date APIs. Branded Fare may includes checked bagages, meals, priority boarding and etc. 

**The API verions that support Branded Fare and changes in the RQ and RS**

| **The API verions that support Branded Fare:** | Parameters added in Request | Parameters added in Response | Error Code |
| --- | --- | --- | --- |
| Shopping\_V8 (json format) | tag, returnTagPrice | tag, otherFareRules | B195 - Invalid tag - The tag you request is invalid |
| PrecisePricing\_V10 (json foramt) | tag | tag, otherFareRules |  |
| PreciseBooking\_V7 (json format) | tag | tag |  |
| Penlaty\_V3 (json format) | tag | NONE |  |
| AncillaryPricing\_V6 (json format) | tag | NONE |  |
| OrderPricing\_V5 (json format) | NONE | tag, otherFareRules |  |
| OrderDetail\_V10 (json format) | NONE | tag, otherFareRules |  |

# Tips：

1.  If request at Shopping **without** tag, the response would return regualr content of the lowest prices without Branded Fare.
    
2.  If request at Shopping **with** tag, the response will contain the parameters of tag, and otherFareRules.
    
3.  In the Shopping response, each unique `solutionID` has its corresponding branded fare `Tag`.
    
4.  In the resposne of shopping and pricing, the object `otherFareRules` contains a parameter `detail` which displays the detailed content of that branded fare, for example,  "REFUNDABLE TICKET"，"MILEAGE ACCRUAL", "UPGRADE ELIGIBILITY", "CHANGEABLE TICKET",  "PRIORITY BOARDING
    

# Commonly asked Q & A:

*   Q: How many airlines are current available for branded fare from PKFARE's API
    
    *   A: About 140+ airline are available now, please check some of the airlines and their corresponding branded fare tags below. If you would like to review the full airline and branded fare tag list, please reach out to your account manager or our product operation team.
        
*   Q: Do I have to upgrade to the newest versions of the APIs to receive branded fare content?
    
    *   A: Yes. All the APIs that need to be upgrade are listed above.
        
*   Q: Let's suppose a customer named Alice. Can Alice choose a Branded Fare and a pre-booking or post-booking ancillary purchases?
    
    *   A: Yes, she can.
        
    *   For example, suppose Alice selects a branded fare that includes one free 25kg checked baggage. If the airline allows a maximum of 45kg, Alice can still choose to purchase additional baggage before or after the booking is completed. This would trigger the **AncillaryPricing API**, which would respond by indicating the maximum additional baggage Alice can buy—in this case, up to **20kg more**—without exceeding the airline’s baggage limit. 
        

# Branded Fare Tag List

We currently support branded fare content including but not limited to the following airlines. The branded fare tag code correspond to the officaly branded fare names at this airline. 

**\*\* Please pay attention to the upper and lower cases and the space.**

| **Airlines** | **Branded Fares Tags** |
| --- | --- |
| AA | MAIN CABIN |
| AS | SAVER |
| AZ | ECONOMY LIGHT |
| CX | ECONOMY LIGHT |
|  | ECONOMY ESSENTIAL |
|  | ECONOMY FLEX |
| CZ | ECONOMY FLEX |
| DL | DELTA MAIN |
|  | DELTA MAIN BASIC |
| EK | ECO FLEXPLUS |
|  | ECO FLEX |
|  | ECO SAVER |
| HA | MAIN CABIN BASIC |
| KC | ECONOMY CLASSIC |
|  | ECONOMY PROMO |
|  | ECONOMY COMFORT |
|  | ECONOMY BASIC |
|  | ECONOMY DELUXE |
|  | ECONOMY PLUS |
|  | ECONOMY VALUE |
| QR | ECONOMY CONVENIENCE |
|  | ECONOMY COMFORT |
| S7 | PLUS ECONOMY |
| TK | FLEXIBLE |
|  | RESTRICTED |
| UA | ECONOMY |
| A3 | COMFORTFLEX |
|  | FLEX |
| AF | ECONOMY LIGHT |
| AI | ECONOMY FLEX |
|  | ECONOMY LIGHT |
|  | ECONOMY ESSENTIAL |
| BA | BASIC |
| D8 | LOWFARE |
| DY | LOWFARE |
| EY | ECONOMY COMFORT |
|  | ECONOMY BASIC |
|  | ECONOMY DELUXE |
|  | ECONOMY VALUE |
| G3 | LIGHT |
| GQ | SKY JOY |
| IB | OPTIMA |
| JU | ECONOMY LIGHT |
| KL | ECONOMY LIGHT |
| LA | LIGHT |
| LH | CLASSIC |
| LO | ECONOMY STANDARD |
|  | ECONOMY SAVER |
| LX | CLASSIC |
| MH | FLEX |
|  | BASIC |
| NH | ECO I FULLFLEX 2F |
| OD | SUPER SAVER |
|  | FLEXI |
|  | VALUE |
| OS | CLASSIC |
| PC | BEYOND ESSENTIALS |
| QF | ECONOMY FLEX |
|  | ECONOMY SAVER |
| SK | SAS GO SMART |
| SN | CLASSIC |
| SQ | ECONOMY FLEXI |
| TG | ECONOMY FLEX |
| UX | LITE |
| VN | ECONOMY FLEX |
| VY | OPTIMA |
| WY | ECONOMY FLEX |
|  | ECONOMY COMFORT |
| NK | Spirit First |
|  | Premium Economy |
|  | Value |
| Y4 | Zero |
|  | Plus |
|  | Basic |

# Example of Request and Response with Branded Fare Tag

### Shopping Request 

```json
{
    "authentication": {
        "partnerId": "",
        "sign": ""
    },
    "search": {
        "adults": 1,
        "children": 0,
        "infants": 0,
        "nonstop": 0,
        "airline": "",
        "solutions": 0,
        "tag": "",
        "returnTagPrice": "Y",
        "searchAirLegs": [
            {
                "cabinClass": "",
                "departureDate": "2025-12-15",
                "destination": "BKK",
                "origin": "HKG",
                "airline": ""
            }
        ]
    }
}
```

### Shopping Response (One Exmaple Only)

```json
{
                "solutionKey": "ccab7a77675a461c168ea38682c010b0",
                "solutionId": "gEhPce+vG78Y2lTWLjTjzivJbqzjR6Dy3DS4I6X/M9tSCLzorMjeMuuLzkl56uuI8eeRnSfYGAvd6pKBWb4pfbGXPQwBNdK1umsLUYJ1AxmSK6n/ErIpH4ihfJD/TN+aLtqJMCzT4vAUip9heWXjF/FguxesPgjLM6mvhJjKlhVzY3MPqEfhCdaM+KCgKNlMLMHN1lbCmg32s6MMdlA/Tez+WfUumC4MwuDaEWh3C3uw4sFsr2mSWh6Y6CEBRbje9q1HvsTQyAKtPhp72+CoVsxFRvh0yU0w1SGDv7jOPqOIQoSQBQkrsQDHUZVcel72",
                "fareType": "PUBLIC",
                "currency": "CNY",
                "adtFare": 1565.41,
                "adtTax": 391.56,
                "chdFare": 0,
                "chdTax": 0,
                "qCharge": 0,
                "tktFee": 9.53,
                "platformServiceFee": 0,
                "comments": null,
                "journeys": {
                    "journey_0": [
                        "da367089ffc9886ea10d79e41e9eb000"
                    ]
                },
                "fareRule": null,
                "rule": null,
                "platingCarrier": "CX",
                "prices": null,
                "merchantFee": 0,
                "adults": 1,
                "children": 0,
                "infants": 0,
                "baggageMap": {
                    "ADT": [
                        {
                            "segmentIndexList": [
                                1
                            ],
                            "baggageAmount": "1PC",
                            "baggageWeight": null,
                            "carryOnAmount": "1PC",
                            "carryOnWeight": "7KG",
                            "carryOnSize": null
                        }
                    ]
                },
                "miniRuleMap": {
                    "ADT": [
                        {
                            "segmentIndex": [
                                1
                            ],
                            "miniRules": [
                                {
                                    "penaltyType": 0,
                                    "isPermited": 1,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": 1005,
                                    "currencyCode": "CNY",
                                    "percent": null,
                                    "baseType": null
                                },
                                {
                                    "penaltyType": 0,
                                    "isPermited": 0,
                                    "when": 1,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": null,
                                    "currencyCode": null,
                                    "percent": null,
                                    "baseType": null
                                },
                                {
                                    "penaltyType": 2,
                                    "isPermited": 1,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": 1005,
                                    "currencyCode": "CNY",
                                    "percent": null,
                                    "baseType": null
                                },
                                {
                                    "penaltyType": 2,
                                    "isPermited": 0,
                                    "when": 1,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": null,
                                    "currencyCode": null,
                                    "percent": null,
                                    "baseType": null
                                }
                            ]
                        }
                    ]
                },
                "afterSaleRule": null,
                "category": null,
                "tag": "ECONOMY LIGHT",
                "otherFareRules": {
                    "ADT": [
                        {
                            "segmentIndexList": [
                                1
                            ],
                            "detail": [
                                "REFUNDABLE TICKET",
                                "MILEAGE ACCRUAL",
                                "UPGRADE ELIGIBILITY",
                                "CHANGEABLE TICKET",
                                "GO SHOW",
                                "MAX 2PC OR TTL 30KG 158LCM",
                                "MAX 2PC OR TTL 35KG 158LCM",
                                "MAX 2PC OR TTL 40KG 158LCM",
                                "1PC MAX 23KG 158LCM EACH",
                                "MAX 3PC OR TTL 50KG 158LCM",
                                "2PC MAX 23KG 158LCM EACH",
                                "3PC MAX 32KG 158LCM EACH",
                                "2PC MAX 32KG 158LCM EACH",
                                "1PC MAX 15LB 7KG 115LCM",
                                "1PC MAX 22LB 10KG 115LCM",
                                "1PC MAX 33LB 15KG 115LCM",
                                "FIRST CLASS LOUNGE ACCESS",
                                "BUSINESS CLASS LOUNGE ACCESS",
                                "SEAT ASSIGNMENT",
                                "PRIORITY CHKIN AT CERTAIN PORT",
                                "PRIORITY BOARDING"
                            ]
                        }
                    ]
                }
            },
```

### PrecisePricing Request

```json
{
    "authentication": {
        "partnerId": "",
        "sign": ""
    },
    "pricing": {
        "journeys": {
            "journey_0": [
                {
                    "airline": "CX",
                    "flightNum": "617",
                    "arrival": "BKK",
                    "arrivalDate": "2025-12-16",
                    "arrivalTime": "00:10",
                    "departure": "HKG",
                    "departureDate": "2025-12-15",
                    "departureTime": "22:10",
                    "bookingCode": "S"
                }
            ]
        },
        "adults": 1,
        "children":0,
        "infants": 0,
        "solutionId": "gEhPce+vG78Y2lTWLjTjzivJbqzjR6Dy3DS4I6X/M9tSCLzorMjeMuuLzkl56uuI8eeRnSfYGAvd6pKBWb4pfbGXPQwBNdK1umsLUYJ1AxmSK6n/ErIpH4ihfJD/TN+aLtqJMCzT4vAUip9heWXjF/FguxesPgjLM6mvhJjKlhVzY3MPqEfhCdaM+KCgKNlMLMHN1lbCmg32s6MMdlA/Tez+WfUumC4MwuDaEWh3C3uw4sFsr2mSWh6Y6CEBRbje9q1HvsTQyAKtPhp72+CoVsxFRvh0yU0w1SGDv7jOPqOIQoSQBQkrsQDHUZVcel72",
        "cabin": "",
        "tag": "ECONOMY LIGHT"
    }
}
```

### PrecisePricing Response

```json
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "solution": {
            "solutionKey": "ccab7a77675a461c168ea38682c010b0",
            "solutionId": "gEhPce+vG78Y2lTWLjTjzivJbqzjR6Dy3DS4I6X/M9tSCLzorMjeMuuLzkl56uuI8eeRnSfYGAvd6pKBWb4pfbGXPQwBNdK1umsLUYJ1AxmSK6n/ErIpH4ihfJD/TN+aLtqJMCzT4vAUip9heWXjF/FguxesPgjLM6mvhJjKlhVzY3MPqEfhCdaM+KCgKNlMLMHN1lbCmg32s6MMdlA/Tez+WfUumC4MwuDaEWh3C3uw4sFsr2mSWh6Y6CEBRbje9q1HvsTQyAKtPhp72+CoVsxFRvh0yU0w1SGDv7jOPqOIQoSQBQkrsQDHUZVcel72",
            "fareType": "PUBLIC",
            "currency": "CNY",
            "adtFare": 1565.41,
            "adtTax": 391.56,
            "chdFare": 0,
            "chdTax": 0,
            "tktFee": 9.53,
            "platformServiceFee": 0,
            "journeys": {
                "journey_0": [
                    "da367089ffc9886ea10d79e41e9eb000"
                ]
            },
            "platingCarrier": "CX",
            "merchantFee": 0,
            "adults": 1,
            "children": 0,
            "infants": 0,
            "baggages": {
                "1": {
                    "carryOn": "1PC7KG",
                    "baggage": "1PC"
                }
            },
            "baggageMap": {
                "ADT": [
                    {
                        "segmentIndexList": [
                            1
                        ],
                        "baggageAmount": "1PC",
                        "carryOnAmount": "1PC",
                        "carryOnWeight": "7KG"
                    }
                ]
            },
            "miniRuleMap": {
                "ADT": [
                    {
                        "segmentIndex": [
                            1
                        ],
                        "miniRules": [
                            {
                                "penaltyType": 1,
                                "isPermited": 1,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "M",
                                "amount": 3205,
                                "currencyCode": "CNY"
                            },
                            {
                                "penaltyType": 0,
                                "isPermited": 1,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "M",
                                "amount": 1005,
                                "currencyCode": "CNY"
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 0,
                                "when": 1
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 0,
                                "when": 1
                            },
                            {
                                "penaltyType": 3,
                                "isPermited": 1,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "M",
                                "amount": 3205,
                                "currencyCode": "CNY"
                            },
                            {
                                "penaltyType": 1,
                                "isPermited": 0,
                                "when": 1
                            },
                            {
                                "penaltyType": 2,
                                "isPermited": 1,
                                "when": 0,
                                "noShowTime": "0",
                                "noShowTimeUnit": "M",
                                "amount": 1005,
                                "currencyCode": "CNY"
                            },
                            {
                                "penaltyType": 0,
                                "isPermited": 0,
                                "when": 1
                            }
                        ]
                    }
                ]
            },
            "bookingWithoutCard": 1,
            "tag": "ECONOMY LIGHT",
            "otherFareRules": {
                "ADT": [
                    {
                        "segmentIndexList": [
                            1
                        ],
                        "detail": [
                            "REFUNDABLE TICKET",
                            "MILEAGE ACCRUAL",
                            "UPGRADE ELIGIBILITY",
                            "CHANGEABLE TICKET",
                            "GO SHOW",
                            "MAX 2PC OR TTL 30KG 158LCM",
                            "MAX 2PC OR TTL 35KG 158LCM",
                            "MAX 2PC OR TTL 40KG 158LCM",
                            "1PC MAX 23KG 158LCM EACH",
                            "MAX 3PC OR TTL 50KG 158LCM",
                            "2PC MAX 23KG 158LCM EACH",
                            "3PC MAX 32KG 158LCM EACH",
                            "2PC MAX 32KG 158LCM EACH",
                            "1PC MAX 15LB 7KG 115LCM",
                            "1PC MAX 22LB 10KG 115LCM",
                            "1PC MAX 33LB 15KG 115LCM",
                            "FIRST CLASS LOUNGE ACCESS",
                            "BUSINESS CLASS LOUNGE ACCESS",
                            "SEAT ASSIGNMENT",
                            "PRIORITY CHKIN AT CERTAIN PORT",
                            "PRIORITY BOARDING"
                        ]
                    }
                ]
            }
        },
        "flights": [
            {
                "flightId": "da367089ffc9886ea10d79e41e9eb000",
                "journeyTime": 180,
                "transferCount": 0,
                "lastTktTime": "2025-12-15 22:59:00",
                "segmentIds": [
                    "0e0c9edc7d4281d60eba051cb5c5ede3"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "0e0c9edc7d4281d60eba051cb5c5ede3",
                "airline": "CX",
                "flightNum": "617",
                "equipment": "333",
                "cabinClass": "ECONOMY",
                "bookingCode": "S",
                "availabilityCount": 9,
                "departure": "HKG",
                "arrival": "BKK",
                "departureTerminal": "1",
                "arrivalTerminal": "",
                "departureDate": 1765807800000,
                "arrivalDate": 1765815000000,
                "flightTime": 180,
                "codeShare": "N",
                "opFltNo": "617",
                "opFltAirline": "CX",
                "fareBasis": "SR21WTAO",
                "strDepartureDate": "2025-12-15",
                "strDepartureTime": "22:10",
                "strArrivalDate": "2025-12-16",
                "strArrivalTime": "00:10"
            }
        ],
        "ancillaryAvailability": {
            "paidBag": true,
            "paidSeat": false
        }
    }
}
```

### PreciseBooking Request

```json
{
    "authentication": {
        "partnerId": "",
        "sign": ""
    },
    "booking": {
        "passengers": [
            {
                "passengerIndex": 1,
                "birthday": "1993-06-22",
                "firstName": "Alice",
                "lastName": "Zhang",
                "nationality": "CN",
                "psgType": "ADT",
                "sex": "F",
                "ffpNumber": "125003559853",
                "ffpAirline": "CA",
                "ktn": "1029490",
                "redress": "2039401"
            }
        ],
        "solution": {
            "solutionId": "gEhPce+vG78Y2lTWLjTjzivJbqzjR6Dy3DS4I6X/M9tSCLzorMjeMuuLzkl56uuI8eeRnSfYGAvd6pKBWb4pfbGXPQwBNdK1umsLUYJ1AxmSK6n/ErIpH4ihfJD/TN+aLtqJMCzT4vAUip9heWXjF/FguxesPgjLM6mvhJjKlhVzY3MPqEfhCdaM+KCgKNlMLMHN1lbCmg32s6MMdlA/Tez+WfUumC4MwuDaEWh3C3uw4sFsr2mSWh6Y6CEBRbje9q1HvsTQyAKtPhp72+CoVsxFRvh0yU0w1SGDv7jOPqOIQoSQBQkrsQDHUZVcel72",
            "adtFare": 1565.41,
            "adtTax": 391.56,
            "chdFare": 0,
            "chdTax": 0,
            "infFare": 0,
            "infTax": 0,
            "tag":"ECONOMY LIGHT",
            "journeys": {
                "journey_0": [
                    {
                        "airline": "CX",
                        "flightNum": "617",
                        "arrival": "BKK",
                        "arrivalDate": "2025-12-16",
                        "arrivalTime": "00:10",
                        "departure": "HKG",
                        "departureDate": "2025-12-15",
                        "departureTime": "22:10",
                        "bookingCode": "S"
                    }
                ]
            }
        },
        "contact": {
            "name": "AndyGuan",
            "email": "an-dy.gu_an@pkfare.com",
            "telCode": "+86",
            "mobile": "17826050868",
            "buyerEmail": "alan.wang@pkfare.com",
            "buyerTelCode": "+86",
            "buyerMobile": "18066793072"
        }
    }
}
```

### PreciseBooking Response

```json
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "orderNum": "917542789129361301",
        "pnr": "WCJCOJ",
        "solution": {
            "solutionKey": "ccab7a77675a461c168ea38682c010b0",
            "solutionId": "gEhPce+vG78Y2lTWLjTjzivJbqzjR6Dy3DS4I6X/M9tSCLzorMjeMuuLzkl56uuI8eeRnSfYGAvd6pKBWb4pfbGXPQwBNdK1umsLUYJ1AxmSK6n/ErIpH4ihfJD/TN+aLtqJMCzT4vAUip9heWXjF/FguxesPgjLM6mvhJjKlhVzY3MPqEfhCdaM+KCgKNlMLMHN1lbCmg32s6MMdlA/Tez+WfUumC4MwuDaEWh3C3uw4sFsr2mSWh6Y6CEBRbje9q1HvsTQyAKtPhp72+CoVsxFRvh0yU0w1SGDv7jOPqOIQoSQBQkrsQDHUZVcel72",
            "fareType": "PUBLIC",
            "currency": "CNY",
            "adtFare": 1566.8,
            "adtTax": 394.32,
            "chdFare": 0,
            "chdTax": 0,
            "qCharge": 0,
            "tktFee": 0,
            "platformServiceFee": 0,
            "journeys": {
                "journey_0": [
                    "da367089ffc9886ea10d79e41e9eb000"
                ]
            },
            "platingCarrier": "CX",
            "merchantFee": 0,
            "adults": 1,
            "children": 0,
            "infants": 0,
            "baggageMap": {
                "ADT": [
                    {
                        "segmentIndexList": [
                            1
                        ],
                        "baggageAmount": "1PC",
                        "carryOnAmount": "1PC",
                        "carryOnWeight": "7KG"
                    }
                ]
            },
            "tag": "ECONOMY LIGHT"
        },
        "flights": [
            {
                "flightId": "da367089ffc9886ea10d79e41e9eb000",
                "journeyTime": 180,
                "transferCount": 0,
                "lastTktTime": "2025-12-16 04:59:00",
                "segmengtIds": [
                    "0e0c9edc7d4281d60eba051cb5c5ede3"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "0e0c9edc7d4281d60eba051cb5c5ede3",
                "airline": "CX",
                "flightNum": "617",
                "equipment": "333",
                "cabinClass": "ECONOMY",
                "bookingCode": "S",
                "availabilityCount": 9,
                "departure": "HKG",
                "arrival": "BKK",
                "departureTerminal": "1",
                "arrivalTerminal": "",
                "departureDate": 1765807800000,
                "arrivalDate": 1765815000000,
                "flightTime": 180,
                "codeShare": "N",
                "opFltNo": "617",
                "opFltAirline": "CX",
                "strDepartureDate": "2025-12-15",
                "strDepartureTime": "22:10",
                "strArrivalDate": "2025-12-16",
                "strArrivalTime": "00:10"
            }
        ]
    }
}
```

### OrderPricing Request

```json
{
    "authentication": {
        "partnerId": "",
        "sign": ""
    },
    "orderPricing": {
        "orderNum": "917542789129361301"
    }
}
```

### OrderPricing Response

```json
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "pricingResult": {
            "solution": {
                "fareType": "PUBLIC",
                "currency": "CNY",
                "adtFare": 1566.8,
                "adtTax": 394.32,
                "chdFare": 0,
                "chdTax": 0,
                "infFare": 0,
                "infTax": 0,
                "qCharge": 0,
                "tktFee": 0,
                "platformServiceFee": 0,
                "journeys": {
                    "journey_0": [
                        "6da9003b743b65f4c0ccd295cc484e57"
                    ]
                },
                "merchantFee": 0,
                "adults": 1,
                "children": 0,
                "infants": 0,
                "tag": "ECONOMY LIGHT",
                "otherFareRules": {
                    "ADT": {
                        "segmentIndexList": [
                            1
                        ],
                        "detail": [
                            "REFUNDABLE TICKET",
                            "MILEAGE ACCRUAL",
                            "UPGRADE ELIGIBILITY",
                            "CHANGEABLE TICKET",
                            "GO SHOW",
                            "MAX 2PC OR TTL 30KG 158LCM",
                            "MAX 2PC OR TTL 35KG 158LCM",
                            "MAX 2PC OR TTL 40KG 158LCM",
                            "1PC MAX 23KG 158LCM EACH",
                            "MAX 3PC OR TTL 50KG 158LCM",
                            "2PC MAX 23KG 158LCM EACH",
                            "3PC MAX 32KG 158LCM EACH",
                            "2PC MAX 32KG 158LCM EACH",
                            "1PC MAX 15LB 7KG 115LCM",
                            "1PC MAX 22LB 10KG 115LCM",
                            "1PC MAX 33LB 15KG 115LCM",
                            "FIRST CLASS LOUNGE ACCESS",
                            "BUSINESS CLASS LOUNGE ACCESS",
                            "SEAT ASSIGNMENT",
                            "PRIORITY CHKIN AT CERTAIN PORT",
                            "PRIORITY BOARDING"
                        ]
                    }
                }
            },
            "flights": [
                {
                    "flightId": "6da9003b743b65f4c0ccd295cc484e57",
                    "journeyTime": 180,
                    "transferCount": 0,
                    "lastTktTime": "2025-08-04 05:41:53",
                    "segmengtIds": [
                        "0e0c9edc7d4281d60eba051cb5c5ede3"
                    ]
                }
            ],
            "segments": [
                {
                    "segmentId": "0e0c9edc7d4281d60eba051cb5c5ede3",
                    "airline": "CX",
                    "flightNum": "617",
                    "equipment": "333",
                    "cabinClass": "ECONOMY",
                    "bookingCode": "S",
                    "availabilityCount": 1,
                    "departure": "HKG",
                    "arrival": "BKK",
                    "departureTerminal": "1",
                    "arrivalTerminal": "",
                    "departureDate": 1765807800000,
                    "arrivalDate": 1765815000000,
                    "flightTime": 180,
                    "codeShare": "N",
                    "opFltNo": "617",
                    "opFltAirline": "CX",
                    "strDepartureDate": "2025-12-15",
                    "strDepartureTime": "22:10",
                    "strArrivalDate": "2025-12-16",
                    "strArrivalTime": "00:10"
                }
            ]
        },
        "orderResult": {
            "orderNum": "917542789129361301",
            "pnr": "WCJCOJ"
        }
    }
}
```

### OrderDetail Request

```json
 {
   "authentication": {
        "partnerId": "",
        "sign": ""
	},
    "data": {
        "orderNum":"917542789129361301",
        "includeFields":"passengers,journeys,solutions,ancillary,scheduleChange,checkinInfo"
    }
}
```

### OrderDetail Response

```json
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "orderStatus": "TO_BE_PAID",
        "orderNum": "917542789129361301",
        "refOrderNum": "9175427891293613",
        "orderType": "O",
        "createdTime": "2025-08-04 03:41:52",
        "pnr": "WCJCOJ",
        "airPnr": "CX/WCJCOJ",
        "platingCarrier": "CX",
        "passengers": [
            {
                "firstName": "Ace",
                "lastName": "Zhang",
                "psgType": "ADT",
                "nationality": "CN",
                "sex": "F",
                "birthday": "1998-06-01",
                "cardType": "O",
                "ticketNum": "",
                "passengerIndex": 1,
                "seats": [
                    {
                        "airline": "CX",
                        "flightNum": "617",
                        "seatNum": ""
                    }
                ]
            }
        ],
        "journeys": [
            {
                "journeyTime": 180,
                "transferCount": 0,
                "segments": [
                    {
                        "airline": "CX",
                        "flightNum": "617",
                        "equipment": "333",
                        "cabinClass": "ECONOMY",
                        "bookingCode": "S",
                        "departure": "HKG",
                        "arrival": "BKK",
                        "departureTerminal": "1",
                        "arrivalTerminal": "",
                        "departureDate": "2025-12-15",
                        "arrivalDate": "2025-12-16",
                        "departureTime": "22:10",
                        "arrivalTime": "00:10",
                        "flightTime": 180,
                        "codeShare": "N",
                        "opFltNo": "617",
                        "opFltAirline": "CX",
                        "fareBasis": "SR21WTAO"
                    }
                ],
                "departureTime": "22:10",
                "arrivalTime": "00:10",
                "departureDate": "2025-12-15",
                "arrivalDate": "2025-12-16"
            }
        ],
        "solutions": [
            {
                "currency": "CNY",
                "adtFare": 1566.8,
                "adtTax": 394.32,
                "tktFee": 0,
                "merchantFee": 0,
                "distCost": 0,
                "coupon": 0,
                "buyerAmount": 1961.12,
                "tag": "ECONOMY LIGHT",
                "otherFareRules": {
                    "ADT": {
                        "segmentIndexList": [
                            1
                        ],
                        "detail": [
                            "REFUNDABLE TICKET",
                            "MILEAGE ACCRUAL",
                            "UPGRADE ELIGIBILITY",
                            "CHANGEABLE TICKET",
                            "GO SHOW",
                            "MAX 2PC OR TTL 30KG 158LCM",
                            "MAX 2PC OR TTL 35KG 158LCM",
                            "MAX 2PC OR TTL 40KG 158LCM",
                            "1PC MAX 23KG 158LCM EACH",
                            "MAX 3PC OR TTL 50KG 158LCM",
                            "2PC MAX 23KG 158LCM EACH",
                            "3PC MAX 32KG 158LCM EACH",
                            "2PC MAX 32KG 158LCM EACH",
                            "1PC MAX 15LB 7KG 115LCM",
                            "1PC MAX 22LB 10KG 115LCM",
                            "1PC MAX 33LB 15KG 115LCM",
                            "FIRST CLASS LOUNGE ACCESS",
                            "BUSINESS CLASS LOUNGE ACCESS",
                            "SEAT ASSIGNMENT",
                            "PRIORITY CHKIN AT CERTAIN PORT",
                            "PRIORITY BOARDING"
                        ]
                    }
                },
                "baggages": {
                    "1": {
                        "carryOn": "1PC7KG",
                        "baggage": "1PC"
                    }
                },
                "baggageMap": {
                    "ADT": [
                        {
                            "segmentIndexList": [
                                1
                            ],
                            "baggageAmount": "1PC",
                            "carryOnAmount": "1PC",
                            "carryOnWeight": "7KG"
                        }
                    ]
                }
            }
        ],
        "lastTktTime": "2025-08-04 05:41:53",
        "ancillaryItems": [],
        "pnrList": [],
        "permitVoid": 0,
        "checkInInfos": [
            {
                "firstName": "ACE",
                "lastName": "ZHANG",
                "ticketNum": "",
                "pnr": "WCJCOJ",
                "airPnr": "CX/WCJCOJ",
                "airline": "CX",
                "mailAccount": "abc@abc.com",
                "mailPassword": "a1s2d3f4#",
                "airlineWebsite": "https://www.airline.com"
            }
        ]
    }
}
```