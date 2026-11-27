# AncillaryTicketing_V2

## 1 Function
  Through AncillaryTicketing API, you can request PKFARE to deduct ancillary order payment (currently only Prepay is supported). 
It’s not allowed to pay multiple ancillary orders with the same ancillary product type at the same time.
After the payment, the status of the ancillary order will turn to be issued.


## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|ancillaryTicketing_V2|http://api.pkfare.com/ancillaryTicketingV2|Support postbooking paid baggage|

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
|ticketing|object|Yes|ticketing information|-|
|Authentification|    |    |    |    |
|partnerId|string|Yes|Partner ID|RksVSX7PfZyF04adBWYsCD7M4=|
|sign|string|Yes|signature, sign=MD5 (partnerId+partnerKey)|17e705d9dae8459065dbb139e5f1bd|
|Ticketing|    |    |    |    |
|ancillaryOrderNum|array|Yes|PKFARE ancillary order number, which is returned from AncillaryBooking|917049521951368302|

### 4.2 Example
```plain
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

## 5 Response

### 5.1 Schema

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|Basic Parameters | | | |
|errorCode |string |error code, refer to Error Code List |0 |
|errorMsg |string |error msg |ok |
|data |object |Only if the errorCode returns "0", returned data would not be null. |- |
|Data | | | |
|ancillaryOrderNum|string|PKFARE ancillary order number|917049521951368302|
|orderAmount|bigDecimal| ancillary order amount|2015|
|transactionExpense|bigDecimal|merchant fee|2.02|
|payAmount|bigDecimal|actual payment amount|2017.02|


### 5.2 Example

Success response

```plain
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


## 6 Error Code List

|errorCode|errorMsg|
|:----|:----|
|0 |ok |
|S001 |System error |
|P001 |ancillaryOrderNum is illegal |
|B002 |Partner is not exists |
|B003 |Illegal sign |
|B009 |Order status is invalid |
|B010 |Order number not exist |
|B022 |Ticketing failed |
|B024 |Order has been paid |
|B082 |It's not allowed to pay multiple ancillary orders with the same ancillary type at the same time. |