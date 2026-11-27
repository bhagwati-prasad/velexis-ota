# CheckReimbursed

## 1 Document Description

### 1.1 Function Description

Through CheckReimbursed API, you are able to request with a order number to check reimbursement status.

### 1.2 Target Reader

The CheckReimbursement interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Node.js, and a basic knowledge of HTTP network protocols.

### 1.3 Character Encoding

The character code of this API is UTF-8.

### 1.4 URLs

|Environment|URL|
|:----|:----|
|Test environment|http://api.pkfare.com/refundReimburse/check|
|Prod environment|http://{{apiHost}}/refundReimburse/check|

> `Notes` The production environment call address is provided after you finish the API development and testing, and before the official launch. You can replace the {{apiHost}} in the production environment call address with the provided domain name.
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

|Key|Parameter Description|Type|
|:----|:----|:----|
|param|The value of ***Basic Request*** which is encoded by Base64. Basic Request is JSON data structure, please refer to details as following text.|Text|

#### 2.1.1 Basic Request

Sample

```json
{
    "authentication": {
        "partnerId": "xxcsRCtssslnHt+bwONbMw=",
        "sign": "4f55459af1e610e872896a3c6"
    },
    "data": {
        "orderNum": "916783592892089401",
    }
}
```
|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|authentication|Object|Yes|Partner ID and signature, refer to 2.1.2|
|data|Object|Yes|Request data，refer to 2.1.3|

#### 2.1.2 Authentication

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|partnerId|String|Yes|Partner ID|
|sign|String|Yes|Signature, refer to 4.1 and 4.2|

#### 2.1.3 Data

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|orderNum|String|Yes|PKFARE Order Number|

### 2.2 Request Parameter Construction

#### 2.2.1 Basic Request as JSON data structure

```json
{
    "authentication": {
        "partnerId": "xxcsRCtssslnHbwONbMw=",
        "sign": "4f55459078940e872896a3c6"
    },
    "data": {
        "orderNum": "916783592892089401",
    }
}
```
#### 2.2.2 Encoding Basic Request by Base64

```json
eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJzSXh4Y3NSQ3Rzc3Nsbkh0K0JpVDRid09OYk13PSIsInNpZ24iOiIyMzRmNTU0NTkwNzg5NDU5YWYxZTYxMGU4NzI4OTZhM2M2In0sImRhdGEiOnsib3JkZXJOdW0iOiI5MTY3ODM1OTI4OTIwODk0MDEiLH19
```
#### 2.2.3 Request Sample

```plain
POST http://open.pkfare.com/refundReimburse/check
Content-Type: application/x-www-form-urlencoded

param=eyJhdXRoZW50aWNhdGlvbiI6eyJwYXJ0bmVySWQiOiJzSXh4Y3NSQ3Rzc3Nsbkh0K0JpVDRid09OYk13PSIsInNpZ24iOiIyMzRmNTU0NTkwNzg5NDU5YWYxZTYxMGU4NzI4OTZhM2M2In0sImRhdGEiOnsib3JkZXJOdW0iOiI5MTY3ODM1OTI4OTIwODk0MDEiLH19
```

## 3 Response

### 3.1 Response Sample

```json
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "reimbursedOrderNum": "916787120452531002",
        "reimbursedOrderStatus": "Reimbursed",
        "payGate": "Voucher",
        "currency": "USD",
        "voucherList": [
            {
                "lastName": "YANGABC",
                "firstName": "TIFFANY",
                "birthday": "1990-08-23",
                "sex": "F",
                "psgType": "ADT",
                "voucherNumber": "1234567890123",
                "voucherCurrency": "THB",
                "voucherAmount": 222.22,
                "voucherValidFrom": "2023-03-20",
                "voucherValidEnd": "2023-03-22",
                "useFor": [
                    1
                ],
                "usageLimitation": 0
            }
        ],
        "voucherFileId": [
            "cc20fde65a836ad3e1555729c11745eb"
        ]
    }
}
```

### 3.2 Response Parameter

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|errorCode|String|Yes|Error Code，0-Success，Others-Failed|
|errorMsg|String|No|Error Message|
|warningMsg|String|No|Warning Message|
|data|Object|No|Return data, will not be empty when error code is "0". Refer to3.2.1|

#### 3.2.1 data

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|reimbursedOrderNum|String|Yes|PKFARE order number - Refund Order or Void Order|
|reimbursedOrderStatus|String|Yes|Order Status：REFUND, REIMBURSED; VOID, REIMBURSED|
|payGate|String|No|Payment gateway: Prepay, Alipay, Voucher|
|paySerialNum|String|No|Payment serial number|
|currency|String|Yes|Currency|
|reimbursedAmount|BigDecimal|Yes|Reimbursed amount|
|voucherList|Array|No|When payment gateway is voucher, voucher information will return. Refer to 3.2.2|
|voucherFileId|Object[String]|No|When payment gateway is voucher, a file ID may be returned. You can download the file by DownloadFile API.|

#### 3.2.2 voucherList

|Name|Type|Required or Not|Parameter Description|
|:----|:----|:----|:----|
|lastName|String|No|Last name|
|firstName|String|No|First Name|
|birthday|String|No|Birtheay，format[yyyy-mm-dd]|
|sex|String|No|Gender|
|psgType|String|No|Passenger Type|
|voucherNumber|String|No|Voucher number, for payment gateway as voucher|
|voucherCurrency|String|No|Voucher currency, for payment gateway as voucher|
|voucherAmount|BigDecimal|No|Voucher amount, for payment gateway as voucher|
|voucherValidFrom|String|No|Voucher valid date from, for payment gateway as voucher|
|voucherValidEnd|String|No|Voucher valid date to, for payment gateway as voucher|
|useFor|Object[Integer]|No|Voucher usage, for payment gateway as voucher：1-Issue ticket，2-Change ticket，3-Purchase ancillaries product|
|usageLimitation|Integer|No|Voucher usage limitaion, for payment gateway as voucher： 0 - Uncertain， 1-Passenger only， 2-No limitation|

### 4 Signature

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
## 5 Appendix

### 5.1 Error Code List

|Error Code|Error Message|Description|
|:----|:----|:----|
|0|Ok|Success|
|P001|xxx is illegal|Request parameter is illegal, xxx will display request parameter|
|B002|Partner is not exists|Partner is not exists.|
|B003|Illegal sign|Signature is illegal|
|B048|Invalid buyer|Buyer is invalid, please contact PKFARE account manager|
|S001|System error|System error|
|B037|Order is not exist|Order is not exist|
|B141|Order is not a refund order.|Order number in the request is not a refund order|

 

