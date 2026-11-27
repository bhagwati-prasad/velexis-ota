# ReimbursedResultNotify

## 1 Description

### 1.1 Function

This Api is used to push the refund result to the buyers by PKFARE through the URL provided by the buyers after completing the refund process.

### 1.2 Target Reader

The ReimbursedResultNotify API documentation is intended for website developers, maintainers, and managers who have a certain level of website development skills, are familiar with one of the mainstream programming languages such as Java, Python, ASP.NET, PHP, Node.js, and have a basic understanding of the HTTP network protocol.

### 1.3 Character encoding

The character encoding for this Api is unified as UTF-8.

### 1.4 URLs

Provided by buyer partners.

### 1.5 Http Method

POST

### 1.6 Request Header

|key|value|
|:----|:----|
|Content-Type|application/json|

### 1.7 Response Header

|key|value|
|:----|:----|
|Content-Type|application/json|

## 2 Request

### 2.1 Sample

```json
{
	"currency": "USD",
	"payGate": "Prepay",
	"paySerialNum": "",
	"reimbursedAmount": 136.23,
	"reimbursedOrderNum": "916715517771831303",
	"reimbursedOrderStatus": "Reimbursed"
}
```
### 2.2 Schema

|name|type|required|description|
|:----|:----|:----|:----|
|reimbursedOrderNum|String|yes|PKFARE order number-refund order or void order|
|reimbursedOrderStatus|String|yes|order status：REFUND, REIMBURSED|
|payGate|String|no|Supported refund method：Prepay account、Alipay、Voucher|
|paySerialNum|String|no|transaction serial number|
|currency|String|yes|currency|
|reimbursedAmount|BigDecimal|yes|reimbursed amount|
|voucherList|Array|no|Available when the refund method is Voucher, refer to 2.2.1|
|voucherFileId|Object[String]|no|File ID of the Voucher. The user can download the corresponding file with this ID.|

#### 2.2.1 voucherList

|name|type|required|description|
|:----|:----|:----|:----|
|lastName|String|no|passenger's last name|
|firstName|String|no|passenger's first name|
|birthday|String|no|passenger's dob，yyyy-mm-dd|
|sex|String|no|sexuality|
|psgType|String|no|passenger type|
|voucherNumber|String|no|This field will be assigned EMD number, in the case where the refund method is Voucher.|
|voucherCurrency|String|no|This field will be assigned voucher currency, in the case where the refund method is Voucher.|
|voucherAmount|BigDecimal|no|This field will be assigned voucher's face value, in the case where the refund method is Voucher.|
|voucherValidFrom|String|no|This field will be assigned the date when the voucher take effects , in the case where the refund method is Voucher.|
|voucherValidEnd|String|no|This field will be assigned voucher's expiration date, in the case where the refund method is Voucher.|
|useFor|Object[Integer]|no|This field will be assigned the purposes of the voucher, in the case where the refund method is Voucher.<br>1-ticket issuance，2-schedule change，3-Add-ons；|
|usageLimitation|Integer|no|User limitation： 0 - uncertain， 1-passengers only， 2-unlimited|

## 3 Response

### 3.1 Sample

```json
{
    "errorCode": "0",
    "errorMsg": "ok"
}
```
### 3.2 Schema

|name|type|required|description|
|:----|:----|:----|:----|
|errorCode|String|yes|error code，0-success，other-failure；<br>PKFARE will only consider this notification successful when the buyer returns an errorCode of 0.|
|errorMsg|String|yes|error message|

## 4 Retry mechanism

After a failed request, we will retry for once every 5 minutes, up to a maximum of 5 retries.

