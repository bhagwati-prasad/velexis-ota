# Add Paid Bags after the Booking

# Overview

## Add Paid Bags after the Booking

**If you want to add a paid bag after the booking, you should:**


:::info
**1) search ancillary product**
**2) select the product and create an ancillary order**
**3) cancel the previous order if you need to update the order information and create a new ancillary order**
**4) pay the ancillary order**
**5) check the status of ancillary order**
:::

### API Workflow

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338124/image-preview)

#### **Search Ancillary Product**
Generally, the prices of prebooking and postbooking ancillaries are different. An air order should be booked at PKFARE before you want to add baggage in the postbooking stage.

The information of postbooking ancillary product can be obtained by calling `Ancillarypricing`. The request of `AncillaryPricing` about postbooking bag is simple and  only air order number and ancillary type are required. 

Postbooking ancillary search is based on the itinerary and passenger information provided in the air order.Tthere is no need to provide additional itinerary details,  passenger type and its corresponding quantities in the request.

The status of air order should be issuing or issued, otherwise you cannot get the `AncillaryPricing` results about postbooking ancillary.

Baggages are sold based on weight, instead of based on pieces at PKFARE.  "`baggageWeight`" means total baggage weight, "`baggagePiece`" means total baggage piece. You can select the baggage weight of the same baggage type you want in the same journey while adding multiple baggaage weights of the same baggage type is not allowed.


***AncillaryPricing Request Sample***
```
{
    "authentication": {
        "sign": "QC4cn5nhgyUodlm+3tXKTnduw=",
        "partnerId": "aac39b4a1ebfa12c9bf3f81fffdc"
    },
    "pricing": {
        "airOrderNum": "917049521951368301",
        "ancillary": [
            1
        ]
    }
}
```

***AncillaryPricing Response Sample***
```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": [
        {
            "ancillaryType": 1,
            "ancillary": {
                "journeys": [
                    {
                        "airline": "TR",
                        "flightNum": "980",
                        "departure": "SIN",
                        "departureDate": "2022-04-23",
                        "departureTime": "06:00",
                        "arrival": "HKG",
                        "arrivalDate": "2022-04-23",
                        "arrivalTime": "10:05",
                        "bookingCode": "O"
                    }
                ],
                "ancillaries": {
                    "baggage": [
                        {
                            "ancillaryKey": "62613b9298386105acb75ed148af00cb",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "22KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": 663.0,
                            "description": "22KG"
                        }
                    ]
                }
            }
        },
        {
            "ancillaryType": 1,
            "ancillary": {
                "journeys": [
                    {
                        "airline": "TR",
                        "flightNum": "981",
                        "departure": "HKG",
                        "departureDate": "2022-04-25",
                        "departureTime": "10:55",
                        "arrival": "SIN",
                        "arrivalDate": "2022-04-25",
                        "arrivalTime": "14:50",
                        "bookingCode": "W"
                    }
                ],
                "ancillaries": {
                    "baggage": [
                        {
                            "ancillaryKey": "e8e932e9e97e82610fe538a54c3eb83e",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "50KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": 663.0,
                            "description": "50KG"
                        }
                    ]
                }
            }
        }
    ]
}
```

#### **Select the Product and Create Ancillary Orders**
Based on the AncillaryPricing results, you can select the baggage allowance you want.
     There is a duplicate booking verification and status check of the air order after you request to create an ancillary order. If there is a pending unpaid order, the new order, of which the same passenger still adds the same baggage type in the same journey, cannot be created successfully.  Addtionally, the ancillary order won't be created successfully if the status of the air order is not issued.
 
**The following cases are supported:**

:::highlight blue 
1.The same passenger has added 20KG checked bag in the same journey for the first time. Then he/she can create another ancillary order of 10KG carry-on bag for the second time in the same journey.


2.The same passenger can add 15KG carry-on bag and 20KG checked bag in the same journey at the same time.


:::

    
**The following cases are not allowed:**


:::highlight red 
1.The same passenger can't add 20KG checked bag and 30KG checked bag at the same time.

2.The same passenger has added 20KG checked bag for the first time and cannot add 15KG checked bag for the second time.

:::


   You can get the ancillary order number based on the response of AncillaryBooking.
 
 
 ---
   You should pay the ancillary order within half an hour after the order is created, otherwise it will be cancelled automatically.
   
   
   
   ***AncillaryBooking Request Sample***
   ```
{
    "airOrderNum": "917049521951368301",
    "authentication": {
        "sign": "09516fe5668d5d92695d3af62d55a2d0",
        "partnerId": "hrXpLEy2wxdO7PXjh7WoMPpjw3U="
    },
    "ancillaryBooking": {
        "baggages": [
            {
                "passenger": {
                    "birthday": "2003-03-23",
                    "firstName": "XiaoJun",
                    "lastName": "Zhong",
                    "psgType": "ADT",
                    "sex": "M"
                },
                "products": [
                    {
                        "ancillaryKey": "38781f820e9ee25737d7b313410b5317"
                    },
                    {
                        "ancillaryKey": "2781c40741271185391c4ef5dab51df5"
                    }
                ]
            },
            {
                "passenger": {
                    "birthday": "2003-03-23",
                    "firstName": "Harris",
                    "lastName": "Kaufman",
                    "psgType": "ADT",
                    "sex": "M"
                },
                "products": [
                    {
                        "ancillaryKey": "38781f820e9ee25737d7b313410b5317"
                    },
                    {
                        "ancillaryKey": "2781c40741271185391c4ef5dab51df5"
                    }
                ]
            },
            {
                "passenger": {
                    "birthday": "2015-03-23",
                    "firstName": "Yue",
                    "lastName": "Hong",
                    "psgType": "CHD",
                    "sex": "M"
                },
                "products": [
                    {
                        "ancillaryKey": "38781f820e9ee25737d7b313410b5317"
                    },
                    {
                        "ancillaryKey": "2781c40741271185391c4ef5dab51df5"
                    }
                ]
            }
        ]
    }
}
```

   ***AncillaryBooking Response Sample***
   ```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "baggageOrder": {
            "ancillaryOrderNum": "917049521951368302",
            "baggages": [
                {
                    "passenger": {
                        "birthday": "2003-03-23",
                        "firstName": "XiaoJun",
                        "lastName": "Zhong",
                        "psgType": "ADT",
                        "sex": "M"
                    },
                    "baggageDetails": [
                        {
                            "ancillaryKey": "38781f820e9ee25737d7b313410b5317",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "18KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": 521.00,
                            "description": "1PC x 40lb Checked Bag",
                            "journey": [
                                {
                                    "airline": "NK",
                                    "flightNum": "1850",
                                    "departure": "LAS",
                                    "departureDate": "2024-02-10",
                                    "departureTime": "21:53",
                                    "arrival": "SAN",
                                    "arrivalDate": "2024-02-10",
                                    "arrivalTime": "23:11",
                                    "bookingCode": "W",
                                    "cabinClass": "ECONOMY"
                                }
                            ]
                        },
                        {
                            "ancillaryKey": "2781c40741271185391c4ef5dab51df5",
                            "payBaggageType": 2,
                            "baggagePiece": 1,
                            "baggageWeight": "11KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": 556.00,
                            "description": "1PC x 25lb Cabin Bag",
                            "journey": [
                                {
                                    "airline": "NK",
                                    "flightNum": "744",
                                    "departure": "SAN",
                                    "departureDate": "2024-01-26",
                                    "departureTime": "20:06",
                                    "arrival": "LAS",
                                    "arrivalDate": "2024-01-26",
                                    "arrivalTime": "21:31",
                                    "bookingCode": "U",
                                    "cabinClass": "ECONOMY"
                                }
                            ]
                        }
                    ]
                },
                {
                    "passenger": {
                        "birthday": "2003-03-23",
                        "firstName": "Harris",
                        "lastName": "Kaufman",
                        "psgType": "ADT",
                        "sex": "M"
                    },
                    "baggageDetails": [
                        {
                            "ancillaryKey": "38781f820e9ee25737d7b313410b5317",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "18KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": 521.00,
                            "description": "1PC x 40lb Checked Bag",
                            "journey": [
                                {
                                    "airline": "NK",
                                    "flightNum": "1850",
                                    "departure": "LAS",
                                    "departureDate": "2024-02-10",
                                    "departureTime": "21:53",
                                    "arrival": "SAN",
                                    "arrivalDate": "2024-02-10",
                                    "arrivalTime": "23:11",
                                    "bookingCode": "W",
                                    "cabinClass": "ECONOMY"
                                }
                            ]
                        },
                        {
                            "ancillaryKey": "2781c40741271185391c4ef5dab51df5",
                            "payBaggageType": 2,
                            "baggagePiece": 1,
                            "baggageWeight": "11KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": 556.00,
                            "description": "1PC x 25lb Cabin Bag",
                            "journey": [
                                {
                                    "airline": "NK",
                                    "flightNum": "744",
                                    "departure": "SAN",
                                    "departureDate": "2024-01-26",
                                    "departureTime": "20:06",
                                    "arrival": "LAS",
                                    "arrivalDate": "2024-01-26",
                                    "arrivalTime": "21:31",
                                    "bookingCode": "U",
                                    "cabinClass": "ECONOMY"
                                }
                            ]
                        }
                    ]
                },
                {
                    "passenger": {
                        "birthday": "2015-03-23",
                        "firstName": "Yue",
                        "lastName": "Hong",
                        "psgType": "CHD",
                        "sex": "M"
                    },
                    "baggageDetails": [
                        {
                            "ancillaryKey": "38781f820e9ee25737d7b313410b5317",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "18KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": 521.00,
                            "description": "1PC x 40lb Checked Bag",
                            "journey": [
                                {
                                    "airline": "NK",
                                    "flightNum": "1850",
                                    "departure": "LAS",
                                    "departureDate": "2024-02-10",
                                    "departureTime": "21:53",
                                    "arrival": "SAN",
                                    "arrivalDate": "2024-02-10",
                                    "arrivalTime": "23:11",
                                    "bookingCode": "W",
                                    "cabinClass": "ECONOMY"
                                }
                            ]
                        },
                        {
                            "ancillaryKey": "2781c40741271185391c4ef5dab51df5",
                            "payBaggageType": 2,
                            "baggagePiece": 1,
                            "baggageWeight": "11KG",
                            "baggageCurrency": "CNY",
                            "baggagePrice": 556.00,
                            "description": "1PC x 25lb Cabin Bag",
                            "journey": [
                                {
                                    "airline": "NK",
                                    "flightNum": "744",
                                    "departure": "SAN",
                                    "departureDate": "2024-01-26",
                                    "departureTime": "20:06",
                                    "arrival": "LAS",
                                    "arrivalDate": "2024-01-26",
                                    "arrivalTime": "21:31",
                                    "bookingCode": "U",
                                    "cabinClass": "ECONOMY"
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    }
}
```
---
#### **Cancel Ancillary Orders**
It's recommended to cancel the previous order by calling CancelAncillaryOrder API if you want to update the booking infomation.

---

#### Pay Ancillary Orders
The order information is confirmed and you can call AncillaryTicketing API to pay the ancillary order and it will enter into the ticketing process.





***AncillaryTicketing Request Sample***
```
{
    "authentication": {
        "sign": "09516fe5668d5d92695d3af62d55a2d0",
        "partnerId": "hrXpLEy2wxdO7PXjh7WoMPpjw3U="
    },
    "ticketing": {
        "ancillaryOrderNum": [
            "917049521951368302"
        ]
    }
}
```

***AncillaryTicketing Response Sample***
```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "ancillaryOrderNum": "917049521951368302",
        "orderAmount": 3231.00,
        "transactionExpense": 0,
        "payAmount": 3231.00
    }
}
```
---
#### Check the Status of Ancillary Orders
There are two ways to check the status of ancillary orders, one is to be notified by AncillaryStatusPush API once the status is updated, if you have provided the URL to PKFARE. The other is to check the status by calling AncillaryOrderdetail.



***AncillaryStatusPush Request Sample***
```
{
    "ancillaries": {
        "baggages": [
            {
                "baggagePiece": 1,
                "baggageWeight": "18KG",
                "description": "1PC x 40lb Checked Bag",
                "journeyId": "152254",
                "passengerId": "242475",
                "payBaggageType": 1
            },
            {
                "baggagePiece": 1,
                "baggageWeight": "11KG",
                "description": "1PC x 25lb Cabin Bag",
                "journeyId": "152253",
                "passengerId": "242475",
                "payBaggageType": 2
            },
            {
                "baggagePiece": 1,
                "baggageWeight": "18KG",
                "description": "1PC x 40lb Checked Bag",
                "journeyId": "152254",
                "passengerId": "242474",
                "payBaggageType": 1
            },
            {
                "baggagePiece": 1,
                "baggageWeight": "11KG",
                "description": "1PC x 25lb Cabin Bag",
                "journeyId": "152253",
                "passengerId": "242474",
                "payBaggageType": 2
            },
            {
                "baggagePiece": 1,
                "baggageWeight": "18KG",
                "description": "1PC x 40lb Checked Bag",
                "journeyId": "152254",
                "passengerId": "242473",
                "payBaggageType": 1
            },
            {
                "baggagePiece": 1,
                "baggageWeight": "11KG",
                "description": "1PC x 25lb Cabin Bag",
                "journeyId": "152253",
                "passengerId": "242473",
                "payBaggageType": 2
            }
        ]
    },
    "ancillaryOrderNum": "917049521951368302",
    "errorMsg": "The specified bag allowance is unavailable",
    "journeys": [
        {
            "journeyId": "152254",
            "segments": [
                {
                    "airline": "NK",
                    "arrival": "SAN",
                    "arrivalDate": "20240210",
                    "arrivalTime": "2311",
                    "bookingCode": "W",
                    "departure": "LAS",
                    "departureDate": "20240210",
                    "departureTime": "2153",
                    "flightNum": "1850",
                    "segmentKey": "176710"
                }
            ]
        },
        {
            "journeyId": "152253",
            "segments": [
                {
                    "airline": "NK",
                    "arrival": "LAS",
                    "arrivalDate": "20240126",
                    "arrivalTime": "2131",
                    "bookingCode": "U",
                    "departure": "SAN",
                    "departureDate": "20240126",
                    "departureTime": "2006",
                    "flightNum": "744",
                    "segmentKey": "176709"
                }
            ]
        }
    ],
    "passengers": [
        {
            "birthday": "20030323",
            "firstName": "XIAOJUN",
            "lastName": "ZHONG",
            "passengerId": "242473",
            "psgType": "ADT",
            "sex": "M"
        },
        {
            "birthday": "20030323",
            "firstName": "HARRIS",
            "lastName": "KAUFMAN",
            "passengerId": "242474",
            "psgType": "ADT",
            "sex": "M"
        },
        {
            "birthday": "20150323",
            "firstName": "YUE",
            "lastName": "HONG",
            "passengerId": "242475",
            "psgType": "CHD",
            "sex": "M"
        }
    ],
    "status": "Failed"
}
```


***AncillaryStatusPush Response Sample***
```
{
    "errorCode": 0,
    "errorMsg": "ok"
}
```


***AncillaryOrderDetail Request Sample***
```
{
    "authentication": {
        "sign": "09516fe5668d5d92695d3af62d55a2d0",
        "partnerId": "hrXpLEy2wxdO7PXjh7WoMPpjw3U="
    },
    "data": {
        "ancillaryOrderNum": "917049521951368302"
    }
}
```

***AncillaryOrderDetail Response Sample***
```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "ancillaryOrderNum": "917049521951368302",
        "airOrderNum": "917049521951368301",
        "ancillaryOrderStatus": "ISSED",
        "ancillaryOrderType": "ORIGIN",
        "saleStage": 1,
        "ancillaryType": 1,
        "createTime": "2024-01-11T05:50:36+00:00",
        "pnr": "E39BB4|dW1pNV",
        "airPnr": "wPIJCe|EYLo2H",
        "payGate": "Prepay",
        "paySerialNum": "PREPAY_20240111135036_917049521951368302_5451",
        "lastTktTime": "",
        "passengers": [
            {
                "lastName": "ZHONG",
                "firstName": "XIAOJUN",
                "psgType": "ADT",
                "birthday": "2003-03-23",
                "sex": "M",
                "passengerID": "242473"
            },
            {
                "lastName": "KAUFMAN",
                "firstName": "HARRIS",
                "psgType": "ADT",
                "birthday": "2003-03-23",
                "sex": "M",
                "passengerID": "242474"
            },
            {
                "lastName": "HONG",
                "firstName": "YUE",
                "psgType": "CHD",
                "birthday": "2015-03-23",
                "sex": "M",
                "passengerID": "242475"
            }
        ],
        "journeys": [
            {
                "journeyID": "152253",
                "segments": [
                    {
                        "airline": "NK",
                        "departure": "SAN",
                        "departureDate": "2024-01-26",
                        "departureTime": "20:06",
                        "arrival": "LAS",
                        "arrivalDate": "21:31",
                        "arrivalTime": "2024-01-26",
                        "flightNum": "744",
                        "bookingCode": "U",
                        "segmentKey": "176709"
                    }
                ]
            },
            {
                "journeyID": "152254",
                "segments": [
                    {
                        "airline": "NK",
                        "departure": "LAS",
                        "departureDate": "2024-02-10",
                        "departureTime": "21:53",
                        "arrival": "SAN",
                        "arrivalDate": "23:11",
                        "arrivalTime": "2024-02-10",
                        "flightNum": "1850",
                        "bookingCode": "W",
                        "segmentKey": "176710"
                    }
                ]
            }
        ],
        "ancillaryInfos": [
            {
                "baggages": {
                    "passengerID": "242473",
                    "journeyID": "152254",
                    "payBaggageType": 1,
                    "baggagePiece": 1,
                    "baggageWeight": "18KG",
                    "baggageCurrency": "CNY",
                    "baggagePrice": "521.00",
                    "description": "1PC x 40lb Checked Bag"
                }
            },
            {
                "baggages": {
                    "passengerID": "242473",
                    "journeyID": "152253",
                    "payBaggageType": 2,
                    "baggagePiece": 1,
                    "baggageWeight": "11KG",
                    "baggageCurrency": "CNY",
                    "baggagePrice": "556.00",
                    "description": "1PC x 25lb Cabin Bag"
                }
            },
            {
                "baggages": {
                    "passengerID": "242474",
                    "journeyID": "152254",
                    "payBaggageType": 1,
                    "baggagePiece": 1,
                    "baggageWeight": "18KG",
                    "baggageCurrency": "CNY",
                    "baggagePrice": "521.00",
                    "description": "1PC x 40lb Checked Bag"
                }
            },
            {
                "baggages": {
                    "passengerID": "242474",
                    "journeyID": "152253",
                    "payBaggageType": 2,
                    "baggagePiece": 1,
                    "baggageWeight": "11KG",
                    "baggageCurrency": "CNY",
                    "baggagePrice": "556.00",
                    "description": "1PC x 25lb Cabin Bag"
                }
            },
            {
                "baggages": {
                    "passengerID": "242475",
                    "journeyID": "152254",
                    "payBaggageType": 1,
                    "baggagePiece": 1,
                    "baggageWeight": "18KG",
                    "baggageCurrency": "CNY",
                    "baggagePrice": "521.00",
                    "description": "1PC x 40lb Checked Bag"
                }
            },
            {
                "baggages": {
                    "passengerID": "242475",
                    "journeyID": "152253",
                    "payBaggageType": 2,
                    "baggagePiece": 1,
                    "baggageWeight": "11KG",
                    "baggageCurrency": "CNY",
                    "baggagePrice": "556.00",
                    "description": "1PC x 25lb Cabin Bag"
                }
            }
        ]
    }
}
```












