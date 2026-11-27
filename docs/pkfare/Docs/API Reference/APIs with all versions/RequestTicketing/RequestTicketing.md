# RequestTicketing

## 1 Document Description

### 1.1 Function Description

Using the TicketingRequest API, users can send ticket issuance reminders for flight orders.

1. You can only prompt ticket issuance for flight orders. It does not support ticket issuance reminders for ancillary orders.
2. It supports simultaneous ticket issuance reminders for multiple orders. The same order can only be prompted once within a 10-minute period.
>`Note` This API provides Postman examples, which you can obtain by contacting your account manager.
## 1.2 Target Reader

The RequestTicketing interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Node.js, and a basic knowledge of HTTP network protocols.

### 1.3 Character Encoding

The character code of this API is UTF-8.

### 1.4 URLs

|Environment|URL|
|:----|:----|
|Test environment|http://api.pkfare.com/requestTicketing|
|Prod environment|http://{{apiHost}}/requestTicketing|

### 1.5 Http Method

POST

### 1.6 Request Header

|key|value|
|:----|:----|
|Content-Type|application/x-www-form-urlencoded|

### 1.7 Response Header

|key|value|
|:----|:----|
|Content-Type|application/json|

## 2 Request

### 2.1 Request Parameter

|Key|Parameter Descritpion|Type|
|:----|:----|:----|
|param|The value of ***Basic Request*** which is encoded by Base64. Basic Request is JSON data structure, please refer to details as following text.|Text|

#### 2.1.1 Basic Request

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|authentication|Object|Yes|Partner ID and signature, refer to 2.1.2|
|data|Object|Yes|Request, refer to 2.1.3|

#### 2.1.2 Authentication

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|partnerId|String|Yes|Partner ID|
|sign|String|Yes|Signature, refer to 4.1 and 4.2|

#### 2.1.3 Data

|Name|Type|Required or not|Parameter Description|
|:----|:----|:----|:----|
|issuingOrdersPush|Array|Yes|Ticket issuance reminder order list.<br>PKFARE orders|

### 2.2 Request Parameter Construction

#### 2.2.1 Basic Request as JSON data structure

```plain
{
  "authentication":{
      "partnerId": "BBsVSX7PfZmF04adBWYfCD7M4=",
      "sign": "17e707b9dae8459085dbb139e5f1bd"
  },
  "data": {
    "issuingOrdersPush": [
      "9187887878872501"，
      "9187887878872201"  
    ]
  }
}
```
#### 2.2.2 Encoding Basic Request by Base64

```plain
ewogICJhdXRoZW50aWNhdGlvbiI6ewogICAgICAicGFydG5lcklkIjogIkJCc1ZTWDdQZlptRjA0YWRCV1lmQ0Q3TTQ9IiwKICAgICAgInNpZ24iOiAiMTdlNzA3YjlkYWU4NDU5MDg1ZGJiMTM5ZTVmMWJkIgogIH0sCiAgImRhdGEiOiB7CiAgICAiaXNzdWluZ09yZGVyc1B1c2giOiBbCiAgICAgICI5MTg3ODg3ODc4ODcyNTAxIu+8jAogICAgICAiOTE4Nzg4Nzg3ODg3MjIwMSIgIAogICAgXQogIH0KfQ==
```
#### 2.2.3 Request Sample

```plain
POST http://api.pkfare.com/requestTicketing
Content-Type:application/x-www-form-urlencoded

param=ewogICJhdXRoZW50aWNhdGlvbiI6ewogICAgICAicGFydG5lcklkIjogIkJCc1ZTWDdQZlptRjA0YWRCV1lmQ0Q3TTQ9IiwKICAgICAgInNpZ24iOiAiMTdlNzA3YjlkYWU4NDU5MDg1ZGJiMTM5ZTVmMWJkIgogIH0sCiAgImRhdGEiOiB7CiAgICAiaXNzdWluZ09yZGVyc1B1c2giOiBbCiAgICAgICI5MTg3ODg3ODc4ODcyNTAxIu+8jAogICAgICAiOTE4Nzg4Nzg3ODg3MjIwMSIgIAogICAgXQogIH0KfQ==
```
## 3 Response

### 3.1 Basic Parameter

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|errorCode|String|Yes|error code,refer  to Error Code List|
|errorMsg|String|NO|error message|
|data|Array|NO|Showing details of failed ticket issuance orders.|

#### 3.1.1 Data

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|orderNum|String|Yes|Order numbers for failed ticket issuance orders.<br>【PKFARE】Order Number|
|errorCode|String|Yes|Error codes for failed ticket issuance orders.<br>error code,refer  to Error Code List|
|errorMsg|String|Yes|Error messages for failed ticket issuance orders.<br>error message,refer  to Error Code List|

### 3.2 Response Sample

#### 3.2.1 Success Response

1. All orders have been successfully prompted for ticket issuance.
```plain
{
  "errorCode": "0",
  "errorMsg": "OK"
  "data":[]
}
```
2. Some orders failed to be prompted for ticket issuance.
```plain
{
  "errorCode": "0",
  "errorMsg": "OK"
  "data":[
    {
        "orderNum":"9108282828101",
        "errorCode":"B179"，
        "errorMsg":"Duplicate ticketing request within 10 minutes."
    }
    {
        "orderNum":"9108282828101"，
        "errorCode":"B180"，
        "errorMsg":"Order is not in an unissued state."
    }
  ]
}
```
#### 3.2.2 Error Response

```plain
{
  "errorCode": "S001",
  "errorMsg": "System error"
  "data":[]
}
```
## 4 Signature

### 4.1 Parameters for Signature

partnerId，partnerKey

### 4.2 Signature

Combine partnerId and partnerKey to make MD5 encryption on the final value.

Sign = MD5(partnerId+partnerKey)

```plain
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
## 5 Error Code List

|erroCode|erroMsg|Description|
|:----|:----|:----|
|0|ok|Request has been processed successfully.|
|S001|System error|System error|
|S002|timeout|Request timeout|
|P001|-|Parameter is illegal|
|B037|Order is not exists.|Order is not exists.|
|B179|Duplicate ticketing request within 10 minutes.|Duplicate ticketing request for the same order within 10 minutes.|
|B180|The order status is not issuing.|Only Issuing order can be used in this API.|
|B181|The ticketing reminder list contains more than 100 orders.|The ticketing reminder list contains more than 100 orders.|

