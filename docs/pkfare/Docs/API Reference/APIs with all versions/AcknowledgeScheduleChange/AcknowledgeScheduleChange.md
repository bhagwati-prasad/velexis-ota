# AcknowledgeScheduleChange

### 1 Document Description
#### 1.1 Function Description
Through AcknowledgeScheduleChange API, you are able to remove a the schedule change message, which you do NOT want to get it from GetScheduleChange API.

#### 1.2 Target Reader
The AcknowledgeScheduleChange API document targets developers who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
Address in test environment: http://api.pkfare.com/scheduleChange/acknowledge 

Address in production environment: http://pending.com/scheduleChange/acknowledge 
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


#### 2.2 Request Sample
##### 2.2.1 JSON Format Sample

```
{
    "data": {
        "messageId":"123456"
    },
    "authentication": {
        "partnerId": "sVSX7PfZm1yF0D7M4=",
        "sign": "e707b5d9dae8459065dbb139e5f1bd"
    }
}
```
##### 2.2.2 Base64 Encryption
Use BASE64 to encode request, and get result as below:
```
ewogICAgImRhdGEiOiB7CiAgICAgICAgIm1lc3NhZ2VJZCI6IjEyMzQ1NiIKICAgIH0sCiAgICAiYXV0aGVudGljYXRpb24iOiB7CiAgICAgICAgInBhcnRuZXJJZCI6ICJSa3NWU1g3UGZabTF5RjBEN000PSIsCiAgICAgICAgInNpZ24iOiAiMTdlNzA3YjVkOWRhZTg0NTkwNjVkYmIxMzllNWYxYmQiCiAgICB9Cn0=
```

##### 2.2.3 Sending Encrypted Request Sample
This sample is for reference only:
```
http://pending.com/AcknowledgeScheduleChange?param=ewogICAgImRhdGEiOiB7CiAgICAgICAgIm1lc3NhZ2VJZCI6IjEyMzQ1NiIKICAgIH0sCiAgICAiYXV0aGVudGljYXRpb24iOiB7CiAgICAgICAgInBhcnRuZXJJZCI6ICJSa3NWU1g3UGZabTF5RjBEN000PSIsCiAgICAgICAgInNpZ24iOiAiMTdlNzA3YjVkOWRhZTg0NTkwNjVkYmIxMzllNWYxYmQiCiAgICB9Cn0=
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
|   B037            |    Order is not exist.       |   Order does not exist.                 |
|   B048            |    Invalid buyer       |   Buyer is invalid.                 |
|   B130            |    Message is not exist.       |   Schedule change message does not exist.                 |


</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>