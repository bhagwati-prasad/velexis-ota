# OrderDetail_V2

### 1 Document Description
#### 1.1 Function Description
Through OrderDetail API, user can check order details by indicating a order number. The order number is returned in the responds of preciseBooking API.

#### 1.2 Target Reader
The OrderDetail API document targets developers who work in the fields of network development, maintenance as well as management. They should have the knowledge of at least one of following programmng language: ASP、PHP、JAVA、ASP、.NET.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`。
#### 1.4 Invoking Address
Address in test environment：https://api.pkfare.com/orderDetail/v2?param=reqParam
Address in production environment：http://(pending for provide)/orderDetail/v2?param=reqParam
`Notes` PKFARE will provide production domain after Buyer Partners finished integration and co-test. Please replace "pending for provide" with the domain which PKFARE provides individually.
</br>
###  2.Request Parameter
#### 2.1 Parameter Construction
Please structure paramater as JSON format.

##### 2.1.1 Authentication
| Name        | Type     | Required or Not | Parameter Description             | Sample   |
| --------- | ------ | ---- | ---------------- | ---- |
| partnerId | String | Yes    | Partner ID             | -    |
| sign      | String | Yes    | signature, sign=MD5(partnerId+partnerKey), refer to 4.1 and 4.2 | -    |

##### 2.1.2 Data
| Name         | Type     | Required or Not | Parameter Description         | Sample    |
| ---------- | ------ | ---- | ------------ | ---- |
| orderNum | String | Yes    | Order Number | 915687075841601001    |
| includeFields   | String | No    | User could request with 3 options: passengers、journeys、solution. | passengers,journeys,solutions    |

#### 2.2 Request Sample
##### 2.2.1 Format Sample in JSON
`Note` : Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. </br>
`Note` : Please do not use urlencoded, please use POST method.


`Case 1` ：A sample request include passengers、journeys、and solution：
```
    {
    "authentication": {
        "partnerId": "sVSX7PfZm1yF04adBWYfCD7M4=",
        "sign": "e707b5d9dae8459085dbb139e5f1bd"
    },
    "data": {
        "orderNum":915687075841601001,
        "includeFields":"passengers,journeys,solutions"
    }
}

```

`Case 2` ：A sample request exclude passengers、journeys、and solution：
```
    {
    "authentication": {
        "partnerId": "sVSX7PfZm1yF04adBWYfCD7M4=",
        "sign": "e707b5d9dae8459085dbb139e5f1bd"
    },
    "data": {
        "orderNum":915687075841601001,
        "includeFields":""
    }
}

```


</br>

#####  2.2.2 Base64 Encryption

Use BASE64 to encode results from 2.2.1 Case 1:

```
ICAgewogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiQkJzVlNYN1BmWm0xeUYwNGFkQldZZkNEN000PSIsCiAgICAgICAgInNpZ24iOiAiMTdlNzA3YjVkOWRhZTg0NTkwODVkYmIxMzllNWYxYmQiCiAgICB9LAogICAgImRhdGEiOiB7CiAgICAgICAgIm9yZGVyTnVtIjo5MTU2ODcwNzU4NDE2MDEwMDEsCiAgICAgICAgImluY2x1ZGVGaWVsZHMiOiJwYXNzZW5nZXJzLGpvdXJuZXlzLHNvbHV0aW9ucyIKICAgIH0KfQ==
```

</br>

#####  2.2.3 Encryption Request Sample

This sample is for reference only:

```
http://open.pkfare.com/apitest/orderDetail/v2?param=ICAgewogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiQkJzVlNYN1BmWm0xeUYwNGFkQldZZkNEN000PSIsCiAgICAgICAgInNpZ24iOiAiMTdlNzA3YjVkOWRhZTg0NTkwODVkYmIxMzllNWYxYmQiCiAgICB9LAogICAgImRhdGEiOiB7CiAgICAgICAgIm9yZGVyTnVtIjo5MTU2ODcwNzU4NDE2MDEwMDEsCiAgICAgICAgImluY2x1ZGVGaWVsZHMiOiJwYXNzZW5nZXJzLGpvdXJuZXlzLHNvbHV0aW9ucyIKICAgIH0KfQ==
```

### 3. Response Parameter

#### 3.1 Response Parameter Construction
You would get the ``JSON`` data. Please refer to following tables for more details.


##### 3.1.1 Basic Parameter
| Name        | Type     | Parameter Description                               | Sample   |
| --------- | ------ | ----------------------------------- | ---- |
| errorCode | String | Error Code，refer to 5.1                          | 0    |
| errorMsg  | String | Error Message, refer to 5.1                                | OK   |
| data      | Object | Only if the errorCode returns "0", returned data would not be null. Data is refer to 3.1.2 | -    |

##### 3.1.2 Data
| Name       | Type       | Parameter Description     | Sample            |
| -------- | -------- | -------- | ------------- |
| orderStatus | String | Order Status，refer to 5.7 | ISSUED |
| orderNum | String | 【PKFARE】Order Number | 915687075841601001 |
| parentOrderNum | String | 【PKFARE】Applicatable to VOID/CHANGE/REFUND order. For VOID order, this is original ticketing order number. For CHANGE order, this is original ticketing order number or previous change order number. For REFUND order, this is original ticketing order number or previous change order number. | 915687075841601001 |
| refOrderNum | String | 【PKFARE】Main order number, it could be consider as the original ticketing order number, it will related with multiple orders if VOID/CHANGE/REFUND requested.| 915687075841601001 |
| orderType | String | Order type: O-Ticketing Order, V-Void Order, C-Change Order, R-Refund Order | O |
| createTime | String | Order created time | 2019-09-12 09:12:20 |
| postingDate | String | Order complted time. For Ticketing and Change order, it is ticketing time. For Void order, it is voided time. For Refund order, it is refunded time.| 2019-09-12 |
| pnr | String | PNR | EDTCZP |
| airPnr | String | Airline PNR | CA/HJKD34 |
| platingCarrier | String | Ticket issued Airline  | CA |
| payGate | String | Form of payment, Alipay or prepayment | ALIPAY |
| paySerialNum | String | Serial Number of payment transaction | - |
| passengers | Array | Passenger information, refer to 3.1.3 | - |
| journeys | Object | Itinerary information, refer to 3.1.4 | - |
| solutions | Array | Pricing information, refer to 3.1.5 | - |
| lastTktTime   | String   | latest ticketing time (GMT)                                  | 2015-10-28 23:59:00              |


##### 3.1.3 Passengers
| Name                 | Type         | Parameter Description                                     | Sample                               |
| ------------------ | ---------- | ---------------------------------------- | -------------------------------- |
| birthday | String | Date of birth 【yyyy-mm-dd】 | 1988-10-01 |
| cardType | String | Identification type, refer to 5.3 | PP |
| cardNum | String | Identification Number | G2568574 |
| cardExpiredDate | String | Identification expired date | 2020-05-06 |
| lastName | String | Surname | WONG |
| firstName | String | Given Name | LEON |
| nationality | String | Nationality【2 letters country code】| CN |
| psgType | String | Passenger Type, refer to 5.4 | ADT |
| sex | String | Gender, refer to 5.5 | M |
| ticketNum | String | Ticket Number. If multiple tickets, it will use "/" to separate. For example, 9991234567890/9991234567891 | 9991234567890 |

##### 3.1.4 Journey
| Name            | Type       | Parameter Description                                     | Sample                               |
| ------------- | -------- | ---------------------------------------- | -------------------------------- |
| journeyTime      | Long   | Journey time from departure to arrival, unit: minutes                                | 350 |
| transferCount | Integer  | Count of transfer times                                     | 1                                |
| departureDate | String   | Departure Date [yyyy-mm-dd]（Local time of departure location）  | 2019-10-10|
| arrivalDate   | String   | Arrival Date [yyyy-mm-dd]（Local time of arrival location）| 2019-10-10 |
| departureTime | String   | Departure Time [hh:mm]（Local time of departure location）| 11：00 |
| arrivalTime   | String   | Arrival Time [hh:mm]（Local time of arrival location） | 14：00 |
| segments   | Object[] | segment information, refer to 3.1.5 | -                                |

##### 3.1.5 Segments
| Name                | Type      | Parameter Description                  | Sample                               |
| ----------------- | ------- | --------------------- | -------------------------------- |
| airline           | String  | Airline                | CA                               |
| flightNum         | String  | Flight Number                  | 650                              |
| equipment         | String  | Equipment                    | 737                              |
| cabinClass        | String  | Cabin Class, refer to 5.2        | ECONOMY                          |
| bookingCode       | String  | Booking Code                    | E                                |
| departure         | String  | Departure Airport                  | PEK                              |
| arrival           | String  | Arrival Airport                  | HKG                              |
| departureTerminal | String  | Departure Terminal                 | 3                                |
| arrivalTerminal   | String  | Arrival Terminal                 | 1                                |
| departureDate     | String    | Departure Date [yyyy-mm-dd]（Local time of departure location）             | 2019-10-10                    |
| arrivalDate       | String    | Arrival Date [yyyy-mm-dd]（Local time of arrival location）             | 2019-10-10                    |
| departureTime    | String | Departure Time [hh:mm]（Local time of departure location）    | 11：00 |
| arrivalTime  | String | Arrival Time [hh:mm] （Local time of arrival location） | 14：00 |
| flightTime        | Integer | Fly Time, Unit: minutes            | 130                              |
| stayTime          | Integer | Stay Time, Unit：minutes            | 60                               |
| codeShare         | String  | Code Share Indicator [Y-Code Share flight, N-Not Code Share flight]     | Y                                |
| opFltNo           | String  | Operating Flight Number               | 202                              |
| opFltAirline      | String  | Operating Carrier                | KA                               |
| stopover          | String  | Stopover Airport                  | PEK                              |

##### 3.1.6 Solutions
| Name                | Type      | Parameter Description                  | Sample                               |
| ----------------- | ------- | --------------------- | -------------------------------- |
| currency | String | Currency | CNY |
| adtFare  | BigDecimal | Fare Amount per adult of original order | 1000 |
| adtTax   | BigDecimal | Tax Amount per adult of original order | 350  |
| chdFare  | BigDecimal | Fare Amount per child of original order | 750  |
| chdTax   | BigDecimal | Tax Amount per child of original order | 250  |
| tktFee   | BigDecimal | Issue Ticket Fee per person | 50 |
| merchantFee | BigDecimal | Merchant Fee of the order | 2 |
| distCost | BigDecimal | Distribution Cost of the order | 0 |
| coupon | BigDecimal | Used Coupon Amount of the order | 0 |
| buyerAmount | BigDecimal | Buyer Amount of the order | 2452 |
| voidServFee | BigDecimal | Void Service Fee per person of void order | 50 |
| voidReimTktFee | BigDecimal | Ticket Fee reimbursed amount of void order | 0 |
| voidReimMerFee | BigDecimal | Merchant Fee reimbursed amount of void order | 0 |
| voidReimDistCost | BigDecimal | Distribution Cost reimbursed amount of void order | 0 |
| voidReimCoupon | BigDecimal | Coupon reimbursed amount of void order | 0 |
| voidReimAmount | BigDecimal | Reimbused amount of void order | 0 |
| adtChgFee | BigDecimal | Change Fee per adult of change order | 500 |
| chdChgFee | BigDecimal | Change Fee per child of change order | 500 |
| adtChgAddFee | BigDecimal | Fare difference per adult of change order | 0 |
| chdChgAddFee | BigDecimal | Fare difference per child of change order | 0 |
| chgServFee | BigDecimal | Change Service Fee per adult of change order | 0 |
| chgMerFee | BigDecimal | Change Merchain Fee of change order | 0 |
| chgBuyerAmount | BigDecimal | Buyer Amount of change order | 1000 |
| adtRfdFee | BigDecimal | Refund Fee per adult of refund order | 500 |
| chdRfdFee | BigDecimal | Refund Fee per child of refund order | 500 |
| adtUsedFee | BigDecimal | Used fare per adult of refund order | 500 |
| chdUsedFee | BigDecimal | Used fare per child of refund order | 500 |
| adtReimChgAddFee | BigDecimal | Reimbursed fare difference per adult of refund order | 0 |
| chdReimChgAddFee | BigDecimal | Reimbursed fare difference per child of refund order | 0 |
| rfdServFee | BigDecimal | Refund Service Fee per person of refund order | 80 |
| rfdReimTktFee | BigDecimal | Reimbursed Ticket Fee per person of refund order | 0 |
| rfdReimMerFee | BigDecimal | Reimbursed Merchant Fee of refund order | 0 |
| rfdReimDistCost | BigDecimal | Reimbursed Distribution Cost of refund order | 0 |
| rfdReimCoupon | BigDecimal | Reimbursed Coupon of refund order | 0 |
| rfdReimAmount | BigDecimal | Reimbursed amount of refund order | 0 |

#### 3.2 Response Sample
##### 3.2.1 Success Response

``Note``: Including passenger and journey information

```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "orderStatus": "ISSED",
        "orderNum": 1234568788,
        "parentOrderNum": null,
        "refOrderNum": 1234568788,
        "orderType": "O",
        "createdTime": "2016-09-22 09:12:44",
        "postingDate": "2016-09-22",
        "pnr": "OTZATB",
        "airPnr": "7C/ZP35Q",
        "platingCarrier": "7C ",
        "payGate": "prepay",
        "paySerialNum": "PREPAY_20160922092648_1234568788_1234",
        "passengers": [
            {
                "firstName": "PEI",
                "lastName": "SUN",
                "psgType": "ADT",
                "nationality": "CN",
                "sex": "M",
                "birthday": "1959-11-11",
                "cardType": "PP",
                "cardNum": "E00000000",
                "cardExpiredDate": "2026-11-11",
                "ticketNum": "1234567890123"
            }
        ],
        "journeys": [
            {
                "journeyTime": 70,
                "transferCount": 0,
                "segments": [
                    {
                        "airline": "7C",
                        "flightNum": "8502",
                        "equipment": "737",
                        "cabinClass": "ECONOMY",
                        "bookingCode": "X",
                        "departure": "WEH",
                        "arrival": "ICN",
                        "departureTerminal": "1",
                        "arrivalTerminal": "3",
                        "departureDate": "2016-09-30",
                        "arrivalDate": "2016-09-30",
                        "departureTime": "11:50",
                        "arrivalTime": "14:00",
                        "flightTime": 70,
                        "stayTime": null,
                        "codeShare": "N",
                        "opFltNo": null,
                        "opFltAirline": null,
                        "stopover": null
                    }
                ],
                "departureTime": "11:50",
                "arrivalTime": "14:00",
                "departureDate": "2016-09-30",
                "arrivalDate": "2016-09-30"
            }
        ],
        "solutions":{
                "adtFare": "1000",
                "adtTax": "350",
                "tktFee": "20",
                "merchantFee": "0",
                "distCost": "0",
                "coupon": "0",
                "buyerAmount": "1370",
                "currency": "CNY"
            }
    }
}

```

``Note``: Not including passenger and journey information

```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "orderStatus": "ISSED",
        "orderNum": 1234568788,
        "parentOrderNum": null,
        "refOrderNum": 1234568788,
        "orderType": "O",
        "createdTime": "2016-09-22 09:12:44",
        "postingDate": "2016-09-22",
        "pnr": "OTZATB",
        "airPnr": "7C/ZP35Q",
        "platingCarrier": "7C ",
        "payGate": "prepay",
        "paySerialNum": "PREPAY_20160922092648_1234568788_1234"
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
#### 4.1 Parameters of Signature
partnerId，partnerKey

#### 4.2 Signature
Combine partnerId and partnerKey to make an MD5 encryption on final value.
Sign = MD5(partnerId+partnerKey)。
```
e.g
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
</br>

### 5 Appendix

#### 5.1 Error Code List
| errorCode | errorMsg                                 | Description                        |
| --------- | ---------------------------------------- | ------------------------- |
| 0         | ok                                       | Request has been processed successfully                    |
| S001      | System error                             | System error                      |
| S002      | timeout                           | Request timeout                     |
| P001      | -                                        | Parameter is illegal                    |
| B002      | Partner is not exists.                            | PartnerID does not exist               |
| B003      | Illegal sign                             | Illegal sign. Please check your signature               |
| B048      | Invalid buyer            | Request buyer is not matched with order.   |
| B037      | Order is not exists. | Order is not exist.            |


#### 5.2 Cabin Class
| Enum              | Description    |
| -------------- | ----- |
| ECONOMY        | economy class         |
| PREMIUM ECONOMY | premium economy class |
| BUSINESS       | business class        |
| FIRST          | first class           |

#### 5.3 Type of identification
Chinese Identity is supported for the China domesic journey(NOT inlcuding Hong Kong, Macao and Taiwan).

| Enum    | Description   |
| ---- | ---- |
| PP    | Passport   |
| HK    | Hongkong and Macau permit for Chinese   |
| TW    | Mainland Travel Permit for Taiwan Residents    |
| BH    | Home Return Permit   |
| NI    | Chinese Identity   |
| TH    | Others   |

#### 5.4 Passenger Type
| Enum    | Description        |
| ---- | --------- |
| ADT  | Adult        |
| CHD  | Child[2-12 years old] |

#### 5.5 Gender
| Enum    | Description   |
| ---- | ---- |
| M    | Male   |
| F    | Female   |

#### 5.6 Fare Type
| Enum       | Description   |
| ------- | ---- |
| PUBLIC  | Public Fare |
| PRIVATE | Private Fare |

#### 5.7 Order Status
| Enum       | Description   |
| ------- | ---- |
| ISS_PRC  | Ticket is issuing. |
| CHG_PRC  | Change order is proceeding. |
| REFD_PRC | Refund order is proceeding. |
| VOID_PRC | Ticket is voiding. |
| TO_BE_PAID | To be Paid. |
| ISSED | Ticket issued. |
| TO_BE_RSV | To be reserved. |
| UNDER_REVIEW | Under review. |
| HOLD | Order is holding manually, please contact customer service for further action. |
| RSV_FAIL | Reservation failed |
| CLOSED | Order closed. |
| CNCL | Order Cancelled. |
| CNCL_TO_BE_REIM | Order Cancelled, and reimbursement is under processing. |
| CNCL_REIMED | Order Cancelled, and payment has been reimbused. |
| CHG_RQ | Change Order is requested. |
| CHG_TO_BE_PAID | Change Order is to be paid. |
| CHG_REJ | Change Order is rejected. |
| CHGD | Change Order is changed. |
| REFD_REJ | Change Order is rejected. |
| REFD_TO_BE_REIM | Refunded to be reimbursed. |
| REFD_REIMED | Refunded and reimbursed. |
| REFD | Refunded |
| VOID_REJ | Void request is rejected. |
| VOID_TO_BE_REIM | Void to be reimbursed. |
| VOID_REIMED | Void and reimbursed |
| VOID | Void |


</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>