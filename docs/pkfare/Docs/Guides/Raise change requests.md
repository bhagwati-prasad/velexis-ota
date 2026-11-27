# Raise change requests

# **Overview**

**a. A passenger would like to raise a voluntary/involuntary change to his/her original flight joruney and you need to go through the following procedures:**

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338215/image-preview)
:::info
1.Raise a request in ChangeReshop API to check the bookable alternative flight solutions,the change price may or may not be displayed at this stage throguh API.

2.Invoke ChangeReprice API to check the the passenger selected solution price.

3.Raise a Change Request to create change order,When the reprice stage returns no price, the  system will create a change order for asynchronous repricing. When the reprice stage has returned a price, the system will create a change order with a status of 'To be paid'. 

4.Once asynchronous repricing is completed, PKFARE pushes the price information via the ChangeRepricePush API, or *Invoke OrderDetail API to get the order detail,include change price.

5.For an order that is in 'To be paid' status, invoke Ticketing API to issue ticket for the change order.

7.Once the change process is completed, the change processing result is pushed by PKFARE through the ChangeResultPush API.

:::

**b. A passenger would like to raise change of the passenger details/information against the original order and you need to go through the following procedures:**

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338216/image-preview)
:::info

1.Upload file ID using UploadAttachmentFile API and get UploadedFileIds.

2.Raise a request in ChangePassengerInfo API with file ids.

3.Once the change process is completed, the change processing result is pushed by PKFARE through the ChangeResultPush API. 
:::

**When there is a need of change request from your customers, you will need to raise ChangeReshop API to check the eligibility as well as other alternative and bookable flight solutions. The change price may or may not be displayed at this stage throguh API.**

## **ChangeReshop Request**

```plain

{
	"authentication": {
		"partnerId": "qiE0YKcJlXjknkCkZKhz11111=",
		"sign": "d53d44ea413c40d5f1d18e69777777"
	},
	"data": {
		"changeAirlegs": [
			{
				"airportOrCity": 1,
				"departureDate": "2023-10-07",
				"destination": "BKK",
				"journeySeq": 0,
				"origin": "HKG"
			},
			{
				"airportOrCity": 1,
				"departureDate": "2023-10-20",
				"destination": "HKG",
				"journeySeq": 1,
				"origin": "BKK"
			}
		],
		"changeReason": 0,
		"orderNum": 916958958684833601,
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
		"voluntaryType": 0
	}
}

```

## **ChangeReshop Response**

**If the change procedure could be automatically processed, a `solutions`element will be returned with the change amount:**

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
		],
		"solutions": [
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
					"CHD": [
					]
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
							"miniRules": [
							],
							"segmentIndex": [
								"1"
							]
						},
						{
							"miniRules": [
							],
							"segmentIndex": [
								"2"
							]
						}
					]
				},
				"platingCarrier": "OD",
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
					"CHD": [
					]
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
							"miniRules": [
							],
							"segmentIndex": [
								"1"
							]
						},
						{
							"miniRules": [
							],
							"segmentIndex": [
								"2"
							]
						}
					]
				},
				"platingCarrier": "OD",
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
					"CHD": [
					]
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
							"miniRules": [
							],
							"segmentIndex": [
								"1"
							]
						},
						{
							"miniRules": [
							],
							"segmentIndex": [
								"2"
							]
						}
					]
				},
				"platingCarrier": "OD",
				"solutionKey": "0c62b654ef24bbb8dd4c6295bf34198c",
				"totalChangeAmount": 0
			}
		]
	},
	"errorCode": "0",
	"errorMsg": "ok"
}

```

**If the change procedure could not be automatically processed and needs human intervention, the`solutions`section will not be returned with the change amount:**

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
		],
		"solutions": [
			{
				"journeys": {
					"journey_1": [
						"a26d645b1d2d5c71ba0749fa9fd96f01"
					]
				},
				"platingCarrier": "OD",
				"solutionKey": "de43c371998ad3b809401b78cb09f16d"
			},
			{
				"journeys": {
					"journey_1": [
						"6815cbebca0cf5ba590967ee438d573d"
					]
				},
				"platingCarrier": "OD",
				"solutionKey": "a211f7574da54aae7d0a6f0bbf5742c6"
			},
			{
				"journeys": {
					"journey_1": [
						"14c6b6bf0287e9705a04e7665e120f95"
					]
				},
				"platingCarrier": "OD",
				"solutionKey": "0c62b654ef24bbb8dd4c6295bf34198c"
			}
		]
	},
	"errorCode": "0",
	"errorMsg": "ok"
}


```

---

**Invoke ChangeReprice API to check the the passenger selected solution price.**

## **ChangeReprice Request**

```plain

{
	"authentication": {
		"partnerId": "qiE0YKcJlXjknkCkZKhzIi2222",
		"sign": "d53d44ea413c40d5f1d18e69777777"
	},
	"data": {
		"changeReason": 0,
		"journeys": {
			"journey_0": [
				{
					"airline": "FD",
					"arrival": "DMK",
					"arrivalDate": "2024-12-15",
					"arrivalTime": "16:40",
					"bookingCode": "Z",
					"departure": "HKG",
					"departureDate": "2024-12-15",
					"departureTime": "14:40",
					"flightNum": "501"
				}
			]
		},
		"orderNum": 916958958684833601,
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
		"voluntaryType": 0
	}
}

```

## **ChangeReprice Response**

**If the change procedure could be automatically processed, a `solutions`element will be returned with the change amount:**

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
			}
		],
		"solution": {
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
				"CHD": [
				]
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
						"miniRules": [
						],
						"segmentIndex": [
							"1"
						]
					},
					{
						"miniRules": [
						],
						"segmentIndex": [
							"2"
						]
					}
				]
			},
			"platingCarrier": "OD",
			"solutionKey": "de43c371998ad3b809401b78cb09f16d",
			"totalChangeAmount": 0
		}
	},
	"errorCode": "0",
	"errorMsg": "ok"
}

```

**If the change procedure could not be automatically processed and needs human intervention, the`solutions`section will not be returned with the change amount:**

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
			}
		],
		"solution": {
			"journeys": {
				"journey_1": [
					"a26d645b1d2d5c71ba0749fa9fd96f01"
				]
			},
			"platingCarrier": "OD",
			"solutionKey": "de43c371998ad3b809401b78cb09f16d"
		}
	},
	"errorCode": "0",
	"errorMsg": "ok"
}

```

---

**If passgner is willing to proceed, you could create a change order with PKFARE get new order information.**

## **Change Request**

```plain

{
	"authentication": {
		"partnerId": "qiE0YKcJlXjknkCkZKhzIll555",
		"sign": "d53d44ea413c40d5f1d18e69077777"
	},
	"data": {
		"buyerOrder": "buyerOrder1",
		"changeJourney": {
			"journey_0": [
				{
					"airline": "OD",
					"arrival": "KUL",
					"arrivalDate": "2023-09-29",
					"arrivalTime": "19:05",
					"bookingCode": "T",
					"cabinClass": "ECONOMY",
					"departure": "HKG",
					"departureDate": "2023-09-29",
					"departureTime": "15:15",
					"flightNum": "606"
				}
			]
		},
		"changeReason": 1,
		"contactInfo": {
			"email": "amy.zhang@pkfare.com",
			"name": "amy",
			"telCode": "+86",
			"telNum": "15691012314"
		},
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
		"solutionKey": "",
		"uploadedFileIds": [
			"975b70c89f0ed3e3e1555729c11745eb",
			"a98c63e1f9371ccce1555729c11745eb"
		],
		"voluntaryType": 1
	}
}

```

## **Change Request Response**

**When the reprice stage has returned a price, the system will create a change order with a status of 'To be paid'.  **

```plain

{
	"data": {
		"airPnr": "C3CV9F",
		"changeReason": 1,
		"createTime": "2023-10-08T15:54:04+08:00",
		"lastTktTime": "2023-10-08T16:24:04+08:00",
		"orderNum": "916958958684833602",
		"orderStatus": "To Be Paid",
		"parentOrderNum": "916958958684833601",
		"passengers": [
			{
				"birthday": "2003-09-28",
				"cardNum": "G54014364",
				"cardType": "P",
				"firstName": "YI",
				"lastName": "BAO",
				"nationality": "CN",
				"psgType": "ADT",
				"sex": "M"
			},
			{
				"birthday": "2017-09-28",
				"cardNum": "G19405622",
				"cardType": "P",
				"firstName": "SAN",
				"lastName": "BAO",
				"nationality": "CN",
				"psgType": "CHD",
				"sex": "M"
			}
		],
		"platingCarrier": "UO",
		"pnr": "C3CV9F",
		"refOrderNum": "9169589586848336",
		"solution": [
			{
				"adtAdditionalFare": 0,
				"adtAdditionalTax": 0,
				"adtChangeAmount": 0,
				"adtChangeFee": 0,
				"changeServiceFee": 0,
				"chdAdditionalFare": 0,
				"chdAdditionalTax": 0,
				"chdChangeAmount": 0,
				"chdChangeFee": 0,
				"currency": "USD",
				"fareType": "PRIVATE",
				"journeys": {
					"journey_0": [
						{
							"arrivalDate": "2024-03-04",
							"arrivalTime": "10:15",
							"departureDate": "2024-03-04",
							"departureTime": "06:50",
							"journeyTime": 145,
							"segments": [
								{
									"airline": "UO",
									"arrival": "BKK",
									"arrivalDate": "1697971800000",
									"bookingCode": "V",
									"cabinClass": "ECONOMY",
									"codeShare": "N",
									"departure": "HKG",
									"departureDate": "1697964900000",
									"equipment": "321",
									"flightNum": "702",
									"flightTime": "175",
									"segmentId": "fb421f8215cb7adc6b292b35dbca716b",
									"strArrivalDate": "2023-10-22",
									"strArrivalTime": "18:50",
									"strDepartureDate": "2023-10-22",
									"strDepartureTime": "16:55"
								}
							],
							"transferCount": 0
						}
					]
				},
				"merchantFee": 0,
				"solutionKey": "8ba97001b7230d47d7a3d2b037b8a95b",
				"totalChangeAmount": 0
			}
		],
		"voluntaryType": 1
	},
	"errorCode": "0",
	"errorMsg": "ok"
}

```

**When the reprice stage returns no price, the  system will create a change order for asynchronous repricing**

```plain

{
	"data": {
		"airPnr": "C3CV9F",
		"changeReason": 1,
		"createTime": "2023-10-08T15:54:04+08:00",
		"lastTktTime": "2023-10-08T16:24:04+08:00",
		"orderNum": "916958958684833602",
		"orderStatus": "Under Review",
		"parentOrderNum": "916958958684833601",
		"passengers": [
			{
				"birthday": "2003-09-28",
				"cardNum": "G54014364",
				"cardType": "P",
				"firstName": "YI",
				"lastName": "BAO",
				"nationality": "CN",
				"psgType": "ADT",
				"sex": "M"
			},
			{
				"birthday": "2017-09-28",
				"cardNum": "G19405622",
				"cardType": "P",
				"firstName": "SAN",
				"lastName": "BAO",
				"nationality": "CN",
				"psgType": "CHD",
				"sex": "M"
			}
		],
		"platingCarrier": "UO",
		"pnr": "C3CV9F",
		"refOrderNum": "9169589586848336",
		"solution": [
			{
				"journeys": {
					"journey_0": [
						{
							"arrivalDate": "2024-03-04",
							"arrivalTime": "10:15",
							"departureDate": "2024-03-04",
							"departureTime": "06:50",
							"journeyTime": 145,
							"segments": [
								{
									"airline": "UO",
									"arrival": "BKK",
									"arrivalDate": "1697971800000",
									"bookingCode": "V",
									"cabinClass": "ECONOMY",
									"codeShare": "N",
									"departure": "HKG",
									"departureDate": "1697964900000",
									"equipment": "321",
									"flightNum": "702",
									"flightTime": "175",
									"segmentId": "fb421f8215cb7adc6b292b35dbca716b",
									"strArrivalDate": "2023-10-22",
									"strArrivalTime": "18:50",
									"strDepartureDate": "2023-10-22",
									"strDepartureTime": "16:55"
								}
							],
							"transferCount": 0
						}
					]
				},
				"solutionKey": "8ba97001b7230d47d7a3d2b037b8a95b"
			}
		],
		"voluntaryType": 1
	},
	"errorCode": "0",
	"errorMsg": "ok"
}

```

---

## **Check Order status and change amount**

**If the change amount did not be returned and specified when invoking changeReshop and changeReprice API, you can invoke Orderdetail API to loop check the order status as well as the change amount until you get information about change price and reach the relevant state regarding order status, which is,****"changed, to be paid"****.**

## **OrderDetail Request**

```plain
{
	"authentication": {
		"partnerId": "12343",
		"sign": "1234"
	},
	"data": {
		"includeFields": "ticket",
		"orderNum": "800000000000000102"
	}
}

```

## **OrderDetail Response**

```plain

{
	"data": {
		"airPnr": "BBBBBB",
		"createdTime": "2023-11-27 08:45:48",
		"journeys": [
			{
				"arrivalDate": "2024-12-17",
				"arrivalTime": "19:25",
				"departureDate": "2024-12-17",
				"departureTime": "12:05",
				"journeyTime": 320,
				"segments": [
					{
						"airline": "VJ",
						"arrival": "SGN",
						"arrivalDate": "2024-12-17",
						"arrivalTerminal": "1",
						"arrivalTime": "19:25",
						"bookingCode": "Z",
						"cabinClass": "ECONOMY",
						"codeShare": "N",
						"departure": "ICN",
						"departureDate": "2024-12-17",
						"departureTerminal": "2",
						"departureTime": "12:05",
						"flightNum": "863",
						"flightTime": 320
					}
				],
				"transferCount": 0
			}
		],
		"lastTktTime": "2023-11-27 09:45:48",
		"orderNum": "800000000000000102",
		"orderStatus": "CHGD, TO_BE_PAID",
		"orderType": "C",
		"parentOrderNum": "800000000000000101",
		"passengers": [
			{
				"birthday": "1990-08-09",
				"cardExpiredDate": "2038-12-10",
				"cardNum": "NT11537654",
				"cardType": "P",
				"firstName": "CHAENGDEE",
				"lastName": "NICHAPHAT",
				"nationality": "CN",
				"psgType": "ADT",
				"sex": "M",
				"ticketNum": "QHKBGS"
			},
			{
				"birthday": "2020-08-09",
				"cardExpiredDate": "2038-12-10",
				"cardNum": "NT11531234",
				"cardType": "P",
				"firstName": "MADEE",
				"lastName": "KANAWAT",
				"nationality": "CN",
				"psgType": "CHD",
				"sex": "M",
				"ticketNum": "QHKBGS"
			}
		],
		"permitVoid": 0,
		"platingCarrier": "VJ",
		"pnr": "QHKBGS",
		"pnrList": [
			{
				"airPnr": "QHKBGS",
				"arrival": "SGN",
				"bookingCode": "Z",
				"cabinClass": "ECONOMY",
				"departure": "ICN",
				"flightNum": "863",
				"pnr": "QHKBGS",
				"segmentNo": 1,
				"ticketNums": [
					{
						"passengerIndex": 1,
						"ticketNum": "QHKBGS"
					},
					{
						"passengerIndex": 2,
						"ticketNum": "QHKBGS"
					}
				]
			}
		],
		"refOrderNum": "8000000000000001",
		"solutions": [
			{
				"adtChgAddFee": 0,
				"adtChgFee": 0,
				"chdChgAddFee": 0,
				"chdChgFee": 0,
				"chgBuyerAmount": 0,
				"chgMerFee": 0,
				"chgServFee": 0,
				"currency": "USD"
			}
		]
	},
	"errorCode": "0",
	"errorMsg": "ok"
}

```

---

## **Ticketing**

**Once you successfully pass the OrderPricing check, you are then free to invoke Ticketing API to have tickets issued for the change order.**

## **Ticketing Request**

```plain

{
	"authentication": {
		"partnerId": "4563",
		"sign": "12343"
	},
	"ticketing": {
		"email": "jango.wang@gongfutrip.com",
		"name": "Jango/Wang",
		"orderNum": "800000000000000002",
		"PNR": "HYN1B7",
		"telNum": "13249073855"
	}
}

```

## **Ticketing Response**

```plain

{
	"data": {
		"orderAmount": 0.0,
		"orderNum": "800000000000000002",
		"payAmount": 0.0,
		"transactionExpense": 0
	},
	"errorCode": "0",
	"errorMsg": "ok"
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
		"partnerId": "12343",
		"sign": "1234"
	},
	"data": {
		"includeFields": "ticket",
		"orderNum": "800000000000000102"
	}
}

```

## **OrderDetail Response**

```plain
{
	"data": {
		"airPnr": "QHKBGS",
		"createdTime": "2023-11-27 08:45:48",
		"journeys": [
			{
				"arrivalDate": "2024-12-17",
				"arrivalTime": "19:25",
				"departureDate": "2024-12-17",
				"departureTime": "12:05",
				"journeyTime": 320,
				"segments": [
					{
						"airline": "VJ",
						"arrival": "SGN",
						"arrivalDate": "2024-12-17",
						"arrivalTerminal": "1",
						"arrivalTime": "19:25",
						"bookingCode": "Z",
						"cabinClass": "ECONOMY",
						"codeShare": "N",
						"departure": "ICN",
						"departureDate": "2024-12-17",
						"departureTerminal": "2",
						"departureTime": "12:05",
						"flightNum": "863",
						"flightTime": 320
					}
				],
				"transferCount": 0
			}
		],
		"lastTktTime": "2023-11-27 09:45:48",
		"orderNum": "800000000000000102",
		"orderStatus": "CHGD",
		"orderType": "C",
		"parentOrderNum": "800000000000000101",
		"passengers": [
			{
				"birthday": "1990-08-09",
				"cardExpiredDate": "2038-12-10",
				"cardNum": "NT11537654",
				"cardType": "P",
				"firstName": "CHAENGDEE",
				"lastName": "NICHAPHAT",
				"nationality": "CN",
				"psgType": "ADT",
				"sex": "M",
				"ticketNum": "QHKBGS"
			},
			{
				"birthday": "2020-08-09",
				"cardExpiredDate": "2038-12-10",
				"cardNum": "NT11531234",
				"cardType": "P",
				"firstName": "MADEE",
				"lastName": "KANAWAT",
				"nationality": "CN",
				"psgType": "CHD",
				"sex": "M",
				"ticketNum": "QHKBGS"
			}
		],
		"permitVoid": 0,
		"platingCarrier": "VJ",
		"pnr": "QHKBGS",
		"pnrList": [
			{
				"airPnr": "QHKBGS",
				"arrival": "SGN",
				"bookingCode": "Z",
				"cabinClass": "ECONOMY",
				"departure": "ICN",
				"flightNum": "863",
				"pnr": "QHKBGS",
				"segmentNo": 1,
				"ticketNums": [
					{
						"passengerIndex": 1,
						"ticketNum": "QHKBGS"
					},
					{
						"passengerIndex": 2,
						"ticketNum": "QHKBGS"
					}
				]
			}
		],
		"refOrderNum": "8000000000000001",
		"solutions": [
			{
				"adtChgAddFee": 0,
				"adtChgFee": 0,
				"chdChgAddFee": 0,
				"chdChgFee": 0,
				"chgBuyerAmount": 0,
				"chgMerFee": 0,
				"chgServFee": 0,
				"currency": "USD"
			}
		]
	},
	"errorCode": "0",
	"errorMsg": "ok"
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
			"birthday": "1995-06-15",
			"cardExpiredDate": "2024-05-01",
			"cardNum": "E29384798",
			"cardType": "PP",
			"firstName": "Xiaoqing",
			"lastName": "Ding",
			"nationality": "CN",
			"passengerIndex": 1,
			"psgType": "ADT",
			"sex": "F",
			"ticketNum": "1T9LO2"
		},
		{
			"birthday": "1993-04-01",
			"cardExpiredDate": "2024-07-01",
			"cardNum": "E05849326",
			"cardType": "PP",
			"firstName": "Zhigang",
			"lastName": "Zhao",
			"nationality": "CN",
			"passengerIndex": 2,
			"psgType": "ADT",
			"sex": "M",
			"ticketNum": "2T9LO2"
		},
		{
			"associatedPassengerIndex": 1,
			"birthday": "2022-06-17",
			"cardExpiredDate": "2042-10-01",
			"cardNum": "E09819649",
			"cardType": "PP",
			"firstName": "Weiwei",
			"lastName": "Zhao",
			"nationality": "CN",
			"passengerIndex": 3,
			"psgType": "INF",
			"sex": "M",
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

## **Get Ticket Asynchronous Repricing Result**

**The issuance asynchronous reprice process may take some time and there are also two ways to check the asynchronous reprice results like which in normal reprice process:**

1. **Invoke looping call of`orderDetail`API to pull out the order detail until it reaches the final state -`"To Be Paid"`**
2. **Provide a webhook endpoint and to which PKFARE can push the result via`ChangeRepricePush`API.**
## **OrderDetail Request**

```plain

{
	"authentication": {
		"partnerId": "12343",
		"sign": "1234"
	},
	"data": {
		"includeFields": "ticket",
		"orderNum": "800000000000000102"
	}
}

```

## **OrderDetail Response**

```plain
{
	"data": {
		"airPnr": "QHKBGS",
		"createdTime": "2023-11-27 08:45:48",
		"journeys": [
			{
				"arrivalDate": "2024-12-17",
				"arrivalTime": "19:25",
				"departureDate": "2024-12-17",
				"departureTime": "12:05",
				"journeyTime": 320,
				"segments": [
					{
						"airline": "VJ",
						"arrival": "SGN",
						"arrivalDate": "2024-12-17",
						"arrivalTerminal": "1",
						"arrivalTime": "19:25",
						"bookingCode": "Z",
						"cabinClass": "ECONOMY",
						"codeShare": "N",
						"departure": "ICN",
						"departureDate": "2024-12-17",
						"departureTerminal": "2",
						"departureTime": "12:05",
						"flightNum": "863",
						"flightTime": 320
					}
				],
				"transferCount": 0
			}
		],
		"lastTktTime": "2023-11-27 09:45:48",
		"orderNum": "800000000000000102",
		"orderStatus": "CHGD",
		"orderType": "C",
		"parentOrderNum": "800000000000000101",
		"passengers": [
			{
				"birthday": "1990-08-09",
				"cardExpiredDate": "2038-12-10",
				"cardNum": "NT11537654",
				"cardType": "P",
				"firstName": "CHAENGDEE",
				"lastName": "NICHAPHAT",
				"nationality": "CN",
				"psgType": "ADT",
				"sex": "M",
				"ticketNum": "QHKBGS"
			},
			{
				"birthday": "2020-08-09",
				"cardExpiredDate": "2038-12-10",
				"cardNum": "NT11531234",
				"cardType": "P",
				"firstName": "MADEE",
				"lastName": "KANAWAT",
				"nationality": "CN",
				"psgType": "CHD",
				"sex": "M",
				"ticketNum": "QHKBGS"
			}
		],
		"permitVoid": 0,
		"platingCarrier": "VJ",
		"pnr": "QHKBGS",
		"pnrList": [
			{
				"airPnr": "QHKBGS",
				"arrival": "SGN",
				"bookingCode": "Z",
				"cabinClass": "ECONOMY",
				"departure": "ICN",
				"flightNum": "863",
				"pnr": "QHKBGS",
				"segmentNo": 1,
				"ticketNums": [
					{
						"passengerIndex": 1,
						"ticketNum": "QHKBGS"
					},
					{
						"passengerIndex": 2,
						"ticketNum": "QHKBGS"
					}
				]
			}
		],
		"refOrderNum": "8000000000000001",
		"solutions": [
			{
				"adtChgAddFee": 0,
				"adtChgFee": 0,
				"chdChgAddFee": 0,
				"chdChgFee": 0,
				"chgBuyerAmount": 0,
				"chgMerFee": 0,
				"chgServFee": 0,
				"currency": "USD"
			}
		]
	},
	"errorCode": "0",
	"errorMsg": "ok"
}

```

## **ChangeRepricePush Request**

```plain

{
	"orderNum": "916716911545376001",
	"priceStatus": "PRICED",
	"remark": "",
	"solution": {
		"adtAdditionalFare": 291,
		"adtAdditionalTax": 0,
		"adtChangeAmount": 0,
		"adtChangeFee": 0,
		"changeServiceFee": 1574,
		"chdAdditionalFare": 0,
		"chdAdditionalTax": 0,
		"chdChangeAmount": 0,
		"chdChangeFee": 0,
		"currency": "CNY",
		"infAdditionalFare": 0,
		"infAdditionalTax": 0,
		"infChangeAmount": 0,
		"infChangeFee": 0,
		"merchantFee": 0,
		"totalChangeAmount": 1865
	}
}

```

## **ChangeRepricePush Response**

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
	"data": {
		"fileId": "1ee71d50b4d59ef3e1555729c11745eb",
		"fileName": "Pkfarer.jpg"
	},
	"errorCode": "0",
	"errorMsg": "ok"
}

```

---

**Once you got the fileID, then you can proceed with passenger information change request**

## Change Passenger Info Request

```plain

{
	"authentication": {
		"partnerId": "1234=",
		"sign": "12563"
	},
	"data": {
		"buyerOrder": "123321",
		"contact": {
			"email": "",
			"name": "",
			"telNum": ""
		},
		"orderNum": 916974267198317218,
		"passengerList": [
			{
				"changePassengerInfo": {
					"birthday": "1990-08-23",
					"cardExpiredDate": "2024-03-17",
					"cardNum": "E07700466",
					"cardType": "P",
					"firstName": "TIFFANY",
					"lastName": "YANGA",
					"nationality": "US",
					"sex": "F"
				},
				"originPassengerInfo": {
					"birthday": "1990-08-23",
					"cardExpiredDate": "2024-03-17",
					"cardNum": "E07700466",
					"cardType": "P",
					"firstName": "TIFFANY",
					"lastName": "YANGA",
					"nationality": "CN",
					"sex": "F"
				}
			}
		],
		"remark": "test remark bob ",
		"uploadedFileIds": [
			"950efc964a678536e1555729c11745eb",
			"22851ce436c38ca6e1555729c11745eb",
			"8ebf03c5ed8862f4e1555729c11745eb"
		]
	}
}

```

## Change Passenger Info Response

```plain

{
	"data": {
		"createTime": "2023-10-16T20:21:55+08:00",
		"orderNum": "916974267198317240",
		"orderStatus": "Under review",
		"parentOrderNum": "916974267198317218",
		"passengers": [
			{
				"birthday": "1990-08-23",
				"cardExpiredDate": "2024-03-17",
				"cardNum": "E07700466",
				"cardType": "PP",
				"firstName": "TIFFANY",
				"lastName": "YANGA",
				"nationality": "US",
				"psgType": "ADT",
				"sex": "F"
			}
		],
		"platingCarrier": "UO",
		"pnr": "5BDWCY",
		"refOrderNum": "9169742671983172"
	},
	"errorCode": "0",
	"errorMsg": "ok"
}

```

**The change may not be immediately effective and may take some time. You could invoke Order Detail API to retrieve the order status of this change order.**

---

