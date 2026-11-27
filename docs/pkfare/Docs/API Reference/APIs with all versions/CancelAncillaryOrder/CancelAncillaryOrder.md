# CancelAncillaryOrder

## 1 Function
  You can cancel the ancillary order through CancelAncillaryOrder API before AncillaryTicketing.
 

## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|cancelAncillaryOrder|http://api.pkfare.com/cancelAncillaryOrder|Support postbooking ancillary|

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
|Authentification | | | | |
|partnerId |string |Yes |Partner ID |RksVSX7PfZm1yF04adBWYsCD7M4= |
|sign |string |Yes |signature, sign=MD5 (partnerId+partnerKey) |17e707b5d9dae8459065dbb139e5f1bd |
|cancel | | | | |
|ancillaryOrderNum |String |Yes |Ancillary order number returned from AncillaryBooking |917049521951368303|

### 4.2 Request Example
```plain
{
    "authentication": {
        "sign": "RksVSX7PfZm1yF04adBWYsCD7M4=",
        "partnerId": "17e707b5d9dae8459065dbb139e5f1bd"
    },
    "cancel": {
        "ancillaryOrderNum": "917049521951368303"
    }
}
```

## 5 Response

### 5.1 Schema

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|errorCode |String |error code |0 |
|errorMsg |String |error message |ok |


### 5.2 Example
Success Response
```
{
"errorCode": "0",
"errorMsg": "ok",
}
```

## 6 Error Code List
|errorCode|errorMsg|
|:----|:----|
|0 |ok |
|B001 |Business exception |
|B002 |Partner does not exist. |
|B003 |Illegal sign. |
|P006 |Invalid parameter. |
|B182 |Invalid AncillaryOrderNum |
|B183 |The ancillary order has been canceled and please don't make duplicate cancellations. |
|B184 |Cancel failed due to invalid ancillary status |