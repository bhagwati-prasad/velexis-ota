# TicketingNumPush_V2

### 1 Document Description
#### 1.1 Function Description
**Buyer partners should provide a ticketing number reception service based on HTTP/HTTPS protocol to PKFARE for pushing back ticket numbers.**
**PKFARE will push back the ticketing numbers when the tickets are issued.**
`Note` TicketingNumPush_V2 has different parameter structure from TicketingNumPush API. Voiding information is added in TicketingNumPush\_V2 API.

#### 1.2 Target Reader
The TicketingNumPush API document targets developers who work in the fields of network development, maintenance as well as management, and they should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
This address URL is provided by the customer.
</br>
### 2 Request Parameter
This request is sent by PKFARE API. Requesting method would be POST.
#### 2.1 Parameter Construction
##### 2.1.1 Basic Parameter
| Name           | Type       | Parameter Description                                        | Sample                             |
| -------------- | ---------- | ------------------------------------------------------------ | ---------------------------------- |
| orderNum       | String     | [PKFARE] order number                                        | 1012674912                         |
| airPnr         | String     | airline PNR                                                  | CA/JFDKHF                          |
| pnr | String | GDS PNR | HYFBKU |
| paymentGate    | String     | payment gate                                                 | ALIPAY                             |
| serialNum      | String     | payment serial number                                        | 2013012200021000200172105074       |
| merchantOrder  | String     | merchant order number (for ALIPAY only)                      | ALIPAY\_20161101105225\_1028814703 |
| permitVoid     | Integer    | allow to void ticket or not. [1-yes, 0-not allow]             | 1                                  |
| lastVoidTime   | String     | voiding deadline. Voiding operation would not be allow after lastVoidTime. (GMT) [yyyy-mm-dd hh : mm :ss]| 2018-01-01 13:00:00                |
| voidServiceFee | BigDecimal | void service fee                                             | 5.00                             |
| currency       | String     | currency for void service fee                                | USD                                |
| ticketNums     | Array      | passengers and corresponding ticket num，refer to 2.1.2      | -                                  |
| buyerOrder         | String     | buyerOrder                                                  | 1234567                          |
| data | Object | Include remark field for reference | - |

##### 2.1.2 TicketNums
| Name      | Type   | Parameter Description                                        | Sample        |
| --------- | ------ | ------------------------------------------------------------ | ------------- |
| ticketNum | String | ticket number, multiple number will be separated by '/', like9991234567890/9991234567891 | 1122334455667 |
| lastName  | String | last name                                                    | WANG          |
| firstName | String | first name                                                   | JANGO         |
| cardType  | String | travel document type. Refer to 4.1                           | P             |
| cardNum   | String | travel document number                                       | P1234567      |
| sex       | String | gender, Refer to 4.2                                         | F             |
| birthday  | String | birthday, format[yyyy-mm-dd]                                 | 2000-01-01    |

#### 2.2 Request Sample
```
{
    "orderNum": "1010792124",
    "buyerOrder": "1234567",
    "airPnr": "CA/JFDKHF",
    "pnr": "HYFBKU"
    "paymentGate": "ALIPAY",
    "serialNum": "2013012200021000200172105074",
    "merchantOrder": "ALIPAY_20161101105225_1028814703",
    "permitVoid": 1,
    "lastVoidTime": "2018-01-03 13:00:00",
    "voidServiceFee": 20.00,
    "currency": "CNY",
    "data":
    {
        "remark": {}
        }
    "ticketNums": [
            {
                "birthday": "1980-10-11",
                "cardNum": "G154017482",
                "cardType": "P",
                "firstName": "MARY",
                "lastName": "SMITH",
                "sex": "F",
                "ticketNum": "9990000000001"
            },
            {
                "birthday": "1980-10-11",
                "cardNum": "G17492581",
                "cardType": "P",
                "firstName": "JO",
                "lastName": "SMITH",
                "sex": "M",
                "ticketNum": "9990000000002"
            },
            {
                "birthday": "2016-08-01",
                "cardNum": "G58396302",
                "cardType": "P",
                "firstName": "ANGEL",
                "lastName": "SMITH",
                "sex": "F",
                "ticketNum": "9990000000003"
            }
        ]
}
```
</br>
### 3 Response Parameter
This response is returned by the buyer partners. Please respond as the format we provided below. Otherwise system is not able to recognize the response. If the response is not with 'errorCode' 0, system would try to push the ticket numbers to partners' URL again for 4 times.

#### 3.1 Response Parameter Construction
| Name      | Type   | Parameter Description | Sample |
| --------- | ------ | --------------------- | ------ |
| errorCode | String | error code            | 0      |
| errorMsg  | String | error message         | ok     |

#### 3.2 Response Sample
##### 3.2.1 Normal Response
```
{"errorCode":0,"errorMsg":"ok"}
```

##### 3.2.2 Error Response
```
{"errorCode":1,"errorMsg":"Failure reason"}
```
</br>
###4 Appendix
#### 4.1 Type of Travel Document

| Enum | Description      |
| ---- | ---------------- |
| P    | Passport         |
| N    | Chinese Identity |
| O    | Others           |

#### 4.2 Gender

| Enum | Description |
| ---- | ----------- |
| M    | Male        |
| F    | Female      |

</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>