# PreciseBooking_V5

## 1 Function

Through the most updated version PreciseBooking_V5 API, Seat selection in  the bookings are supported based on the results from AncillaryPricing_V3. 

It's not supported that multiple paid checked bags or multiple paid carry-on bags are added for the same passenger on a single journey, but it's allowed to add a checked bag and a carry-on baggage on a single journey at the same time.

Besides,  it's not allowed to add multiple seats for the same passenger in a flight or select the same seat for multiple passengers in a flight.

It is necessary to use PrecisePricing service before using this interface. The whole process should be limited to 30 mins.

## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|PreciseBooking|[https://api.pkfare.com/preciseBooking](https://api.pkfare.com/preciseBooking)|    |
|PreciseBooking_V2|[https://api.pkfare.com/preciseBooking_V2](https://api.pkfare.com/preciseBooking_V2)|It is capable of buying ancillaries|
|PreciseBooking_V3|[https://api.pkfare.com/preciseBooking_V](https://api.pkfare.com/preciseBooking_V2)3|Support infant (no seat) bookings.|
|PreciseBooking_V4|[http://api.pkfare.com/preciseBooking_V4](http://api.pkfare.com/preciseBooking_V4)|support seat selection in the initial booking|
|PreciseBooking_V5|[https://api.pkfare.com/preciseBooking_V](https://api.pkfare.com/preciseBooking_V2)5|Add solutionId to enhance tracebility and visibility; Support json formatted requesting structure|

*Below is the most updated version*

## 3 Character Encoding

The character code of this API is UTF-8.

## 4 Request

Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted.

### 4.1 Schema

|Name|Type|Required or Not|Parameter Description|Sample|
|:----|:----|:----|:----|:----|
|Authentication|    |    |    |    |
|partnerId|String|Yes|Partner ID|HJqiE0cJlXjknkCkZKhzIis5o=|
|sign|String|Yes|Signature, sign=MD5(partnerId+partnerKey)|fed53d44ea413c40d5f18e69047b7c|
|Booking|    |    |    |    |
|passengers|Array|Yes|Passenger information, refer to Passengers|-|
|solution|Object|Yes|Journey information, refer to Solution|-|
|buyerOrder|String|No|Your order number if you want to store at PKFARE side|-|
|ancillary|Object|Yes|Ancillary information|-|
|Passengers|    |    |    |    |
|passngerIndex|Integer|No|Passenger sequence number. Positive and continuous integers starting from 1. Only bookings contain infant passengers need to fullfill this part.|3|
|birthday|String|Yes|Date of birth|2015-01-10|
|cardType|String|No|Type of travel document, P as passport, N as Chinese Identity, O as others. Passengers could make reservations with Chinese Identity if the itinerary is China domestic journey (NOT including Hong Kong, Macao and Taiwan). If using Chinese Identity please input 'N' into 'cardType' and input name in Chinese character.If bookingWithoutCard is 1 in responds of PrecisePricing API, you can leave it as blank.|P|
|cardNum|String|No|Travel document number. If bookingWithoutCard is 1 in responds of PrecisePricing API, you can leave it as blank.|G2568574|
|cardExpiredDate|String|No|Travel document expired date. If using Chinese Identity please input a fake cardExpiredDate to pass the parameter validation. If bookingWithoutCard is 1 in responds of PrecisePricing API, you can leave it as blank.|2020-05-06|
|lastName|String|Yes|Last name. Please use a real name and do not use "TEST"|Wang|
|firstName|String|Yes|First name. Please use a real name and do not use "TEST"|Jango|
|nationality|String|Yes|Nationality [country code].|CN|
|psgType|String|Yes|Passenger type including ADT for adults, CHD for children, INF for infants (no seat)|ADT|
|sex|String|Yes|Gender, including M for male, F for female|M|
|associatedPassengerIndex|Integer|No|Only required for infant passengers. The adult passenger sequence number which the infant is associated to.|1|
|Solution|    |    |    |    |
|solutionId|String|Yes|Unique identification returned in PrecisePricing, request with it for associating with the Pricing solution and linking to the entire request process|25a061970d8a7ebeb5e63391b9788f36|
|fareType|String|No|Fare type, including PUBLIC and PRIVATE|PUBLIC|
|adtFare|BigDecimal|No|Adult fare|1206|
|adtTax|BigDecimal|No|Adult tax|1298|
|chdFare|BigDecimal|No|Child[age 2-12] fare|803|
|chdTax|BigDecimal|No|Child[age 2-12] tax|200|
|infFare|BigDecimal|No|Infant[age 0-2, no seat] fare|205|
|infTax|BigDecimal|No|Infant[age 0-2, no seat] tax|100|
|journeys|Object[]|Yes|Journey, refer to Journey|-|
|Journey|    |    |    |    |
|airline|String|Yes|Airline code|SA|
|flightNum|String|Yes|Flight No.|102|
|arrival|String|Yes|Destination[IATA airport code]|CPT|
|arrivalDate|String|Yes|Arrival Date[yyyy-mm-dd]|2023-11-11|
|arrivalTime|String|Yes|Arrival Time[hh:mm]|11:45|
|departure|String|Yes|Departure[IATA airport code]|BKK|
|departureDate|String|Yes|Departure Date[yyyy-mm-dd]|2023-11-30|
|departureTime|String|Yes|Departure Time[hh:mm]|07:05|
|bookingCode|String|Yes|Cabin code|N|
|Ancillary|    |    |    |    |
|ancillaryPassenger|Object|Yes|Booking ancillary passenger (If booking with ancillaries, this field is required and cannot be an infant passenger)|-|
|ancillaries|Object|Yes|Ancillary data( If booking with ancillaries, this field is required)|-|
|AncillaryPassengers|    |    |    |    |
|lastName|String|Yes|Last name (This field is required when booking with ancillaries)|WANG|
|firstName|String|Yes|First name (This field is required when booking with ancillaries)|JANGO|
|psgType|String|Yes|Passenger type (This field is required when booking with ancillaries); ADT-Adult, CHD-Child[2-12 years old]; Cannot be infant passenger|ADT|
|Ancillaries|    |    |    |    |
|baggage|Array|Yes|Baggage details( This field is required when booking with bags)|    |
|seat|Array|Yes|Seat details( This field is required when booking with seats)|    |
|Baggage|    |    |    |    |
|ancillaryType|Integer|Yes|Baggage details (This field is required when booking with ancillaries); 1-baggage|1|
|ancillaryKey|String|Yes|Unique ID returned in AncillaryPricing (This field is required when booking with ancillaries)|62613b9298386105acb75ed148af00cb|
|payBaggageType|Integer|Yes|Baggage type (This field is required when booking with ancillaries); 1-checked baggage, 2-carry-on baggage|1|
|baggagePiece|Integer|Yes|Baggage piece (This field is required when booking with ancillaries); -1 - no limit to baggage piece|1|
|baggageWeight|String|Yes|Baggage weight (This field is required when booking with ancillaries)|20KG|
|baggageCurrency|String|Yes|Currency (This field is required when booking)|CNY|
|baggagePrice|BigDecimal|Yes|Price (This field is required when booking)|198.00|
|description|String|No|Baggage description|-|
|ancillaryJourneys|Array|Yes|Itinerary information (This field is required when booking with ancillaries)|-|
|buyerOrder|String|No|Buyer ancillary order number|-|
|AncillaryJourney|    |    |    |    |
|airline|String|Yes|Airline code|FD|
|departure|String|Yes|Origin[IATA airport code]|DMK|
|departureDate|String|Yes|Departure date[yyyy-MM-dd]|2022-10-01|
|departureTime|String|Yes|Departure time[hh:mm]|09:55|
|arrival|String|Yes|Destination[IATA airport code]|CNX|
|arrivalDate|String|Yes|Arrival date[yyyy-MM-dd]|2022-10-01|
|arrivalTime|String|Yes|Arrival time[hh:mm]|11:25|
|flightNum|String|Yes|Flight number|513|
|bookingCode|String|Yes|Cabin code|N|
|Contact|    |    |    |    |
|name|String|No|Name format: FirstnameLastname|AndyGuan|
|email|String|No|Email address|andy.guan123@pkfare.com|
|telCode|String|No|Area Code|+86|
|mobile|String|No|Telephone|17826150868|
|postcode|String|No|Postcode|    |
|address|String|No|Address|    |
|Seat| | | | |
|ancillaryType|Integer|Yes|seat details (This field is required when booking with ancillaries); 2-seat|2|
|ancillaryKey|String|Yes|Unique ID returned in AncillaryPricing (This field is required when booking with ancillaries)|79313b0298386105acb75ed148af11ab|
|seatName|string|No|seat name|12A|
|column|string|No|seat column|A|
|row|string|No|seat row|12|
|seatCategory|string|No|seat category|standard seat|
|seatCurrency|string|No|currency|38|
|seatPrice|string|No|price|CNY|
|characteristics|array|No|the traits of seats; window；middle；aisle；exit_row|window|
|ancillarySegment|object|Yes|The segment details of ancillary|-|
|buyerOrder|string|No|buyer ancillary order number|-|
|AncilllarySegment| | | | |
|airline|String|Yes|Airline code|FD|
|departure|String|Yes|Origin[IATA airport code]|DMK|
|departureDate|String|Yes|Departure date[yyyy-MM-dd]|2022-10-01|
|departureTime|String|Yes|Departure time[hh:mm]|09:55|
|arrival|String|Yes|Destination[IATA airport code]|CNX|
|arrivalDate|String|Yes|Arrival date[yyyy-MM-dd]|2022-10-01|
|arrivalTime|String|Yes|Arrival time[hh:mm]|11:25|
|flightNum|String|Yes|Flight number|513|
|bookingCode|String|Yes|Cabin code|N|

 

### 4.2 Example

1. Booking without Infant
```plain
{
    "authentication": {
        "partnerId": "HJqiE0YKcXjknkCkZKhzIis5o=",
        "sign": "fed53d44413c40d5f1d18e69047b7c"
    },
    "booking": {
        "passengers": [
            {
                "birthday": "1997-06-22",
                "firstName": "Jason",
                "lastName": "Smith",
                "nationality": "PH",
                "psgType": "ADT",
                "sex": "M"
            },
            {
                "birthday": "2018-04-19",
                "firstName": "Sarah",
                "lastName": "Smith",
                "nationality": "PH",
                "psgType": "CHD",
                "sex": "F"
            },
        ],
        "ancillary": [
            {
                "ancillaryPassenger": {
                    "firstName": "Jason",
                    "lastName": "Smith",
                    "psgType": "ADT"
                },
                "ancillaries": {
                    "baggage": [
                        {
                            "ancillaryKey": "91a3502dc966d911494239612d6d7765",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "20KG",
                            "baggageCurrency": "USD",
                            "baggagePrice": "18.940",
                            "ancillaryJourneys": [
                                {
                                    "airline": "5J",
                                    "flightNum": "506",
                                    "arrival": "TUG",
                                    "arrivalDate": "2023-12-04",
                                    "arrivalTime": "12:15",
                                    "departure": "MNL",
                                    "departureDate": "2023-12-04",
                                    "departureTime": "11:05",
                                    "bookingCode": "K"
                                }
                            ]
                        },
                        {
                            "ancillaryKey": "2e81b09af4c2eb137248f5af29ffe2ce",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "20KG",
                            "baggageCurrency": "USD",
                            "baggagePrice": "18.940",
                            "ancillaryJourneys": [
                                {
                                    "airline": "5J",
                                    "flightNum": "507",
                                    "arrival": "MNL",
                                    "arrivalDate": "2023-12-07",
                                    "arrivalTime": "14:05",
                                    "departure": "TUG",
                                    "departureDate": "2023-12-07",
                                    "departureTime": "12:45",
                                    "bookingCode": "V"
                                }
                            ]
                        }
                    ]
                }
            }
        ],
        "solution": {
            "solutionId":"1",
            "adtFare": 153.22,
            "adtTax": 25.49,
            "chdFare":79.13,
            "chdTax": 15.72,
            "journeys": {
                "journey_0": [
                    {
                        "airline": "5J",
                        "flightNum": "506",
                        "arrival": "TUG",
                        "arrivalDate": "2023-12-04",
                        "arrivalTime": "12:15",
                        "departure": "MNL",
                        "departureDate": "2023-12-04",
                        "departureTime": "11:05",
                        "bookingCode": "K"
                    }
                ],
                "journey_1": [
                    {
                        "airline": "5J",
                        "flightNum": "507",
                        "arrival": "MNL",
                        "arrivalDate": "2023-12-07",
                        "arrivalTime": "14:05",
                        "departure": "TUG",
                        "departureDate": "2023-12-07",
                        "departureTime": "12:45",
                        "bookingCode": "V"
                    }
                ]
            }
        }
    }
}
```
2. Booking with Infant
```plain
{
    "authentication": {
        "partnerId": "HJqiE0YKcJlXjkCkZKhzIis5o=",
        "sign": "fed53d44ea413c40d5f18e69047b7c"
    },
    "booking": {
        "passengers": [
            {
                "passengerIndex": 1
                "birthday": "1994-06-22",
                "firstName": "Mary",
                "lastName": "Jones",
                "nationality": "PH",
                "psgType": "ADT",
                "sex": "F"
            },
            {
                "passengerIndex": 2
                "birthday": "1991-04-12",
                "firstName": "Jason",
                "lastName": "Smith",
                "nationality": "PH",
                "psgType": "ADT",
                "sex": "M"
            },
            {
                "passengerIndex": 3
                "birthday": "2022-11-24",
                "firstName": "Laura",
                "lastName": "Smith",
                "nationality": "PH",
                "psgType": "INF",
                "sex": "F"
                "associatedPassengerIndex": 1
            },
        ],
        "ancillary": [
            {
                "ancillaryPassenger": {
                    "firstName": "Jason",
                    "lastName": "Smith",
                    "psgType": "ADT"
                },
                "ancillaries": {
                    "baggage": [
                        {
                            "ancillaryKey": "91a3502dc966d911494239612d6d7765",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "20KG",
                            "baggageCurrency": "USD",
                            "baggagePrice": "18.940",
                            "ancillaryJourneys": [
                                {
                                    "airline": "5J",
                                    "flightNum": "506",
                                    "arrival": "TUG",
                                    "arrivalDate": "2023-12-04",
                                    "arrivalTime": "12:15",
                                    "departure": "MNL",
                                    "departureDate": "2023-12-04",
                                    "departureTime": "11:05",
                                    "bookingCode": "K"
                                }
                            ]
                        },
                        {
                            "ancillaryKey": "2e81b09af4c2eb137248f5af29ffe2ce",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "20KG",
                            "baggageCurrency": "USD",
                            "baggagePrice": "18.940",
                            "ancillaryJourneys": [
                                {
                                    "airline": "5J",
                                    "flightNum": "507",
                                    "arrival": "MNL",
                                    "arrivalDate": "2023-12-07",
                                    "arrivalTime": "14:05",
                                    "departure": "TUG",
                                    "departureDate": "2023-12-07",
                                    "departureTime": "12:45",
                                    "bookingCode": "V"
                                }
                            ]
                        }
                    ]
                }
            }
        ],
        "solution": {
            "solutionId":"1"
            "adtFare": 153.22,
            "adtTax": 25.49,
            "infFare":43.96,
            "infTax": 10.11,
            "journeys": {
                "journey_0": [
                    {
                        "airline": "5J",
                        "flightNum": "506",
                        "arrival": "TUG",
                        "arrivalDate": "2023-12-04",
                        "arrivalTime": "12:15",
                        "departure": "MNL",
                        "departureDate": "2023-12-04",
                        "departureTime": "11:05",
                        "bookingCode": "K"
                    }
                ],
                "journey_1": [
                    {
                        "airline": "5J",
                        "flightNum": "507",
                        "arrival": "MNL",
                        "arrivalDate": "2023-12-07",
                        "arrivalTime": "14:05",
                        "departure": "TUG",
                        "departureDate": "2023-12-07",
                        "departureTime": "12:45",
                        "bookingCode": "V"
                    }
                ]
            }
        }
    }
}
```
3. Booking with seat
```plain
{
    "authentication": {
        "sign": "d579219dd2ac133692e9a15",
        "partnerId": "KM3Pin/8iI6tqPDQuAY="
    },
    "booking": {
        "passengers": [
            {
                "birthday": "2003-03-23",
                "firstName": "LIHONG",
                "lastName": "LIN",
                "cardNum": "E21415326",
                "nationality": "CN",
                "psgType": "ADT",
                "sex": "M",
                "cardType": "P",
                "cardExpiredDate": "2027-03-31"
            }
        ],
        "solution": {
            "solutionId":"1"
            "adtFare": "2862",
            "adtTax": "1211.0",
            "journeys": {
                "journey_0": [
                    {
                        "departureTime": "00:05",
                        "flightNum": "896",
                        "arrival": "SGN",
                        "arrivalTime": "06:20",
                        "bookingCode": "I",
                        "departure": "DEL",
                        "departureDate": "2023-11-30",
                        "airline": "VJ",
                        "arrivalDate": "2023-11-30"
                    },
                    {
                        "departureTime": "17:20",
                        "flightNum": "632",
                        "arrival": "DAD",
                        "arrivalTime": "18:35",
                        "bookingCode": "I",
                        "departure": "SGN",
                        "departureDate": "2023-11-30",
                        "airline": "VJ",
                        "arrivalDate": "2023-11-30"
                    }
                ]
            }
        },
        "ancillary": [
            {
                "ancillaries": {
                    "seat": [
                        {
                            "ancillaryKey": "4f556396a9e7490cccb75a91ae19dbca",
                            "ancillaryType": "2",
                            "ancillarySegment": {
                                "departureTime": "00:05",
                                "flightNum": "896",
                                "arrival": "SGN",
                                "arrivalTime": "06:20",
                                "bookingCode": "I",
                                "departure": "DEL",
                                "departureDate": "2023-11-30",
                                "airline": "VJ",
                                "arrivalDate": "2023-11-30"
                            }
                        },
                        {
                            "ancillaryKey": "b9fb374c9c7fb51d88b04b415027be67",
                            "ancillaryType": "2",
                            "ancillarySegment": {
                                "departureTime": "17:20",
                                "flightNum": "632",
                                "arrival": "DAD",
                                "arrivalTime": "18:35",
                                "bookingCode": "I",
                                "departure": "SGN",
                                "departureDate": "2023-11-30",
                                "airline": "VJ",
                                "arrivalDate": "2023-11-30"
                            }
                        }
                    ]
                },
                "ancillaryPassenger": {
                    "firstName": "LIHONG",
                    "lastName": "LIN",
                    "psgType": "ADT",
                    "sex": "M"
                }
            }
        ]
    }
}
```

4. Booking with baggage and seat
```plain
{
    "authentication": {
        "sign": "d57921ac133692eb5f229eea15",
        "partnerId": "KPin4rGP8iI6tqPDQuAY="
    },
    "booking": {
        "passengers": [
            {
                "birthday": "2003-03-23",
                "firstName": "LIHONG",
                "lastName": "LIN",
                "cardNum": "E21415326",
                "nationality": "CN",
                "psgType": "ADT",
                "sex": "M",
                "cardType": "P",
                "cardExpiredDate": "2027-03-31"
            }
        ],
        "solution": {
            "adtFare": "2862",
            "adtTax": "1211.0",
            "journeys": {
                "journey_0": [
                    {
                        "departureTime": "00:05",
                        "flightNum": "896",
                        "arrival": "SGN",
                        "arrivalTime": "06:20",
                        "bookingCode": "I",
                        "departure": "DEL",
                        "departureDate": "2023-11-30",
                        "airline": "VJ",
                        "arrivalDate": "2023-11-30"
                    },
                    {
                        "departureTime": "17:20",
                        "flightNum": "632",
                        "arrival": "DAD",
                        "arrivalTime": "18:35",
                        "bookingCode": "I",
                        "departure": "SGN",
                        "departureDate": "2023-11-30",
                        "airline": "VJ",
                        "arrivalDate": "2023-11-30"
                    }
                ]
            }
        },
        "ancillary": [
            {
                "ancillaries": {
                    "baggage": [
                        {
                            "ancillaryType": 1,
                            "ancillaryKey": "0c3596cc08171e66748b91bdad5c1e57",
                            "payBaggageType": "1",
                            "baggagePiece": "2",
                            "baggageWeight": "36KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": "95.0",
                            "description": "",
                            "ancillaryJourneys": [
                                {
                                    "departureTime": "00:05",
                                    "flightNum": "896",
                                    "arrival": "SGN",
                                    "arrivalTime": "06:20",
                                    "bookingCode": "I",
                                    "departure": "DEL",
                                    "departureDate": "2023-11-30",
                                    "airline": "VJ",
                                    "arrivalDate": "2023-11-30"
                                },
                                {
                                    "departureTime": "17:20",
                                    "flightNum": "632",
                                    "arrival": "DAD",
                                    "arrivalTime": "18:35",
                                    "bookingCode": "I",
                                    "departure": "SGN",
                                    "departureDate": "2023-11-30",
                                    "airline": "VJ",
                                    "arrivalDate": "2023-11-30"
                                }
                            ],
                            "buyerOrder": " "
                        }
                    ],
                    "seat": [
                        {
                            "ancillaryKey": "4f556396a9e7490cccb75a91ae19dbca",
                            "ancillaryType": "2",
                            "ancillarySegment": {
                                "departureTime": "00:05",
                                "flightNum": "896",
                                "arrival": "SGN",
                                "arrivalTime": "06:20",
                                "bookingCode": "I",
                                "departure": "DEL",
                                "departureDate": "2023-11-30",
                                "airline": "VJ",
                                "arrivalDate": "2023-11-30"
                            }
                        },
                        {
                            "ancillaryKey": "b9fb374c9c7fb51d88b04b415027be67",
                            "ancillaryType": "2",
                            "ancillarySegment": {
                                "departureTime": "17:20",
                                "flightNum": "632",
                                "arrival": "DAD",
                                "arrivalTime": "18:35",
                                "bookingCode": "I",
                                "departure": "SGN",
                                "departureDate": "2023-11-30",
                                "airline": "VJ",
                                "arrivalDate": "2023-11-30"
                            }
                        }
                        
                    ]
                },
                "ancillaryPassenger": {
                    "firstName": "LIHONG",
                    "lastName": "LIN",
                    "psgType": "ADT",
                    "sex": "M"
                }
            }
        ]
    }
}
```


### 4.3 PreciseBooking Request Breakdown Structure

[PriciseBooking Requset-V4.pdf](http://open.pkfare.com/api-agent/document/load/181783)

 

## 5 Response

### 5.1 Schema

|Name|Type|Parameter Description|Sample|
|:----|:----|:----|:----|
|Basic Parameters|    |    |    |
|errorCode|String|Error code, refer to Error Code List|0|
|errorMsg|String|Error message|OK|
|data|Object|Only if the errorCode returns "0", returned data would not be null. Data is in JSON format, which contains three collection objects: solutions, flights, segments.|-|
|Data|    |    |    |
|solution|Object|Refer to Solution.|-|
|flights|Array|Refer to Flights.|-|
|segments|Array|Refer to Segments.|-|
|pnr|String|Pnr|KKXJS2|
|orderNum|String|Order number.|1014766841|
|ancillary|Object|Ancillary information.|-|
|Solution|    |    |    |
|solutionId|String|Unique identification|25a061970d8a7ebeb5e63391b9788f36|
|solutionKey|String|Unique identification|0357301bf213453389fcb55c379a4667|
|fareType|String|Fare type including PUBLIC and PRIVATE|PUBLIC|
|currency|String|Currency|CNY|
|adtFare|BigDecimal|Adult fare|1011|
|adtTax|BigDecimal|Adult tax|527|
|chdFare|BigDecimal|Children [age 2-12] fare|500|
|chdTax|BigDecimal|Children [age 2-12] tax|250|
|infFare|BigDecimal|Infant [ age 0-2, no seat ] fare|125|
|infTax|BigDecimal|Infant [ age 0-2, no seat] tax|50|
|qCharge|BigDecimal|Q charge, bunker adjustment surcharge, for reference only|0|
|tktFee|BigDecimal|Ticketing service fee|0|
|platformServiceFee|BigDecimal|Platform service fee, defaults to 0|0|
|journeys|String[]|JSON format string array. Content: flightID|-|
|platingCarrier|String|Ticketing airline|CA|
|merchantFee|BigDecimal|Payment transaction fee|7.39|
|afterSaleRule|Obejct|After sale rule, not supported yet|-|
|Flights|    |    |    |
|flightId|String|Flight ID， unique identification|9ef88fd9dae30560c683911f534c6c49|
|journeyTime|Long|Journey Time, unit: minute|350|
|transferCount|Integer|Number of transfers|1|
|lastTktTime|String|Latest ticketing time (GMT)|2015-10-28 23:59:00|
|segmengtIds|String[]|Number of segment arrays (please note the segmengtIds is a typo due to history edition)|-|
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
|strDepartureDate|String|Departure date[yyyy-mm-dd], local time|2016-08-27|
|strDepartureTime|String|Departure time[hh:mm], local time|09:30|
|strArrivalDate|String|Arrival date[yyyy-mm-dd], local time|2016-08-27|
|strArrivalTime|String|Arrival time[hh:mm], local time|11:50|
|Ancillary|    |    |    |
|lastName|String|Last name|WANG|
|firstName|String|First name|JANGO|
|psgType|String|Passenger type; ADT-Adult, CHD-Child[2-12 years old]|ADT|
|ancillaries|Object|Ancillary data|-|
|Ancillaries|    |    |    |
|baggage|Object|Baggage details|-|
|seat|Object|Seat details|-|
|Baggage|    |    |    |
|ancillaryType|Integer|Baggage details; 1-baggage|1|
|ancillaryKey|String|Unique ID returned in AncillaryPricing|62613b9298386105acb75ed148af00cb|
|payBaggageType|Integer|Baggage type; 1-checked baggage, 2-carry-on baggage|1|
|baggagePiece|Integer|Baggage piece; -1 - no limit to baggage piece|1|
|baggageWeight|String|Baggage weight|20KG|
|baggageCurrency|String|Currency|CNY|
|baggagePrice|bigDecimal|Price|198.00|
|description|String|Baggage description|-|
|journeys|Object|Itinerary information|-|
|buyerOrder|String|Buyer ancillary order number|-|
|Journey|    |    |    |
|airline|String|Airline code|FD|
|departure|String|Origin[IATA airport code]|DMK|
|departureDate|String|Departure date[yyyy-MM-dd]|2022-10-01|
|departureTime|String|Departure time[hh:mm]|09:55|
|arrival|String|Destination[IATA airport code]|CNX|
|arrivalDate|String|Arrival date[yyyy-MM-dd]|2022-10-01|
|arrivalTime|String|Arrival time[hh:mm]|11:25|
|flightNum|String|Flight number|513|
|bookingCode|String|Cabin code|N|
|Seat|    |    |    |
|ancillaryType|Integer|seat details; 2-seat|2|
|ancillaryKey|String|Unique Identification returned in AncillaryPricing|72613b18386105acb75ed148af11cb|
|seatName|string|seat name|12A|
|column|string|seat column|A|
|row|string|seat row|12|
|seatCategory|string|seat category|standard seast|
|seatCurrency|string|currency|38|
|seatPrice|string|price|CNY|
|characteristics|array|the traits of seats|window；middle；aisle；exit_row|
|ancillarySegment|object|The segment details of ancillary|    |
|buyerOrder|string|buyer ancillary order number|    |
|AncilllarySegment|    |    |    |
|airline|String|Airline code|FD|
|departure|String|Origin[IATA airport code]|DMK|
|departureDate|String|Departure date[yyyy-MM-dd]|2022-10-01|
|departureTime|String|Departure time[hh:mm]|09:55|
|arrival|String|Destination[IATA airport code]|CNX|
|arrivalDate|String|Arrival date[yyyy-MM-dd]|2022-10-01|
|arrivalTime|String|Arrival time[hh:mm]|11:25|
|flightNum|String|Flight number|513|
|bookingCode|String|Cabin code|N|

### 5.2 Example

Success Response

1. Booking response with baggage
```plain
{
    "data": {
        "flights": [
            {
                "flightId": "ef8caaf829406399310863e678196849",
                "journeyTime": 450,
                "lastTktTime": "2023-07-07 23:59:00",
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
                "strArrivalDate": "2023-07-07",
                "strArrivalTime": "11:50",
                "strDepartureDate": "2023-07-07",
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
                "strArrivalDate": "2023-07-07",
                "strArrivalTime": "07:20",
                "strDepartureDate": "2023-07-07",
                "strDepartureTime": "02:10"
            }
        ],
        "solution": {
            "adtFare": 1330,
            "adtTax": 753.0,
            "afterSaleRule": null,
            "chdFare": 567,
            "chdTax": 234.2,
            "infFare": 218,
            "infTax": 97.6,
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
            "solutionId": "1",
            "tktFee": 0.0
        }
        "ancillary": [
            {
                "ancillaries": {
                    "baggage": [
                        {
                            "ancillaryJourneys": [
                                {
                                    "airline": "MU",
                                    "arrival": "HKG",
                                    "arrivalDate": "2023-07-07",
                                    "arrivalTime": "11:50",
                                    "bookingCode": "B",
                                    "departure": "PVG",
                                    "departureDate": "2023-07-07",
                                    "departureTime": "09:30",
                                    "flightNum": "501"
                                },
                                {
                                    "airline": "MU",
                                    "arrival": "PVG",
                                    "arrivalDate": "2023-07-07",
                                    "arrivalTime": "07:20",
                                    "bookingCode": "R",
                                    "departure": "KUL",
                                    "departureDate": "2023-07-07",
                                    "departureTime": "02:10",
                                    "flightNum": "9862"
                                }
                            ],
                            "ancillaryId": "9b43ce6302e3ae8e130b94112f992771",
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
                "firstName": "Mary",
                "lastName": "Jones",
                "psgType": "ADT"
            }
        ],
    },
    "errorCode": "0",
    "errorMsg": "ok"
}
```
2. Booking response with seat
```plain
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "orderNum": "916995304456203701",
        "pnr": "A8GS1Q",
        "solution": {
            "solutionKey": "03d83a531a25d8853baa94d02fe7cb79",
            "solutionId": "1",
            "fareType": "PRIVATE",
            "currency": "CNY",
            "adtFare": 2862,
            "adtTax": 1211.0,
            "chdFare": 0,
            "chdTax": 0,
            "qCharge": 0,
            "tktFee": 0.0,
            "platformServiceFee": 0,
            "journeys": {
                "journey_0": [
                    "036343eddc01e31dbe364d10df1c4e5a"
                ]
            },
            "platingCarrier": "VJ",
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
                        "baggageAmount": "0PC"
                    },
                    {
                        "segmentIndexList": [
                            2
                        ],
                        "baggageAmount": "0PC"
                    }
                ],
            }
        },
        "flights": [
            {
                "flightId": "036343eddc01e31dbe364d10df1c4e5a",
                "journeyTime": 360,
                "transferCount": 1,
                "segmengtIds": [
                    "def32e56f53ad461c6437c0d237ae6db",
                    "4abffb5c6b36b9a366075d4726460a66"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "4abffb5c6b36b9a366075d4726460a66",
                "airline": "VJ",
                "flightNum": "632",
                "cabinClass": "ECONOMY",
                "bookingCode": "I",
                "availabilityCount": 3,
                "departure": "SGN",
                "arrival": "DAD",
                "departureDate": 1701336000000,
                "arrivalDate": 1701340500000,
                "flightTime": 75,
                "codeShare": "N",
                "strDepartureDate": "2023-11-30",
                "strDepartureTime": "17:20",
                "strArrivalDate": "2023-11-30",
                "strArrivalTime": "18:35"
            },
            {
                "segmentId": "def32e56f53ad461c6437c0d237ae6db",
                "airline": "VJ",
                "flightNum": "896",
                "cabinClass": "ECONOMY",
                "bookingCode": "I",
                "availabilityCount": 3,
                "departure": "DEL",
                "arrival": "SGN",
                "departureDate": 1701273900000,
                "arrivalDate": 1701296400000,
                "flightTime": 285,
                "codeShare": "N",
                "strDepartureDate": "2023-11-30",
                "strDepartureTime": "00:05",
                "strArrivalDate": "2023-11-30",
                "strArrivalTime": "06:20"
            }
        ],
        "ancillary": [
            {
                "lastName": "LIN",
                "firstName": "LIHONG",
                "psgType": "ADT",
                "ancillaries": {
                    "seat": [
                        {
                            "ancillaryKey": "4f556396a9e7490cccb75a91ae19dbca",
                            "ancillaryType": 2,
                            "ancillarySegment": {
                                "airline": "VJ",
                                "flightNum": "896",
                                "departure": "DEL",
                                "departureDate": "2023-11-30",
                                "departureTime": "00:05",
                                "arrival": "SGN",
                                "arrivalDate": "2023-11-30",
                                "arrivalTime": "06:20",
                                "bookingCode": "I"
                            },
                            "seatName": "46A",
                            "column": "A",
                            "row": "46",
                            "characteristics": [
                                "middle"
                            ],
                            "seatCurrency": "CNY",
                            "seatPrice": "40.0"
                        },
                        {
                            "ancillaryKey": "b9fb374c9c7fb51d88b04b415027be67",
                            "ancillaryType": 2,
                            "ancillarySegment": {
                                "airline": "VJ",
                                "flightNum": "632",
                                "departure": "SGN",
                                "departureDate": "2023-11-30",
                                "departureTime": "17:20",
                                "arrival": "DAD",
                                "arrivalDate": "2023-11-30",
                                "arrivalTime": "18:35",
                                "bookingCode": "I"
                            },
                            "seatName": "15A",
                            "column": "A",
                            "row": "15",
                            "characteristics": [
                                "middle"
                            ],
                            "seatCurrency": "CNY",
                            "seatPrice": "40.0"
                        }
                    ]
                }
            }
        ]
    }
}
```
3. Booking response with baggage and seat
```plain
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "orderNum": "916995304456203701",
        "pnr": "A8GS1Q",
        "solution": {
            "solutionKey": "03d83a531a25d8853baa94d02fe7cb79",
            "solutionId": "1",
            "fareType": "PRIVATE",
            "currency": "CNY",
            "adtFare": 2862,
            "adtTax": 1211.0,
            "chdFare": 0,
            "chdTax": 0,
            "qCharge": 0,
            "tktFee": 0.0,
            "platformServiceFee": 0,
            "journeys": {
                "journey_0": [
                    "036343eddc01e31dbe364d10df1c4e5a"
                ]
            },
            "platingCarrier": "VJ",
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
                        "baggageAmount": "0PC"
                    },
                    {
                        "segmentIndexList": [
                            2
                        ],
                        "baggageAmount": "0PC"
                    }
                ],
            }
        },
        "flights": [
            {
                "flightId": "036343eddc01e31dbe364d10df1c4e5a",
                "journeyTime": 360,
                "transferCount": 1,
                "segmengtIds": [
                    "def32e56f53ad461c6437c0d237ae6db",
                    "4abffb5c6b36b9a366075d4726460a66"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "4abffb5c6b36b9a366075d4726460a66",
                "airline": "VJ",
                "flightNum": "632",
                "cabinClass": "ECONOMY",
                "bookingCode": "I",
                "availabilityCount": 3,
                "departure": "SGN",
                "arrival": "DAD",
                "departureDate": 1701336000000,
                "arrivalDate": 1701340500000,
                "flightTime": 75,
                "codeShare": "N",
                "strDepartureDate": "2023-11-30",
                "strDepartureTime": "17:20",
                "strArrivalDate": "2023-11-30",
                "strArrivalTime": "18:35"
            },
            {
                "segmentId": "def32e56f53ad461c6437c0d237ae6db",
                "airline": "VJ",
                "flightNum": "896",
                "cabinClass": "ECONOMY",
                "bookingCode": "I",
                "availabilityCount": 3,
                "departure": "DEL",
                "arrival": "SGN",
                "departureDate": 1701273900000,
                "arrivalDate": 1701296400000,
                "flightTime": 285,
                "codeShare": "N",
                "strDepartureDate": "2023-11-30",
                "strDepartureTime": "00:05",
                "strArrivalDate": "2023-11-30",
                "strArrivalTime": "06:20"
            }
        ],
        "ancillary": [
            {
                "lastName": "LIN",
                "firstName": "LIHONG",
                "psgType": "ADT",
                "ancillaries": {
                    "baggage": [
                        {
                            "ancillaryKey": "0c3596cc08171e66748b91bdad5c1e57",
                            "ancillaryType": 1,
                            "payBaggageType": 1,
                            "baggagePiece": 2,
                            "baggageWeight": "36KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": 95.0,
                            "ancillaryJourneys": [
                                {
                                    "airline": "VJ",
                                    "flightNum": "896",
                                    "departure": "DEL",
                                    "departureDate": "2023-11-30",
                                    "departureTime": "00:05",
                                    "arrival": "SGN",
                                    "arrivalDate": "2023-11-30",
                                    "arrivalTime": "06:20",
                                    "bookingCode": "I"
                                },
                                {
                                    "airline": "VJ",
                                    "flightNum": "632",
                                    "departure": "SGN",
                                    "departureDate": "2023-11-30",
                                    "departureTime": "17:20",
                                    "arrival": "DAD",
                                    "arrivalDate": "2023-11-30",
                                    "arrivalTime": "18:35",
                                    "bookingCode": "I"
                                }
                            ]
                        }
                    ],
                    "seat": [
                        {
                            "ancillaryKey": "4f556396a9e7490cccb75a91ae19dbca",
                            "ancillaryType": 2,
                            "ancillarySegment": {
                                "airline": "VJ",
                                "flightNum": "896",
                                "departure": "DEL",
                                "departureDate": "2023-11-30",
                                "departureTime": "00:05",
                                "arrival": "SGN",
                                "arrivalDate": "2023-11-30",
                                "arrivalTime": "06:20",
                                "bookingCode": "I"
                            },
                            "seatName": "46A",
                            "column": "A",
                            "row": "46",
                            "characteristics": [
                                "middle"
                            ],
                            "seatCurrency": "CNY",
                            "seatPrice": "40.0"
                        },
                        {
                            "ancillaryKey": "b9fb374c9c7fb51d88b04b415027be67",
                            "ancillaryType": 2,
                            "ancillarySegment": {
                                "airline": "VJ",
                                "flightNum": "632",
                                "departure": "SGN",
                                "departureDate": "2023-11-30",
                                "departureTime": "17:20",
                                "arrival": "DAD",
                                "arrivalDate": "2023-11-30",
                                "arrivalTime": "18:35",
                                "bookingCode": "I"
                            },
                            "seatName": "15A",
                            "column": "A",
                            "row": "15",
                            "characteristics": [
                                "middle"
                            ],
                            "seatCurrency": "CNY",
                            "seatPrice": "40.0"
                        }
                    ]
                }
            }
        ]
    }
}

```
 
Error Response

```plain
{
    "errorCode": "B079",
    "errorMsg": "Each infant must be associated to one adult and each adult can only take charge of one infant.",
    "data": null
}
```
### 5.3 PreciseBooking Response Breakdown Strucutre

[PriciseBooking Response-V4.pdf](http://open.pkfare.com/api-agent/document/load/181784)

## 6 Error Code List

|erroCode|erroMsg|Description|
|:----|:----|:----|
|0|ok|Request has been processed successfully.|
|S001|System error.|System error.|
|B002|Partner is not exists.|PartnerID does not exist.|
|B003|Illegal sign.|Illegal sign. Please check your signature.|
|B035|Concurrency limited. Please contact PKFARE API support team for assistant.|Concurrency exceeded system limits.|
|P001|XXX is illegal.|The field of XXX is illegal.|
|P002|XXX is missing.|The field of XXX is missing.|
|P006|Invalid parameter.|Value of request cannot pass the validation, please check on the request.|
|0307|Reservation failed - Booking class is sold out.|Reservation failed. Seats have been sold out.|
|B004|There are errors in the passenger type of Adults.|Adult passenger's age does not meet the requirements.|
|B005|Can not find any matching precisePricing result within 30 minutes.|Can not find the corresponding precisePricing record. Please check the itinerary and passenger numbers. PreciseBooking has to be invoked within 30 minutes after pricing.|
|B006|Reservation failed - Other. OrderNum is XXX.|Booking fail for other reason. The order has been created which is indicated in Other.OrderNum field|
|B006|Reservation failed.|Booking fail for other reason.|
|B007|Reservation failed - Segment status is not HK.|Segment status is invalid from GDS. Please select other flight options.|
|B008|Itinerary is different between PNR and order.|Itinerary in reservation is different from precisePricing. There might be a flight re-schedule. Please select other flight options.|
|B011|Reservation failed - Fare is unavailable.|Fare is unavailable form GDS. Please select other flight options.|
|B012|Reservation failed - Create PNR time out.|Create PNR time out from GDS. Please wait some minutes or select other flight options.|
|B017|Price is changed.|Price is changed.|
|B023|Reservation failed - Save price fail.|Fail to save price from GDS.|
|B022|There are errors in the passenger type of Children|Child passenger's age does not meet the requirements.|
|B025|Reservation failed - RT PNR fail.|Fail to retieve PNR from GDS.|
|B027|Airline PNR is missing.|Airline PNR is missing from GDS.|
|B028|Reservation failed - Time out.|Booking time out from GDS.|
|B029|Duplicate reservations have been found for passenger XXX/XXX in order XXX, in pnr XXX.|Duplicated reservation is not allowed. If there is an order with same segment and passenger, system will block the second reservation and return error. Please cancel the last duplicated order or pay the last order directly.|
|B030|Illegal passenger name, please use Chinese character.|Wrong passenger name. If passengers use Chinese ID card to make reservation for China domestic flight, please use Chinese character.|
|B031|Illegal passenger name, please use correct Chinese character.|Wrong passenger name. If passengers use chinese ID card to make reservation, the chinese name length is over the limitation.|
|B032|Illegal passport, please use 'N' as document type if you are using Chinese ID card to make reservation.|Illegal passport. If passengers book Chinese flight, please use correct passport.|
|B043|Reservation failed: Create PNR failed.|Booking failed from GDS.|
|B044|Reservation failed - Create PNR failed, end transaction failed.|Booking failed from GDS.|
|B062|The length of passenger name should be 40 English alphabet including / between last name and first name.|Passenger's name should be within 40 English alphabet, including "/" between last name and first name.|
|B064|The lastName of passegner should be within 2-30 English alphabet.|Passenger's last name should be within 2-30 English alphabet.|
|B065|Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality.|Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality.Please contact PKFARE API support.|
|B069|Reservation failed, this fare has passenger age limitation.|Reservation failed, because this fare has a passenger age limition.|
|B077|There are erros in the passenger type of infants.|Infant passenger's age does not meet the requirements.|
|B078|Lack of passengerIndex.|For bookings contain infant(s) , passengerIndex is required for each passenger.|
|B079|Each infant must be associated to one adult and each adult can only be associated to one infant maximum.|Each infant must be associated to one adult and each adult can only be associated to one infant maximum.|
|B080|Invalid or duplicated or discontinuous passengerIndex|PassengerIndex must be positive and continuous integers starting from 1.|
|B081|Error in ancillary passenger info.|Error in ancillary passenger info.|
|B188|Ancillary info is inconsistent in the field XXXX.|Error in ancillary info.|

 

