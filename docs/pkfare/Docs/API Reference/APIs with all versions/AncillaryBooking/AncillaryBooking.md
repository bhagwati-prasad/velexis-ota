# AncillaryBooking

## 1 Function
  You can add ancillary products and create an ancillary order in PKFARE through AncillaryBooking API. It is necessary to use AncillaryPricing service before using this interface.
 

## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|ancillaryBooking_V2|http://api.pkfare.com/ancillaryBookingV2|Support postbooking paid baggage|

 *Below is the most updated version* 
 

## 
## 3 Charater Encoding

The character code of this API is UTF-8. 


## 
## 4 Request 

### 4.1 Schema

Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. 

|Name|Type|Required|Description|Sample|
|:----|:----|:----|:----|:----|
|Basic Parameters|    |    |    |    |
|authentication|object|Yes|authentication information|-|
|buyerOrder|string|No|your order number if you want to store at PKFARE side|-|
|airOrderNum|string|Yes|PKFARE air order number|917049521951368301|
|ancillaryBooking|object|Yes|ancillary booking information|-|
|Authentification|    |    |    |    |
|partnerId|string|Yes|Partner ID|RksVSX7PfZyF04adBWYsCD7M4=|
|sign|string|Yes|signature, sign=MD5 (partnerId+partnerKey)|17e705d9dae8459065dbb139e5f1bd|
|AncillaryBooking|    |    |    |    |
|baggages |array |Yes|baggage detail |-|
|Baggages | | | |
|passenger |object |Yes|passenger detail|-|
|products |array |Yes|product detail|-|
|Passenger | | | |
|lastName |string |Yes |last name |Zhong |
|firstName |string |Yes |first name |XiaoJun |
|psgType |string |Yes |passenger type including ADT for adults, CHD for children |ADT |
|sex |string |Yes |gender, including M for male, F for female |M |
|birthday |string |Yes |birthday |2003-03-23 |
|Products | | | | |
|ancillaryKey |string |Yes |unique identification of ancillary |9298386105acb75ed148af00cb |

### 4.3 Request Example
```plain
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

## 5 Response

### 5.1 Schema

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|Basic Parameters | | | |
|errorCode |string |error code, refer to Error Code List |0 |
|errorMsg |string |error msg |ok |
|data |object |Only if the errorCode returns "0", returned data would not be null. |- |
|Data | | | |
|baggageOrder |object |baggage order detail |- |
|BaggageOrder | | | |
|buyerOrder |string |your order number if you want to store at PKFARE side | |
|ancillaryOrderNum |string |PKFARE ancillary order number |917049521951368302 |
|baggages |array |baggage details |- |
|Baggages | | | |
|passenger |object |passenger details | |
|baggageDetails |array |baggage details | |
|Passenger | | | |
|lastName |string |last name |Zhong |
|firstName |string |first name |XiaoJun |
|psgType |string |passenger type including ADT for adults, CHD for children |ADT |
|birthday |string |birthday |M |
|sex |string |Gender, including M for male, F for female |2003-03-23 |
|BaggageDetails | | | |
|ancillaryKey |string |unique identification of ancillary |9298386105acb75ed148af00cb |
|payBaggageType |integer |baggage type; 1-checked baggage, 2-carry-on baggage |1 |
|baggagePiece |integer |baggage piece; -1 - no limit to baggage piece |1 |
|baggageWeight |string |baggage weight |20KG |
|baggageCurrency |string |currency |CNY |
|baggagePrice |bigDecimal |price |198.00 |
|description |string |baggage description |1PC x 25lb Cabin Bag |
|journey |array |journey details |- |
|Journey | | | |
|airline |string |airline code |FD |
|departure |string |origin[IATA airport code] |DMK |
|departureDate |string |departure date[yyyy-MM-dd] |2022-10-01 |
|departureTime |string |departure time[hh:mm] |09:55 |
|arrival |string |destination[IATA airport code] |CNX |
|arrivalDate |string |arrival date[yyyy-MM-dd] |2022-10-01 |
|arrivalTime |string |arrival time[hh:mm] |11:25 |
|flightNum |string |flight number |513 |
|cabinClass |string |cabin class |ECONOMY |
|bookingCode |string |cabin code |N |


### 5.2 Example

Success response
```plain
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

## 6 Error Code List

|errorCode|errorMsg|
|:----|:----|
|0 |ok |
|S001 |System error. |
|P001 |XXX is illegal. |
|P002 |XXX is missing. |
|P006 |Invalid parameter. |
|B002 |Partner is not exists. |
|B003 |Illegal sign. |
|B005 |Can not find any matching ancillaryPricing result within 30 minutes. |
|B009 |Order status is invalid |
|B010 |The order was not found |
|B017 |Price is changed. |
|B029 |Duplicate reservations have been found for passenger XXX/XXX in order XXX. |
|B071 |Itinerary is different between request and order. |
|B075 |There are duplicate bookings and the same passenger is only allowed to choose one of baggage weights in the same journey. |
