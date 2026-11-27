# AncillaryOrderDetail

## 1 Function
  Through AncillaryOrderDetail API, you can check ancillary order details 
  
## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|ancillaryOrderDetail|http://api.pkfare.com/ancillaryOrderDetail|Support postbooking paid baggage|

 *Below is the most updated version* 
 
 
 # 
## 3 Charater Encoding

The character code of this API is UTF-8. 


## 
## 4 Request 

### 4.1 Schema

Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. 

Name|Type|Required|Description|Sample|
|:----|:----|:----|:----|:----|
|Basic Parameters|    |    |    |    |
|authentication |object |Yes |authentication information |
|data |object |Yes |ancillary data |
|Authentication|    |    |    |    |
|partnerId |String |Yes |partner ID |HJqiE0YKcJlXnkCkZKhzIis5o= |
|sign |String |Yes |signature, sign=MD5(partnerId+partnerKey) |fed53d44ea413c40d5f18e69047b7c |
|Data|    |    |    |    |
|ancillaryOrderNum |string |Yes |PKFARE ancillary order number |917049521951368302|

### 4.2 Request Example
```plain
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

## 5 Response

### 5.1 Schema

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|Basic Parameters | | | |
|errorCode |string |error code, refer to Error Code List |0 |
|errorMsg |string |error msg |ok |
|data |object |Only if the errorCode returns "0", returned data would not be null. |- |
|Data | | | |
|ancillaryOrderNum |string |PKFARE ancillary order number |917049521951368302
|airOrderNum |string |associated air order number |
|ancillaryOrderStatus |string |the status of ancillary order |-|
|ancillaryOrderType |string |ancillary order type, ORIGIN-Ticketing Order |
|saleStage |Integer |sales stage：0- prebooking stage; 1-postbooking stage |
|ancillaryType |Integer|ancillary type：1-baggage; 2- seat |
|createTime |string | ancillary order created time（GMT）|2023-12-26T05:07:36+00:00 
|pnr |string |PNR |
|airPnr |string |Airline PNR |
|payGate |string |Form of payment, Alipay or Prepay |Prepay
|paySerialNum |string |Serial Number of payment transaction |
|lastTktTime |string |latest ticketing time (GMT)|2023-12-26T05:07:36+00:00
|passengers |array |passengers information |
|journeys |array |journey information |
|ancillaryInfos |array |ancillary information |
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
|AncillaryInfos | | | |
|baggages |array |baggage detail |- |
|Baggages | | | |
|payBaggageType |integer |baggage type; 1-checked baggage, 2-carry-on baggage
|baggagePiece |integer |baggage piece; -1 - no limit to baggage piece |-1|
|baggageWeight |string |baggage weight |20KG |
|baggageCurrency|string|currency|CNY|
|baggagePrice|bigdecimal|price|198.00|
|description |string |baggage description |1PC x 25lb Cabin Bag |
|journeyID |string |unique identification of the journey |
|passengerID |string |unique identification of the passenger |


### 5.2 Example

Success response

```plain
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

## 6 Error Code List

|errorCode|errorMsg|
|:----|:----|
|0 |ok |
|S001 |System error |
|P002 |XXX is missing |
|B002 |Partner is not exists |
|B003 |Illegal sign |
|B036 |Order is not exist |