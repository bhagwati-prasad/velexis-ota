# VoidRequest_V2

## 1.1 Function Description

Through VoidRequest API, users could apply for voiding tickets after tickets are issued. Passengers that are included in the order are allowed to void ticket if void service time is available.  Please refer to void service time that is provided in `TicketingNumPush_V2` API.

`note`VoidRequest_V2 API has different structure with VoidRequest，VoidRequest_V2 API adds passenger name and passenger sex，while removes passenger card number and card type。

## 1.2 Target Reader

The VoidRequest API document targets developers who work in the fields of network development, maintenance as well as management, and they should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

## 1.3 Character Encoding

The character code of this API is `UTF-8`.

## 1.4 Invoking Address

Address in test environment: https://api.pkfare.com/voiding/V2
Address in production environment: https://pending.com/voiding/v2

# 2. Request Parameter

Request should be structuralized in JSON format.

## 2.1 Parameter Construction

### 2.1.1 Authentication

| Name      | Type   | Required or Not | Description                     | Sample |
| --------- | ------ | --------------- | ------------------------------- | ------ |
| partnerId | Object | Yes             | partner ID                      | -      |
| sign      | Object | Yes             | signature, refer to 4.1 and 4.2 | -      |

### 2.1.2 VoidRequest

| Name       | Type   | Required or Not | Description                                                  | Sample     |
| ---------- | ------ | --------------- | ------------------------------------------------------------ | ---------- |
| orderNum   | String | Yes             | [PKFARE] order Number                                        | 1234568788 |
| passengers | Array  | Yes             | passengers that request to void. Refer to 2.1.2.1. Please make sure that   void service time is available | -          |

### 2.1.3 Passengers

| Name      | Type   | Required or Not | Description           | Sample     |
| --------- | ------ | --------------- | --------------------- | ---------- |
| firstName | String | Yes             | first name            | JANGO      |
| lastName  | String | Yes             | last name             | WANG       |
| birthday  | String | Yes             | birthday [yyyy-mm-dd] | 1990-10-12 |
| sex       | String | Yes             | Sex，M-Male，F-Female | M          |

## 2.2 Request Sample

### 2.2.1 JSON Format Sample

```java
{
​    "voidRequest":{
​        "passengers":[
​            {
​                "lastName":"WONG",
​                "firstName":"LEONB",
​                "birthday":"1990-01-01",
​                "sex":"M"
​            }
​        ],
​        "orderNum":915656792701128401 
​    },
​    "authentication":{
​        "sign":"45be29a6237643aa1781a85f26f34f",
​        "partnerId":"rYXkI9dJxoB6f5tz4+idGRBRE="
​    }
}
```



### 2.2.2 Base64 Encryption

ewogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiQkJzVlNYN1BmWm0xeUYwNGFkQldZZkNEN000PSIsCiAgICAgICAgInNpZ24iOiAiMTdlNzA3YjVkOWRhZTg0NTkwODVkYmIxMzllNWYxYmQiCiAgICB9LAogICAgImRhdGEiOiB7CiAgICAgICAgIm9yZGVyTnVtIjoxMjM0NTY4Nzg4LAogICAgICAgICJpbmNsdWRlRmllbGRzIjoicGFzc2VuZ2Vycyxqb3VybmV5cyxzb2x1dGlvbnMiCiAgICB9Cn0=

### 2.2.3 Encryption Request Sample

https://pengding.pkfare.com/voiding/v2?param=ewogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiQkJzVlNYN1BmWm0xeUYwNGFkQldZZkNEN000PSIsCiAgICAgICAgInNpZ24iOiAiMTdlNzA3YjVkOWRhZTg0NTkwODVkYmIxMzllNWYxYmQiCiAgICB9LAogICAgImRhdGEiOiB7CiAgICAgICAgIm9yZGVyTnVtIjoxMjM0NTY4Nzg4LAogICAgICAgICJpbmNsdWRlRmllbGRzIjoicGFzc2VuZ2Vycyxqb3VybmV5cyxzb2x1dGlvbnMiCiAgICB9Cn0=

# 3. Response Parameter

The data returned is in `JSON` format. For specific fields, please refer to following charts.

## 3.1 Response Parameter Construction

### 3.1.1 Basic Parameter

| Name      | Type   | Parameter Description                                        | Sample |
| --------- | ------ | ------------------------------------------------------------ | ------ |
| errorCode | String | error number,   refer to 5.1                                 | 0      |
| errorMsg  | String | error message,   refer to 5.1                                | ok     |
| data      | Object | return data.   Not empty when error code is ‘0’. Refer to 3.1.1 | -      |

### 3.1.2 Data

| Name         | Type   | Parameter Description                                        | Sample             |
| ------------ | ------ | ------------------------------------------------------------ | ------------------ |
| orderNum     | String | [PKFARE] order Number                                        | 915536694627487000 |
| voidOrderNum | String | [PKFARE] void order number   (after a void request is submitted, a void order would be generated in PKFARE   system) | 915536694627487000 |
| passengers   | Array  | passengers that request to void.   Refer to 3.1.3            | -                  |

### 3.1.3 Passengers

| Name      | Type   | Parameter   Description | Sample     |
| --------- | ------ | ----------------------- | ---------- |
| firstName | String | first name              | JANGO      |
| lastName  | String | last name               | WANG       |
| birthday  | String | birthday [yyyy-mm-dd]   | 1990-10-12 |
| sex       | String | Sex，M-Male，F-Female   | M          |

## 3.2 Response Sample

### 3.2.1 Normal Response

```java
{
​    "errorCode":"0",
​    "errorMsg":"ok",
​    "data":{
​        "orderNum":"915634179313900301",
​        "voidOrderNum":"915634179313900302",
​        "passengers":[
​            {
​                "lastName": "WONG",
​                "firstName": "LEONB",
​                "birthday": "1990-01-01",
​                "sex": "M"
​            }
​        ]
​    }
}
```

### 3.2.2 Error Response

```java
{
​    "errorCode": "P001", 
​    "errorMsg": "Invalid authentication.", 
​    "data": null
}
```

# 4. Signature

## 4.1 Parameters for Signature

partnerId，partnerKey

## 4.2 Signature

Combine partnerID and partnerKey to make an MD5 encryption on final value.

Sign = MD5(partnerId+partnerKey)。

```java
1. e.g.
2. partnerId: abcdefg123456
3. partnerKey: jkHKhkikdhy258dffj
4. Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```

# 5. Appendix

## 5.1 Error Code List

| errorCode | errorMsg                                                     | Description                                                  |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 0         | ok                                                           | request has been processed successfully                      |
| S001      | System error                                                 | system error                                                 |
| P001      | -                                                            | wrong parameter                                              |
| P002      | XXXXX is missing.                                            | parameter is missing                                         |
| P006      | Invalid parameter.                                           | wrong parameter                                              |
| B002      | Partner is not exists                                        | PartnerID does not exist.                                    |
| B003      | Illegal sign                                                 | Illegal sign. Please check your signature.                   |
| B009      | order status invalid                                         | order status is invalid                                      |
| B010      | order not exist                                              | order number does not exist                                  |
| B048      | Invaild buyer                                                | buyer does not match                                         |
| V001      | Illegal void time                                            | the time limit for voiding tickets has been exceeded          |
| V002      | passenger(s) not allowed to void. Origin order has no ADT remain | passenger(s) not allowed to void. Origin order has no ADT remain |
| O001      | passenger does not match the order                           | passenger does not match the order                           |
| O002      | some passengers submitted other after sale requests, so failure to submit void request. | some passengers submitted other after sale requests, so failure to submit void request. |
| O003      | the new or original journey exists unaccompanied minor.      | the new or original journey contains unaccompanied minor.      |

## 5.2 Sex

| Name | Description |
| ---- | ----------- |
| M    | Male        |
| F    | Female      |


</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>