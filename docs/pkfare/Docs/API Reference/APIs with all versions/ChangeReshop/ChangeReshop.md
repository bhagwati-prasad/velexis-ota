# ChangeReshop

### 1 Document Description

### 1.1 Function


This API is used for a change reshop. User can indicate order number, origin, destination, and departure date to check flight availability by using relevant parameters. Order number is refer to PKFARE order number, the change is able to raise base on issued order or change order.
 
`Note`: This API provides Postman examples, which you can obtain by contacting your account manager.
### 1.2 Target Reader

The Change Reshop interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Nodes.js, and a basic knowledge of HTTP network protocols.
 
### 1.3 Character Encoding

The character code of this API is `UTF-8`.
 
### 1.4 URLs

|Environment |URL |
| ------ | ------ |
|Test environment |[https://api.pkfare.com](http://api.pkfare.com)/change/reshop |
|Prod environment |https://{{apiHost}}/change/reshop |

 
`Notes` The production environment call address is provided after you finish the API development and testing, and before the official launch. You can replace the {{apiHost}} in the production environment call address with the provided domain name.
 
### 1.5 Http Method

POST
### 1.6 Request Header

|key |value |
| ------ | ------ |
|Content-Type |application/x-www-form-urlencoded |

### 1.7 Response Header


|key |value |
| ------ | ------ |
|Content-type |application/json |

 
### 2.Request

### 2.1 Schema


|name |description |type |
| ------ | ------ |
|param |The value after Base64 encoding the Basic Request. The Basic Request is a JSON-structured data, and the details explanation is provided in the following text. |Text |

 
### 2.1.1 Basic Request

sample

```
 {
	"authentication": {
		"sign": "d53d44ea413c40d5fb7c",
		"partnerId": "qiE0YKcJlXj5o="
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
 
 


| Name         | Type      | Required or Not  | Parameter Description              | Sample    |
| ------ | ------ |------ |------ |------ |
|authentication |Object |Yes |Identity information, refer to 2.1.2 |- |
|data |Object |Yes |File information, refer to 2.1.3 |- |

 
 
### 2.1.2 Authentication


| Name         | Type      | Required or Not  | Parameter Description              | Sample    |
| ------ | ------ |------ |------ |------ |
|partnerId |String |Yes |Partner ID |qiE0YKcJlXjknkCkZKhzIis5o= |
|sign |String |Yes |Signature, sign=MD5(partnerId+partnerKey), refer to 4.1 and 4.2 for the signature method. |d53d44ea413c40d5f1d18e69047b7c |

 
### 2.1.2 Data


| Name          | Type      | Required or Not  | Parameter Description          | Sample   |
| ------ | ------ |------ |------ |------ |
|orderNum |String |Yes |Order Number |915687075841601001 |
|voluntaryType |Integer |Yes |Voluntary type: 0 - Voluntary, 1 - Involuntary |0 |
|changeReason |Integer |Yes |Change reason: 0 - Voluntary, 1 - Flight reschedule / cancellation, 2 - Reissue due to medical reasons, 3 - Reissue due to visa refusal, 4 - Others |0 |
|segmentList |Array |No |Booked flights which you want to change,refer to 2.1.3 |- |
|passengerList |Array |Yes |Passengers who you want to change,refer to 2.1.4 |- |
|changeAirLegs |Array |Yes |New journey after change,  refer to 2.1.5 |- |

### 2.1.3 segmentList


| Name          | Type      | Required or Not  | Parameter Description          | Sample    |
| ------ | ------ |------ |------ |------ |
|segmentNo |String |Yes |Segment number |1 |
|flightNum |String |Yes |Flight number, carrier code and flight number |TG618 |
|departure |String |Yes |Departure airport code, 3 letters airport code |HKG |
|pnr |String |No |PNR | |
|airPnr |String |No |Airline PNR | |
|arrival |String |Yes |Arrival airport code, 3 letters airport code |BKK |

 
### 2.1.4 passengerList


| Name          | Type      | Required or Not  | Parameter Description          | Sample    |
| ------ | ------ |------ |------ |------ |
|lastName |String |Yes |Last name |Wang |
|firstName |String |Yes |First name |Jango |
|nationality |String |Yes |Nationality |CN |
|sex |String |Yes |Gender |M |
|birthday |String |Yes |Date of birth |2015-01-10 |
|cardType |String |No |Travel document type, which used for creating the booking. |P |
|cardNum |String |No |Travel document number, which used for creating the booking. |G2568574 |

 
 
### 2.1.5 searchAirLegs



| Name          | Type      | Required or Not  | Parameter Description          | Sample    |
| ------ | ------ |------ |------ |------ |
|journeySeq |Integer |Yes |Journey sequences, 0 for outbound journey, 1 for inbound journey |0 |
|cabinClass |String |No |Cabin class |ENCONOMY |
|airportOrCity |Integer |Yes |Indicated the destination or origin is by airport or by city: 0-City, 1-Airport |0 |
|destination |String |Yes |Destination - 3 letters IATA city or airport code |BKK |
|origin |String |Yes |Origin - 3 letters IATA city or airport code |HKG |
|departureDate |String |Yes |Departure date | |

 
### 2.2 Sample of Request Construction Process

### 2.2.1 Request Sample

 

```
{
	"authentication": {
		"sign": "d53d44ee69047b7c",
		"partnerId": "qiE0YKcJlXjknk="
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
				"cardType": "PP",
				"firstName": "yi",
				"lastName": "bao",
				"nationality": "CN",
				"sex": "M"
			},
			{
				"birthday": "2017-09-28",
				"cardNum": "",
				"cardType": "PP",
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
 
 
### 2.2.2 Base64 Encryption

Use BASE64 to encode results from 2.2.1:
 `ewoJImF1dGhlbnRpY2F0aW9uIjogewoJCSJzaWduIjogImZlZDUzZDQ0ZWE0MTNjNDBkNWYxZDE4ZTY5MDQ3YjdjIiwKCQkicGFydG5lcklkIjogIkhKcWlFMFlLY0psWGprbmtDa1pLaHpJaXM1bz0iCgl9LAoJImRhdGEiOiB7CgkJIm9yZGVyTnVtIjogOTE2OTU4OTU4Njg0ODMzNjAxLAoJCSJ2b2x1bnRhcnlUeXBlIjogMCwKCQkiY2hhbmdlUmVhc29uIjogMCwKCQkic2VnbWVudExpc3QiOiBbXSwKCQkicGFzc2VuZ2VyTGlzdCI6IFsKCQkJewoJCQkJImJpcnRoZGF5IjogIjIwMDMtMDktMjgiLAoJCQkJImNhcmROdW0iOiAiIiwKCQkJCSJjYXJkVHlwZSI6ICJQUCIsCgkJCQkiZmlyc3ROYW1lIjogInlpIiwKCQkJCSJsYXN0TmFtZSI6ICJiYW8iLAoJCQkJIm5hdGlvbmFsaXR5IjogIkNOIiwKCQkJCSJzZXgiOiAiTSIKCQkJfSwKCQkJewoJCQkJImJpcnRoZGF5IjogIjIwMTctMDktMjgiLAoJCQkJImNhcmROdW0iOiAiIiwKCQkJCSJjYXJkVHlwZSI6ICJQUCIsCgkJCQkiZmlyc3ROYW1lIjogInNhbiIsCgkJCQkibGFzdE5hbWUiOiAiYmFvIiwKCQkJCSJuYXRpb25hbGl0eSI6ICJDTiIsCgkJCQkic2V4IjogIk0iCgkJCX0KCQldLAoJCSJjaGFuZ2VBaXJsZWdzIjogWwoJCQl7CgkJCQkiam91cm5leVNlcSI6IDAsCgkJCQkiYWlycG9ydE9yQ2l0eSI6IDEsCgkJCQkiZGVzdGluYXRpb24iOiAiQktLIiwKCQkJCSJvcmlnaW4iOiAiSEtHIiwKCQkJCSJkZXBhcnR1cmVEYXRlIjogIjIwMjMtMTAtMDciCgkJCX0sCgkJCXsKCQkJCSJqb3VybmV5U2VxIjogMSwKCQkJCSJhaXJwb3J0T3JDaXR5IjogMSwKCQkJCSJkZXN0aW5hdGlvbiI6ICJIS0ciLAoJCQkJIm9yaWdpbiI6ICJCS0siLAoJCQkJImRlcGFydHVyZURhdGUiOiAiMjAyMy0xMC0yMCIKCQkJfQoJCV0KCX0KfQ==` 
 
 ### 2.2.3 Post Request

This sample is for reference only:

```
POST http://api.pkfare.com/change/reshop
Content-type: application/x-www-form-urlencoded


param=ewoJImF1dGhlbnRpY2F0aW9uIjogewoJCSJzaWduIjogImZlZDUzZDQ0ZWE0MTNjNDBkNWYxZDE4ZTY5MDQ3YjdjIiwKCQkicGFydG5lcklkIjogIkhKcWlFMFlLY0psWGprbmtDa1pLaHpJaXM1bz0iCgl9LAoJImRhdGEiOiB7CgkJIm9yZGVyTnVtIjogOTE2OTU4OTU4Njg0ODMzNjAxLAoJCSJ2b2x1bnRhcnlUeXBlIjogMCwKCQkiY2hhbmdlUmVhc29uIjogMCwKCQkic2VnbWVudExpc3QiOiBbXSwKCQkicGFzc2VuZ2VyTGlzdCI6IFsKCQkJewoJCQkJImJpcnRoZGF5IjogIjIwMDMtMDktMjgiLAoJCQkJImNhcmROdW0iOiAiIiwKCQkJCSJjYXJkVHlwZSI6ICJQUCIsCgkJCQkiZmlyc3ROYW1lIjogInlpIiwKCQkJCSJsYXN0TmFtZSI6ICJiYW8iLAoJCQkJIm5hdGlvbmFsaXR5IjogIkNOIiwKCQkJCSJzZXgiOiAiTSIKCQkJfSwKCQkJewoJCQkJImJpcnRoZGF5IjogIjIwMTctMDktMjgiLAoJCQkJImNhcmROdW0iOiAiIiwKCQkJCSJjYXJkVHlwZSI6ICJQUCIsCgkJCQkiZmlyc3ROYW1lIjogInNhbiIsCgkJCQkibGFzdE5hbWUiOiAiYmFvIiwKCQkJCSJuYXRpb25hbGl0eSI6ICJDTiIsCgkJCQkic2V4IjogIk0iCgkJCX0KCQldLAoJCSJjaGFuZ2VBaXJsZWdzIjogWwoJCQl7CgkJCQkiam91cm5leVNlcSI6IDAsCgkJCQkiYWlycG9ydE9yQ2l0eSI6IDEsCgkJCQkiZGVzdGluYXRpb24iOiAiQktLIiwKCQkJCSJvcmlnaW4iOiAiSEtHIiwKCQkJCSJkZXBhcnR1cmVEYXRlIjogIjIwMjMtMTAtMDciCgkJCX0sCgkJCXsKCQkJCSJqb3VybmV5U2VxIjogMSwKCQkJCSJhaXJwb3J0T3JDaXR5IjogMSwKCQkJCSJkZXN0aW5hdGlvbiI6ICJIS0ciLAoJCQkJIm9yaWdpbiI6ICJCS0siLAoJCQkJImRlcGFydHVyZURhdGUiOiAiMjAyMy0xMC0yMCIKCQkJfQoJCV0KCX0KfQ==
```


### 3. Response

### 3.1 Response Sample

2 types of response will be returned. If the change is able to be automated, a passengerPriceList element would be returned with the change amount as following: 

```
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
If the change is not able to be automated, we will return the changeable flight information without change amount as following:

```
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
 
### 3.2 Response Parameter



| Name         | Type      | Parameter Description                                 | Sample    |
| ------ | ------ |------ |------ |
|errorCode |String |Error code, refer to error code list 5.1 |0 |
|errorMsg |String |Error message |OK |
|warningMsg |String |Warning message | |
|data |Object |The return data, this parameter is not empty only when the errorCode retruns "0", refer to section 3.2.1 |- |

### 3.2.1 Data



| Name        | Type        | Parameter Description | Sample          |
| ------ | ------ |------ |------ |
|journeys |Array |Itinerary information, outbound use journey_0, inbound use journey_1 |- |
|passengerPriceList |Array |Passenger pricing information |- |
|flights |Array |Journey information |- |
|segments |Array |Flight information |- |
|passengers |Array |Passenger information |- |

### 3.2.2 Journeys



| Name        | Type        | Parameter Description | Sample           |
| ------ | ------ |------ |------ |
|journey |Array |Flight ID of this itinerary |- |

 
### 3.2.3 PassengerPriceList



| Name        | Type        | Parameter Description | Sample           |
| ------ | ------ |------ |------ |
|solutionId |String |Unique identification of this solution |- |
|solutionKey |String |Unique identification of this solution | |
|fareType |String |Fare type, PUBLIC or PRIVATE |PUBLIC |
|currency |String |Currency code |CNY |
|changeServiceFee |BigDecimal |Change service fee per passenger |50.00 |
|adtAdditionalFare |BigDecimal |Additional fare per adult | |
|adtAdditionalTax |BigDecimal |Additional tax per adult | |
|adtChangeFee |BigDecimal |Adult change fee which is charged per penalty or goverment in some special area | |
|adtChangeAmount |BigDecimal |Total change amount per adult | |
|chdAdditionalFare |BigDecimal |Additional fare per child | |
|chdAdditionalTax |BigDecimal |Additional tax per child | |
|chdChangeFee |BigDecimal |Child change fee which is charged per penalty or goverment in some special area | |
|chdChangeAmount |BigDecimal |Total change amount per child | |
|infAdditionalFare |BigDecimal |Additional fare per infant | |
|infAdditionalTax |BigDecimal |Additional tax per infant | |
|infChangeFee |BigDecimal |Infant change fee which is charged per penalty or goverment in some special area | |
|infChangeAmount |BigDecimal |Total change amount per infant | |
|totalChangeAmount |BigDecimal |Total change amount of this change request | |
|merchantFee |BigDecimal |Payment transaction fee | |
|journeys |Array |Changable journey infomration of the price | |
|baggageMap |Object |Baggage allowance for reference only. Including 'ADT' and 'CHD'. If the request does not include children, 'CHD' would be NULL. | |
|miniRuleMap |Object |Penalty rule for reference only. | |
|platingCarrier |String |Ticketing airline | |
|lastTktTime |String |Latest ticketing time | |

 
### 3.2.4 Flights



| Name        | Type        | Parameter Description | Sample           |
| ------ | ------ |
|flightId |String |Journey ID，unique identification |5681852857622213a101ebe5ec4b38cd |
|journeyTime |String |Journey time, unit: minute |315 |
|segmentIds |String[] |Segment ID，this is related to Segments[]，refer to 3.2.5 |88af51ed8e8bd63127e06b2c7f800398 |
|transferCount |String |Transfer count |0 |

 
### 3.2.5 Segments



| Name                  | Type          | Parameter Description                                      | Sample                              |
| ------ | ------ |------ |------ |
|segmentId |String |Segment ID, unique identification |88af51ed8e8bd63127e06b2c7f800398 |
|airline |String |Airline code [IATA airline code] |CA |
|flightNum |String |Flight Number |6509 |
|equipment |String |Equipment |737 |
|cabinClass |String |Cabin class, refer to 5.2 |ECONOMY |
|bookingCode |String |Booking code. It will be return along with a change price. If the price is not able to be returned, please refer to classCodes |E |
|availabilityCount |String |Availability count of booking code. It will be return along with a change price. If the price is not able to be returned, please refer to classCodes |9 |
|departure |String |Departure airport code |PEK |
|arrival |String |Arrival airport code |HKG |
|departureTerminal |String |Departure terminal |1 |
|arrivalTerminal |String |Arrival terminal |2 |
|departureDate |Long |Departure date [unix time] |1570633500000 |
|strDepartureDate |String |Departure date [yyyy-mm-dd], local time of departure city |2019-09-30 |
|arrivalDate |String |Arrival date [unix time] |1570661400000 |
|strArrivalDate |String |Arrival date [yyyy-mm-dd], local time of arrival city |2019-09-30 |
|strDepartureTime |String |Departure time [hh:mm], local time of departure city |11:00 |
|strArrivalTime |String |Arrival time [hh:mm], local time of arrival city |14:00 |
|flightTime |Integer |Flight time, unit: minute |250 |
|stayTime |Integer |Stay time, valid with 'stopover', unit: minute |100 |
|codeShare |String |Code share flight or not [Y - Yes, N - No] |Y |
|opFltNo |String |Flight number of operated carrier. It will not return if the flight is not a code share flight |202 |
|opFltAirline |String |Operated carrier. It will not return if the flight is not a code share flight |KA |
|stopover |String |Stopover airport [IATA airport code]. It will not return if there is no stopover |BKK |
|fareBasis |String |Fare basis of the price. It will be return along with a change price. If the price is not able to be returned, it will not return | |
|classCodes |Object |Class code of this flight. It will be return when the price is not able to be returned. | |

 
### 3.2.6 Passengers



| Name             | Type        | Parameter Description                                      | Sample                           |
| ------ | ------ |------ |------ |
|lastName |String |Last name |WANG |
|firstName |String |First name |JANGO |
|cardType |String |Travel document type |P |
|cardNum |String |Travel document number |P1234567 |
|cardExpiredDate |String |Travel document expired date |2030-10-10 |
|nationality |String |Nationality |CN |
|psgType |String |Passenger type |ADT |
|sex |String |Gender |M |
|birthday |String |Date of birth |2015-01-10 |

### 3.2.7 BaggageMap



| Name             |Type        | Parameter Description                                      | Sample                              |
| ------ | ------ |------ |------ |
|segmentIndexList |String[] |Segment index list for baggage. Index begins with "1". If 1st segment has same baggage allowance with 3rd segment, please refer to sample |[1,3] |
|baggageAmount |String |Free baggage amount allowance. '1PC' for 1 piece |1PC |
|baggageWeight |String |Free baggage weight allownance |30KG |
|carryOnAmount |String |Free carry-on baggage amount allownance. '1PC' for 1 piece | |
|carryOnWeight |String |Free carry-on baggage weight allownance | |

### 3.2.8 MiniRuleMap



| Name            |Type       |Parameter Description                                      | Sample                                |
| ------ | ------ |------ |------ |
|segmentIndex |String[] |Segment index list for mini-rule. Index begins with "1". If 1st segment has same rules allowance with 3rd segment, please refer to sample |[1,3] |
|miniRules |Array |Mini-rules information |- |

 
### 3.2.9 MiniRules


| Name             | Type        | Parameter Description                                      | Sample                               |
| ------ | ------ |------ |------ |
|penaltyType |Integer |Penalty type: 0-refund, 1-noShow refund, 2-change, 3-noShow change | |
|isPermited |Integer |Allow refund/change or not; 0-not allow, 1-allow, 2-unknown | |
|when |Integer |Appropriate situationL 0-Both Outbound and inbound are not used, 1-Outbound flight used, 2-All situation | |
|noShowTime |String |NoShow definition. Apply with 'noShowTimeUnit' | |
|noShowTimeUnit |String |NoShow unit. Apply with 'noShowTime': H-hour, M-minute | |
|amount |BigDecimal |Penalty amount | |
|currencyCode |String |Penalty currency code | |
|percentage |BigDecimal |Penalty percentage. Apply with 'baseType'. Penalty and penalty percentage would not go into effect at the same. Please take the strict one. Unit:% | |
|baseType |Integer |Apply with 'percent'. Multiply corresponding value of 'baseType' by 'percent' would be penalty. 0-fare, 1-fare+taxes+ticketing fee, 2-cabin basic fare | |

 
### 3.2.10 classCodes


| Name             | Type        | Parameter Description                                     | Sample                              |
| ------ | ------ |------ |------ |
|classCode |String[] |Available booking code of the flight |F,C,Y |

 
### 4 Signature

### 4.1 Parameters

partnerId，partnerKey
 
### 4.2 Sign

Combine partnerId and partnerKey to make an MD5 encryption on final value.
Sign = MD5(partnerId+partnerKey)。

```
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
 
 
### 5 Appendix

 
### 5.1 Error Code List



| errorCode  | errorMsg                         | Description                         |
| ------ | ------ |------ |
|0 |ok |Request has been processed successfully. |
|S001 |System error |System error. |
|P001 |xxx is illegal |Parameter in the request is illegal. xxx will be replaced by the element name |
|P002 |xxx is missing |Parameter is not in the request, which is mandatory. xxx will be replaced by the element name. |
|P006 |Invalid parameter |Invalid parameter. |
|B002 |Partner is not exists |Partner is not exists. |
|B003 |Illegal sign |Illigal sign, please check signature session |
|B009 |Order status is invalid |Order status is not allow to change. |
|B037 |Order is not exist. |Order number is not exists. |
|B038 |Departure date must be today to a year. |Departure date must be today to a year. |
|B048 |Invalid buyer |Buyer is invalid, please contact with PKFARE administrator |
|B135 |Passenger or ticket number is not in the order |Passenger or ticket number in the request is not in the order. |
|B148 |UploadedFileId is not exist. |UploadedFileIds in the request is not exist. |
|B150 |The order was changed, please kindly use change order number. |The order was changed before. Please use the latest order number to raise change. |
|B152 |pnrList information is not same as order, please kindly check. |pnrList information is not same as order, please kindly check. |
|B156 |Order#[Order number] is not applicable for change |The order is neither origin order nor change order. Change request is not allowed. |
|B157 |Duplicate change has been found for passenger[passenger name] in order [order number] |A duplicated request is found, and  order for previous request was created succesfully. You are able to use order number in the message to request OrderDetails API for more information. |
|B160 |You have the option to select any day within a {x}-day window prior to the original departure date or {x} days window following the original departure date as the new departure date, but not allow change to {Blackout date range}. |According to airline rules, the change is only allowed in a time window. |
|B162 |Change is not applicable for passenger xxx/xxx |Passenger has requested for void or refund, change is not allowed. |
|B163 |Ticket(s) [ticket number] is No-show, change is not applicable. |The ticket is noshow per airline rules, change is not allowed. |
|B164 |Passenger(s) must has same routing and request to change. If routing isvaries, please request per passenger. |One of multiple Passenger(s) in the request has requested to change the routing. Change is not allow to raise togther. |
|B165 |Uncompleted segmentList, it should contain segments of whole journey |Itinerary in the request is part of the journey, change by segment is not support for this order. |
|B174 |Reason is not match with voluntary type. |Reason is not match with voluntary type. |
|B175 |Reason is not match with involuntary type. |Reason is not match with involuntary type. |
|B176 |Infant is not support for change. Please kindly contact online service for help. |Infant is not support for change. Please kindly contact online service for help. |

 
### 5.2 Cabin Class


|Value               | Description     |
| ------ | ------ |
|Economy |Enconomy class |
|PremiumEconomy |Premium Economy class |
|Business |Business class |
|First |First class |