# CancelOrder

## **1 Function**

Through Cancel API, users can cancel orders and PNRs generated in GDS by PKFARE. Cancel API is used for canceling orders before ticketing.

## **2 Versioning**

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|cancelOrder|[https://api.pkfare.com/cancel](https://api.pkfare.com/cancel)|    |

## **3 Charater Encoding**

The character code of this API is UTF-8. 

## 4 Request 

### 4.1 Schema

Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. 

|Name|Type|Required|Description|Sample|
|:----|:----|:----|:----|:----|
|Authentification|    |    |    |    |
|partnerId|string|Yes|Partner ID|RksVSX7PfZm1yF04adBWYsCD7M4=|
|sign|string|Yes|signature, sign=MD5 (partnerId+partnerKey)|17e707b5d9dae8459065dbb139e5f1bd<br> |
|ticketing|    |    |    |    |
|orderNum|String|Yes|order ID returned from PreciseBooking|1012666145|
|virtualPnr|String|No|PNR|6DV9PP|

### 4.3 Example

```plain
{
	"authentication": {
		"partnerId": "RksVSX7PfZm1yF0dBWYsCD7M4=",
		"sign": "17e707b5d9da59065db139e5f1bd"
	},
	"cancel": {
		"orderNum": 1012666145,
		"virtualPnr": "6DV9PP"
	}
}
```
## 5 Response

### 5.1 Schema

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|Basic Parameters|    |    |    |
|errorCode|String|error code|0|
|errorMsg|String|error message. If return to "OK", order cancels successfully|OK|
|data|Object|return data. Only if the errorCode returns to "0", returned data is non-null|-|

### 5.2 Example

Success response

```plain
{
	"errorCode": "0",
	"errorMsg": "ok",
	"data": null
}
```
Failure response
```plain
{
	"errorCode": "B007",
	"errorMsg": "Cancel failed.",
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
|B009|Order status is invalid|order status is not to_be_paid|
|B010|Order number not exist|order number does not exist|
|B041|The order has been cancelled|Order has been canceled|


