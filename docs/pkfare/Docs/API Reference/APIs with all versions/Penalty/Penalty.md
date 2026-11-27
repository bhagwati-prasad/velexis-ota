# Penalty

## **1 Function**

Through Penalty API, users can get the refund and reissue/revalidation penalty for specific flight. It needs to be invoked after using PrecisePricing API within 30 minutes (We suggest invoking this API 10 seconds after you get the response of PrecisePricing), and the corresponding fare rule will be responded.

## **2 Versioning**

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|Penalty|[https://api.pkfare.com/penalty](https://api.pkfare.com/penalty)|    |

** ^^Below is  the most updated version.^^ **
## **3 Charater Encoding**

The character code of this API is UTF-8. 

## 4 Request 

### 4.1 Schema

Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. 

|Name|Type|Required|Description|Sample|
|:----|:----|:----|:----|:----|
|**Authentification**|    |    |    |    |
|partnerId|string|Yes|Partner ID|RksVSX7Pf1yF04adBWYsCD7M4=|
|sign|string|Yes|signature, sign=MD5 (partnerId+partnerKey)|17e707b5d9dae89065dbb139e5f1bd<br> |
|**penalty**|    |    |    |    |
|journeys|Object|Yes|specified journey data. Need to include all the journeys, refer to 2.1.3|-|
|**journey_0/journey_1**|    |    |    |    |
|airline|String|Yes|airline code|SA|
|flightNum|String|Yes|flight No.|102|
|arrival|String|Yes|destination|CPT|
|arrivalDate|String|Yes|arrival date|2015-11-11|
|arrivalTime|String|Yes|arrival time|11:45|
|departure|String|Yes|origin|BKK|
|departureDate|String|Yes|departure date|2015-11-30|
|departureTime|String|Yes|departure time|07:05|
|bookingCode|String|Yes|cabin code|N|

### 4.3 Example

```plain
{
	"authentication": {
		"partnerId": "sVSX7PfZm1y4adBWYsCD7M4:",
		"sigh": "17e707b5d9d459065dbb139e5f1bd"
	},
	"penalty"{
		"journeys": {
			"journey_0": [{
				"airline": "SA",
				"arrival": "JNB",
				"arrivalDate": "2015-11-20",
				"arrivalTime": "07:45",
				"bookingCode": "N",
				"departure": "CPT",
				"departureDate": "2015-11-20",
				"departureTime": "05:45",
				"flightNum": "378"
			}],
			"journey_1": [{
				"airline": "SA",
				"arrival": "CPT",
				"arrivalDate": "2015-11-25",
				"arrivalTime": "08:10",
				"bookingCode": "N",
				"departure": "JNB",
				"departureDate": "2015-11-25",
				"departureTime": "06:00",
				"flightNum": "303"
			}]
		}
	}
}
```
## 5 Response

### 5.1 Schema

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|**Basic Parameters**|    |    |    |
|errorCode|String|error code|0|
|errorMsg|String|error message. If return to "OK", order cancels successfully|OK|
|data|Object|return data. Only if the errorCode returns to "0", returned data is non-null|-|
|**Data**|    |    |    |
|Penalties|Array|penalties are ordered by time of journey segments. Using "\n" as a line break|-|
|Remark|String|if the penalties are not retrieved, remark will apply|-|

### 5.2 Example

Success response with penalty text

```plain
{
	"data": {
		"penalties": [
			"PENALTIES
			UNLESS OTHERWISE SPECIFIED
			 CHANGES
			 ANY TIME
			n CHARGE HKD 700 FOR REISSUE.
			 NOTE -
			 CHANGE WITHIN SALES
			 PERIOD
			n ALLOWED WITH CHARGE OF HKD700 PER DOCUMENT PER
			 EACH TIME OF CHANGE PLUS A
			NY APPLICABLE FARE
			 DIFFERENTIAL
			 -----------------------------------------------
			 CHA
			NGE ON/AFTER 12MAR2016
			 WHOLLY UNUSED TICKET HAS TO BE CONVERT TO
			 PREVAILIN
			G MARKET FARE.CHARGE HKD700 PLUS
			 APPLICABLE FARE DIFFERENTIAL
			 ---------------------
			---------------------------
			 PARTIALLY USED TICKET A CHARGE OF HKD700 PLUS
			 FARE DIFFER
			ENTIAL IF APPLICABLE
			 ----------------------------------------------
			 GO SHOW NOT PERMITTE
			D
			 CANCELLATIONS
			 ANY TIME
			 TICKET IS NON-REFUNDABLE IN CASE OF CANCEL/NO-SHOW/
			n REFUND.
			 NOTE -
			 IN CASE OF NO-SHOW
			 CONSIDERED AS USED AND CANNO
			T BE RE-USED OR RE-
			 BOOK FOR TRAVEL ON OTHER FLIGHT/DATES FARE YQ YR
			 NON- REF
			UNDABLE."
			]
		},
	"errorCode": "0",
	"errorMsg": "ok"
}
```
Success response with remark
```plain
{
"data":{
        "penalties":["Refer to structured rules."]
        },
        "errorCode":"0",
        "errorMsg":"ok"
}
```
Failure response
```plain
{
	"errorCode": "P001",
	"errorMsg" : "Invalid authentication." ,
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
|B023|Penalty failed|collecting fare rule failed|


