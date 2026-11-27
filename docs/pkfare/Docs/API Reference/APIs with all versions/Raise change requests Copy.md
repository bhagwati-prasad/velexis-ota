# Raise change requests Copy

# **Overview**


**a. A passenger would like to raise a voluntary/involuntary change to his/her original flight joruney and you need to go through the following procedures:**


:::info
1. **Raise a request in ChangeReshop API to check the bookable alternative flight solutions**
2. **The passenger selects a solution and is willing to proceed with change process**
3. **Raise a Change Request to create change order**
4. **Invoke OrderDetail API to get the change price**
5. **Invoke Orderpricng API to get final check before payment**
6. **Invoke Ticketing API to issue ticket for the change order**

:::

**b. A passenger would like to raise change of the passenger details/information against the original order and you need to go through the following proceedures:**

:::info
1. **Upload file ID using UploadAttachmentFile API and get UploadedFileIds**
2. **Raise a request in ChangePassengerInfo API with file ids**

:::

# **Voluntary Change Procedure**

**When there is a need of voluntary change request from your customers, you will need to raise ChangeReshop API to check the eligibility as well as other alternative and bookable flight solutions. The change price may or may not be displayed at this stage throguh API.**

## **ChangeReshop Request**

```plain
{
	"authentication": {
		"sign": "d53d44ea413c40d5f1d18e69047b7c",
		"partnerId": "qiE0YKcJlXjknkCkZKhzIis5o="
	},
	"data": {
		"orderNum": 916958958684833601,
		"voluntaryType": 0,
		"changeReason": 0,
		"segmentList": [],
		"passengerList": [
			{
				"birthday": "2003-09-28",
				"cardNum": "",
				"cardType": "P",
				"firstName": "yi",
				"lastName": "bao",
				"nationality": "CN",
				"sex": "M"
			},
			{
				"birthday": "2017-09-28",
				"cardNum": "",
				"cardType": "P",
				"firstName": "san",
				"lastName": "bao",
				"nationality": "CN",
				"sex": "M"
			}
		],
		"changeAirlegs": [
			{
				"journeySeq": 0,
				"airportOrCity": 1,
				"destination": "BKK",
				"origin": "HKG",
				"departureDate": "2023-10-07"
			},
			{
				"journeySeq": 1,
				"airportOrCity": 1,
				"destination": "HKG",
				"origin": "BKK",
				"departureDate": "2023-10-20"
			}
		]
	}
}
```
## **ChangeReshop Response**

**If the change procedure could be automatically processed, a `passengerPriceList`element will be returned with the change amount:**

```plain
{
	"data": {
		"flights": [
			{
				"flightId": "a26d645b1d2d5c71ba0749fa9fd96f01",
				"journeyTime": "1525",
				"segmentIds": [
					"f77a96773b837d0f86d19b5458a4b9c3",
					"fa2296922596330db9db53a7e2607432"
				],
				"transferCount": "1"
			},
			{
				"flightId": "6815cbebca0cf5ba590967ee438d573d",
				"journeyTime": "1145",
				"segmentIds": [
					"370004a702073eeec91c6e4324d0fc39",
					"fa2296922596330db9db53a7e2607432"
				],
				"transferCount": "1"
			},
			{
				"flightId": "14c6b6bf0287e9705a04e7665e120f95",
				"journeyTime": "1690",
				"segmentIds": [
					"4bd7b30e064883d5f76045ecd5d1dddb",
					"fa2296922596330db9db53a7e2607432"
				],
				"transferCount": "1"
			}
			],
		"journeys": {
			"journey_1": [
				"a26d645b1d2d5c71ba0749fa9fd96f01",
				"6815cbebca0cf5ba590967ee438d573d",
				"14c6b6bf0287e9705a04e7665e120f95"
			]
			},
		"passengerPriceList": [
			{
				"adtChangeAmount": 0,
				"adtChangeFee": 0,
				"baggageMap": {
					"ADT": [
						{
							"baggageWeight": "20KG",
							"segmentIndexList": [
								"1",
								"2"
							]
						}
					],
					"CHD": []
				},
				"chdChangeAmount": 0,
				"chdChangeFee": 0,
				"currency": "CNY",
				"fareType": "PUBLIC",
				"journeys": {
					"journey_1": [
						"a26d645b1d2d5c71ba0749fa9fd96f01"
					]
				},
				"lastTktTime": "2023-10-07 23:59:00",
				"merchantFee": 0,
				"miniRuleMap": {
					"CHD": [
						{
							"miniRules": [],
							"segmentIndex": [
								"1"
							]
						},
						{
							"miniRules": [],
							"segmentIndex": [
								"2"
							]
						}
					]
				},
				"platingCarrier": "OD",
				"solutionId": "de43c371998ad3b809401b78cb09f16d",
				"solutionKey": "de43c371998ad3b809401b78cb09f16d",
				"totalChangeAmount": 0
			},
			{
				"adtChangeAmount": 0,
				"adtChangeFee": 0,
				"baggageMap": {
					"ADT": [
						{
							"baggageWeight": "20KG",
							"segmentIndexList": [
								"1",
								"2"
							]
						}
					],
					"CHD": []
						},
				"chdChangeAmount": 0,
				"chdChangeFee": 0,
				"currency": "CNY",
				"fareType": "PUBLIC",
				"journeys": {
					"journey_1": [
						"6815cbebca0cf5ba590967ee438d573d"
					]
				},
				"lastTktTime": "2023-10-07 23:59:00",
				"merchantFee": 0,
				"miniRuleMap": {
					"CHD": [
						{
							"miniRules": [],
							"segmentIndex": [
								"1"
							]
						},
						{
							"miniRules": [],
							"segmentIndex": [
								"2"
							]
						}
					]
				},
				"platingCarrier": "OD",
				"solutionId": "a211f7574da54aae7d0a6f0bbf5742c6",
				"solutionKey": "a211f7574da54aae7d0a6f0bbf5742c6",
				"totalChangeAmount": 0
			},
			{
				"adtChangeAmount": 0,
				"adtChangeFee": 0,
				"baggageMap": {
					"ADT": [
						{
							"baggageWeight": "20KG",
							"segmentIndexList": [
								"1",
								"2"
							]
						}
					],
					"CHD": []
				},
				"chdChangeAmount": 0,
				"chdChangeFee": 0,
				"currency": "CNY",
				"fareType": "PUBLIC",
				"journeys": {
					"journey_1": [
						"14c6b6bf0287e9705a04e7665e120f95"
					]
				},
				"lastTktTime": "2023-10-07 23:59:00",
				"merchantFee": 0,
				"miniRuleMap": {
					"CHD": [
						{
							"miniRules": [],
							"segmentIndex": [
								"1"
							]
						},
						{
							"miniRules": [],
							"segmentIndex": [
								"2"
							]
						}
					]
				},
				"platingCarrier": "OD",
				"solutionId": "0c62b654ef24bbb8dd4c6295bf34198c",
				"solutionKey": "0c62b654ef24bbb8dd4c6295bf34198c",
				"totalChangeAmount": 0
				}
			],
		"passengers": [
			{
				"birthday": "2020-03-04",
				"cardExpiredDate": "2025-06-07",
				"cardNum": "E12345678",
				"cardType": "PP",
				"firstName": "TIFFANY",
				"lastName": "YANGC",
				"nationality": "CN",
				"psgType": "CHD",
				"sex": "M"
			},
			{
				"birthday": "1990-08-23",
				"cardExpiredDate": "2024-03-17",
				"cardNum": "E07700466",
				"cardType": "PP",
				"firstName": "TIFFANY",
				"lastName": "YANGA",
				"nationality": "CN",
				"psgType": "ADT",
				"sex": "M"
				}
		],
		"segments": [
			{
				"airline": "OD",
				"arrival": "KUL",
				"arrivalDate": "1697472000000",
				"arrivalTerminal": "1",
				"availablityCount": 9,
				"bookingCode": "X",
				"cabinClass": "ECONOMY",
				"codeShare": "N",
				"departure": "DMK",
				"departureDate": "1697472000000",
				"departureTerminal": "0",
				"equipment": "738",
				"flightNum": "525",
				"flightTime": 135,
				"opFltAirline": "",
				"segmentId": "4bd7b30e064883d5f76045ecd5d1dddb",
				"strArrivalDate": "2023-10-17",
				"strArrivalTime": "12:20",
				"strDepartureDate": "2023-10-17",
				"strDepartureTime": "09:05"
			},
			{
				"airline": "OD",
				"arrival": "HKG",
				"arrivalDate": "1697558400000",
				"arrivalTerminal": "2",
				"availablityCount": 9,
				"bookingCode": "X",
				"cabinClass": "ECONOMY",
				"codeShare": "N",
				"departure": "KUL",
				"departureDate": "1697558400000",
				"departureTerminal": "1",
				"equipment": "738",
				"flightNum": "605",
				"flightTime": 240,
				"opFltAirline": "",
				"segmentId": "fa2296922596330db9db53a7e2607432",
				"strArrivalDate": "2023-10-18",
				"strArrivalTime": "14:15",
				"strDepartureDate": "2023-10-18",
				"strDepartureTime": "10:15"
			},
			{
				"airline": "OD",
				"arrival": "KUL",
				"arrivalDate": "1697472000000",
				"arrivalTerminal": "1",
				"availablityCount": 9,
				"bookingCode": "X",
				"cabinClass": "ECONOMY",
				"codeShare": "N",
				"departure": "DMK",
				"departureDate": "1697472000000",
				"departureTerminal": "0",
				"equipment": "738",
				"flightNum": "523",
				"flightTime": 135,
				"opFltAirline": "",
				"segmentId": "370004a702073eeec91c6e4324d0fc39",
				"strArrivalDate": "2023-10-17",
				"strArrivalTime": "21:25",
				"strDepartureDate": "2023-10-17",
				"strDepartureTime": "18:10"
			},
			{
				"airline": "OD",
				"arrival": "KUL",
				"arrivalDate": "1697472000000",
				"arrivalTerminal": "1",
				"availablityCount": 9,
				"bookingCode": "X",
				"cabinClass": "ECONOMY",
				"codeShare": "N",
				"departure": "DMK",
				"departureDate": "1697472000000",
				"departureTerminal": "0",
				"equipment": "738",
				"flightNum": "521",
				"flightTime": 135,
				"opFltAirline": "",
				"segmentId": "f77a96773b837d0f86d19b5458a4b9c3",
				"strArrivalDate": "2023-10-17",
				"strArrivalTime": "15:05",
				"strDepartureDate": "2023-10-17",
				"strDepartureTime": "11:50"
			}
		]
	},
	"errorCode": "0",
	"errorMsg": "ok"
}
```

**If the change procedure could not be automatically processed and needs human intervention, the`passengerPriceList`section will not be returned with the change amount:**

```plain
{
	"data": {
		"flights": [
			{
				"flightId": "f5deaeeae1538fb6c45901d524ee2f98",
				"journeyTime": "165",
				"segmentIds": [
					"18f64642c5e156a84f476f98554040d4"
				],
				"transferCount": "0"
			},
			{
				"flightId": "92cc227532d17e56e07902b254dfad10",
				"journeyTime": "170",
				"segmentIds": [
					"04be3fae9272a3232c0e034d77f25770"
				],
				"transferCount": "0"
			},
			{
				"flightId": "8fe0093bb30d6f8c31474bd0764e6ac0",
				"journeyTime": "165",
				"segmentIds": [
					"e5b39536b12440627d2febce91001726"
				],
				"transferCount": "0"
			},
			{
				"flightId": "ab817c9349cf9c4f6877e1894a1faa00",
				"journeyTime": "175",
				"segmentIds": [
					"fe1294d9a52af8d0cd571a3b1bd6c4d5"
				],
				"transferCount": "0"
			},
			{
				"flightId": "303ed4c69846ab36c2904d3ba8573050",
				"journeyTime": "175",
				"segmentIds": [
					"31518e6b412d09e023657f86c0dc0bd4"
				],
				"transferCount": "0"
			}
		],
		"journeys": {
			"journey_1": [
				"f5deaeeae1538fb6c45901d524ee2f98",
				"92cc227532d17e56e07902b254dfad10",
				"8fe0093bb30d6f8c31474bd0764e6ac0"
			],
			"journey_0": [
				"ab817c9349cf9c4f6877e1894a1faa00",
				"303ed4c69846ab36c2904d3ba8573050"
			]
		},
		"passengers": [
			{
				"birthday": "2017-09-28",
				"cardExpiredDate": "2024-10-27",
				"cardNum": "G19405622",
				"cardType": "PP",
				"firstName": "SAN",
				"lastName": "BAO",
				"nationality": "CN",
				"psgType": "CHD",
				"sex": "M"
			},
			{
				"birthday": "2003-09-28",
				"cardExpiredDate": "2024-10-27",
				"cardNum": "G54014364",
				"cardType": "PP",
				"firstName": "YI",
				"lastName": "BAO",
				"nationality": "CN",
				"psgType": "ADT",
				"sex": "M"
			}
		],
		"segments": [
			{
				"airline": "UO",
				"arrival": "HKG",
				"arrivalDate": "1697731200000",
				"classCodes": "Y,B,H,K,L,M,N,S,X,Q,T,V,W,O,U",
				"codeShare": "N",
				"departure": "BKK",
				"departureDate": "1697731200000",
				"equipment": "320",
				"flightNum": "705",
				"flightTime": 165,
				"segmentId": "18f64642c5e156a84f476f98554040d4",
				"strArrivalDate": "2023-10-20",
				"strArrivalTime": "14:50",
				"strDepartureDate": "2023-10-20",
				"strDepartureTime": "11:05"
			},
			{
				"airline": "UO",
				"arrival": "HKG",
				"arrivalDate": "1697731200000",
				"classCodes": "Y,B,H,K,L,M,N,S,X,Q,T,V,W,O,U",
				"codeShare": "N",
				"departure": "BKK",
				"departureDate": "1697731200000",
				"equipment": "320",
				"flightNum": "701",
				"flightTime": 170,
				"segmentId": "04be3fae9272a3232c0e034d77f25770",
				"strArrivalDate": "2023-10-20",
				"strArrivalTime": "20:00",
				"strDepartureDate": "2023-10-20",
				"strDepartureTime": "16:10"
			},
			{
				"airline": "UO",
				"arrival": "HKG",
				"arrivalDate": "1697731200000",
				"classCodes": "Y,B,H,K,L,M,N,S,X,Q,T,V,W,O,U",
				"codeShare": "N",
				"departure": "BKK",
				"departureDate": "1697731200000",
				"equipment": "321",
				"flightNum": "703",
				"flightTime": 165,
				"segmentId": "e5b39536b12440627d2febce91001726",
				"strArrivalDate": "2023-10-20",
				"strArrivalTime": "23:20",
				"strDepartureDate": "2023-10-20",
				"strDepartureTime": "19:35"
			},
			{
				"airline": "UO",
				"arrival": "BKK",
				"arrivalDate": "1696608000000",
				"classCodes": "Y,B,H,K,L,M,N,S,X,Q,T,V,W,O,U",
				"codeShare": "N",
				"departure": "HKG",
				"departureDate": "1696608000000",
				"equipment": "320",
				"flightNum": "700",
				"flightTime": 175,
				"segmentId": "fe1294d9a52af8d0cd571a3b1bd6c4d5",
				"strArrivalDate": "2023-10-07",
				"strArrivalTime": "15:20",
				"strDepartureDate": "2023-10-07",
				"strDepartureTime": "13:25"
			},
			{
				"airline": "UO",
				"arrival": "BKK",
				"arrivalDate": "1696608000000",
				"classCodes": "Y,B,H,K,L,M,N,S,X,Q,T,V,W,O,U",
				"codeShare": "N",
				"departure": "HKG",
				"departureDate": "1696608000000",
				"equipment": "321",
				"flightNum": "702",
				"flightTime": 175,
				"segmentId": "31518e6b412d09e023657f86c0dc0bd4",
				"strArrivalDate": "2023-10-07",
				"strArrivalTime": "18:50",
				"strDepartureDate": "2023-10-07",
				"strDepartureTime": "16:55"
			}
		]
	},
	"errorCode": "0",
	"errorMsg": "ok"
}
```

---


**If passgner is willing to proceed, you could create a change order with PKFARE get new order information. At this stage, change amount might or might not be displayed.**

## **Change Request**

```plain
{
    "authentication": {
        "partnerId": "qiE0YKcJlXjknkCkZKhzIis5o=",
        "sign": "d53d44ea413c40d5f1d18e69047b7c"
    },
    "data": {
        "voluntaryType": 1,
        "changeReason": 1,
        "uploadedFileIds": [
            "975b70c89f0ed3e3e1555729c11745eb",
            "a98c63e1f9371ccce1555729c11745eb"
        ],
        "changeJourney": {
            "journey_0": [
                {
                    "airline": "OD",
                    "flightNum": "606",
                    "departure": "HKG",
                    "departureDate": "2023-09-29",
                    "departureTime": "15:15",
                    "bookingCode": "T",
                    "cabinClass": "ECONOMY",
                    "arrival": "KUL",
                    "arrivalDate": "2023-09-29",
                    "arrivalTime": "19:05"
                },
                {
                    "airline": "OD",
                    "flightNum": "520",
                    "departure": "KUL",
                    "departureDate": "2023-09-30",
                    "departureTime": "09:55",
                    "bookingCode": "X",
                    "cabinClass": "ECONOMY",
                    "arrival": "DMK",
                    "arrivalDate": "2023-09-30",
                    "arrivalTime": "11:05"
                }
            ],
            "journey_1": [
                {
                    "airline": "OD",
                    "flightNum": "521",
                    "departure": "DMK",
                    "departureDate": "2023-10-20",
                    "departureTime": "11:50",
                    "bookingCode": "X",
                    "cabinClass": "ECONOMY",
                    "arrival": "KUL",
                    "arrivalDate": "2023-10-20",
                    "arrivalTime": "15:05"
                },
                {
                    "airline": "OD",
                    "flightNum": "605",
                    "departure": "KUL",
                    "departureDate": "2023-10-21",
                    "departureTime": "10:15",
                    "bookingCode": "X",
                    "cabinClass": "ECONOMY",
                    "arrival": "HKG",
                    "arrivalDate": "2023-10-21",
                    "arrivalTime": "14:15"
                }
            ]
        },
        "buyerOrder": "buyerOrder1",
        "solutionKey": "",
        "orderNum": "916958798364810031",
        "passengerList": [
            {
                "birthday": "1999-09-09",
                "cardNum": "",
                "cardType": "PP",
                "firstName": "yang",
                "lastName": "zhang",
                "nationality": "CN",
                "sex": "F"
            }
        ],
        "contactInfo": {
            "telNum": "15691012314",
            "name": "amy",
            "email": "amy.zhang@pkfare.com"
        }
    }
}
```

## **Change Response**

**If the change procedure could be automatically processed, a`passengerPriceList`element will be returned with the change amount:**

```plain
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "parentOrderNum": "916958958684833601",
        "orderNum": "916958958684833602",
        "refOrderNum": "9169589586848336",
        "createTime": "2023-10-08T15:54:04+08:00",
        "voluntaryType": 1,
        "changeReason": 1,
        "orderStatus": "To Be Paid",
        "pnr": "C3CV9F",
        "airPnr": "C3CV9F",
        "platingCarrier": "UO",
        "lastTktTime": "2023-10-08T16:24:04+08:00",
        "flights": [
            {
                "flightId": "9bf2f65c69c54e553e4b1603ae5e8ca5",
                "journeyTime": "175",
                "transferCount": 0,
                "segmentIds": [
                    "fb421f8215cb7adc6b292b35dbca716b"
                ]
            },
            {
                "flightId": "580ec661f432db859df93e8820f0ba58",
                "journeyTime": "165",
                "transferCount": 0,
                "segmentIds": [
                    "ba4fca9429e79abee0c3755b88a282fe"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "fb421f8215cb7adc6b292b35dbca716b",
                "airline": "UO",
                "flightNum": "702",
                "equipment": "321",
                "cabinClass": "ECONOMY",
                "bookingCode": "V",
                "departure": "HKG",
                "arrival": "BKK",
                "departureDate": "1697964900000",
                "arrivalDate": "1697971800000",
                "flightTime": "175",
                "codeShare": "N",
                "strDepartureDate": "2023-10-22",
                "strDepartureTime": "16:55",
                "strArrivalDate": "2023-10-22",
                "strArrivalTime": "18:50"
            },
            {
                "segmentId": "ba4fca9429e79abee0c3755b88a282fe",
                "airline": "UO",
                "flightNum": "701",
                "equipment": "320",
                "cabinClass": "ECONOMY",
                "bookingCode": "T",
                "departure": "BKK",
                "arrival": "HKG",
                "departureDate": "1698740400000",
                "arrivalDate": "1698753900000",
                "flightTime": "165",
                "codeShare": "N",
                "strDepartureDate": "2023-10-31",
                "strDepartureTime": "16:20",
                "strArrivalDate": "2023-10-31",
                "strArrivalTime": "20:05"
            }
        ],
        "passengers": [
            {
                "lastName": "BAO",
                "firstName": "YI",
                "cardType": "P",
                "cardNum": "G54014364",
                "nationality": "CN",
                "psgType": "ADT",
                "sex": "M",
                "birthday": "2003-09-28"
            },
            {
                "lastName": "BAO",
                "firstName": "SAN",
                "cardType": "P",
                "cardNum": "G19405622",
                "nationality": "CN",
                "psgType": "CHD",
                "sex": "M",
                "birthday": "2017-09-28"
            }
        ],
        "passengerPriceList": [
            {
                "solutionId": "8ba97001b7230d47d7a3d2b037b8a95b",
                "solutionKey": "8ba97001b7230d47d7a3d2b037b8a95b",
                "fareType": "PRIVATE",
                "currency": "USD",
                "adtAdditionalFare": 0,
                "adtAdditionalTax": 0,
                "adtChangeFee": 0,
                "changeServiceFee": 0,
                "adtChangeAmount": 0,
                "chdAdditionalFare": 0,
                "chdAdditionalTax": 0,
                "chdChangeFee": 0,
                "chdChangeAmount": 0,
                "totalChangeAmount": 0,
                "merchantFee": 0,
                "journeys": {
                    "journey_0": [
                        "9bf2f65c69c54e553e4b1603ae5e8ca5"
                    ],
                    "journey_1": [
                        "580ec661f432db859df93e8820f0ba58"
                    ]
                }
            }
        ]
    }
}
```

**If the change procedure could not be automatically processed and needs human intervention, the`passengerPriceList`section will not be returned with the change amount:**

```plain
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "parentOrderNum": "916958798364810031",
        "orderNum": "916958798364810038",
        "refOrderNum": "9169587983648100",
        "createTime": "2023-10-08T15:22:11+08:00",
        "voluntaryType": 1,
        "changeReason": 1,
        "orderStatus": "Under review",
        "pnr": "rrrr1|rrrr2|rrrr3|rrrr4",
        "platingCarrier": "OD",
        "flights": [
            {
                "flightId": "6f9cf85e209c336035854438760d1213",
                "journeyTime": "1250",
                "transferCount": 1,
                "segmentIds": [
                    "9dbf1ee0de48df643959296bd6bb078b",
                    "20ce18062818aff96f6734cefeb94a73"
                ]
            },
            {
                "flightId": "ef2abf1476d7daa10e04125e1ab511c5",
                "journeyTime": "1525",
                "transferCount": 1,
                "segmentIds": [
                    "ba9bda72df6c5b8369ebed92242729ae",
                    "e4a100ce91b1b3e9413c1588abce0cde"
                ]
            }
        ],
        "journeys": {
            "journey_0": [
                "6f9cf85e209c336035854438760d1213"
            ],
            "journey_1": [
                "ef2abf1476d7daa10e04125e1ab511c5"
            ]
        },
        "segments": [
            {
                "segmentId": "9dbf1ee0de48df643959296bd6bb078b",
                "airline": "OD",
                "flightNum": "606",
                "equipment": "738",
                "cabinClass": "ECONOMY",
                "bookingCode": "T",
                "departure": "HKG",
                "arrival": "KUL",
                "departureTerminal": "2",
                "arrivalTerminal": "M",
                "departureDate": "1695971700000",
                "arrivalDate": "1695985500000",
                "flightTime": "230",
                "codeShare": "N",
                "strDepartureDate": "2023-09-29",
                "strDepartureTime": "15:15",
                "strArrivalDate": "2023-09-29",
                "strArrivalTime": "19:05"
            },
            {
                "segmentId": "20ce18062818aff96f6734cefeb94a73",
                "airline": "OD",
                "flightNum": "520",
                "equipment": "738",
                "cabinClass": "ECONOMY",
                "bookingCode": "X",
                "departure": "KUL",
                "arrival": "DMK",
                "departureTerminal": "M",
                "arrivalTerminal": "1",
                "departureDate": "1696038900000",
                "arrivalDate": "1696043100000",
                "flightTime": "130",
                "codeShare": "N",
                "strDepartureDate": "2023-09-30",
                "strDepartureTime": "09:55",
                "strArrivalDate": "2023-09-30",
                "strArrivalTime": "11:05"
            },
            {
                "segmentId": "ba9bda72df6c5b8369ebed92242729ae",
                "airline": "OD",
                "flightNum": "521",
                "equipment": "738",
                "cabinClass": "ECONOMY",
                "bookingCode": "X",
                "departure": "DMK",
                "arrival": "KUL",
                "departureTerminal": "1",
                "arrivalTerminal": "M",
                "departureDate": "1697773800000",
                "arrivalDate": "1697785500000",
                "flightTime": "135",
                "codeShare": "N",
                "strDepartureDate": "2023-10-20",
                "strDepartureTime": "11:50",
                "strArrivalDate": "2023-10-20",
                "strArrivalTime": "15:05"
            },
            {
                "segmentId": "e4a100ce91b1b3e9413c1588abce0cde",
                "airline": "OD",
                "flightNum": "605",
                "equipment": "738",
                "cabinClass": "ECONOMY",
                "bookingCode": "X",
                "departure": "KUL",
                "arrival": "HKG",
                "departureTerminal": "M",
                "arrivalTerminal": "2",
                "departureDate": "1697854500000",
                "arrivalDate": "1697868900000",
                "flightTime": "240",
                "codeShare": "N",
                "strDepartureDate": "2023-10-21",
                "strDepartureTime": "10:15",
                "strArrivalDate": "2023-10-21",
                "strArrivalTime": "14:15"
            }
        ],
        "passengers": [
            {
                "lastName": "ZHANG",
                "firstName": "YANG",
                "cardType": "P",
                "cardNum": "",
                "nationality": "CN",
                "psgType": "ADT",
                "sex": "F",
                "birthday": "1999-09-09"
            }
        ]
    }
}
```

---
## **Check Order status and change amount**

**If the change amount did not be returned and specified when invoking changeReshop and changeRequest API, you can invoke Orderdetail API to loop check the order status as well as the change amount until you get information about change price and reach the relevant state regarding order status, which is,****"changed, to be paid"****.**

:::note
**Note: If the order status in ChangeRequest response indicates "To be Paid" and you observe that the change amount has been specified in previous API responses, then it is not necessary to call OrderDetail API and you can move forward to call orderPricing API to pre-check before payment.**
:::


## **OrderDetail Request**

```plain
{
    "authentication": {
        "sign": "1234",
        "partnerId": "12343"
    },
    "data": {
        "orderNum":"800000000000000102",
        "includeFields":"ticket"
    }
}
```

## **OrderDetail Response**

```plain
{
  "errorCode": "0",
  "errorMsg": "ok",
  "data": {
    "orderStatus": "CHGD, TO_BE_PAID",
    "orderNum": "800000000000000102",
    "parentOrderNum": "800000000000000101",
    "refOrderNum": "8000000000000001",
    "orderType": "C",
    "createdTime": "2023-11-27 08:45:48",
    "pnr": "QHKBGS",
    "airPnr": "QHKBGS",
    "platingCarrier": "VJ",
    "passengers": [
      {
        "firstName": "CHAENGDEE",
        "lastName": "NICHAPHAT",
        "psgType": "ADT",
        "nationality": "CN",
        "sex": "M",
        "birthday": "1990-08-09",
        "cardType": "P",
        "cardNum": "NT11537654",
        "cardExpiredDate": "2038-12-10",
        "ticketNum": "QHKBGS"
      },
      {
        "firstName": "MADEE",
        "lastName": "KANAWAT",
        "psgType": "CHD",
        "nationality": "CN",
        "sex": "M",
        "birthday": "2020-08-09",
        "cardType": "P",
        "cardNum": "NT11531234",
        "cardExpiredDate": "2038-12-10",
        "ticketNum": "QHKBGS"
      }
    ],
    "journeys": [
      {
        "journeyTime": 320,
        "transferCount": 0,
        "segments": [
          {
            "airline": "VJ",
            "flightNum": "863",
            "cabinClass": "ECONOMY",
            "bookingCode": "Z",
            "departure": "ICN",
            "arrival": "SGN",
            "departureTerminal": "2",
            "arrivalTerminal": "1",
            "departureDate": "2024-12-17",
            "arrivalDate": "2024-12-17",
            "departureTime": "12:05",
            "arrivalTime": "19:25",
            "flightTime": 320,
            "codeShare": "N"
          }
        ],
        "departureTime": "12:05",
        "arrivalTime": "19:25",
        "departureDate": "2024-12-17",
        "arrivalDate": "2024-12-17"
      }
    ],
    "solutions": [
      {
        "currency": "USD",
        "adtChgFee": 0,
        "chdChgFee": 0,
        "adtChgAddFee": 0,
        "chdChgAddFee": 0,
        "chgServFee": 0,
        "chgMerFee": 0,
        "chgBuyerAmount": 0
      }
    ],
    "lastTktTime": "2023-11-27 09:45:48",
    "pnrList": [
      {
        "segmentNo": 1,
        "departure": "ICN",
        "arrival": "SGN",
        "flightNum": "863",
        "pnr": "QHKBGS",
        "airPnr": "QHKBGS",
        "cabinClass": "ECONOMY",
        "bookingCode": "Z",
        "ticketNums": [
          {
            "ticketNum": "QHKBGS",
            "passengerIndex": 1
          },
          {
            "ticketNum": "QHKBGS",
            "passengerIndex": 2
          }
        ]
      }
    ],
    "permitVoid": 0
  }
}
```


---
## **Pre-check before payment**

**It is necessary to conduct a pre-check before payment confirmed to examine the eligibility for ticketing. If orderPricing request records are not found in the system, PKFARE will automatically invoke this API and check before ticketing.**

## **OrderPricing Request**

```plain
{
    "authentication": {
        "sign": "1234",
        "partnerId": "345"
    },
    "orderPricing": {
        "orderNum": "800000000000000002"
    }
}
```
## **OrderPricing Response**

```plain
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "pricingResult": {
            "solution": {
                "currency": "USD",
                "journeys": {
                    "journey_0": [
                        "8dfe4a83787290cd192566406f5f4ad6"
                    ]
                },
                "merchantFee": 0.00,
                "adtAdditionalFare": 0.00,
                "adtAdditionalTax": 0,
                "adtChangeFee": 0.00,
                "adtChangeServiceFee": 0.00,
                "adtChangeAmount": 0.00
            },
            "flights": [
                {
                    "flightId": "8dfe4a83787290cd192566406f5f4ad6",
                    "journeyTime": 320,
                    "transferCount": 0,
                    "lastTktTime": "2023-11-17T09:45:48+08:00",
                    "segmengtIds": [
                        "c3f463cd35a8dfb89c7308d16de233f3"
                    ]
                }
            ],
            "segments": [
                {
                    "segmentId": "c3f463cd35a8dfb89c7308d16de233f3",
                    "airline": "VJ",
                    "flightNum": "863",
                    "equipment": "32S",
                    "cabinClass": "ECONOMY",
                    "bookingCode": "Z",
                    "departure": "ICN",
                    "arrival": "SNG",
                    "departureTerminal": "2",
                    "arrivalTerminal": "1",
                    "departureDate": 1734408300000,
                    "arrivalDate": 1734434700000,
                    "flightTime": 320,
                    "codeShare": "N",
                    "strDepartureDate": "2024-12-17",
                    "strDepartureTime": "12:05",
                    "strArrivalDate": "2024-12-17",
                    "strArrivalTime": "19:25"
                }
            ]
        },
        "orderResult": {
            "orderNum": "800000000000000002",
            "pnr": "HYN1B7"
        }
    }
}
```


---
## **Ticketing**

**Once you successfully pass the OrderPricing check, you are then free to invoke Ticketing API to have tickets issued for the change order.**

## **Ticketing Request**

```plain
{
    "authentication": {
        "sign": "12343",
        "partnerId": "4563"
    },
    "ticketing": {
        "orderNum":"800000000000000002",
        "email": "jango.wang@gongfutrip.com",
        "name": "Jango/Wang",
        "telNum": "13249073855",
        "PNR": "HYN1B7"
    }
}
```


## **Ticketing Response**

```plain
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "orderNum": "800000000000000002",
        "orderAmount": 0.0,
        "transactionExpense": 0,
        "payAmount": 0.0
    }
}
```


---
## **Get Ticket Issuance Result**

**The issuance process may take some time before you receive the tickets and there are also two ways to check the issuance results like which in normal ticketing process:**

1. **Invoke looping call of`orderDetail`API to pull out the order status until it reaches the final state -`"CHGD"`**
2. **Provide a webhook endpoint and to which PKFARE can push the result via`TicketIssuanceNotify`API.**


## **OrderDetail Request**

```plain
{
"authentication": {
"sign": "1234",
"partnerId": "12343"
},
"data": {
"orderNum":"800000000000000102",
"includeFields":"ticket"
}
}
```
 
## **OrderDetail Response** 

```plain
{
  "errorCode": "0",
  "errorMsg": "ok",
  "data": {
    "orderStatus": "CHGD",
    "orderNum": "800000000000000102",
    "parentOrderNum": "800000000000000101",
    "refOrderNum": "8000000000000001",
    "orderType": "C",
    "createdTime": "2023-11-27 08:45:48",
    "pnr": "QHKBGS",
    "airPnr": "QHKBGS",
    "platingCarrier": "VJ",
    "passengers": [
      {
        "firstName": "CHAENGDEE",
        "lastName": "NICHAPHAT",
        "psgType": "ADT",
        "nationality": "CN",
        "sex": "M",
        "birthday": "1990-08-09",
        "cardType": "P",
        "cardNum": "NT11537654",
        "cardExpiredDate": "2038-12-10",
        "ticketNum": "QHKBGS"
      },
      {
        "firstName": "MADEE",
        "lastName": "KANAWAT",
        "psgType": "CHD",
        "nationality": "CN",
        "sex": "M",
        "birthday": "2020-08-09",
        "cardType": "P",
        "cardNum": "NT11531234",
        "cardExpiredDate": "2038-12-10",
        "ticketNum": "QHKBGS"
      }
    ],
    "journeys": [
      {
        "journeyTime": 320,
        "transferCount": 0,
        "segments": [
          {
            "airline": "VJ",
            "flightNum": "863",
            "cabinClass": "ECONOMY",
            "bookingCode": "Z",
            "departure": "ICN",
            "arrival": "SGN",
            "departureTerminal": "2",
            "arrivalTerminal": "1",
            "departureDate": "2024-12-17",
            "arrivalDate": "2024-12-17",
            "departureTime": "12:05",
            "arrivalTime": "19:25",
            "flightTime": 320,
            "codeShare": "N"
          }
        ],
        "departureTime": "12:05",
        "arrivalTime": "19:25",
        "departureDate": "2024-12-17",
        "arrivalDate": "2024-12-17"
      }
    ],
    "solutions": [
      {
        "currency": "USD",
        "adtChgFee": 0,
        "chdChgFee": 0,
        "adtChgAddFee": 0,
        "chdChgAddFee": 0,
        "chgServFee": 0,
        "chgMerFee": 0,
        "chgBuyerAmount": 0
      }
    ],
    "lastTktTime": "2023-11-27 09:45:48",
    "pnrList": [
      {
        "segmentNo": 1,
        "departure": "ICN",
        "arrival": "SGN",
        "flightNum": "863",
        "pnr": "QHKBGS",
        "airPnr": "QHKBGS",
        "cabinClass": "ECONOMY",
        "bookingCode": "Z",
        "ticketNums": [
          {
            "ticketNum": "QHKBGS",
            "passengerIndex": 1
          },
          {
            "ticketNum": "QHKBGS",
            "passengerIndex": 2
          }
        ]
      }
    ],
    "permitVoid": 0
  }
}
```
 


## **TicketIssuanceNotify Request**

```plain
{
    "airPnr": "15CUCZ|25CUCZ",
    "currency": "CNY",
    "merchantOrder": "PREPAY_20221222145440_916716911545376001_4677",
    "orderNum": "916716911545376001",
    "passengers": [
        {
            "passengerIndex": 1,
            "birthday": "1995-06-15",
            "cardExpiredDate": "2024-05-01",
            "cardNum": "E29384798",
            "cardType": "PP",
            "firstName": "Xiaoqing",
            "lastName": "Ding",
            "nationality": "CN",
            "psgType": "ADT",
            "sex": "F",
            "ticketNum": "1T9LO2"
        },
        {
            "passengerIndex": 2,
            "birthday": "1993-04-01",
            "cardExpiredDate": "2024-07-01",
            "cardNum": "E05849326",
            "cardType": "PP",
            "firstName": "Zhigang",
            "lastName": "Zhao",
            "nationality": "CN",
            "psgType": "ADT",
            "sex": "M",
            "ticketNum": "2T9LO2"
        },
        {
            "passengerIndex": 3,
            "birthday": "2022-06-17",
            "cardExpiredDate": "2042-10-01",
            "cardNum": "E09819649",
            "cardType": "PP",
            "firstName": "Weiwei",
            "lastName": "Zhao",
            "nationality": "CN",
            "psgType": "INF",
            "sex": "M",
            "associatedPassengerIndex": 1,
            "ticketNum": "3T9LO2"
        }
    ],
    "paymentGate": "PREPAY",
    "permitVoid": 0,
    "pnr": "187UIJHNJUIJIU8789|287UIJHNJUIJIU8789",
    "pnrList": [
        {
            "airPnr": "15CUCZ",
            "arrival": "NRT",
            "bookingCode": "H",
            "cabinClass": "ECONOMY",
            "departure": "HKG",
            "flightNum": "812",
            "pnr": "187UIJHNJUIJIU8789",
            "segmentNo": 1,
            "ticketNums": [
                {
                    "passengerIndex": 1,
                    "ticketNum": "1T9LO2"
                },
                {
                    "passengerIndex": 3,
                    "ticketNum": "3T9LO2"
                }
                
            ]
        },
        {
            "airPnr": "25CUCZ",
            "arrival": "NRT",
            "bookingCode": "H",
            "cabinClass": "ECONOMY",
            "departure": "HKG",
            "flightNum": "812",
            "pnr": "287UIJHNJUIJIU8789",
            "segmentNo": 1,
            "ticketNums": [
                {
                    "passengerIndex": 2,
                    "ticketNum": "2T9LO2"
                }
            ]
        }       
    ],
    "serialNum": "PREPAY_20221222145440_916716911545376001_4677"
}
```

## **TicketIssuanceNotify Response**

```plain
{"errorCode":0,"errorMsg":"ok"}
```

---
## Change Passenger Info 

**The process of altering passenger information in ordered tickets is similar with the voluntary change process to some extent:**

**First, you will need to raise a change request with specified reason, to which PKFARE willresopond with message regarding whether changes could be made with passengers' information, with or without the change fee in this stage.** 

**Second, if the price be indicated along with the change response, you can jump to the next step to upload the passenger ID file. If the price could not be instantly calculated, you will need to invoke OrderDetail API to check the order status as well as the change fee to be applied.** 

**Afterwards, when you get the change price and the correct order status - "changed, to be paid", you will need to upload ID in order to proceed with passenger information changing process and please upload ID using UploadAttachmentFile API.**

## UploadAttachmentFile Request 

```plain
{
    "authentication": {
        "partnerId": "RksVSX7PfZmWYsCD7M4=",
        "sign": "17e707b5d9dae8459065dbb139e5f1bd"
    }
}
```
**Attach the file to be uploaded and send the request**

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338123/image-preview)


## **UploadAttachmentFile Response**

```plain
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "fileId": "1ee71d50b4d59ef3e1555729c11745eb",
        "fileName": "Pkfarer.jpg"
    }
}
```


---
**Once you got the fileID, then you can proceed with passenger information change request**

## Change Passenger Info Request 

```plain
{
    "authentication": {
        "partnerId": "qiE0YKcJlXjknkCkZKhzIis5o=",
        "sign": "d53d44ea413c40d5f1d18e69047b7c"
    },
    "data": {
        "orderNum": 916974267198317218,
        "buyerOrder": "123321",
        "remark": "test remark bob ",
        "uploadedFileIds": [
            "950efc964a678536e1555729c11745eb",
            "22851ce436c38ca6e1555729c11745eb",
            "8ebf03c5ed8862f4e1555729c11745eb"
        ],
        "passengerList": [
            {
                "originPassengerInfo": {
                    "lastName": "YANGA",
                    "firstName": "TIFFANY",
                    "nationality": "CN",
                    "sex": "F",
                    "birthday": "1990-08-23",
                    "cardType": "P",
                    "cardNum": "E07700466",
                    "cardExpiredDate": "2024-03-17"
                },
                "changePassengerInfo": {
                    "lastName": "YANGA",
                    "firstName": "TIFFANY",
                    "nationality": "US",
                    "sex": "F",
                    "birthday": "1990-08-23",
                    "cardType": "P",
                    "cardNum": "E07700466",
                    "cardExpiredDate": "2024-03-17"
                }
            }
        ],
        "contact": {
            "telNum": "",
            "name": "",
            "email": ""
        }
    }
}
```

## Change Passenger Info Response 

```plain
{
  "errorCode": "0",
  "errorMsg": "ok",
  "data": {
    "parentOrderNum": "916974267198317218",
    "orderNum": "916974267198317240",
    "refOrderNum": "9169742671983172",
    "createTime": "2023-10-16T20:21:55+08:00",
    "orderStatus": "Under review",
    "pnr": "5BDWCY",
    "platingCarrier": "UO",
    "passengers": [
      {
        "lastName": "YANGA",
        "firstName": "TIFFANY",
        "cardType": "PP",
        "cardNum": "E07700466",
        "cardExpiredDate": "2024-03-17",
        "nationality": "US",
        "psgType": "ADT",
        "sex": "F",
        "birthday": "1990-08-23"
      }
    ]
  }
}
```

**The change may not be immediately effective and may take some time. You could invoke Order Detail API to retrieve the order status of this change order.**


---



