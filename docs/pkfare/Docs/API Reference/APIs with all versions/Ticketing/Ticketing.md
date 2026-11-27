# Ticketing

## **1 Function**

Through Ticketing API, users can request PKFARE to deduct credits (currently only Prepay and Alipay are supported). Ticket numbers would be provided by TickeitngNumPush or orderDetail API.

## **2 Versioning**

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|ticketing|[https://api.pkfare.com/ticketing](https://api.pkfare.com/ticketing)|    |

 *Below is  the most updated version.* 
 
## **3 Charater Encoding**

The character code of this API is UTF-8. 

## 4 Request 

### 4.1 Schema

Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. 

|Name|Type|Required|Description|Sample|
|:----|:----|:----|:----|:----|
|Authentification|    |    |    |    |
|partnerId|string|Yes|Partner ID|RksVSXfZm1yF04adBWYsCD7M4=|
|sign|string|Yes|signature, sign=MD5 (partnerId+partnerKey)|17e707b5d9da59065dbb139e5f1bd<br> |
|ticketing|    |    |    |    |
|orderNum|String|Yes|[PKFARE] Order number|1012674912|
|pnr|String|Yes|PNR returned by PreciseBooking|KHZ1WU|
|name|String|No|contact name, formatted with "last name/first name" or "first name"|Wang/Jango|
|email|String|No|email address [to receive schedule-changed notice]|jango.wang@gongfutrip.com|
|telNum|String|No|contact phone number|13249073855|

### 4.3 Example

```plain
{
	"authentication": {
		"partnerId": "RksVSX7Pf1yF04adBWYsCD7M4=",
		"sign": "17e707>b5d9dae59065dbb139e5f1bd"
	},
	"ticketing": {
		"email": "jango.wang@gongfutrip.com",
		"name": "Jango/Wang",
		"orderNum": 1012674912,
		"telNum": "13249073855",
		"PNR": "KHZ1WU"
	}
}
```
## 5 Response

### 5.1 Schema

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|Basic Parameters|    |    |    |
|errorCode|String|error code; refer to error code list|0|
|errorMsg|String|error message|OK|
|data|Object|only if the errorCode returns "0", returned data would not be null. Data is in JSON format, which contains three collection objects: solutions, flights, segments |-|
|data|    |    |    |
|orderNum|String|order number in PKFARE system|1012704540|
|orderAmount|BigDecimal|order Amount|2015.00|
|transactionExpense|BigDecimal|merchant fee|2.02|
|payAmount|BigDecimal|actual payment amount|2017.02|

### 5.2 Example

Success response

```plain
{
	"errorCode": "0",
	"errorMsg": "ok",
	"data": {
		"orderNum": "1012704540",
		"orderAmount": 2015,
		"transactionExpense":2.02,
		"payAmount": 2017.02
	}
}
```
Failure response
```plain
{
	"errorCode": "P001",
	"errorMsg": "Invalid authentication.",
	"data": null
}
```
## 6 Error Code List

|errorCode|errorMsg|Description|
|:----|:----|:----|
|0|ok|request has been processed successfully|
|S001|System error|system error|
|P001|-|wrong parameter|
|B002|Partner is not exists|partnerID does not exist|
|B003|Illegal sign|illegal sign. Please check your signature|
|B009|Order status is invalid|order status is invalid|
|B010|Order number not exist|order number does not exist|
|B022|Ticketing failed|balance left is not enough to pay the order|
|B024|Order has been paid|order has already been paid. No need to pay again|


