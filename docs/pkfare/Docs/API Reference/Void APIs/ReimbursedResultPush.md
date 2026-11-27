# ReimbursedResultPush


## 1 Document Description

### 1.1 Function Description

Buyer partners should provide a void result reception service URL based on HTTP/HTTPS protocol to PKFARE for pushing back void result.

After voiding request, PKFARE would generates a void order in PKFARE system to proceed void operation. PKFARE void order number and detail would be pushed back if succeed. Or feedback reason if fail.

### 1.2 Target Reader

The ReimburseResultPush API document targets developers who work in the fields of network development, maintenance as well as management, and they should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

### 1.3 Character Encoding

The character code of this API is `UTF-8`.

### 1.4 Invoking Address

This address URL is provided by buyers.

## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|ReimburseResultPush|This address is provided by the customer.|    |
|ReimburseResultPush_V2|This address is provided by the customer.|Add parent order number info |

## 3 Request Parameter

The request is sent by PKFARE API. Structure: JSON. Requesting method: POST.

### 3.1 Parameter Construction

#### 3.1.1 Basic Parameter

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|voidOrderNum|string|[PKFARE] void order number|916932661022462502|
|voidOrderStatus|String|[PKFARE] void order status, refer to 5.2|VOID_TO_BE_REIM|
|remark|String|failure reason. NOT null only if void operation is failed to proceed|rejected reason|
|parentOrderNum|String|[PKFARE] parent order number |916932661022462501|
|reimburseResult|Object|void result details, refer to 3.1.2. NOT null only if void operation is successful|-|
|passengers|Array|passengers that request to void. Refer to 3.1.3|    |

#### 3.1.2 ReimburseResult

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|payments|Object|Payment informationt|    |
|solutions|Object|Price informationt<br>|    |

##### 3.1.2.1 Payments

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|payMethod|String|Payment method|Prepay|
|transactionFlow|String|Transaction number|fb89dab6-f825-47be-a491-50c57ca49be2|

##### 3.1.2.2 Solutions

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|currency|String|currency of regarding amount|USD|
|voidServFee|BigDecimal|void service fee for single adult|4.00|
|voidReimAmount|BigDecimal|amount to be reimbursed after ticket voided (Alipay merchant fee is non-refundable)|216.00|
|voidReimCoupon|BigDecimal|coupon was used for ticket issuance, and it will be call back after voided|4.00|
|voidReimDistCost|BigDecimal|distribution cost after voided to be call back|234.00|
|voidReimMerFee|BigDecimal|merchain fee after voided to be return|10.00|
|voidReimTktFee|BigDecimal|ticket service fee after voided to be return|10.00|

#### 3.1.3 Passengers

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|cardType|String|travel document type. Refer to 5.1|P|
|cardNum|String|travel document number|P1234567|
|lastName|String|last name|WANG|
|firstName|String|first name|JANGO|

### 3.2 Request Sample

#### `Case 1` Successful void operation, to be reimbursed.

```plain
{
    "passengers": [
        {
            "birthday": "1989-09-01",
            "firstName": "JOHN",
            "lastName": "SMITH",
            "sex": "M"
        }
    ],
    "voidOrderNum": "916932661022462502",
    "voidOrderStatus": "VOID_TO_BE_REIM",
    "parentOrderNum": "916932661022462501",
    "reimburseResult": {
        "solutions": [
            {
                "currency": "USD",
                "voidReimAmount": 183.84,
                "voidReimCoupon": 0,
                "voidReimDistCost": 0,
                "voidReimMerFee": 0.0,
                "voidReimTktFee": 0.0,
                "voidServFee": 7.0
            }
        ]
    }
}
```

#### `Case 2` Successful reimbursed.

```plain
{
	"passengers": [
		{
			"birthday": "1989-09-01",
			"firstName": "JOHN",
			"lastName": "SMITH",
			"sex": "M"
		}
	],
	"voidOrderNum": "916932708029462502",
	"voidOrderStatus": "VOID_REIMED",
    "parentOrderNum": "916932661022462501",
	"reimburseResult": {
		"payments": [
			{
				"payMethod": "Prepay",
				"transactionFlow": "fb89dab6-f825-47be-a491-50c57ca49be2"
			}
		],
		"solutions": [
			{
				"currency": "USD",
				"voidReimAmount": 183.84,
				"voidReimCoupon": 0,
				"voidReimDistCost": 0,
				"voidReimMerFee": 0.0,
				"voidReimTktFee": 0.0,
				"voidServFee": 7.0
			}
		]
	}
}
```

#### `Case 3` Void rejected.

```plain
{
    "passengers": [
        {
            "birthday": "1989-09-01",
            "firstName": "JOHN",
            "lastName": "SMITH",
            "sex": "M"
        }
    ],
    "voidOrderNum": "916932661022462502",
    "voidOrderStatus": "VOID_REJ",
    "parentOrderNum": "916932661022462501",
    "remark": " Exceed the time limit for nullification"
}
```


## 4 Response Parameter

This response is returned by the buyer partners. Please response in following format.

### 4.1 Response Parameter Construction

|Name|Type|Parameter Description|Sample|
|:----|:----|:----|:----|
|errorCode|String|error code|0|
|errorMsg|String|error message|ok|

### 4.2 Response Sample

#### 4.2.1 Normal Response

```plain
{"errorCode":0,"errorMsg":"ok"}
```
#### 4.2.2 Error Response

```plain
{"errorCode":1,"errorMsg":"Failure reason"}
```

## 5 Appendix

### 5.1 Travel Document Type

|Enum|Description|
|:----|:----|
|P|passport|
|O|others|

### 5.2 Order Status

|Enum|Description|
|:----|:----|
|VOID_TO_BE_REIM|Void，to be reimbursed|
|VOID_REIMED|Void，reimbursed|
|VOID_REJ|Void Rejected|



##### 


