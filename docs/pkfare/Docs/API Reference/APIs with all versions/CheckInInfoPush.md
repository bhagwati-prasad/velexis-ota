# CheckInInfoPush

# CheckInInfoPush

## 1 Function

Buyer partners should provide a webhook/URL based on HTTP/HTTPS protocol to PKFARE for push check-in details for specific airlines' orders. PKFARE will push the message, including account details, after the tickets being issued. 


## 2 Versioning

|Version |Sandbox Invoking Address |Update |
|:--|:----|:----|
|CheckInInfoPush |This address is provided by the customer. | |


## 3 Character Encoding
The character code of this API is UTF-8.


## 4 Request
The request is sent by PKFARE API. Requesting method would be POST.

### 4.1 Schema
|Name |Type |Parameter Description |Sample |
|:--|:--|:----|:----|
|Basic Parameter | | | |
|orderNum |string |[PKFARE] order number |1012674912 |
|data|object|including remarks||
|checkinInfos|object|check-in details||
|data|||
|remark|string|optional field||
|checkinInfos|||
|firstName|string|first name|David|
|lastname|string|last name|Alexandra|
|ticketNum|string|flight ticket number|5897514587459|
|pnr|string|locator PNR|YNFJGF|
|airPnr|string|airline PNR|HFI2FE|
|airline|string|ticketing carrier|MU|
|mailAccount|string|booking email address|123@gmail.com|
|mailPassword|string|booking email passcode|2435443|
|airlineWebsite|string|airline website for check-in|https://us.ceair.com/en/ |

### 4.2 Example


```
{
    "orderNum": "916390443615569701",
    "data":
    {
        "remark": {}
        }
    "checkinInfos": [
            {
                "firstName": "MARY",
                "lastName": "SMITH",
                "ticketNum": "9990000000001"
                "pr": "ABCDEF"
                "airPar": "ABCDEF"
                "airline": "FD"
                "mailAccount": "abc@abc.com"
                "mailPassword": "als2d3f4#
                "airlineWebsite":
                 "https://ww.airasia.com"
            },
            {
                "firstName": "JO",
                "lastName": "SMITH",
                "ticketNum": "9990000000002"
                "pr": "ABCDEG"
                "airPnr": "ABCDEG"
                "airline": "FD"
                "mailAccount": "abd@abc.com"
                "mailPassword":"als2d3f4#"
                "airlineWebsite" : 
                "https://www.airasia.com"
            },
            {
                "firstName": "ANGEL",
                "lastName": "SMITH",
                "ticketNum": "9990000000003"
                "pnr": "ABCDEZ"
                "airPr": "ABCDEZ"
                "airline": "FD"
                "mailAccount": "abe@abc.com"
                "mailPassword": "als2d3f4#"
                "airlineWebsite": 
                "https://www.airasia.com'
             }
      ]
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

2. Failure Response
```plain
{"errorCode":1,"errorMsg":"Failure Reason"}
```