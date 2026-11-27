# AncillaryStatusPush

## 1 Function
  You can be notified when the status of ancillary is updated as long as the URL has been provided.
  
 

## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|ancillaryStatusPush|This address is provided by the customer.|Support postbooking paid baggage|

 *Below is the most updated version* 
 

## 
## 3 Charater Encoding

The character code of this API is UTF-8. 


## 
## 4 Request
### 4.1 Schema 
The request is sent by PKFARE API. Requesting method would be POST.

|Name |Type |Parameter Description |Sample
|:--|:--|:--|:--|
|Basic Parameter | | | |
|ancillaryOrderNum |string |PKFARE ancillary order number |917049521951368302
|buyerOrder |string |your order number if you want to store at PKFARE side, which is sent by ancillaryBooking request|
|status |string |the status of ancillary order, Fulfilled-success： Failed-failure |Fulfilled
|errorMsg |string |the failure reason |
|passengers |array |passenger detail |-|
|journeys |array |journey information |-|
|ancillaries |object |ancillary detail |-|
|Passengers | | | |
|lastName |string | last name |Zhong |
|firstName |string |first name |XiaoJun
|sex |string |gender；M-male，F-female |M|
|birthday |string |birthday |2003-03-23 |
|psgType |string |passenger type including ADT for adults, CHD for children |ADT |
|passengerID |string |unique identification of the passenger |-|
|Journeys | | | 
|journeyID |string |unique identification of the journey |-|
|segments |array |segment detail |-|
|Segments | | | |
|airline |string |airline code |FD |
|departure |string |origin[IATA airport code] |DMK |
|departureDate |string |departure date[yyyy-MM-dd] |2022-10-01 |
|departureTime |string |departure time[hh:mm] |09:55 |
|arrival |string |destination[IATA airport code] |CNX |
|arrivalDate |string |arrival date[yyyy-MM-dd] |2022-10-01 |
|arrivalTime |string |arrival time[hh:mm] |11:25 |
|flightNum |string |flight number |513 |
|bookingCode |string |cabin code |N |
|segmentKey |string |unique identification of the segment |- |
|Ancillaries | | | |
|baggages |array |baggage detail |- |
|Baggages | | | |
|EMD |string |EMD number |-|
|payBaggageType |integer |baggage type; 1-checked baggage, 2-carry-on baggage
|baggagePiece |integer |baggage piece; -1 - no limit to baggage piece |-1|
|baggageWeight |string |baggage weight |20KG |
|description |string |baggage description |1PC x 25lb Cabin Bag |
|journeyID |string |unique identification of the journey |
|passengerID |string |unique identification of the passenger |

### 4.2 Example
 
 Request Sample
```plain
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

## 5 Response

### 5.1 Schema

|Name|Type|Parameter Description|Sample|
|:----|:----|:----|:----|
|errorCode|String|error code|0|
|errorMsg|String|error message|ok|

### 5.2 Example

1. Success Response
```plain
{"errorCode":0,"errorMsg":"ok"}
```