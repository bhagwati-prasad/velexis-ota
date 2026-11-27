# VoidRequest

## VoidRequest 

Please use VoidRequest_v2, this service will offline soon
### 1 Document Description
#### 1.1 Function Description
Through VoidRequest API, users could apply for voiding tickets after tickets are issued. Passengers that are included in the order are allowed to void ticket if void service time is available.  Please refer to void service time that is provided in `TicketingNumPush_V2` API.

#### 1.2 Target Reader
The VoidRequest API document targets developers who work in the fields of network development, maintenance as well as management, and they should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: not supported yet.
Address in production environment: https://pending.com/voiding
</br>
### 2 Request Parameter
Request should be structuralized in JSON format.
#### 2.1 Parameter Construction
##### 2.1.1 Authentication
| Name      | Type   | Required or Not | Description                     | Sample |
| --------- | ------ | --------------- | ------------------------------- | ------ |
| partnerId | String | Yes             | partner ID                      | -      |
| sign      | string | Yes             | signature, refer to 4.1 and 4.2 | -      |

##### 2.1.2 VoidRequest
| Name       | Type  | Required or Not | Description                                                  | Sample     |
| ---------- | ----- | --------------- | ------------------------------------------------------------ | ---------- |
| orderNum   | Long  | Yes             | [PKFARE] order Number                                        | 1012694529 |
| passengers | Array | No              | passengers that request to void. Refer to 2.1.2.1. Please make sure that void service time is available | -          |

##### 2.1.2.1 Passengers
| Name      | Type   | Required or Not | Description                        | Sample |
| --------- | ------ | --------------- | ---------------------------------- | ------ |
| cardType  | String | Yes             | travel document type. Refer to 5.2 | P      |
| cardNum   | String | Yes             | travel document number             | P123   |
| lastName  | String | Yes             | last name                          | WANG   |
| firstName | String | Yes             | first name                         | JANGO  |

#### 2.2 Request Sample
##### 2.2.1 Request Structure
```
{
    "authentication": {
        "partnerId": "sVSX7PfZm1yF04adBWYfCD7M4=",
        "sign": "e707b5d9dae8459085dbb139e5f1bd"
    },
    "voidRequest": {
        "orderNum": 1234568788,
        "passengers": [
          {
            "cardType": "P",
            "cardNum": "G1234567",
            "lastName": "SMITH",
            "firstName": "JOHN"
          },
          {
            "cardType": "P",
            "cardNum": "G1357902",
            "lastName": "SMITH",
            "firstName": "MARY"
          }
        ]
    }
}
```

##### 2.2.2 BASE64 Encryption
```
eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sInNlYXJjCI6eyJhZHVsdHMiOjEsImFpcmxpbmUiOiIiLCJjaGlsZHJlbiI6MCwiaW5mY9teSIsImRlcGFydHVyZURhdGUiOiIyMDE2LTAxLTIzIiwiZGVzdGluYXRpb24iOiJCSlMiLCJvcmlnaW4iOiJIS0cifV0sInNvbHV0aW9ucyI6MjB9fQ=
```

##### 2.2.3 Request Sample
```
http://api.pkfare.com/voiding?param=eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJSa3NWU1g3UGZabTF5RjA0YWRCV1lzQ0Q3TTQ9Iiwic2lnbiI6IjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIn0sInNlYXJjaCI6eyJhZHVsdHMiOjEsImFpcmxpbmUiOiIiLCJjaGlsZHJlbiI6MCwiaW5mY9teSIsImRlcGFydHVyZURhdGUiOiIyDE2LTAxLTIzIiwiZGVzdGluYXRpb24iOiJCSlMiLCJvcmlnaW4iOiJIS0cifV0sInNvbHV0aW9ucyI6MjB9fQ=
```
</br>
### 3 Response Parameter
The data returned is in JSON format. For specific fields, please refer to following charts.

#### 3.1 Response Parameter Construction
| Name      | Type   | Parameter Description                                        | Sample |
| --------- | ------ | ------------------------------------------------------------ | ------ |
| errorCode | String | error code. Refer to 5.1                                     | 0      |
| errorMsg  | String | error message                                                | ok     |
| data      | Object | return data. Not empty when error code is '0'. Refer to 3.1.1 | -      |

##### 3.1.1 Data
| Name         | Type  | Parameter Description                                        | Sample     |
| ------------ | ----- | ------------------------------------------------------------ | ---------- |
| orderNum     | Long  | [PKFARE] order Number                                        | 1012694529 |
| voidOrderNum | Long  | [PKFARE] void order number (after a void request is submitted, a void order would be generated in PKFARE system) | 1012694589 |
| passengers   | Array | passengers that request to void. Refer to 3.1.1.1. Please make sure that void service time is available | -          |

##### 3.1.1.1 Passengers
| Name      | Type   | Parameter Description              | Sample |
| --------- | ------ | ---------------------------------- | ------ |
| cardType  | String | travel document type. Refer to 5.2 | P      |
| cardNum   | String | travel document number             | P123   |
| lastName  | String | last name                          | WANG   |
| firstName | String | first name                         | JANGO  |

#### 3.2 Response Sample
##### 3.2.1 Normal Response
```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
      "orderNum": 1234568788,
      "voidOrderNum": 1432558799,
      "passengers": [
          {
            "cardType": "P",
            "cardNum": "G1234567",
            "lastName": "SMITH",
            "firstName": "JOHN"
          },
          {
            "cardType": "P",
            "cardNum": "G1357902",
            "lastName": "SMITH",
            "firstName": "MARY"
          }
       ]
    }
}
```

##### 3.2.2 Error Response
```
{
    "errorCode": "P001", 
    "errorMsg": "Invalid authentication.", 
    "data": null
}
```
</br>
### 4 Signature
#### 4.1 Parameters for Signature
partnerId, partnerKey

#### 4.2 Signature
Combine partnerId and partnerKey to make an MD5 encryption on final value.
Sign = MD5 (partnerId + partnerKey).
```
e.g.
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
</br>

### 5 Appendix
#### 5.1 Error Code List

| errorCode | errorMsg | Description   |
| --------- | ----------------------------------- | ------------------------------------------------------- |
| 0         | ok                                                           | request has been processed successfully                      |
| S001      | System error                                                 | system error                                                 |
| P001      | -                                                            | wrong parameter                                              |
| B002      | Partner is not exists                                        | partnerID does not exist                                     |
| B003      | Illegal sign                                                 | illegal sign. Please check your signature                    |
| V001      | Illegal void time                                            | voiding deadline has passed                                  |
| V002      | passenger(s) not allowed to void. Origin order has no ADT remain | voiding request is rejected. If there are partial passengers submitting voiding request, one adult at least should be remain in original order. |
| O001      | passenger does not match the order                           | passenger information does not match original order          |
| O002      | passenger(s) not allowed to submit request, there is an order with a state of "XXX", order number: XXX | passenger(s) is not allowed to submit voiding request due to on-going after-sale procedure |
| O003      | order create failed                                          | order create failed                                          |
| B010      | order does not exist                                         | order does not exist                                         |

#### 5.2 Travel Document Type
| Enum | Description     |
| ---- | --------------- |
| P    | passport        |
| N    | Chinese ID card |
| O    | others          |
</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>