# Shopping_V4

## 1 Function

Through Shopping API, users can check flight availability and its price by using relevant parameters. Shopping service supports one-way trip, round trip and open jaw (2 journeys max).

## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|Shopping|[https://api.pkfare.com/shopping](https://api.pkfare.com/shopping)|    |
|Shopping_V2|[https://api.pkfare.com/shoppingV2](https://api.pkfare.com/shoppingV2)|Add BaggageMap and MiniRuleMap, only for reference.|
|Shopping_V3|[https://api.pkfare.com/shoppingV](https://api.pkfare.com/shoppingV2)3|Support infant（without seat) tickets.|
|Shopping_V4|[https://api.pkfare.com/shoppingV](https://api.pkfare.com/shoppingV2)4|Add solutionId to enhance tracebility and visibility |

*Below is the most updated version*

## 3 Character Encoding

The character code of this API is UTF-8. 

## 4 Request

Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. Response would be compressed by GZIP. Please decompress response.

### 4.1 Schema

|Name|Type|Required or Not|Parameter  Description|Sample|
|:----|:----|:----|:----|:----|
|Authentication|    |    |    |    |
|partnerId|String|Yes|Partner ID |HJqiE0YKcJlXjknkCkZKhzIis5o=|
|sign|String|Yes|Signature, sign=MD5(partnerId+partnerKey)|fed53d44ea413c40d5f1d18e69047b7c|
|Search|    |    |    |    |
|adults|Integer|Yes|Number of adult passenger |1|
|children|Integer|No|Number of child [age 2-12] passenger |1|
|infants|Integer|No|Number of infant [age 0-2, no seat] passenger |1|
|nonstop|Integer|No|Only search for non-stop flight[0= No; 1=Yes]|0|
|airline|String|No|Search for specific airline; Support one airline only; IATA airlines code|CA|
|solutions|Integer|No|Suggested quantity of returned solutions|0|
|searchAirLegs|Array|Yes|Journey object array, |-|
|searchAirlegs|    |    |    |    |
|cabinClass|String|No|Cabin class [default : economy]|Economy；PremiumEconomy；Business；First|
|destination|String|Yes|Destination [IATA airport/city code]|SIN|
|origin|String|Yes|Origin [IATA airport/city code ]|HKG|
|departureDate|String|Yes|Departure date [yyyy-MM-dd]|2023-10-22|


### 4.2 Example

1. One Way Journey
```plain
{
    "authentication": {
        "partnerId": "ojRw6HvWEDYaF6BPcICoQGJSXhw=",
        "sign": "xxxxx"
    },
    "search": {
        "airline":"UO",
        "adults": 1,
        "children": 0,
        "fromOta": true,
        "infants": 0,
        "nonstop": 1,
        "oldShopping": 0,
        "searchAirLegs": [
            {
                "cabinClass": "Economy",
                "departureDate": "2024-04-15",
                "destination": "BKK",
                "origin": "HKG"
            }
        ],
        "solutions": 0,
        "stressTest": false
    }
}
```



2. Round Trip Journey

```plain
{
    "authentication": {
        "partnerId": "HJqiE0YKcJlXjknkCkZKhzIis5o=",
        "sign": "fed53d44ea413c40d5f1d18e69047b7c"
    },
    "search": {
        "adults": 2,
        "airline": "",
        "children": 1,
        "infants": 1,
        "nonstop": 0,
        "searchAirLegs": [
            {
                "cabinClass": "Economy",
                "departureDate": "2023-10-16",
                "destination": "LAX",
                "origin": "HKG"
            },
            {
                "cabinClass": "Economy",
                "departureDate": "2023-11-23",
                "destination": "HKG",
                "origin": "LAX"
            }
        ],
        "solutions": 50
    }
}
```

3. Open Jaw Journey
```plain
{
    "authentication": {
        "partnerId": "HJqiE0YKcJlXjknkCkZKhzIis5o=",
        "sign": "fed53d44ea413c40d5f1d18e69047b7c"
    },
    "search": {
        "adults": 2,
        "airline": "",
        "children": 1,
        "infants": 1,
        "nonstop": 0,
        "searchAirLegs": [
            {
                "cabinClass": "Economy",
                "departureDate": "2023-11-16",
                "destination": "LAX",
                "origin": "HKG"
            },
            {
                "cabinClass": "Economy",
                "departureDate": "2023-11-23",
                "destination": "SEA",
                "origin": "LAX"
            }
        ],
        "solutions": 50
    }
}
```

## 5 Response

### 5.1 Schema

|Name|Type|Parameter Description|Sample|
|:----|:----|:----|:----|
|Basic Parameters|    |    |    |
|errorCode|String|Error code, refer to error code list|0|
|errorMsg|String|Error message|OK|
|data|Object|Only if the errorCode returns "0", returned data would not be null. Data is in JSON format, which contains three collection objects: solutions , flights, segments|-|
|Solution|    |    |    |
|solutionId|String|Unique identification|25a061970d8a7ebeb5e63391b9788f36|
|solutionKey|String|Unique identification|0357301bf213453389fcb55c379a4667|
|fareType|String|Fare type, PUBLIC or PRIVATE|PUBLIC|
|currency|String|currency|CNY|
|adtFare|BigDecimal|adult fare|1011|
|adtTax|BigDecimal|adult tax|527|
|chdFare|BigDecimal|children [age 2-12] fare|500|
|chdTax|BigDecimal|children [age 2-12] tax|250|
|infFare|BigDecimal|infant [age 0-2, no seat] fare|100|
|infTax|BigDecimal|infant [age 0-2, no seat] tax|50|
|qCharge|BigDecimal|Q charge, bunker adjustment surcharge, for reference only|0|
|tktFee|BigDecimal|ticketing service fee|0|
|baggageMap|Object|baggage rule. For reference only. Including 'ADT'、'CHD' and 'INF'. If the request does not include children or infants, 'CHD' or 'INF' would be NULL. |-|
|MiniRuleMap|Object|penalty rule. For reference only, please find precise penalty rule on Penalty API. |-|
|platformServiceFee|BigDecimal|platform service fee, defaults to 0|0|
|comments|String|comments|-|
|journeys|Object|journey_0 outboundtrip, journey_1 inbound trip, refer to flightId|-|
|fareRule|Object|supplier rule, not supported yet|-|
|rule|Object|PKFARE API rule, not supported yet|-|
|platingCarrier|String|ticketing airline|CA|
|merchantFee|BigDecimal|payment transaction fee|7.39|
|afterSaleRule|Object|not supported yet.|-|
|Flights|    |    |    |
|flightId|String|flight ID, unique identification|9ef88fd9dae30560c683911f534c6c49|
|journeyTime|Long|journey time, unit: minute|350|
|transferCount|Integer|transfer times|1|
|lastTktTime|String|last ticketing time (GMT)|2015-10-28 23:59:00|
|segmentIds|String[]|Including segment [segmentId] array, refer to segmentId |-|
|Segments|    |    |    |
|segmentId|String|segment ID, unique identification|4ee200cb7feab403d6babbf797ac92aa|
|airline|String|airline code|CA|
|flightNum|String|flight number|6509|
|equipment|String|equipment|737|
|cabinClass|String|cabin class including Economy, PremiumEconomy, Business, First|Economy|
|bookingCode|String|cabin code|E|
|availabilityCount|Integer|available seats, for reference only|7|
|departure|String|departure airport|PEK|
|arrival|String|arrival airport|HKG|
|departureTerminal|String|departure airport terminal|3|
|arrivalTerminal|String|arrival airport terminal|1|
|departureDate|Long|departure date [unix time]|1446009600000|
|arrivalDate|Long|arrival date [unix time]|1446017400000|
|flightTime|Integer|flight time, unit: minute|130|
|stayTime|Integer|stay time, valid with 'stopover' , unit: minute|60|
|codeShare|String|code share or not: [Y-yes, N-no]|Y|
|opFltNo|String|flight number of operated carrier|202|
|opFltAirline|String|operated carrier|KA|
|stopover|String|stopover airport|PVG|
|strDepartureDate|String|departure date[yyyy-MM-dd], local time|2016-08-27|
|strDepartureTime|String|departure time[HH:mm], local time|09:30|
|strArrivalDate|String|arrival date[yyyy-MM-dd], local time|2016-08-27|
|strArrivalTime|String|arrival time[HH:mm], local time|11:50|
|fareBasis|String|fare basis code|SLCPWFR|
|baggageMap|    |    |    |
|segmentIndexList|String[]|segment index list for baggage. Index begins with '1'. If 1st segment has same baggage allowance with 3rd segment, please refer to sample|[1,3]|
|baggageAmount|String|free baggage amount allowance. '1PC' for 1 piece|1PC|
|baggageWeight|String|free baggage weight allowance|15KG|
|carryOnAmount|String|free carry-on baggage amount allowance. '1PC' for 1 piece|1PC|
|carryOnWeight|String|free carry-on baggage weight allowance|7KG|
|miniRuleMap|    |    |    |
|segmentIndex|String[]|segment index list for penalty. Index begins with '1'. If 1st segment has same penalty rule with 3rd segment, please refer to sample|[1,3]|
|miniRules|Object|refer to miniRules|-|
|miniRules|    |    |    |
|penaltyType|Integer|penalty type. [0 - refund, 1 - noShow refund, 2 - change, 3 - noShow change]|0|
|isPermited|Integer|allow refund/change or not. [0 - not allow, 1 - allow, 2 - unknown]|1|
|when|Integer|appropriate situation. [0 - Both Outbound and Inbound are not used, 1- Outbound Flight used, 2 - all Situation]|2|
|noShowTime|String|noShow definition. Apply with 'noShowTimeUnit'|2|
|noShowTimeUnit|String|noShow Unit. Apply with 'noShowTime'. [H - hour, M - minute]|H|
|amount|BigDecimal|penalty|300|
|currencyCode|String|penalty currency|CNY|
|percent|BigDecimal|penalty percentage. Apply with 'baseType'. Penalty and penalty percentage would not go into effect at the same. Please take the strict one. Unit: %|10|
|baseType|Integer|apply with 'percent'. Multiply corresponding value of 'baseType' by 'percent' would be the penalty. [0 - fare, 1 - fare+tax+ticketingFee, 2 - cabin basic fare]|0|

### 5.2 Example

1. Success Response
```plain
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "searchKey": "HKGBKK20240415Y1001UO",
        "shoppingKey": "eea11ca4a523a0c99812fad0201d582b",
        "solutions": [
            {
                "solutionKey": "3ae425c8566c492dbc1481a4677d9a8a",
                "solutionId": "hhQKlXX38bThxfFbh+E9m/hbzWF4gWXGR+fTq0UTB/5jortNNEQh8c5YYZTig7usIbD9zw6Z+uCv7T5LEp7b/3XTdL2WPQs108z/pDvKpTgVTurYlfkCwI7HbXdFyZyy0rQYDpqwuY2U5OHmFwJYyhmqz+o86xRNbP4HqIrO2rCSN68StUK5NUwGEZHFuVGJYjAi40H21GejFUYSLRetkLbd5EglKxG+R1Si/3zNQVuDE4m7X0f6oxS/V10VApjBFmi6fKVAAK90j4/LjuLZKFtW/zHc/pUJyyCRIPlJ6hiKtDSDAMqLnYN41Yu+uWvC",
                "fareType": "PRIVATE",
                "currency": "USD",
                "adtFare": 81.070,
                "adtTax": 58.310,
                "chdFare": 0,
                "chdTax": 0,
                "qCharge": 0,
                "tktFee": 0.000,
                "platformServiceFee": 0,
                "comments": null,
                "journeys": {
                    "journey_0": [
                        "51fa1ce0c85fa868b7121d73787fb830"
                    ]
                },
                "fareRule": null,
                "rule": null,
                "platingCarrier": "UO",
                "prices": null,
                "merchantFee": 0.00,
                "adults": 1,
                "children": 0,
                "infants": 0,
                "baggageMap": {
                    "ADT": [
                        {
                            "segmentIndexList": [
                                1
                            ],
                            "baggageAmount": "0PC",
                            "baggageWeight": null,
                            "carryOnAmount": "0PC",
                            "carryOnWeight": "17.5KG",
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
                                    "isPermited": 0,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": null,
                                    "currencyCode": null,
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                },
                                {
                                    "penaltyType": 1,
                                    "isPermited": 0,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": null,
                                    "currencyCode": null,
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                },
                                {
                                    "penaltyType": 2,
                                    "isPermited": 1,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": 67,
                                    "currencyCode": "USD",
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                },
                                {
                                    "penaltyType": 3,
                                    "isPermited": 0,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": null,
                                    "currencyCode": null,
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                }
                            ]
                        }
                    ]
                },
                "afterSaleRule": null
            },
            {
                "solutionKey": "c33ed9b2a09bcbafa47fc2359b231a7f",
                "solutionId": "kEsN5y1uRlxlW67IwyIcvSswoOaaTFOz7fq+HIcV8rl7R3j6S3X+UufHX+XcNmDHDIiO7divHz62BRxlfoqHobBmhdZ63/TnKGFLjFr96AX9pQPb7Zrn//jreGClWW/iJ5tLBxbJPJEiqfzqlNdZbloq+prEgt9TpHrW3cvulKh8mw8/JygIgl+C7JJvgoFMrAksORxZKbYsZmzLSTVK8oIEEJRVcQkLbzaRI1mvs9A6mOPNhrJ6AUcKvZbZW+w2HgoPISuLHrB1u5LCxOwUUFlFA2oYoFxUHacZdhmOSsyO3mMxRi2NbhUeqwHksMMP",
                "fareType": "PUBLIC",
                "currency": "USD",
                "adtFare": 67.910,
                "adtTax": 61.760,
                "chdFare": 0,
                "chdTax": 0,
                "qCharge": 0,
                "tktFee": 0.000,
                "platformServiceFee": 0,
                "comments": null,
                "journeys": {
                    "journey_0": [
                        "eb99261d5c578e9718b5fbfbd133602c"
                    ]
                },
                "fareRule": null,
                "rule": null,
                "platingCarrier": "UO",
                "prices": null,
                "merchantFee": 0.00,
                "adults": 1,
                "children": 0,
                "infants": 0,
                "baggageMap": {
                    "ADT": [
                        {
                            "segmentIndexList": [
                                1
                            ],
                            "baggageAmount": null,
                            "baggageWeight": "20KG",
                            "carryOnAmount": "0PC",
                            "carryOnWeight": "17.5KG",
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
                                    "penaltyType": 2,
                                    "isPermited": 1,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": 76,
                                    "currencyCode": "USD",
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                },
                                {
                                    "penaltyType": 0,
                                    "isPermited": 0,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": null,
                                    "currencyCode": null,
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                }
                            ]
                        }
                    ]
                },
                "afterSaleRule": null
            },
            {
                "solutionKey": "35caba44ec6ee06c5e50e160e5f82930",
                "solutionId": "uPqqzT17niNimeS2QrEMbDN5f7AYM2El63FBn+Yl6uglTBBl7klcv8BSOalYq7kjvJrPSpsL86Fga3vjWYKCtrj/tbfVoDQMgJIOGl60nRqQfeoa0i76dXi/FwOw+O2yES26yA4Wg5F8WKvU4sYn5hAdJ/iEh2mDqdnzYXBa+3WD/Mb0bw2aUK/VebDTs3NEh8SXaDclAruSPgM8fontQK9jqBFIHqxCPncKjCxpJVOC8bilktfzDSwBzbJ0hh+lGGLN68u3jDrmKgq569F7RfWgPX5CMz1pWM5fK14ar4oFu+qwdC37VNDXaa52j9Pp",
                "fareType": "PUBLIC",
                "currency": "USD",
                "adtFare": 74.800,
                "adtTax": 61.760,
                "chdFare": 0,
                "chdTax": 0,
                "qCharge": 0,
                "tktFee": 0.000,
                "platformServiceFee": 0,
                "comments": null,
                "journeys": {
                    "journey_0": [
                        "4cf9c3bf6f34dca474908ab1c9ccb736"
                    ]
                },
                "fareRule": null,
                "rule": null,
                "platingCarrier": "UO",
                "prices": null,
                "merchantFee": 0.00,
                "adults": 1,
                "children": 0,
                "infants": 0,
                "baggageMap": {
                    "ADT": [
                        {
                            "segmentIndexList": [
                                1
                            ],
                            "baggageAmount": null,
                            "baggageWeight": "20KG",
                            "carryOnAmount": null,
                            "carryOnWeight": null,
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
                                    "penaltyType": 2,
                                    "isPermited": 1,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": 76,
                                    "currencyCode": "USD",
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                },
                                {
                                    "penaltyType": 0,
                                    "isPermited": 0,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": null,
                                    "currencyCode": null,
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                }
                            ]
                        }
                    ]
                },
                "afterSaleRule": null
            },
            {
                "solutionKey": "89d265d0c5fa4e19831ba1aae7e55cac",
                "solutionId": "kEsN5y1uRlxlW67IwyIcvSswoOaaTFOz7fq+HIcV8rl7R3j6S3X+UufHX+XcNmDHDIiO7divHz62BRxlfoqHoQdhC+R6PZgrXjb7wpFxWlXFF+j+pak5rF3dPqnH0MjNY/1xcDmLKVo4sR+VaCCLj85eN62FEUIkMn+abo7oUVKKhl2keNjD230nPGchelFlpn3IBmMk5+qyqKCXRGpNmBBmJty2/RLFLT3b9dh8HIXH5f4vnOCP4wTy1Y8spuvoxIVQUH0bGHcV7Kmov0QKIs4SW+zeOKuowyjybF6bjOuPTNY0sZAkgmPJXHSnOGfH",
                "fareType": "PUBLIC",
                "currency": "USD",
                "adtFare": 67.910,
                "adtTax": 61.760,
                "chdFare": 0,
                "chdTax": 0,
                "qCharge": 0,
                "tktFee": 0.000,
                "platformServiceFee": 0,
                "comments": null,
                "journeys": {
                    "journey_0": [
                        "39ce5a95237b80950065fd07cb926fc3"
                    ]
                },
                "fareRule": null,
                "rule": null,
                "platingCarrier": "UO",
                "prices": null,
                "merchantFee": 0.00,
                "adults": 1,
                "children": 0,
                "infants": 0,
                "baggageMap": {
                    "ADT": [
                        {
                            "segmentIndexList": [
                                1
                            ],
                            "baggageAmount": null,
                            "baggageWeight": "20KG",
                            "carryOnAmount": "0PC",
                            "carryOnWeight": "17.5KG",
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
                                    "penaltyType": 2,
                                    "isPermited": 1,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": 76,
                                    "currencyCode": "USD",
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                },
                                {
                                    "penaltyType": 0,
                                    "isPermited": 0,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": null,
                                    "currencyCode": null,
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                }
                            ]
                        }
                    ]
                },
                "afterSaleRule": null
            },
            {
                "solutionKey": "ff3e42f4acbee64cb93ccf79ec087899",
                "solutionId": "kEsN5y1uRlxlW67IwyIcvSswoOaaTFOz7fq+HIcV8rl7R3j6S3X+UufHX+XcNmDHDIiO7divHz62BRxlfoqHoUmt3XOMXYoeBKrIMjVyeHIn/3pD/qjwEv3xNysILjc/EhPNyr9QQlhfxRoOyXc1yocGt8UD2x/aRaKM7tErA+cZKOxZOD36vAx7d+XY9Y35CDmH2o7BbWrsP3hk6HYEBWVmGk2UQsWcVlCHPEaoixzM88B3StBCzYYNx5wc2oWayzxXmUuErXbmAfQZK6chqdajcFQkT60LQ+NzyWn29KTjCiIlcfsMdpAaDKTc3/xi",
                "fareType": "PUBLIC",
                "currency": "USD",
                "adtFare": 67.910,
                "adtTax": 61.760,
                "chdFare": 0,
                "chdTax": 0,
                "qCharge": 0,
                "tktFee": 0.000,
                "platformServiceFee": 0,
                "comments": null,
                "journeys": {
                    "journey_0": [
                        "9236d905b3a1272bc287a4b5b4cbb736"
                    ]
                },
                "fareRule": null,
                "rule": null,
                "platingCarrier": "UO",
                "prices": null,
                "merchantFee": 0.00,
                "adults": 1,
                "children": 0,
                "infants": 0,
                "baggageMap": {
                    "ADT": [
                        {
                            "segmentIndexList": [
                                1
                            ],
                            "baggageAmount": null,
                            "baggageWeight": "20KG",
                            "carryOnAmount": "0PC",
                            "carryOnWeight": "17.5KG",
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
                                    "penaltyType": 2,
                                    "isPermited": 1,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": 76,
                                    "currencyCode": "USD",
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                },
                                {
                                    "penaltyType": 0,
                                    "isPermited": 0,
                                    "when": 0,
                                    "noShowTime": null,
                                    "noShowTimeUnit": null,
                                    "amount": null,
                                    "currencyCode": null,
                                    "percent": null,
                                    "baseType": null,
                                    "originAmount": null,
                                    "miniRuleAdjustAmount": null,
                                    "miniRuleAdjustFlag": null,
                                    "originCurrencyCode": null,
                                    "guarantee": null
                                }
                            ]
                        }
                    ]
                },
                "afterSaleRule": null
            }
        ],
        "flights": [
            {
                "flightId": "4cf9c3bf6f34dca474908ab1c9ccb736",
                "journeyTime": 185,
                "transferCount": 0,
                "lastTktTime": "2024-03-11 15:59:00",
                "segmengtIds": [
                    "b4d7c3d87a9225fa7bf2d7501b87d312"
                ]
            },
            {
                "flightId": "51fa1ce0c85fa868b7121d73787fb830",
                "journeyTime": 190,
                "transferCount": 0,
                "lastTktTime": null,
                "segmengtIds": [
                    "e82a0f95cb02450541d4e7df6d8ca889"
                ]
            },
            {
                "flightId": "39ce5a95237b80950065fd07cb926fc3",
                "journeyTime": 175,
                "transferCount": 0,
                "lastTktTime": "2024-03-11 15:59:00",
                "segmengtIds": [
                    "e193bb1690dba39556c8e24b3ae21ad2"
                ]
            },
            {
                "flightId": "eb99261d5c578e9718b5fbfbd133602c",
                "journeyTime": 190,
                "transferCount": 0,
                "lastTktTime": "2024-03-11 15:59:00",
                "segmengtIds": [
                    "f179f3fd6adda24d50443c5e3d01d31b"
                ]
            },
            {
                "flightId": "9236d905b3a1272bc287a4b5b4cbb736",
                "journeyTime": 175,
                "transferCount": 0,
                "lastTktTime": "2024-03-11 15:59:00",
                "segmengtIds": [
                    "ffce59cd92f517d92bde28993ffd7915"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "ffce59cd92f517d92bde28993ffd7915",
                "airline": "UO",
                "flightNum": "700",
                "equipment": "320",
                "cabinClass": "ECONOMY",
                "bookingCode": "U",
                "availabilityCount": 9,
                "departure": "HKG",
                "arrival": "BKK",
                "departureTerminal": "1",
                "arrivalTerminal": null,
                "departureDate": 1713158700000,
                "arrivalDate": 1713165600000,
                "flightTime": 175,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": "",
                "stopover": null,
                "fareBasis": "UGDD",
                "strDepartureDate": "2024-04-15",
                "strDepartureTime": "13:25",
                "strArrivalDate": "2024-04-15",
                "strArrivalTime": "15:20"
            },
            {
                "segmentId": "e82a0f95cb02450541d4e7df6d8ca889",
                "airline": "UO",
                "flightNum": "714",
                "equipment": "321",
                "cabinClass": "ECONOMY",
                "bookingCode": "Q",
                "availabilityCount": 2,
                "departure": "HKG",
                "arrival": "BKK",
                "departureTerminal": null,
                "arrivalTerminal": null,
                "departureDate": 1713138900000,
                "arrivalDate": 1713146700000,
                "flightTime": 190,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": null,
                "stopover": null,
                "fareBasis": "YOW",
                "strDepartureDate": "2024-04-15",
                "strDepartureTime": "07:55",
                "strArrivalDate": "2024-04-15",
                "strArrivalTime": "10:05"
            },
            {
                "segmentId": "b4d7c3d87a9225fa7bf2d7501b87d312",
                "airline": "UO",
                "flightNum": "792",
                "equipment": "320",
                "cabinClass": "ECONOMY",
                "bookingCode": "O",
                "availabilityCount": 4,
                "departure": "HKG",
                "arrival": "DMK",
                "departureTerminal": "1",
                "arrivalTerminal": null,
                "departureDate": 1713168900000,
                "arrivalDate": 1713176400000,
                "flightTime": 185,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": "",
                "stopover": null,
                "fareBasis": "OGDD",
                "strDepartureDate": "2024-04-15",
                "strDepartureTime": "16:15",
                "strArrivalDate": "2024-04-15",
                "strArrivalTime": "18:20"
            },
            {
                "segmentId": "f179f3fd6adda24d50443c5e3d01d31b",
                "airline": "UO",
                "flightNum": "704",
                "equipment": "320",
                "cabinClass": "ECONOMY",
                "bookingCode": "U",
                "availabilityCount": 9,
                "departure": "HKG",
                "arrival": "BKK",
                "departureTerminal": "1",
                "arrivalTerminal": null,
                "departureDate": 1713138900000,
                "arrivalDate": 1713146700000,
                "flightTime": 190,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": "",
                "stopover": null,
                "fareBasis": "UGDD",
                "strDepartureDate": "2024-04-15",
                "strDepartureTime": "07:55",
                "strArrivalDate": "2024-04-15",
                "strArrivalTime": "10:05"
            },
            {
                "segmentId": "e193bb1690dba39556c8e24b3ae21ad2",
                "airline": "UO",
                "flightNum": "702",
                "equipment": "321",
                "cabinClass": "ECONOMY",
                "bookingCode": "U",
                "availabilityCount": 9,
                "departure": "HKG",
                "arrival": "BKK",
                "departureTerminal": "1",
                "arrivalTerminal": null,
                "departureDate": 1713171300000,
                "arrivalDate": 1713178200000,
                "flightTime": 175,
                "stayTime": null,
                "codeShare": "N",
                "opFltNo": null,
                "opFltAirline": "",
                "stopover": null,
                "fareBasis": "UGDD",
                "strDepartureDate": "2024-04-15",
                "strDepartureTime": "16:55",
                "strArrivalDate": "2024-04-15",
                "strArrivalTime": "18:50"
            }
        ]
    }
}
```

2. Error Response
```plain
{
    "errorCode": "P001", 
    "errorMsg": "Invalid authentication.", 
    "data": null
}
```

## 
## 6 Error Code List

|erroCode|erroMsg|Description|
|:----|:----|:----|
|0|ok|Request has been processed successfully.|
|S001|System error.|System error.|
|B002|Partner is not exists.|PartnerID does not exist.|
|B003|Illegal sign.|Illegal sign. Please check your signature.|
|P001|XXX is illegal.|The field of XXX is illegal.|
|P002|XXX is missing.|The field of XXX is missing.|
|P004|The maximum number of passengers with seat is 9.|Wrong parameter. The maximum number of passengers with seat is 9.|
|P005|There should be at least one adult.|Wrong parameter. There should be at least one adult.|
|P009|The number of infant passengers can not exceed the number of adult passengers.|Wrong parameter. The number of infant passengers can not exceed the number of adult passengers.|
|B013|Interface is limited, please contact the system administrator.|The route that you request is limited, please contact system administrator.|
|B014|Shopping failed.|Shopping failed caused by other reasons.|
|B024|Time-out, please try later.|Time-out. You can try the second searching after a few seconds.|
|B034|Shopping interface is offline.|Shopping service is limited.|
|B035|Concurrency limited. Please contact PKFARE API support team for assistant.|Concurrent users contral. Please contact PKFARE API support for assistant.|
|B038|Departure date must be today to a year.|Wrong parameter. Departure date must be today to a year.|
|B039|Can't find the related data of XXX.|Wrong parameter. Can't find the related data of XXX, like illegal city/country/area/airline.|
|B046|Interface is limited, the routing is offlined by PKFARE.|Look to book control. If you need this routing, please contact PKFARE API for assistant.|
|B059|Shopping failed from upstream.|Shopping failed, shopping error from upstream. Please contact PKFARE API support.|
|B060|Interface is limited, please contact PKFARE.|Interface is limited, due to restriction rules, please contact PKFARE API support.|
|B009|Supplier is offline|Supplier is not at working time, please contact PKFARE API support.|
|B066|Only 2 journeys can be supported, please check your itinerary.|System support maximum 2 journeys shopping at this moment.|

