# AcceptScheduleChange

### 1 Document Description
#### 1.1 Function Description
Through AcceptScheduleChange API, you are able to accept a the schedule change by passenger. Sensitivity Level in the schedule change message indicated whether it required to be accept or not. Airline may cancel the seat due to passenger does not accept schedule change. It is highly appreciated to use this API to accept schedule change.

#### 1.2 Target Reader
The AcceptScheduleChange API document targets developers who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: http://api.pkfare.com/scheduleChange/acceptScheduleChange

Address in production environment: http://pending.com/scheduleChange/acceptScheduleChange
`Note` PKFARE will provide production domain after Buyer Partners finish integration and co-test. Please replace 'pending.com' with the domain which PKFARE provides individually.

#### 1.5 Request Type
POST

#### 1.6 Request Header
|  key      |  value      |
|----|----|
|  Content-Type      |  application/json;charset=UTF-8      |

### 2.Request Parameter
#### 2.1 Parameter Construction
Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted
##### 2.1.1 Basic Request
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   authentication       |   object       |   Yes        |   Partner ID and signature, refer to 2.1.2.             |   -          |
|   data            |   object      |   Yes        |  request, refer to 2.1.3.       |   -          |

##### 2.1.2 Authentication
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   partnerId       |   String       |   Yes        |   Partner ID                   |   -          |
|   sign            |   String       |   Yes        |  Signature, refer to 4.1 and 4.2       |   -          |


##### 2.1.3 Data
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   messageId       |   String       |   Yes    |  PKFARE message ID. You can get specific message by indicating the messageId       |   1075841601001          |
|   email       |   String       |   Yes    |  Email address for contacting after we completed accpeting schedule change procedure       |   abc@abc.com         |
|   passengers      |   Array       |   Yes    |  Passenger information who accept the schedule change       |   -          |

##### 2.1.4 Passengers
| Name          | Type    | Required or Not   | Parameter Description                        | Sample |
| ------------- | ------- | ----------------- | -------------------------------------------- | ------ |
|   lastName     |   String       |   Yes      |   Last name       | wang       |
|   firstName       |   String        |   Yes      |  First name    | jia    |
|   birthday     |   String       |   Yes    |  Date of birth [yyyy-mm-dd]       | 1988-10-10     |
|   sex     |   String       |   Yes      |   Gender, M - male, F - Female. Refer to 5.4    |   M     |
|   psgType     |   String       |   Yes      |   ADT - adult, CHD - child , INF-Infant. Refer to 5.3   |   CHD     |
|   cardType    |   String       |   No      |   Travel document type. Refer to 5.2    |   P     |
|   cardNum    |   String       |   No      |   Travel document number    |   P78921345     |
|   cardExpiredDate    |   String       |   No      |   Travel document expiration date, [yyyy-mm-dd]    |   2025-03-03     |
|   nationality    |   String       |   Yes      |   Nationality of the passenger, 2 letters country code    |   CN     |

#### 2.2 Request Sample
##### 2.2.1 JSON Format Sample

```
{
    "data": {
        "messageId": "2944666",
        "email": "jaylee.li@pkfare.com",
        "passengers": [
            {
                "birthday": "2003-04-20",
                "firstName": "CHRISTOPHER",
                "lastName": "KING",
                "nationality": "US",
                "psgType": "ADT", 
                "sex": "M",
                "cardType":"P",
                "cardNum":"P76541234",
                "cardExpiredDate":"2025-05-10"
            }
        ]
    },
    "authentication": {
        "partnerId": "RksVSX7PfZmWYsCD7M4=",
        "sign": "17e707b5d9dae8459065dbb139e5f1bd"
    }
}
```
##### 2.2.2 Base64 Encryption
Use BASE64 to encode request, and get result as below:
```
ewogICAgImRhdGEiOiB7CiAgICAgICAgIm1lc3NhZ2VJZCI6ICIyOTQ0NjY2IiwKICAgICAgICAiZW1haWwiOiAiamF5bGVlLmxpQHBrZmFyZS5jb20iLAogICAgICAgICJwYXNzZW5nZXJzIjogWwogICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAiYmlydGhkYXkiOiAiMjAwMy0wNC0yMCIsCiAgICAgICAgICAgICAgICAiZmlyc3ROYW1lIjogIkNIUklTVE9QSEVSIiwKICAgICAgICAgICAgICAgICJsYXN0TmFtZSI6ICJLSU5HIiwKICAgICAgICAgICAgICAgICJuYXRpb25hbGl0eSI6ICJVUyIsCiAgICAgICAgICAgICAgICAicHNnVHlwZSI6ICJBRFQiLCAKICAgICAgICAgICAgICAgICJzZXgiOiAiTSIsCiAgICAgICAgICAgICAgICAiY2FyZFR5cGUiOiJQIiwKICAgICAgICAgICAgICAgICJjYXJkTnVtIjoiUDc2NTQxMjM0IiwKICAgICAgICAgICAgICAgICJjYXJkRXhwaXJlZERhdGUiOiIyMDI1LTA1LTEwIgogICAgICAgICAgICB9CiAgICAgICAgXQogICAgfSwKICAgICJhdXRoZW50aWNhdGlvbiI6IHsKICAgICAgICAicGFydG5lcklkIjogIlJrc1ZTWDdQZlptV1lzQ0Q3TTQ9IiwKICAgICAgICAic2lnbiI6ICIxN2U3MDdiNWQ5ZGFlODQ1OTA2NWRiYjEzOWU1ZjFiZCIKICAgIH0KfQ==
```

##### 2.2.3 Sending Encrypted Request Sample
This sample is for reference only:
```
http://pending.com/AcknowledgeScheduleChange?param=ewogICAgImRhdGEiOiB7CiAgICAgICAgIm1lc3NhZ2VJZCI6ICIyOTQ0NjY2IiwKICAgICAgICAiZW1haWwiOiAiamF5bGVlLmxpQHBrZmFyZS5jb20iLAogICAgICAgICJwYXNzZW5nZXJzIjogWwogICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAiYmlydGhkYXkiOiAiMjAwMy0wNC0yMCIsCiAgICAgICAgICAgICAgICAiZmlyc3ROYW1lIjogIkNIUklTVE9QSEVSIiwKICAgICAgICAgICAgICAgICJsYXN0TmFtZSI6ICJLSU5HIiwKICAgICAgICAgICAgICAgICJuYXRpb25hbGl0eSI6ICJVUyIsCiAgICAgICAgICAgICAgICAicHNnVHlwZSI6ICJBRFQiLCAKICAgICAgICAgICAgICAgICJzZXgiOiAiTSIsCiAgICAgICAgICAgICAgICAiY2FyZFR5cGUiOiJQIiwKICAgICAgICAgICAgICAgICJjYXJkTnVtIjoiUDc2NTQxMjM0IiwKICAgICAgICAgICAgICAgICJjYXJkRXhwaXJlZERhdGUiOiIyMDI1LTA1LTEwIgogICAgICAgICAgICB9CiAgICAgICAgXQogICAgfSwKICAgICJhdXRoZW50aWNhdGlvbiI6IHsKICAgICAgICAicGFydG5lcklkIjogIlJrc1ZTWDdQZlptV1lzQ0Q3TTQ9IiwKICAgICAgICAic2lnbiI6ICIxN2U3MDdiNWQ5ZGFlODQ1OTA2NWRiYjEzOWU1ZjFiZCIKICAgIH0KfQ==
```

### 3. Response Parameter
#### 3.1 Response Parameter Construction
Response in structuralized in `JSON` format. For concrete fields, please refer to the following tables.


##### 3.1.1 Basic Parameter
| Name          | Type    | Parameter Description                        | Sample |
| ------------- | ------- |  -------------------------------------------- | ------ |
|   errorCode       |   String       |   Error Code, refer to 5.1                              |   0          |
|   errorMsg        |   String       |   Error Message                                    |   OK         |


#### 3.2 Response Example
##### 3.2.1 Normal Response
```
{
    "errorCode":"0",
    "errorMsg":"ok"
}
```
##### 3.2.2 Error Response
```
{
    "errorCode": "P001",
    "errorMsg": "Invalid authentication."
}
```
### 4 Signature
#### 4.1 Parameters for Signature
partnerId,partnerKey

#### 4.2 Signature
Combine partnerId and partnerKey to make MD5 encryption on the final value.

Sign = MD5(partnerId+partnerKey)

```
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
### 5 Appendix
#### 5.1 Error Code List
|   errorCode       |   errorMsg                        |    Description                             |
|----|----|----|
|   0               |   ok                                             |   Request has been processed successfully.                       |
|   S001            |   System error                                   |   System error.                          |
|   P001            |   xxx is illegal                          |   Request parameter is illegal, xxx will display request parameter           |
|   B002            |   Partner is not exists                                 |   Partner does not exist.                    |
|   B003            |   Illegal sign                                   |   Illegal sign.               |
|   B037            |    Order is not exists.       |   Order does not exist.                 |
|   B048            |    Invalid buyer       |   Buyer is invalid.                 |
|   B130            |    Message is not exist.       |   Schedule change message does not exist.                 |
|   B131            |    Accept reject, duplicated to accept schedule change.       |   One passenger is allowed to accept once, if the passenger accept again, this message will be returned.                 |
|   B132            |    Accept reject, wrong passenger indicated.       |   The passenger is not in the order, please kindly check.                 |
|   B133            |    Accept reject, flight has departured.       |   After flight is departured, system will not allow to accept.                 |
|B186|The flight change has been confirmed and is already being processed. Please kindly contact online service for help.|The flight change has been confirmed and is already being processed.|
|B187|Infant confirmation cannot be done separately.|Infant confirmation cannot be done separately.|

#### 5.2 Type of Travel Document
| Enum   | Description   |
|----|----|
|  P       |  Passport    |
|  N       |  Chinese Identity    |
|  O       | Others    |

#### 5.3 Passenger Type
| Enum   | Description   |
|----|----|
|  ADT     |  adult         |
|  CHD     |  children[2-12 years old]  |

#### 5.4 Gender
| Enum   | Description   |
|----|----|
|  M       |  Male    |
|  F       |  Female    |

</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>