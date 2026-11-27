# ChangePassengerInfo

### 1 Document Description

### 1.1 Function

This API is used for raising change request for changing passenger information. User can indicate order number, booked passenger(s) and new passenger(s) to create a change request. Order number is refer to PKFARE order number, the change is able to raise base on issued order or change order.
 
`Note`: This API provides Postman examples, which you can obtain by contacting your account manager.
### 1.2 Target Reader

The Change Passenger Info interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Nodes.js, and a basic knowledge of HTTP network protocols.
 
### 1.3 Character Encoding

The character code of this API is `UTF-8`.
 
### 1.4 URLs


|Environment |URL |
|----|----|
|Test environment |[https://api.pkfare.com](http://api.pkfare.com)/change/changePassengerInfo |
|Prod environment |https://{{apiHost}}/change/changePassengerInfo |

 
`Notes` The production environment call address is provided after you finish the API development and testing, and before the official launch. You can replace the {{apiHost}} in the production environment call address with the provided domain name.
 
### 1.5 Http Method

POST
### 1.6 Request Header


|key |value |
|----|----|
|Content-Type |application/x-www-form-urlencoded |

### 1.7 Response Header


|key |value |
|----|----|
|Content-type |application/json |

 
### 2.Request

### 2.1 Schema


|name |description |type |
|----|----|
|param |The value after Base64 encoding the Basic Request. The Basic Request is a JSON-structured data, and the details explanation is provided in the following text. |Text |

 
### 2.1.1 Basic Request

sample

```
{
    "authentication": {
        "partnerId": "qiE0YKcJlXjks5o=",
        "sign": "d53d44ea48e69047b7c"
    },
    "data": {
        "orderNum": 916974267198317218,
        "buyerOrder": "123321",
        "remark": "test remark bob ",
        "uploadedFileIds": [
            "950efc964a678536e1555729c11745eb",
            "22851ce436c38ca6e1555729c11745eb",
            "8ebf03c5ed8862f4e1555729c11745eb"
        ],
        "passengerList": [
            {
                "originPassengerInfo": {
                    "lastName": "YANGA",
                    "firstName": "TIFFANY",
                    "nationality": "CN",
                    "sex": "F",
                    "birthday": "1990-08-23",
                    "cardType": "P",
                    "cardNum": "E07700466",
                    "cardExpiredDate": "2024-03-17"
                },
                "changePassengerInfo": {
                    "lastName": "YANGA",
                    "firstName": "TIFFANY",
                    "nationality": "US",
                    "sex": "F",
                    "birthday": "1990-08-23",
                    "cardType": "P",
                    "cardNum": "E07700466",
                    "cardExpiredDate": "2024-03-17"
                }
            }
        ],
        "contact": {
            "telNum": "",
            "name": "",
            "email": ""
        }
    }
}
```
 
 
| Name     | Type    | Required or Not  | Parameter Description              | Sample    |
|----|----|----|----|----|
|authentication |Object |Yes |Identity information, refer to 2.1.2 |- |
|data |Object |Yes |File information, refer to 2.1.3 |- |

 
 
### 2.1.2 Authentication


| Name         | Type      | Required or Not  | Parameter Description              |Sample    |
|----|----|----|----|----|
|partnerId |String |Yes |Partner ID |qiE0YKcJlXjknkCkZKhzIis5o= |
|sign |String |Yes |Signature, sign=MD5(partnerId+partnerKey), refer to 4.1 and 4.2 for the signature method. |d53d44ea413c40d5f1d18e69047b7c |

 
### 2.1.2 Data

| Name          | Type      | Required or Not  | Parameter Description          | Sample    |
|----|----|----|----|----|
|orderNum |String |Yes |Order Number |915687075841601001 |
|buyerOrder |String |No |Buyer order number. If you would like PKFARE to store your order, please kindly put it in this element. | |
|remark |String |No |Remark to support reason (maximum 500 characters) | |
|uploadedFileIds |Arrary |No |Uploaded file ID(maximum 99 files per request) | |
|passengerList |Array |Yes |Passengers who you want to change,refer to 2.1.4 |- |
|contact |Object |N |Contact information of this change request. If leave as blank, contact of origin order will be used | |

### 2.1.3 passengerList


| Name          | Type      | Required or Not  | Parameter Description          | Sample    |
|----|----|----|----|----|
|originPassengerInfo |Array |Yes |Booked passenger information |- |
|changePassengerInfo |Array |Yes |Passegner information after changed | |

 
### 2.1.4 originPassengerList


| Name          | Type      | Required or Not  | Parameter Description         | Sample    |
|----|----|----|----|----|
|lastName |String |Yes |Last name |Wang |
|firstName |String |Yes |First name |Jango |
|nationality |String |Yes |Nationality |CN |
|sex |String |Yes |Gender |M |
|birthday |String |Yes |Date of birth |2015-01-10 |
|cardType |String |No |Travel document type, which used for creating the booking. |P |
|cardNum |String |No |Travel document number, which used for creating the booking. |G2568574 |
|cardExpiredDate |String |No |Travel document expired date, which used for creating the booking |2030-01-10 |

 
### 2.1.5 ChangePassengerInfo


| Name          | Type      | Required or Not | Parameter Description          | Sample    |
|----|----|----|----|----|
|lastName |String |Yes |Last name |Wang |
|firstName |String |Yes |First name |Jango |
|nationality |String |Yes |Nationality |CN |
|sex |String |Yes |Gender |M |
|birthday |String |Yes |Date of birth |2015-01-10 |
|cardType |String |No |Travel document type, which used for creating the booking. |P |
|cardNum |String |No |Travel document number, which used for creating the booking. |G2568574 |
|cardExpiredDate |String |No |Travel document expired date, which used for creating the booking |2030-01-10 |

### 2.1.7 Contact


| Name          | Type      | Required or Not  | Parameter Description          | Sample    |
|----|----|----|----|----|
|name |String |No |Contact name |Jonathan Wong |
|email |String |No |Email address |jonathan.wong@pkfare.com |
|telNum |String |No |Telephone number |65098716 |

 
 
### 2.2 Sample of Request Construction Process

### 2.2.1 Request Sample

 

```
{
    "authentication": {
        "partnerId": "qiE0YKcJlXjknkCkZKhzIis5o=",
        "sign": "d53d44ea413c40d5f1d18e69047b7c"
    },
    "data": {
        "orderNum": 916974267198317218,
        "buyerOrder": "123321",
        "remark": "test remark bob ",
        "uploadedFileIds": [
            "950efc964a678536e1555729c11745eb",
            "22851ce436c38ca6e1555729c11745eb",
            "8ebf03c5ed8862f4e1555729c11745eb"
        ],
        "passengerList": [
            {
                "originPassengerInfo": {
                    "lastName": "YANGA",
                    "firstName": "TIFFANY",
                    "nationality": "CN",
                    "sex": "F",
                    "birthday": "1990-08-23",
                    "cardType": "P",
                    "cardNum": "E07700466",
                    "cardExpiredDate": "2024-03-17"
                },
                "changePassengerInfo": {
                    "lastName": "YANGA",
                    "firstName": "TIFFANY",
                    "nationality": "US",
                    "sex": "F",
                    "birthday": "1990-08-23",
                    "cardType": "P",
                    "cardNum": "E07700466",
                    "cardExpiredDate": "2024-03-17"
                }
            }
        ],
        "contact": {
            "telNum": "",
            "name": "",
            "email": ""
        }
    }
}
```
 
 
### 2.2.2 Base64 Encryption

Use BASE64 to encode results from 2.2.1:
 `ewogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiSEpxaUUwWUtjSmxYamtua0NrWktoeklpczVvPSIsCiAgICAgICAgInNpZ24iOiAiZmVkNTNkNDRlYTQxM2M0MGQ1ZjFkMThlNjkwNDdiN2MiCiAgICB9LAogICAgImRhdGEiOiB7CiAgICAgICAgIm9yZGVyTnVtIjogOTE2OTc0MjY3MTk4MzE3MjE4LAogICAgICAgICJidXllck9yZGVyIjogIjEyMzMyMSIsCiAgICAgICAgInJlbWFyayI6ICJ0ZXN0IHJlbWFyayBib2IgIiwKICAgICAgICAidXBsb2FkZWRGaWxlSWRzIjogWwogICAgICAgICAgICAiOTUwZWZjOTY0YTY3ODUzNmUxNTU1NzI5YzExNzQ1ZWIiLAogICAgICAgICAgICAiMjI4NTFjZTQzNmMzOGNhNmUxNTU1NzI5YzExNzQ1ZWIiLAogICAgICAgICAgICAiOGViZjAzYzVlZDg4NjJmNGUxNTU1NzI5YzExNzQ1ZWIiCiAgICAgICAgXSwKICAgICAgICAicGFzc2VuZ2VyTGlzdCI6IFsKICAgICAgICAgICAgewogICAgICAgICAgICAgICAgIm9yaWdpblBhc3NlbmdlckluZm8iOiB7CiAgICAgICAgICAgICAgICAgICAgImxhc3ROYW1lIjogIllBTkdBIiwKICAgICAgICAgICAgICAgICAgICAiZmlyc3ROYW1lIjogIlRJRkZBTlkiLAogICAgICAgICAgICAgICAgICAgICJuYXRpb25hbGl0eSI6ICJDTiIsCiAgICAgICAgICAgICAgICAgICAgInNleCI6ICJGIiwKICAgICAgICAgICAgICAgICAgICAiYmlydGhkYXkiOiAiMTk5MC0wOC0yMyIsCiAgICAgICAgICAgICAgICAgICAgImNhcmRUeXBlIjogIlAiLAogICAgICAgICAgICAgICAgICAgICJjYXJkTnVtIjogIkUwNzcwMDQ2NiIsCiAgICAgICAgICAgICAgICAgICAgImNhcmRFeHBpcmVkRGF0ZSI6ICIyMDI0LTAzLTE3IgogICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgICAgICJjaGFuZ2VQYXNzZW5nZXJJbmZvIjogewogICAgICAgICAgICAgICAgICAgICJsYXN0TmFtZSI6ICJZQU5HQSIsCiAgICAgICAgICAgICAgICAgICAgImZpcnN0TmFtZSI6ICJUSUZGQU5ZIiwKICAgICAgICAgICAgICAgICAgICAibmF0aW9uYWxpdHkiOiAiVVMiLAogICAgICAgICAgICAgICAgICAgICJzZXgiOiAiRiIsCiAgICAgICAgICAgICAgICAgICAgImJpcnRoZGF5IjogIjE5OTAtMDgtMjMiLAogICAgICAgICAgICAgICAgICAgICJjYXJkVHlwZSI6ICJQIiwKICAgICAgICAgICAgICAgICAgICAiY2FyZE51bSI6ICJFMDc3MDA0NjYiLAogICAgICAgICAgICAgICAgICAgICJjYXJkRXhwaXJlZERhdGUiOiAiMjAyNC0wMy0xNyIKICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgfQogICAgICAgIF0sCiAgICAgICAgImNvbnRhY3QiOiB7CiAgICAgICAgICAgICJ0ZWxOdW0iOiAiIiwKICAgICAgICAgICAgIm5hbWUiOiAiIiwKICAgICAgICAgICAgImVtYWlsIjogIiIKICAgICAgICB9CiAgICB9Cn0K` 
 
 ### 2.2.3 Post Request

This sample is for reference only:

```
POST http://api.pkfare.com/change/changePassengerInfo
Content-type: application/x-www-form-urlencoded


param=ewogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiSEpxaUUwWUtjSmxYamtua0NrWktoeklpczVvPSIsCiAgICAgICAgInNpZ24iOiAiZmVkNTNkNDRlYTQxM2M0MGQ1ZjFkMThlNjkwNDdiN2MiCiAgICB9LAogICAgImRhdGEiOiB7CiAgICAgICAgIm9yZGVyTnVtIjogOTE2OTc0MjY3MTk4MzE3MjE4LAogICAgICAgICJidXllck9yZGVyIjogIjEyMzMyMSIsCiAgICAgICAgInJlbWFyayI6ICJ0ZXN0IHJlbWFyayBib2IgIiwKICAgICAgICAidXBsb2FkZWRGaWxlSWRzIjogWwogICAgICAgICAgICAiOTUwZWZjOTY0YTY3ODUzNmUxNTU1NzI5YzExNzQ1ZWIiLAogICAgICAgICAgICAiMjI4NTFjZTQzNmMzOGNhNmUxNTU1NzI5YzExNzQ1ZWIiLAogICAgICAgICAgICAiOGViZjAzYzVlZDg4NjJmNGUxNTU1NzI5YzExNzQ1ZWIiCiAgICAgICAgXSwKICAgICAgICAicGFzc2VuZ2VyTGlzdCI6IFsKICAgICAgICAgICAgewogICAgICAgICAgICAgICAgIm9yaWdpblBhc3NlbmdlckluZm8iOiB7CiAgICAgICAgICAgICAgICAgICAgImxhc3ROYW1lIjogIllBTkdBIiwKICAgICAgICAgICAgICAgICAgICAiZmlyc3ROYW1lIjogIlRJRkZBTlkiLAogICAgICAgICAgICAgICAgICAgICJuYXRpb25hbGl0eSI6ICJDTiIsCiAgICAgICAgICAgICAgICAgICAgInNleCI6ICJGIiwKICAgICAgICAgICAgICAgICAgICAiYmlydGhkYXkiOiAiMTk5MC0wOC0yMyIsCiAgICAgICAgICAgICAgICAgICAgImNhcmRUeXBlIjogIlAiLAogICAgICAgICAgICAgICAgICAgICJjYXJkTnVtIjogIkUwNzcwMDQ2NiIsCiAgICAgICAgICAgICAgICAgICAgImNhcmRFeHBpcmVkRGF0ZSI6ICIyMDI0LTAzLTE3IgogICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgICAgICJjaGFuZ2VQYXNzZW5nZXJJbmZvIjogewogICAgICAgICAgICAgICAgICAgICJsYXN0TmFtZSI6ICJZQU5HQSIsCiAgICAgICAgICAgICAgICAgICAgImZpcnN0TmFtZSI6ICJUSUZGQU5ZIiwKICAgICAgICAgICAgICAgICAgICAibmF0aW9uYWxpdHkiOiAiVVMiLAogICAgICAgICAgICAgICAgICAgICJzZXgiOiAiRiIsCiAgICAgICAgICAgICAgICAgICAgImJpcnRoZGF5IjogIjE5OTAtMDgtMjMiLAogICAgICAgICAgICAgICAgICAgICJjYXJkVHlwZSI6ICJQIiwKICAgICAgICAgICAgICAgICAgICAiY2FyZE51bSI6ICJFMDc3MDA0NjYiLAogICAgICAgICAgICAgICAgICAgICJjYXJkRXhwaXJlZERhdGUiOiAiMjAyNC0wMy0xNyIKICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgfQogICAgICAgIF0sCiAgICAgICAgImNvbnRhY3QiOiB7CiAgICAgICAgICAgICJ0ZWxOdW0iOiAiIiwKICAgICAgICAgICAgIm5hbWUiOiAiIiwKICAgICAgICAgICAgImVtYWlsIjogIiIKICAgICAgICB9CiAgICB9Cn0K
```


### 3. Response

### 3.1 Response Sample


```
{
  "errorCode": "0",
  "errorMsg": "ok",
  "data": {
    "parentOrderNum": "916974267198317218",
    "orderNum": "916974267198317240",
    "refOrderNum": "9169742671983172",
    "createTime": "2023-10-16T20:21:55+08:00",
    "orderStatus": "Under review",
    "pnr": "5BDWCY",
    "platingCarrier": "UO",
    "passengers": [
      {
        "lastName": "YANGA",
        "firstName": "TIFFANY",
        "cardType": "PP",
        "cardNum": "E07700466",
        "cardExpiredDate": "2024-03-17",
        "nationality": "US",
        "psgType": "ADT",
        "sex": "F",
        "birthday": "1990-08-23"
      }
    ]
  }
}
```
 
### 3.2 Response Parameter


| Name         | Type      | Parameter Description                                 |Sample    |
|----|----|----|----|
|errorCode |String |Error code, refer to error code list 5.1 |0 |
|errorMsg |String |Error message |OK |
|warningMsg |String |Warning message | |
|data |Object |The return data, this parameter is not empty only when the errorCode retruns "0", refer to section 3.2.1 |- |

### 3.2.1 Data


| Name        | Type        | Parameter Description | Sample           |
|----|----|----|----|
|orderNum |String |Change order number | |
|parentOrderNum |String |PKFARE parent order number of this change order, it could be issued order number or change order number | |
|refOrderNum |String |PKFARE general order number, it may include more orders | |
|createTime |String |Order creation time, format yyyy-MM-dd HH:mm:ss(UTC+0) | |
|rejectedReason |String |Reject reason | |
|remarks |String |Reject remark | |
|orderStatus |String |Order status | |
|pnr |String |PNR of order | |
|airPnr |String |Airline PNR of order | |
|platingCarrier |String |Plating carrier | |
|lastTktTime |String |Latest ticketing time | |
|passengerPriceList |Array |Passenger pricing information |- |
|passengers |Array |Passenger information |- |

### 3.2.2 PassengerPriceList


| Name        | Type        | Parameter Description | Sample           |
|----|----|----|----|
|solutionId |String |Unique identification of this solution |- |
|solutionKey |String |Unique identification of this solution | |
|fareType |String |Fare type, PUBLIC or PRIVATE |PUBLIC |
|currency |String |Currency code |CNY |
|changeServiceFee |BigDecimal |Change service fee per passenger |50.00 |
|adtAdditionalFare |BigDecimal |Additional fare per adult | |
|adtAdditionalTax |BigDecimal |Additional tax per adult | |
|adtChangeFee |BigDecimal |Adult change fee which is charged per penalty or goverment in some special area | |
|adtChangeAmount |BigDecimal |Total change amount per adult | |
|chdAdditionalFare |BigDecimal |Additional fare per child | |
|chdAdditionalTax |BigDecimal |Additional tax per child | |
|chdChangeFee |BigDecimal |Child change fee which is charged per penalty or goverment in some special area | |
|chdChangeAmount |BigDecimal |Total change amount per child | |
|infAdditionalFare |BigDecimal |Additional fare per infant | |
|infAdditionalTax |BigDecimal |Additional tax per infant | |
|infChangeFee |BigDecimal |Infant change fee which is charged per penalty or goverment in some special area | |
|infChangeAmount |BigDecimal |Total change amount per infant | |
|totalChangeAmount |BigDecimal |Total change amount of this change request | |
|merchantFee |BigDecimal |Payment transaction fee | |

 
### 3.2.3 Passengers


|Name |Type |Parameter Description |Sample |
|----|----|----|----|
|lastName |String |Last name |WANG |
|firstName |String |First name |JANGO |
|cardType |String |Travel document type |P |
|cardNum |String |Travel document number |P1234567 |
|cardExpiredDate |String |Travel document expired date |2030-10-10 |
|nationality |String |Nationality |CN |
|psgType |String |Passenger type |ADT |
|sex |String |Gender |M |
|birthday |String |Date of birth |2015-01-10 |

 
 
### 4 Signature

### 4.1 Parameters

partnerId，partnerKey
 
### 4.2 Sign

Combine partnerId and partnerKey to make an MD5 encryption on final value.
Sign = MD5(partnerId+partnerKey)。

```
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
 
 
### 5 Appendix

 
### 5.1 Error Code List


| errorCode  | errorMsg           | Description                       |
|----|----|----|
|0 |ok |Request has been processed successfully. |
|S001 |System error |System error. |
|P001 |xxx is illegal |Parameter in the request is illegal. xxx will be replaced by the element name |
|P002 |xxx is missing |Parameter is not in the request, which is mandatory. xxx will be replaced by the element name. |
|P006 |Invalid parameter |Invalid parameter. |
|B002 |Partner is not exists |Partner is not exists. |
|B003 |Illegal sign |Illigal sign, please check signature session |
|B009 |Order status is invalid |Order status is not allow to change. |
|B037 |Order is not exist. |Order number is not exists. |
|B048 |Invalid buyer |Buyer is invalid, please contact with PKFARE administrator |
|B135 |Passenger or ticket number is not in the order |Passenger or ticket number in the request is not in the order. |
|B148 |UploadedFileId is not exist. |UploadedFileIds in the request is not exist. |
|B150 |The order was changed, please kindly use change order number. |The order was changed before. Please use the latest order number to raise change. |
|B152 |pnrList information is not same as order, please kindly check. |pnrList information is not same as order, please kindly check. |
|B156 |Order#[Order number] is not applicable for change |The order is neither origin order nor change order. Change request is not allowed. |
|B157 |Duplicate change has been found for passenger[passenger name] in order [order number] |A duplicated request is found, and  order for previous request was created succesfully. You are able to use order number in the message to request OrderDetails API for more information. |
|B162 |Change is not applicable for passenger xxx/xxx |Passenger has requested for void or refund, change is not allowed. |
|B163 |Ticket(s) [ticket number] is No-show, change is not applicable. |The ticket is noshow per airline rules, change is not allowed. |
|B164 |Passenger(s) must has same routing and request to change. If routing is varies, please request per passenger. |One of multiple Passenger(s) in the request has requested to change the routing. Change is not allow to raise togther. |
|B176 |Infant is not support for change. Please kindly contact online service for help. |Infant is not support for change. Please kindly contact online service for help. |

 
