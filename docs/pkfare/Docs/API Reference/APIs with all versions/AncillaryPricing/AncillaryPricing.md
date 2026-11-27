# AncillaryPricing

## 1 Document Description
### 1.1 Function Description
Through AncillaryPricing API, it is able to get a list of ancillary services with its price. When request for ancillary price, the passengers and journeys is requried. AncillaryPricing is same request structure as precisePricing.
`Note:` AncillaryPricing has dependence with PrecisePricing or PrecisePricing_V2.
`Note:` It is necessary to use PrecisePricing or PrecisePricing_V2 service before using this internface. The whole process should be limited to 30 mins.

### 1.2 Target Reader
The AncillaryPricing API document targets people who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of following programming language, such as ASP, PHP, JAVA, ASP.NET or SQL.

### 1.3 Character Encoding
The character code of this API is UTF-8.

### 1.4 Invoking Address
Address in test environment: https://api.pkfare.com/ancillaryPricing
Address in production environment: https://pending.com/ancillaryPricing

## 2 Request Parameter
### 2.1 Parameter Construction
Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted.
|Name |Type |Required or Not |Description |Sample |
|:--|
|authentication |object |Yes |authentication information |- |
|pricing |object |Yes |ancillary pricing data |- |
authentication element
|Name |Type |Required or Not |Description |Sample |
|:--|
|partnerId |string |Yes |partner id |- |
|sign |string |Yes |MD5(partnerId+partnerKey) |- |
pricing element
|Name |Type |Required or Not |Description |Sample |
|:--|
|ancillary |array |Yes |ancillary type; 1-baggage |1 |
|adults |integer |Yes |adult passenger number |1 |
|children |integer |Yes |children passenger number |0 |
|journeys |object |Yes |itinerary information |- |
journeys element
|Name |Type |Required or Not |Description |Sample |
|:--|
|journey_0 |array |Yes |outbound |- |
|journey_1 |array |No |inbound |- |
journey element
|Name |Type |Required or Not |Description |Sample |
|:--|
|airline |string |Yes |airline code |FD |
|departure |string |Yes |origin[IATA airport code] |DMK |
|departureDate |string |Yes |departure date[yyyy-MM-dd] |2022-10-01 |
|departureTime |string |No |departure time[hh:mm] |09:55 |
|arrival |string |Yes |destination[IATA airport code] |CNX |
|arrivalDate |string |Yes |arrival date[yyyy-MM-dd] |2022-10-01 |
|arrivalTime |string |No |arrival time[hh:mm] |11:25 |
|flightNum |string |Yes |flight number |513 |
|bookingCode |string |Yes |cabin code |N |
|fareBasis |string |No |fare basis code |YMR |

### 2.2 Request Sample
#### 2.2.1 JSON Format Sample
Case 1: Round trip journey sample as following
```
{
    "authentication": {
        "partnerId":"C4cn5nhgyUodlm+3tXKT/nduw=",
        "sign":"aac36a9b4a1ebfa12c9bf3f81fffdc"
    },
    "pricing": {
        "adults": 1,
        "children": 0,
        "ancillary": [
            1
        ],
        "journeys": {
            "journey_0": [
                {
                    "airline":"TR",
                    "arrival":"HKG",
                    "arrivalDate":"2022-04-23",
                    "arrivalTime":"10:05",
                    "bookingCode":"O",
                    "departure":"SIN",
                    "departureDate":"2022-04-23",
                    "departureTime":"06:00",
                    "flightNum":"980"
                }
            ],
            "journey_1": [
                {
                    "airline":"TR",
                    "arrival":"SIN",
                    "arrivalDate":"2022-04-25",
                    "arrivalTime":"14:50",
                    "bookingCode":"W",
                    "departure":"HKG",
                    "departureDate":"2022-04-25",
                    "departureTime":"10:55",

                    "flightNum":"981"
                }
            ]
        }
    }
}
```

#### 2.2.2 Base64 Encryption
Use BASE64 to encode request from Case 1:
```
ewogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAicFFDNGNuNW5oZ3lVb2RsbSszdFhLVC9uZHV3PSIsCiAgICAgICAgInNpZ24iOiAiMmFhYWMzNmE5YjRhMWViZmExMmM5YmYzZjgxZmZmZGMiCiAgICB9LAogICAgInByaWNpbmciOiB7CiAgICAgICAgImFkdWx0cyI6IDEsCiAgICAgICAgImNoaWxkcmVuIjogMCwKICAgICAgICAiYW5jaWxsYXJ5IjogWwogICAgICAgICAgICAxCiAgICAgICAgXSwKICAgICAgICAiam91cm5leXMiOiB7CiAgICAgICAgICAgICJqb3VybmV5XzAiOiBbCiAgICAgICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAgICAgImFpcmxpbmUiOiAiVFIiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsIjogIkhLRyIsCiAgICAgICAgICAgICAgICAgICAgImFycml2YWxEYXRlIjogIjIwMjItMDQtMjMiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsVGltZSI6ICIxMDowNSIsCiAgICAgICAgICAgICAgICAgICAgImJvb2tpbmdDb2RlIjogIk8iLAogICAgICAgICAgICAgICAgICAgICJkZXBhcnR1cmUiOiAiU0lOIiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlRGF0ZSI6ICIyMDIyLTA0LTIzIiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlVGltZSI6ICIwNjowMCIsCiAgICAgICAgICAgICAgICAgICAgImZsaWdodE51bSI6ICI5ODAiCiAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgIF0sCiAgICAgICAgICAgICJqb3VybmV5XzEiOiBbCiAgICAgICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAgICAgImFpcmxpbmUiOiAiVFIiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsIjogIlNJTiIsCiAgICAgICAgICAgICAgICAgICAgImFycml2YWxEYXRlIjogIjIwMjItMDQtMjUiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsVGltZSI6ICIxNDo1MCIsCiAgICAgICAgICAgICAgICAgICAgImJvb2tpbmdDb2RlIjogIlciLAogICAgICAgICAgICAgICAgICAgICJkZXBhcnR1cmUiOiAiSEtHIiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlRGF0ZSI6ICIyMDIyLTA0LTI1IiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlVGltZSI6ICIxMDo1NSIsCiAgICAgICAgICAgICAgICAgICAgImZsaWdodE51bSI6ICI5ODEiCiAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgIF0KICAgICAgICB9CiAgICB9Cn0=
```

## 3 Response Parameter
### 3.1 Parameter Construction
|Name |Type |Description |Sample |
|:--|
|errorCode |string |error code |0 |
|errorMsg |string |error message |OK |
|data |object |returned data, will not be empty when error code is “0” |- |
data element
|Name |Type |Description |Sample |
|:--|
|ancillary |object |ancillary data |- |
|ancillaryType |integer |ancillary type; 1-baggage |1 |
ancillary element
|Name |Type |Description |Sample |
|:--|
|journeys |object |itinerary information |- |
|ancillaries |object |ancillary information |- |
ancillaries element
|Name |Type |Description |Sample |
|:--|
|baggage |array |baggage details |- |
baggage element
|Name |Type |Description |Sample |
|:--|
|ancillaryKey |string |unique identification of ancillary |62613b9298386105acb75ed148af00cb |
|payBaggageType |integer |baggage type; 1-checked baggage, 2-carry-on baggage |1 |
|baggagePiece |integer |baggage piece; -1 - no limit to baggage piece |1 |
|baggageWeight |integer |baggage weight |20KG |
|baggageCurrency |string |currency |CNY |
|baggagePrice |bigdecimal |price |198.00 |
|description |string |baggage description |- |
journey element
|Name |Type |Description |Sample |
|:--|
|airline |string |airline code |FD |
|departure |string |origin[IATA airport code] |DMK |
|departureDate |string |departure date[yyyy-MM-dd] |2022-10-01 |
|departureTime |string |departure time[hh:mm] |09:55 |
|arrival |string |destination[IATA airport code] |CNX |
|arrivalDate |string |arrival date[yyyy-MM-dd] |2022-10-01 |
|arrivalTime |string |arrival time[hh:mm] |11:25 |
|flightNum |string |flight number |513 |
|bookingCode |string |cabin code |N |

### 3.2 Response Sample
#### 3.2.1 Success Response
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

#### 3.2.2 Failure Response
```
{
    "errorCode": "P001",
    "errorMsg": "Invalid authentication.",
    "data": null
}
```

## 4 Signature
### 4.1 Parameters for Signature
partnerId, partnerKey

### 4.2 Signature
Combine partnerId and partnerKey to make an MD5 encryption on final value.
Sign = MD5(partnerId+partnerKey)
```
e.g.
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```

## 5 Appendix
### 5.1 Error Code List
|errorCode |errorMsg |Description |
|:--|:--|:--|
|0 |ok |Request has been processed successfully. |
|S001 |System error |System error. |
|P001 |XXX is illegal |Parameter is illegal. |
|P002 |XXX is missing |Parameter is missing. |
|P006 |Invalid parameter |Wrong parameter, please check. |
|B002 |Partner is not exists |Partner ID does not exist. |
|B003 |Illegal sign |Illegal sign, please check your signature. |
|B005 |Can not find any matching precisePricing result within 30 minutes |Can not find the corresponding precisePricing record. Please check the itinerary and passenger numbers. AncillaryPricing has to be invoked within 30 minutes after pricing. |
|B069 |AncillaryPricing is offline-1 |The AncillaryPricing API is offline, please contact PKFARE to enable it. |
|B070 |No ancillary price on this routing |No ancillary price for this routing. |

</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>