# TicketingNumPush_V3

### 1 Document Description

#### 1.1 Function Description

**Buyer partners should provide a ticketing number reception service based on HTTP/HTTPS protocol to PKFARE for pushing back ticket numbers.**

**PKFARE will push back the ticketing numbers when the tickets are issued.**

`Note` TicketingNumPush_V3 has different parameter structure from TicketingNumPush and TicketingNumPush_V2 API. PNRList information is added in TicketingNumPush_V3 API.


#### 1.2 Target Reader

The TicketingNumPush_V3 API document targets developers who work in the fields of network development, maintenance as well as management, and they should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.


#### 1.3 Character Encoding

The character code of this API is `UTF-8`.


#### 1.4 Invoking Address
This address URL is provided by the customer.

### 2 Request Parameter
This request is sent by PKFARE API. Requesting method would be POST.

#### 2.1 Parameter Construction
##### 2.1.1 Basic Parameter
| Name           | Type       | Parameter Description                                        | Sample                             |
| -------------- | ---------- | ------------------------------------------------------------ | ---------------------------------- |
| orderNum       | String     | [PKFARE] order number                                        | 1012674912                         |
| airPnr         | String     | airline PNR                                                  | EDTCZP｜R25TZS                          |
| pnr | String | GDS PNR | EDTCZP｜R25TZS |
| pnrList | Array | PNR list, refer to 2.1.3 | - |
| passengers | Array | passenger list, refer to 2.1.2 | - |
| paymentGate    | String     | payment gate                                                 | ALIPAY                             |
| serialNum      | String     | payment serial number                                        | 2013012200021000200172105074       |
| merchantOrder  | String     | merchant order number (for ALIPAY only)                      | ALIPAY\_20161101105225\_1028814703 |
| permitVoid     | Integer    | allow to void ticket or not. [1-yes, 0-not allow]             | 1                                  |
| lastVoidTime   | String     | voiding deadline. Voiding operation would not be allow after lastVoidTime. (GMT) [yyyy-mm-dd hh : mm :ss]| 2018-01-01 13:00:00                |
| voidServiceFee | BigDecimal | void service fee                                             | 5.00                             |
| currency       | String     | currency for void service fee                                | USD                                |
| buyerOrder         | String     | buyerOrder                                                  | 1234567                          |
| data | Object | Include remark field for reference | - |

##### 2.1.2 passengers
| Name      | Type   | Parameter Description                                        | Sample        |
| --------- | ------ | ------------------------------------------------------------ | ------------- |
| birthday  | String | birthday, format[yyyy-mm-dd]                                 | 2000-01-01    |
| cardExpiredDate  | String | travel document expired date, format[yyyy-mm-dd]                                 | 2000-01-01    |
| cardNum   | String | travel document number                                       | P1234567      |
| cardType  | String | travel document type. Refer to 4.1                           | P             |
| firstName | String | first name                                                   | JANGO         |
| lastName  | String | last name                                                    | WANG          |
| nationality | String | nationality [country code]                                                   | CN         |
| psgType  | String | passenger type, refer to 4.2                                       | ADT    |
| sex       | String | gender, Refer to 4.3                                         | F             |
| ticketNum | String | ticket number, multiple number will be separated by '/', like9991234567890/9991234567891 | 1122334455667 |

##### 2.1.3 pnrList
| Name      | Type   | Parameter Description                                        | Sample        |
| --------- | ------ | ------------------------------------------------------------ | ------------- |
| segmentNo | Integer | segment No. | 1 |
| departure  | String | departure[IATA airport code]                                                         | BKK          |
| arrival | String | destination[IATA airport code]                                                         | CNX         |
| flightNum  | String | flight No.                                            | FD112             |
| cabinClass   | String | cabin class, refer to 4.4                                                       | ECONOMY      |
| bookingCode       | String | cabin code                                                | E             |
| pnr  | String | PNR                                       | EDTCZP    |
| airPnr  | String | airline PNR                                       | EDTCZP    |
| ticketNums  | Array | passengers and corresponding ticket num，refer to 2.1.4                                       | -    |

##### 2.1.4 ticketNums
| Name      | Type   | Parameter Description                                        | Sample        |
| --------- | ------ | ------------------------------------------------------------ | ------------- |
| passengerIndex | Integer | passenger No. | 1 |
| ticketNum  | String | ticket number                                                         | 9991234567890          |

#### 2.2 Request Sample
```
{
    "airPnr": "15CUCZ|25CUCZ|35CUCZ|45CUCZ",
    "currency": "CNY",
    "data": {
        "remark": {
            "code": "1",
            "msg": "product type is mismatched"
        }
    },
    "merchantOrder": "PREPAY_20221222145440_916716911545376001_4677",
    "orderNum": "916716911545376001",
    "passengers": [
        {
            "birthday": "1995-06-15",
            "cardExpiredDate": "2024-05-01",
            "cardNum": "E29384798",
            "cardType": "PP",
            "firstName": "BOB",
            "lastName": "BOB",
            "nationality": "CN",
            "psgType": "ADT",
            "sex": "M",
            "ticketNum": "1T9LO2/3T9LO2"
        },
        {
            "birthday": "1993-04-01",
            "cardExpiredDate": "2024-07-01",
            "cardNum": "E05849326",
            "cardType": "PP",
            "firstName": "JACK",
            "lastName": "LI",
            "nationality": "CN",
            "psgType": "ADT",
            "sex": "F",
            "ticketNum": "2T9LO2/4T9LO2"
        }
    ],
    "paymentGate": "PREPAY",
    "permitVoid": 0,
    "pnr": "187UIJHNJUIJIU8789|287UIJHNJUIJIU8789|387UIJHNJUIJIU8789",
    "pnrList": [
        {
            "airPnr": "15CUCZ",
            "arrival": "NRT",
            "bookingCode": "H",
            "cabinClass": "ECONOMY",
            "departure": "HKG",
            "flightNum": "812",
            "pnr": "187UIJHNJUIJIU8789",
            "segmentNo": 1,
            "ticketNums": [
                {
                    "passengerIndex": 1,
                    "ticketNum": "1T9LO2"
                }
            ]
        },
        {
            "airPnr": "25CUCZ",
            "arrival": "NRT",
            "bookingCode": "H",
            "cabinClass": "ECONOMY",
            "departure": "HKG",
            "flightNum": "812",
            "pnr": "287UIJHNJUIJIU8789",
            "segmentNo": 1,
            "ticketNums": [
                {
                    "passengerIndex": 2,
                    "ticketNum": "2T9LO2"
                }
            ]
        },
        {
            "airPnr": "45CUCZ",
            "arrival": "MEX",
            "bookingCode": "H",
            "cabinClass": "ECONOMY",
            "departure": "NRT",
            "flightNum": "180",
            "pnr": "487UIJHNJUIJIU8789",
            "segmentNo": 2,
            "ticketNums": [
                {
                    "passengerIndex": 2,
                    "ticketNum": "4T9LO2"
                }
            ]
        },
        {
            "airPnr": "35CUCZ",
            "arrival": "MEX",
            "bookingCode": "H",
            "cabinClass": "ECONOMY",
            "departure": "NRT",
            "flightNum": "180",
            "pnr": "387UIJHNJUIJIU8789",
            "segmentNo": 2,
            "ticketNums": [
                {
                    "passengerIndex": 1,
                    "ticketNum": "3T9LO2"
                }
            ]
        }
    ],
    "serialNum": "PREPAY_20221222145440_916716911545376001_4677"
}
```

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

###4 Appendix

#### 4.1 Type of Travel Document
| Enum | Description      |
| ---- | ---------------- |
| P    | Passport         |
| N    | Chinese Identity |
| O    | Others           |

#### 4.2 Passenger Type
| Enum | Description      |
| ---- | ---------------- |
| ADT    | adult         |
| CHD    | children [2-12 years old] |

#### 4.3 Gender
| Enum | Description |
| ---- | ----------- |
| M    | Male        |
| F    | Female      |

#### 4.4 Cabin Class
| Enum | Description |
| ---- | ----------- |
| ECONOMY    | economy class |
| PREMIUM ECONOMY    | premium economy class |
| BUSINESS    | business class |
| FIRST    | first class |


</br>

<a href="javascript:window.scrollTo(0, 0)">Top</a>

</br>