# ChangeRequest

### 1 Document Description

### 1.1 Function

This API is used for raising change request for change itineary. If you want to change passenger information, please read document of change request-change passenger information. User can indicate order number, voluntary type, change reason, booked itineary and new itinerary to create a change request. Order number is refer to PKFARE order number, the change is able to raise base on issued order or change order.
 
`Note`: This API provides Postman examples, which you can obtain by contacting your account manager.
### 1.2 Target Reader

The Change Reshop interface documentation is intended for web developers, maintenance and managers with some web development skills, an understanding of one of the major development languages such as Java, Python, ASP.NET, PHP, Nodes.js, and a basic knowledge of HTTP network protocols.
 
### 1.3 Character Encoding

The character code of this API is `UTF-8`.
 
### 1.4 URLs



|Environment |URL |
|------- |--------- |
|Test environment |[https://api.pkfare.com](http://api.pkfare.com)/change/changeRequest |
|Prod environment |https://{{apiHost}}/change/changeRequest |

 
`Notes` The production environment call address is provided after you finish the API development and testing, and before the official launch. You can replace the {{apiHost}} in the production environment call address with the provided domain name.
 
### 1.5 Http Method

POST
### 1.6 Request Header


|key |value |
|------- |--------- |
|Content-Type |application/x-www-form-urlencoded |

### 1.7 Response Header


|key |value |
|------- |--------- |
|Content-type |application/json |

 
### 2.Request

### 2.1 Schema


|name |description |type |
|------- |--------- |--------- |
|param |The value after Base64 encoding the Basic Request. The Basic Request is a JSON-structured data, and the details explanation is provided in the following text. |Text |

 
### 2.1.1 Basic Request

sample

```
 {
    "authentication": {
        "partnerId": "qiE0YKcJlXjknkCk",
        "sign": "d53d44ea5f1d18e69047b7c"
    },
    "data": {
        "voluntaryType": 1,
        "changeReason": 1,
        "uploadedFileIds": [
            "975b70c89f0ed3e3e1555729c11745eb",
            "a98c63e1f9371ccce1555729c11745eb"
        ],
        "changeJourney": {
            "journey_0": [
                {
                    "airline": "OD",
                    "flightNum": "606",
                    "departure": "HKG",
                    "departureDate": "2023-09-29",
                    "departureTime": "15:15",
                    "bookingCode": "T",
                    "cabinClass": "ECONOMY",
                    "arrival": "KUL",
                    "arrivalDate": "2023-09-29",
                    "arrivalTime": "19:05"
                },
                {
                    "airline": "OD",
                    "flightNum": "520",
                    "departure": "KUL",
                    "departureDate": "2023-09-30",
                    "departureTime": "09:55",
                    "bookingCode": "X",
                    "cabinClass": "ECONOMY",
                    "arrival": "DMK",
                    "arrivalDate": "2023-09-30",
                    "arrivalTime": "11:05"
                }
            ],
            "journey_1": [
                {
                    "airline": "OD",
                    "flightNum": "521",
                    "departure": "DMK",
                    "departureDate": "2023-10-20",
                    "departureTime": "11:50",
                    "bookingCode": "X",
                    "cabinClass": "ECONOMY",
                    "arrival": "KUL",
                    "arrivalDate": "2023-10-20",
                    "arrivalTime": "15:05"
                },
                {
                    "airline": "OD",
                    "flightNum": "605",
                    "departure": "KUL",
                    "departureDate": "2023-10-21",
                    "departureTime": "10:15",
                    "bookingCode": "X",
                    "cabinClass": "ECONOMY",
                    "arrival": "HKG",
                    "arrivalDate": "2023-10-21",
                    "arrivalTime": "14:15"
                }
            ]
        },
        "buyerOrder": "buyerOrder1",
        "solutionKey": "",
        "orderNum": "916958798364810031",
        "passengerList": [
            {
                "birthday": "1999-09-09",
                "cardNum": "",
                "cardType": "PP",
                "firstName": "yang",
                "lastName": "zhang",
                "nationality": "CN",
                "sex": "F"
            }
        ],
        "contactInfo": {
            "telNum": "15691012314",
            "name": "amy",
            "email": "amy.zhang@pkfare.com"
        }
    }
}
```
 
 

| Name         | Type     | Required or Not  | Parameter Description              | Sample    |
|------- |--------- |--------- |--------- |--------- |
|authentication |Object |Yes |Identity information, refer to 2.1.2 |- |
|data |Object |Yes |File information, refer to 2.1.3 |- |

 
 
### 2.1.2 Authentication


|Name |Type |Required or Not |Parameter Description |Sample |
|------- |--------- |------- |--------- |--------- |
|partnerId |String |Yes |Partner ID |qiE0YKcJlXjknkCkZKhzIis5o= |
|sign |String |Yes |Signature, sign=MD5(partnerId+partnerKey), refer to 4.1 and 4.2 for the signature method. |d53d44ea413c40d5f1d18e69047b7c |

 
### 2.1.2 Data


|Name |Type |Required or Not |Parameter Description |Sample |
|------- |--------- |------- |--------- |--------- |
|orderNum |String |Yes |Order Number |915687075841601001 |
|buyerOrder |String |No |Buyer order number. If you would like PKFARE to store your order, please kindly put it in this element. | |
|voluntaryType |Integer |Yes |Voluntary type: 0 - Voluntary, 1 - Involuntary |0 |
|changeReason |Integer |Yes |Change reason: 0 - Voluntary, 1 - Flight reschedule / cancellation, 2 - Reissue due to medical reasons, 3 - Reissue due to visa refusal, 4 - Others |0 |
|remark |String |No |Remark to support reason (maximum 500 characters) | |
|solutionKey |String |No |Solution key from change reshop response. If the change is related to a reshop response which provided with prce, it is mandatory. If there is no solutionKey in the response of Change Reshop, it is not required. | |
|uploadedFileIds |Arrary |No |Uploaded file ID(maximum 99 files per request) | |
|segmentList |Array |No |Booked flights which you want to change,refer to 2.1.3 |- |
|passengerList |Array |Yes |Passengers who you want to change,refer to 2.1.4 |- |
|ChangeJourneys |Array |Yes |New journey after change,  refer to 2.1. |- |
|ancillaries |Object |N |Ancillary information | |
|contact |Object |N |Contact information of this change request. If leave as blank, contact of origin order will be used | |

### 2.1.3 segmentList


| Name          | Type     | Required or Not  | Parameter Description          | Sample    |
|------- |--------- |--------- |--------- |--------- |
|segmentNo |String |Yes |Segment number |1 |
|flightNum |String |Yes |Flight number, carrier code and flight number |TG618 |
|departure |String |Yes |Departure airport code, 3 letters airport code |HKG |
|cabinClass |String |Yes |Cabin class |ECONOMY |
|bookingCode |String |Yes |Booking code |V |
|arrival |String |Yes |Arrival airport code, 3 letters airport code |BKK |

 
### 2.1.4 passengerList


| Name          | Type     | Required or Not  | Parameter Description          | Sample    |
|------- |--------- |--------- |--------- |--------- |
|lastName |String |Yes |Last name |Wang |
|firstName |String |Yes |First name |Jango |
|nationality |String |Yes |Nationality |CN |
|sex |String |Yes |Gender |M |
|birthday |String |Yes |Date of birth |2015-01-10 |
|cardType |String |No |Travel document type, which used for creating the booking. |P |
|cardNum |String |No |Travel document number, which used for creating the booking. |G2568574 |
|cardExpiredDate |String |No |Travel document expired date, which used for creating the booking |2030-01-10 |

 
### 2.1.5 ChangeJourney


| Name          | Type     | Required or Not  | Parameter Description          | Sample    |
|------- |--------- |--------- |--------- |--------- |
|journeySeq |Array |Yes |Journey sequences, journey_0 for outbound journey, journey_1 for inbound journey |journey_0 |

 
 
### 2.1.6 Journey


| Name          | Type      | Required or Not  | Parameter Description          | Sample    |
|------- |--------- |--------- |--------- |--------- |
|airline |String |Yes |Airline |TG |
|flightNum |String |Yes |Flight number |618 |
|departure |String |Yes |Departure airport code | |
|departureDate |String |Yes |Departure date | |
|departureTime |String |Yes |Departure time | |
|arrival |String |Yes |Arrival airport code | |
|arrivalDate |String |Yes |Arrival date | |
|arrivalTime |String |Yes |Arrival time | |
|bookingCode |String |Yes |Booking Code | |
|cabinClass |String |No |Cabin class |ENCONOMY |

### 2.1.7 Contact


| Name          | Type      | Required or Not  | Parameter Description          | Sample    |
|------- |--------- |--------- |--------- |--------- |
|name |String |No |Contact name |Jonathan Wong |
|email |String |No |Email address |jonathan.wong@pkfare.com |
|telNum |String |No |Telephone number | |


 
 
### 2.2 Sample of Request Construction Process

### 2.2.1 Request Sample

 

```
 {
    "authentication": {
        "partnerId": "qiE0YKcJlXjzIis5o=",
        "sign": "d53d443c40d5f1d18e69047b7c"
    },
    "data": {
        "voluntaryType": 1,
        "changeReason": 1,
        "uploadedFileIds": [
            "975b70c89f0ed3e3e1555729c11745eb",
            "a98c63e1f9371ccce1555729c11745eb"
        ],
        "changeJourney": {
            "journey_0": [
                {
                    "airline": "OD",
                    "flightNum": "606",
                    "departure": "HKG",
                    "departureDate": "2023-09-29",
                    "departureTime": "15:15",
                    "bookingCode": "T",
                    "cabinClass": "ECONOMY",
                    "arrival": "KUL",
                    "arrivalDate": "2023-09-29",
                    "arrivalTime": "19:05"
                },
                {
                    "airline": "OD",
                    "flightNum": "520",
                    "departure": "KUL",
                    "departureDate": "2023-09-30",
                    "departureTime": "09:55",
                    "bookingCode": "X",
                    "cabinClass": "ECONOMY",
                    "arrival": "DMK",
                    "arrivalDate": "2023-09-30",
                    "arrivalTime": "11:05"
                }
            ],
            "journey_1": [
                {
                    "airline": "OD",
                    "flightNum": "521",
                    "departure": "DMK",
                    "departureDate": "2023-10-20",
                    "departureTime": "11:50",
                    "bookingCode": "X",
                    "cabinClass": "ECONOMY",
                    "arrival": "KUL",
                    "arrivalDate": "2023-10-20",
                    "arrivalTime": "15:05"
                },
                {
                    "airline": "OD",
                    "flightNum": "605",
                    "departure": "KUL",
                    "departureDate": "2023-10-21",
                    "departureTime": "10:15",
                    "bookingCode": "X",
                    "cabinClass": "ECONOMY",
                    "arrival": "HKG",
                    "arrivalDate": "2023-10-21",
                    "arrivalTime": "14:15"
                }
            ]
        },
        "buyerOrder": "buyerOrder1",
        "solutionKey": "",
        "orderNum": "916958798364810031",
        "passengerList": [
            {
                "birthday": "1999-09-09",
                "cardNum": "",
                "cardType": "PP",
                "firstName": "yang",
                "lastName": "zhang",
                "nationality": "CN",
                "sex": "F"
            }
        ],
        "contactInfo": {
            "telNum": "15691012314",
            "name": "amy",
            "email": "amy.zhang@pkfare.com"
        }
    }
}
```
 
 
### 2.2.2 Base64 Encryption

Use BASE64 to encode results from 2.2.1:
 `IHsKICAgICJhdXRoZW50aWNhdGlvbiI6IHsKICAgICAgICAicGFydG5lcklkIjogIkhKcWlFMFlLY0psWGprbmtDa1pLaHpJaXM1bz0iLAogICAgICAgICJzaWduIjogImZlZDUzZDQ0ZWE0MTNjNDBkNWYxZDE4ZTY5MDQ3YjdjIgogICAgfSwKICAgICJkYXRhIjogewogICAgICAgICJ2b2x1bnRhcnlUeXBlIjogMSwKICAgICAgICAiY2hhbmdlUmVhc29uIjogMSwKICAgICAgICAidXBsb2FkZWRGaWxlSWRzIjogWwogICAgICAgICAgICAiOTc1YjcwYzg5ZjBlZDNlM2UxNTU1NzI5YzExNzQ1ZWIiLAogICAgICAgICAgICAiYTk4YzYzZTFmOTM3MWNjY2UxNTU1NzI5YzExNzQ1ZWIiCiAgICAgICAgXSwKICAgICAgICAiY2hhbmdlSm91cm5leSI6IHsKICAgICAgICAgICAgImpvdXJuZXlfMCI6IFsKICAgICAgICAgICAgICAgIHsKICAgICAgICAgICAgICAgICAgICAiYWlybGluZSI6ICJPRCIsCiAgICAgICAgICAgICAgICAgICAgImZsaWdodE51bSI6ICI2MDYiLAogICAgICAgICAgICAgICAgICAgICJkZXBhcnR1cmUiOiAiSEtHIiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlRGF0ZSI6ICIyMDIzLTA5LTI5IiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlVGltZSI6ICIxNToxNSIsCiAgICAgICAgICAgICAgICAgICAgImJvb2tpbmdDb2RlIjogIlQiLAogICAgICAgICAgICAgICAgICAgICJjYWJpbkNsYXNzIjogIkVDT05PTVkiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsIjogIktVTCIsCiAgICAgICAgICAgICAgICAgICAgImFycml2YWxEYXRlIjogIjIwMjMtMDktMjkiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsVGltZSI6ICIxOTowNSIKICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAgICAgImFpcmxpbmUiOiAiT0QiLAogICAgICAgICAgICAgICAgICAgICJmbGlnaHROdW0iOiAiNTIwIiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlIjogIktVTCIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZURhdGUiOiAiMjAyMy0wOS0zMCIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZVRpbWUiOiAiMDk6NTUiLAogICAgICAgICAgICAgICAgICAgICJib29raW5nQ29kZSI6ICJYIiwKICAgICAgICAgICAgICAgICAgICAiY2FiaW5DbGFzcyI6ICJFQ09OT01ZIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbCI6ICJETUsiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsRGF0ZSI6ICIyMDIzLTA5LTMwIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbFRpbWUiOiAiMTE6MDUiCiAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgIF0sCiAgICAgICAgICAgICJqb3VybmV5XzEiOiBbCiAgICAgICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAgICAgImFpcmxpbmUiOiAiT0QiLAogICAgICAgICAgICAgICAgICAgICJmbGlnaHROdW0iOiAiNTIxIiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlIjogIkRNSyIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZURhdGUiOiAiMjAyMy0xMC0yMCIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZVRpbWUiOiAiMTE6NTAiLAogICAgICAgICAgICAgICAgICAgICJib29raW5nQ29kZSI6ICJYIiwKICAgICAgICAgICAgICAgICAgICAiY2FiaW5DbGFzcyI6ICJFQ09OT01ZIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbCI6ICJLVUwiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsRGF0ZSI6ICIyMDIzLTEwLTIwIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbFRpbWUiOiAiMTU6MDUiCiAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICAgICAgewogICAgICAgICAgICAgICAgICAgICJhaXJsaW5lIjogIk9EIiwKICAgICAgICAgICAgICAgICAgICAiZmxpZ2h0TnVtIjogIjYwNSIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZSI6ICJLVUwiLAogICAgICAgICAgICAgICAgICAgICJkZXBhcnR1cmVEYXRlIjogIjIwMjMtMTAtMjEiLAogICAgICAgICAgICAgICAgICAgICJkZXBhcnR1cmVUaW1lIjogIjEwOjE1IiwKICAgICAgICAgICAgICAgICAgICAiYm9va2luZ0NvZGUiOiAiWCIsCiAgICAgICAgICAgICAgICAgICAgImNhYmluQ2xhc3MiOiAiRUNPTk9NWSIsCiAgICAgICAgICAgICAgICAgICAgImFycml2YWwiOiAiSEtHIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbERhdGUiOiAiMjAyMy0xMC0yMSIsCiAgICAgICAgICAgICAgICAgICAgImFycml2YWxUaW1lIjogIjE0OjE1IgogICAgICAgICAgICAgICAgfQogICAgICAgICAgICBdCiAgICAgICAgfSwKICAgICAgICAiYnV5ZXJPcmRlciI6ICJidXllck9yZGVyMSIsCiAgICAgICAgInNvbHV0aW9uS2V5IjogIiIsCiAgICAgICAgIm9yZGVyTnVtIjogIjkxNjk1ODc5ODM2NDgxMDAzMSIsCiAgICAgICAgInBhc3Nlbmdlckxpc3QiOiBbCiAgICAgICAgICAgIHsKICAgICAgICAgICAgICAgICJiaXJ0aGRheSI6ICIxOTk5LTA5LTA5IiwKICAgICAgICAgICAgICAgICJjYXJkTnVtIjogIiIsCiAgICAgICAgICAgICAgICAiY2FyZFR5cGUiOiAiUFAiLAogICAgICAgICAgICAgICAgImZpcnN0TmFtZSI6ICJ5YW5nIiwKICAgICAgICAgICAgICAgICJsYXN0TmFtZSI6ICJ6aGFuZyIsCiAgICAgICAgICAgICAgICAibmF0aW9uYWxpdHkiOiAiQ04iLAogICAgICAgICAgICAgICAgInNleCI6ICJGIgogICAgICAgICAgICB9CiAgICAgICAgXSwKICAgICAgICAiY29udGFjdEluZm8iOiB7CiAgICAgICAgICAgICJ0ZWxOdW0iOiAiMTU2OTEwMTIzMTQiLAogICAgICAgICAgICAibmFtZSI6ICJhbXkiLAogICAgICAgICAgICAiZW1haWwiOiAiYW15LnpoYW5nQHBrZmFyZS5jb20iCiAgICAgICAgfQogICAgfQp9` 
 
 ### 2.2.3 Post Request

This sample is for reference only:

```
POST http://api.pkfare.com/change/changeRequest
Content-type: application/x-www-form-urlencoded


param=IHsKICAgICJhdXRoZW50aWNhdGlvbiI6IHsKICAgICAgICAicGFydG5lcklkIjogIkhKcWlFMFlLY0psWGprbmtDa1pLaHpJaXM1bz0iLAogICAgICAgICJzaWduIjogImZlZDUzZDQ0ZWE0MTNjNDBkNWYxZDE4ZTY5MDQ3YjdjIgogICAgfSwKICAgICJkYXRhIjogewogICAgICAgICJ2b2x1bnRhcnlUeXBlIjogMSwKICAgICAgICAiY2hhbmdlUmVhc29uIjogMSwKICAgICAgICAidXBsb2FkZWRGaWxlSWRzIjogWwogICAgICAgICAgICAiOTc1YjcwYzg5ZjBlZDNlM2UxNTU1NzI5YzExNzQ1ZWIiLAogICAgICAgICAgICAiYTk4YzYzZTFmOTM3MWNjY2UxNTU1NzI5YzExNzQ1ZWIiCiAgICAgICAgXSwKICAgICAgICAiY2hhbmdlSm91cm5leSI6IHsKICAgICAgICAgICAgImpvdXJuZXlfMCI6IFsKICAgICAgICAgICAgICAgIHsKICAgICAgICAgICAgICAgICAgICAiYWlybGluZSI6ICJPRCIsCiAgICAgICAgICAgICAgICAgICAgImZsaWdodE51bSI6ICI2MDYiLAogICAgICAgICAgICAgICAgICAgICJkZXBhcnR1cmUiOiAiSEtHIiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlRGF0ZSI6ICIyMDIzLTA5LTI5IiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlVGltZSI6ICIxNToxNSIsCiAgICAgICAgICAgICAgICAgICAgImJvb2tpbmdDb2RlIjogIlQiLAogICAgICAgICAgICAgICAgICAgICJjYWJpbkNsYXNzIjogIkVDT05PTVkiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsIjogIktVTCIsCiAgICAgICAgICAgICAgICAgICAgImFycml2YWxEYXRlIjogIjIwMjMtMDktMjkiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsVGltZSI6ICIxOTowNSIKICAgICAgICAgICAgICAgIH0sCiAgICAgICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAgICAgImFpcmxpbmUiOiAiT0QiLAogICAgICAgICAgICAgICAgICAgICJmbGlnaHROdW0iOiAiNTIwIiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlIjogIktVTCIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZURhdGUiOiAiMjAyMy0wOS0zMCIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZVRpbWUiOiAiMDk6NTUiLAogICAgICAgICAgICAgICAgICAgICJib29raW5nQ29kZSI6ICJYIiwKICAgICAgICAgICAgICAgICAgICAiY2FiaW5DbGFzcyI6ICJFQ09OT01ZIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbCI6ICJETUsiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsRGF0ZSI6ICIyMDIzLTA5LTMwIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbFRpbWUiOiAiMTE6MDUiCiAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgIF0sCiAgICAgICAgICAgICJqb3VybmV5XzEiOiBbCiAgICAgICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAgICAgImFpcmxpbmUiOiAiT0QiLAogICAgICAgICAgICAgICAgICAgICJmbGlnaHROdW0iOiAiNTIxIiwKICAgICAgICAgICAgICAgICAgICAiZGVwYXJ0dXJlIjogIkRNSyIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZURhdGUiOiAiMjAyMy0xMC0yMCIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZVRpbWUiOiAiMTE6NTAiLAogICAgICAgICAgICAgICAgICAgICJib29raW5nQ29kZSI6ICJYIiwKICAgICAgICAgICAgICAgICAgICAiY2FiaW5DbGFzcyI6ICJFQ09OT01ZIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbCI6ICJLVUwiLAogICAgICAgICAgICAgICAgICAgICJhcnJpdmFsRGF0ZSI6ICIyMDIzLTEwLTIwIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbFRpbWUiOiAiMTU6MDUiCiAgICAgICAgICAgICAgICB9LAogICAgICAgICAgICAgICAgewogICAgICAgICAgICAgICAgICAgICJhaXJsaW5lIjogIk9EIiwKICAgICAgICAgICAgICAgICAgICAiZmxpZ2h0TnVtIjogIjYwNSIsCiAgICAgICAgICAgICAgICAgICAgImRlcGFydHVyZSI6ICJLVUwiLAogICAgICAgICAgICAgICAgICAgICJkZXBhcnR1cmVEYXRlIjogIjIwMjMtMTAtMjEiLAogICAgICAgICAgICAgICAgICAgICJkZXBhcnR1cmVUaW1lIjogIjEwOjE1IiwKICAgICAgICAgICAgICAgICAgICAiYm9va2luZ0NvZGUiOiAiWCIsCiAgICAgICAgICAgICAgICAgICAgImNhYmluQ2xhc3MiOiAiRUNPTk9NWSIsCiAgICAgICAgICAgICAgICAgICAgImFycml2YWwiOiAiSEtHIiwKICAgICAgICAgICAgICAgICAgICAiYXJyaXZhbERhdGUiOiAiMjAyMy0xMC0yMSIsCiAgICAgICAgICAgICAgICAgICAgImFycml2YWxUaW1lIjogIjE0OjE1IgogICAgICAgICAgICAgICAgfQogICAgICAgICAgICBdCiAgICAgICAgfSwKICAgICAgICAiYnV5ZXJPcmRlciI6ICJidXllck9yZGVyMSIsCiAgICAgICAgInNvbHV0aW9uS2V5IjogIiIsCiAgICAgICAgIm9yZGVyTnVtIjogIjkxNjk1ODc5ODM2NDgxMDAzMSIsCiAgICAgICAgInBhc3Nlbmdlckxpc3QiOiBbCiAgICAgICAgICAgIHsKICAgICAgICAgICAgICAgICJiaXJ0aGRheSI6ICIxOTk5LTA5LTA5IiwKICAgICAgICAgICAgICAgICJjYXJkTnVtIjogIiIsCiAgICAgICAgICAgICAgICAiY2FyZFR5cGUiOiAiUFAiLAogICAgICAgICAgICAgICAgImZpcnN0TmFtZSI6ICJ5YW5nIiwKICAgICAgICAgICAgICAgICJsYXN0TmFtZSI6ICJ6aGFuZyIsCiAgICAgICAgICAgICAgICAibmF0aW9uYWxpdHkiOiAiQ04iLAogICAgICAgICAgICAgICAgInNleCI6ICJGIgogICAgICAgICAgICB9CiAgICAgICAgXSwKICAgICAgICAiY29udGFjdEluZm8iOiB7CiAgICAgICAgICAgICJ0ZWxOdW0iOiAiMTU2OTEwMTIzMTQiLAogICAgICAgICAgICAibmFtZSI6ICJhbXkiLAogICAgICAgICAgICAiZW1haWwiOiAiYW15LnpoYW5nQHBrZmFyZS5jb20iCiAgICAgICAgfQogICAgfQp9
```


### 3. Response

### 3.1 Response Sample

2 types of response will be returned. If the change is able to be automated, a passengerPriceList element would be returned with the change amount as following: 

```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "parentOrderNum": "916958958684833601",
        "orderNum": "916958958684833602",
        "refOrderNum": "9169589586848336",
        "createTime": "2023-10-08T15:54:04+08:00",
        "voluntaryType": 1,
        "changeReason": 1,
        "orderStatus": "To Be Paid",
        "pnr": "C3CV9F",
        "airPnr": "C3CV9F",
        "platingCarrier": "UO",
        "lastTktTime": "2023-10-08T16:24:04+08:00",
        "flights": [
            {
                "flightId": "9bf2f65c69c54e553e4b1603ae5e8ca5",
                "journeyTime": "175",
                "transferCount": 0,
                "segmentIds": [
                    "fb421f8215cb7adc6b292b35dbca716b"
                ]
            },
            {
                "flightId": "580ec661f432db859df93e8820f0ba58",
                "journeyTime": "165",
                "transferCount": 0,
                "segmentIds": [
                    "ba4fca9429e79abee0c3755b88a282fe"
                ]
            }
        ],
        "segments": [
            {
                "segmentId": "fb421f8215cb7adc6b292b35dbca716b",
                "airline": "UO",
                "flightNum": "702",
                "equipment": "321",
                "cabinClass": "ECONOMY",
                "bookingCode": "V",
                "departure": "HKG",
                "arrival": "BKK",
                "departureDate": "1697964900000",
                "arrivalDate": "1697971800000",
                "flightTime": "175",
                "codeShare": "N",
                "strDepartureDate": "2023-10-22",
                "strDepartureTime": "16:55",
                "strArrivalDate": "2023-10-22",
                "strArrivalTime": "18:50"
            },
            {
                "segmentId": "ba4fca9429e79abee0c3755b88a282fe",
                "airline": "UO",
                "flightNum": "701",
                "equipment": "320",
                "cabinClass": "ECONOMY",
                "bookingCode": "T",
                "departure": "BKK",
                "arrival": "HKG",
                "departureDate": "1698740400000",
                "arrivalDate": "1698753900000",
                "flightTime": "165",
                "codeShare": "N",
                "strDepartureDate": "2023-10-31",
                "strDepartureTime": "16:20",
                "strArrivalDate": "2023-10-31",
                "strArrivalTime": "20:05"
            }
        ],
        "passengers": [
            {
                "lastName": "BAO",
                "firstName": "YI",
                "cardType": "P",
                "cardNum": "G54014364",
                "nationality": "CN",
                "psgType": "ADT",
                "sex": "M",
                "birthday": "2003-09-28"
            },
            {
                "lastName": "BAO",
                "firstName": "SAN",
                "cardType": "P",
                "cardNum": "G19405622",
                "nationality": "CN",
                "psgType": "CHD",
                "sex": "M",
                "birthday": "2017-09-28"
            }
        ],
        "passengerPriceList": [
            {
                "solutionId": "8ba97001b7230d47d7a3d2b037b8a95b",
                "solutionKey": "8ba97001b7230d47d7a3d2b037b8a95b",
                "fareType": "PRIVATE",
                "currency": "USD",
                "adtAdditionalFare": 0,
                "adtAdditionalTax": 0,
                "adtChangeFee": 0,
                "changeServiceFee": 0,
                "adtChangeAmount": 0,
                "chdAdditionalFare": 0,
                "chdAdditionalTax": 0,
                "chdChangeFee": 0,
                "chdChangeAmount": 0,
                "totalChangeAmount": 0,
                "merchantFee": 0,
                "journeys": {
                    "journey_0": [
                        "9bf2f65c69c54e553e4b1603ae5e8ca5"
                    ],
                    "journey_1": [
                        "580ec661f432db859df93e8820f0ba58"
                    ]
                }
            }
        ]
    }
}
```
If the change is not able to be automated, we will return the changeable flight information without change amount as following:

```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "parentOrderNum": "916958798364810031",
        "orderNum": "916958798364810038",
        "refOrderNum": "9169587983648100",
        "createTime": "2023-10-08T15:22:11+08:00",
        "voluntaryType": 1,
        "changeReason": 1,
        "orderStatus": "Under review",
        "pnr": "rrrr1|rrrr2|rrrr3|rrrr4",
        "platingCarrier": "OD",
        "flights": [
            {
                "flightId": "6f9cf85e209c336035854438760d1213",
                "journeyTime": "1250",
                "transferCount": 1,
                "segmentIds": [
                    "9dbf1ee0de48df643959296bd6bb078b",
                    "20ce18062818aff96f6734cefeb94a73"
                ]
            },
            {
                "flightId": "ef2abf1476d7daa10e04125e1ab511c5",
                "journeyTime": "1525",
                "transferCount": 1,
                "segmentIds": [
                    "ba9bda72df6c5b8369ebed92242729ae",
                    "e4a100ce91b1b3e9413c1588abce0cde"
                ]
            }
        ],
        "journeys": {
            "journey_0": [
                "6f9cf85e209c336035854438760d1213"
            ],
            "journey_1": [
                "ef2abf1476d7daa10e04125e1ab511c5"
            ]
        },
        "segments": [
            {
                "segmentId": "9dbf1ee0de48df643959296bd6bb078b",
                "airline": "OD",
                "flightNum": "606",
                "equipment": "738",
                "cabinClass": "ECONOMY",
                "bookingCode": "T",
                "departure": "HKG",
                "arrival": "KUL",
                "departureTerminal": "2",
                "arrivalTerminal": "M",
                "departureDate": "1695971700000",
                "arrivalDate": "1695985500000",
                "flightTime": "230",
                "codeShare": "N",
                "strDepartureDate": "2023-09-29",
                "strDepartureTime": "15:15",
                "strArrivalDate": "2023-09-29",
                "strArrivalTime": "19:05"
            },
            {
                "segmentId": "20ce18062818aff96f6734cefeb94a73",
                "airline": "OD",
                "flightNum": "520",
                "equipment": "738",
                "cabinClass": "ECONOMY",
                "bookingCode": "X",
                "departure": "KUL",
                "arrival": "DMK",
                "departureTerminal": "M",
                "arrivalTerminal": "1",
                "departureDate": "1696038900000",
                "arrivalDate": "1696043100000",
                "flightTime": "130",
                "codeShare": "N",
                "strDepartureDate": "2023-09-30",
                "strDepartureTime": "09:55",
                "strArrivalDate": "2023-09-30",
                "strArrivalTime": "11:05"
            },
            {
                "segmentId": "ba9bda72df6c5b8369ebed92242729ae",
                "airline": "OD",
                "flightNum": "521",
                "equipment": "738",
                "cabinClass": "ECONOMY",
                "bookingCode": "X",
                "departure": "DMK",
                "arrival": "KUL",
                "departureTerminal": "1",
                "arrivalTerminal": "M",
                "departureDate": "1697773800000",
                "arrivalDate": "1697785500000",
                "flightTime": "135",
                "codeShare": "N",
                "strDepartureDate": "2023-10-20",
                "strDepartureTime": "11:50",
                "strArrivalDate": "2023-10-20",
                "strArrivalTime": "15:05"
            },
            {
                "segmentId": "e4a100ce91b1b3e9413c1588abce0cde",
                "airline": "OD",
                "flightNum": "605",
                "equipment": "738",
                "cabinClass": "ECONOMY",
                "bookingCode": "X",
                "departure": "KUL",
                "arrival": "HKG",
                "departureTerminal": "M",
                "arrivalTerminal": "2",
                "departureDate": "1697854500000",
                "arrivalDate": "1697868900000",
                "flightTime": "240",
                "codeShare": "N",
                "strDepartureDate": "2023-10-21",
                "strDepartureTime": "10:15",
                "strArrivalDate": "2023-10-21",
                "strArrivalTime": "14:15"
            }
        ],
        "passengers": [
            {
                "lastName": "ZHANG",
                "firstName": "YANG",
                "cardType": "P",
                "cardNum": "",
                "nationality": "CN",
                "psgType": "ADT",
                "sex": "F",
                "birthday": "1999-09-09"
            }
        ]
    }
}
```
 
### 3.2 Response Parameter


|Name |Type |Parameter Description |Sample |
|------- |--------- |--------- |--------- |
|errorCode |String |Error code, refer to error code list 5.1 |0 |
|errorMsg |String |Error message |OK |
|warningMsg |String |Warning message | |
|data |Object |The return data, this parameter is not empty only when the errorCode retruns "0", refer to section 3.2.1 |- |

### 3.2.1 Data


| Name        | Type        | Parameter Description | Sample           |
|------- |--------- |--------- |--------- |
|orderNum |String |Change order number | |
|parentOrderNum |String |PKFARE parent order number of this change order, it could be issued order number or change order number | |
|refOrderNum |String |PKFARE general order number, it may include more orders | |
|createTime |String |Order creation time, format yyyy-MM-dd HH:mm:ss(UTC+0) | |
|voluntaryType |Integer |Change type: 0-voluntary, 1-involuntary | |
|changeReason |Integer |Change reason: 0-Voluntary, 1-Flight reschedule / cancellation, 2-Reissue due to medical reasons, 3-Reissue due to visa refusal， 4-Others | |
|rejectedReason |String |Reject reason | |
|remarks |String |Reject remark | |
|orderStatus |String |Order status | |
|pnr |String |PNR of order | |
|airPnr |String |Airline PNR of order | |
|platingCarrier |String |Plating carrier | |
|lastTktTime |String |Latest ticketing time | |
|journeys |Array |Itinerary information, outbound use journey_0, inbound use journey_1 |- |
|passengerPriceList |Array |Passenger pricing information |- |
|passengers |Array |Passenger information |- |
|ancillaries |Object |Ancillaries product information | |

### 3.2.2 Journeys


| Name        | Type        | Parameter Description | Sample           |
|------- |--------- |------- |--------- |
|journey |Array |Flight ID of this itinerary |- |

 
### 3.2.3 PassengerPriceList


| Name        | Type        | Parameter Description | Sample           |
|------- |--------- |------- |--------- |
|solutionId |String |Unique identification of this solution |- |
|solutionKey |String |Unique identification of this solution | |
|fareType |String |Fare type, PUBLIC or PRIVATE |PUBLIC |
|currency |String |Currency code |CNY |
|changeServiceFee |BigDecimal |Change service fee per passenger |50.00 |
|adtAdditionalFare |BigDecimal |Additional fare per adult | |
|adtAdditionalTax |BigDecimal |Additional tax per adult | |
|adtChangeFee |BigDecimal |Adult change fee which is charged per penalty or goverment in some special area | |
|adtChangeAmount |BigDecimal |Total change amount per adult | |
|chdAdditionalFare |BigDecimal |Additional fare per child | |
|chdAdditionalTax |BigDecimal |Additional tax per child | |
|chdChangeFee |BigDecimal |Child change fee which is charged per penalty or goverment in some special area | |
|chdChangeAmount |BigDecimal |Total change amount per child | |
|infAdditionalFare |BigDecimal |Additional fare per infant | |
|infAdditionalTax |BigDecimal |Additional tax per infant | |
|infChangeFee |BigDecimal |Infant change fee which is charged per penalty or goverment in some special area | |
|infChangeAmount |BigDecimal |Total change amount per infant | |
|totalChangeAmount |BigDecimal |Total change amount of this change request | |
|merchantFee |BigDecimal |Payment transaction fee | |
|journeys |Array |Changable journey infomration of the price | |
|baggageMap |Object |Baggage allowance for reference only. Including 'ADT' and 'CHD'. If the request does not include children, 'CHD' would be NULL. | |
|miniRuleMap |Object |Penalty rule for reference only. | |

 
### 3.2.4 Flights



|Name |Type |Parameter Description |Sample |
|------- |--------- |------- |--------- |
|flightId |String |Journey ID，unique identification |5681852857622213a101ebe5ec4b38cd |
|journeyTime |Integer |Journey time, unit: minute |315 |
|segmentIds |String[] |Segment ID，this is related to Segments[]，refer to 3.2.5 |88af51ed8e8bd63127e06b2c7f800398 |
|transferCount |Integer |Transfer count |0 |

 
### 3.2.5 Segments



|Name |Type |Parameter Description |Sample |
|------- |--------- |------- |--------- |
|segmentId |String |Segment ID, unique identification |88af51ed8e8bd63127e06b2c7f800398 |
|airline |String |Airline code [IATA airline code] |CA |
|flightNum |String |Flight Number |6509 |
|equipment |String |Equipment |737 |
|cabinClass |String |Cabin class, refer to 5.2 |ECONOMY |
|bookingCode |String |Booking code. It will be return along with a change price. If the price is not able to be returned, please refer to classCodes |E |
|availabilityCount |String |Availability count of booking code. It will be return along with a change price. If the price is not able to be returned, please refer to classCodes |9 |
|departure |String |Departure airport code |PEK |
|arrival |String |Arrival airport code |HKG |
|departureTerminal |String |Departure terminal |1 |
|arrivalTerminal |String |Arrival terminal |2 |
|departureDate |Long |Departure date [unix time] |1570633500000 |
|strDepartureDate |String |Departure date [yyyy-mm-dd], local time of departure city |2019-09-30 |
|arrivalDate |String |Arrival date [unix time] |1570661400000 |
|strArrivalDate |String |Arrival date [yyyy-mm-dd], local time of arrival city |2019-09-30 |
|strDepartureTime |String |Departure time [hh:mm], local time of departure city |11:00 |
|strArrivalTime |String |Arrival time [hh:mm], local time of arrival city |14:00 |
|flightTime |Integer |Flight time, unit: minute |250 |
|stayTime |Integer |Stay time, valid with 'stopover', unit: minute |100 |
|codeShare |String |Code share flight or not [Y - Yes, N - No] |Y |
|opFltNo |String |Flight number of operated carrier. It will not return if the flight is not a code share flight |202 |
|opFltAirline |String |Operated carrier. It will not return if the flight is not a code share flight |KA |
|stopover |String |Stopover airport [IATA airport code]. It will not return if there is no stopover |BKK |
|fareBasis |String |Fare basis of the price. It will be return along with a change price. If the price is not able to be returned, it will not return | |

 
### 3.2.6 Passengers



|Name |Type |Parameter Description |Sample |
|------- |--------- |------- |--------- |
|lastName |String |Last name |WANG |
|firstName |String |First name |JANGO |
|cardType |String |Travel document type |P |
|cardNum |String |Travel document number |P1234567 |
|cardExpiredDate |String |Travel document expired date |2030-10-10 |
|nationality |String |Nationality |CN |
|psgType |String |Passenger type |ADT |
|sex |String |Gender |M |
|birthday |String |Date of birth |2015-01-10 |

### 3.2.7 Ancillaries



| Name            | Type       | Parameter Description                                      | Sample                                |
|------- |--------- |------- |--------- |
|ancillaryPassenger |Object |Ancillary passenger who has booked ancillaries and want to change | |
|ancillary |Object |Ancillary information which has been booked and want to change | |

### 3.2.8 Ancillaries


| Name             | Type        | Parameter Description                                      | Sample                                |
|------- |--------- |------- |--------- |
|baggage |Object |Baggage details | |

### 3.2.9 Baggage


| Name             | Type        | Parameter Description                                      | Sample                              |
|------- |--------- |------- |--------- |
|ancillaryType |Integer |Baggage details, 1-baggage | |
|ancillaryKey |String |Unique ID which is used when book this ancillary product | |
|payBaggageType |Integer |Baggage type: 1-checked baggage, 2-carry-on baggage | |
|baggagePiece |Integer |Baggage piece, -1- not limit to baggage piece | |
|baggageWeight |String |Baggage weight |10KG |
|baggageCurrency |String |Currency when booking | |
|baggagePrice |BigDecimal |Price when booking | |
|description |String |Baggage description | |
|ancillaryJourneys |Array |Itinerary information of ancillary | |
|buyerOrder |String |Buyer ancillary order number | |

### 3.2.10 Ancillary Passengers



| Name             | Type        | Parameter Description                                      | Sample                              |
|------- |--------- |------- |--------- |
|lastName |String |Last name | |
|firstName |String |First name | |
|psgType |String |Passenger type | |

### 3.2.11 Ancillary Journey


| Name             | Type        | Parameter Description                                     | Sample                             |
|------- |--------- |------- |--------- |
|airline |String |Airline | |
|flightNum |String |Flight number | |
|departure |String |Departure airport code | |
|departureDate |String |Departure date | |
|departureTime |String |Departure time | |
|arriaval |String |Arrival airport code | |
|arrivalDate |String |Arrival date | |
|arrivalTime |String |Arrival time | |

### 3.2.7 BaggageMap


| Name             | Type        | Parameter Description                                     | Sample                            |
|------- |--------- |------- |--------- |
|segmentIndexList |String[] |Segment index list for baggage. Index begins with "1". If 1st segment has same baggage allowance with 3rd segment, please refer to sample |[1,3] |
|baggageAmount |String |Free baggage amount allowance. '1PC' for 1 piece |1PC |
|baggageWeight |String |Free baggage weight allownance |30KG |
|carryOnAmount |String |Free carry-on baggage amount allownance. '1PC' for 1 piece | |
|carryOnWeight |String |Free carry-on baggage weight allownance | |

### 3.2.8 MiniRuleMap


| Name             | Type        |Parameter Description                                      | Sample                               |
|------- |--------- |------- |--------- |
|segmentIndex |String[] |Segment index list for mini-rule. Index begins with "1". If 1st segment has same rules allowance with 3rd segment, please refer to sample |[1,3] |
|miniRules |Array |Mini-rules information |- |

 
### 3.2.9 MiniRules


| Name             |Type        | Parameter Description                                     | Sample                            |
|------- |--------- |------- |--------- |
|penaltyType |Integer |Penalty type: 0-refund, 1-noShow refund, 2-change, 3-noShow change | |
|isPermited |Integer |Allow refund/change or not; 0-not allow, 1-allow, 2-unknown | |
|when |Integer |Appropriate situationL 0-Both Outbound and inbound are not used, 1-Outbound flight used, 2-All situation | |
|noShowTime |String |NoShow definition. Apply with 'noShowTimeUnit' | |
|noShowTimeUnit |String |NoShow unit. Apply with 'noShowTime': H-hour, M-minute | |
|amount |BigDecimal |Penalty amount | |
|currencyCode |String |Penalty currency code | |
|percentage |BigDecimal |Penalty percentage. Apply with 'baseType'. Penalty and penalty percentage would not go into effect at the same. Please take the strict one. Unit:% | |
|baseType |Integer |Apply with 'percent'. Multiply corresponding value of 'baseType' by 'percent' would be penalty. 0-fare, 1-fare+taxes+ticketing fee, 2-cabin basic fare | |

 
 
### 4 Signature

### 4.1 Parameters

partnerId，partnerKey
 
### 4.2 Sign

Combine partnerId and partnerKey to make an MD5 encryption on final value.
Sign = MD5(partnerId+partnerKey)。

```
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
 
 
### 5 Appendix

 
### 5.1 Error Code List


| errorCode  | errorMsg                       |Description |
|------- |--------- |--------- |
|0 |ok |Request has been processed successfully. |
|S001 |System error |System error. |
|P001 |xxx is illegal |Parameter in the request is illegal. xxx will be replaced by the element name |
|P002 |xxx is missing |Parameter is not in the request, which is mandatory. xxx will be replaced by the element name. |
|P006 |Invalid parameter |Invalid parameter. |
|B002 |Partner is not exists |Partner is not exists. |
|B003 |Illegal sign |Illigal sign, please check signature session |
|B009 |Order status is invalid |Order status is not allow to change. |
|B037 |Order is not exist. |Order number is not exists. |
|B038 |Departure date must be today to a year. |Departure date must be today to a year. |
|B048 |Invalid buyer |Buyer is invalid, please contact with PKFARE administrator |
|B135 |Passenger or ticket number is not in the order |Passenger or ticket number in the request is not in the order. |
|B148 |UploadedFileId is not exist. |UploadedFileIds in the request is not exist. |
|B150 |The order was changed, please kindly use change order number. |The order was changed before. Please use the latest order number to raise change. |
|B152 |pnrList information is not same as order, please kindly check. |pnrList information is not same as order, please kindly check. |
|B156 |Order#[Order number] is not applicable for change |The order is neither origin order nor change order. Change request is not allowed. |
|B157 |Duplicate change has been found for passenger[passenger name] in order [order number] |A duplicated request is found, and  order for previous request was created succesfully. You are able to use order number in the message to request OrderDetails API for more information. |
|B160 |You have the option to select any day within a {x}-day window prior to the original departure date or {x} days window following the original departure date as the new departure date, but not allow change to {Blackout date range}. |According to airline rules, the change is only allowed in a time window. |
|B162 |Change is not applicable for passenger xxx/xxx |Passenger has requested for void or refund, change is not allowed. |
|B163 |Ticket(s) [ticket number] is No-show, change is not applicable. |The ticket is noshow per airline rules, change is not allowed. |
|B164 |Passenger(s) must has same routing and request to change. If routing isvaries, please request per passenger. |One of multiple Passenger(s) in the request has requested to change the routing. Change is not allow to raise togther. |
|B165 |Uncompleted segmentList, it should contain segments of whole journey |Itinerary in the request is part of the journey, change by segment is not support for this order. |
|B167 |The change routing is not same as the routing in SolutionKey |We found the solutionKey in the request which routing information is different with requested routing. |
|B172 |The departure date of return journey must be subsequent to the arrival date of outbound journey. |The departure date of return journey must be subsequent to the arrival date of outbound journey. |
|B173 |Cabin class upgrading or downgrading is not allowed for involuntary change. |For involuntary change, the cabin class has to be same as booked cabin. |
|B174 |Reason is not match with voluntary type. |Reason is not match with voluntary type. |
|B175 |Reason is not match with involuntary type. |Reason is not match with involuntary type. |
|B176 |Infant is not support for change. Please kindly contact online service for help. |Infant is not support for change. Please kindly contact online service for help. |
|B178 |Request processing, please try again later |A change request is processing. Order is locked, other changes is rejected|
 
### 5.2 Cabin Class


|Value |Description |
|------- |--------- |
|Economy |Enconomy class |
|PremiumEconomy |Premium Economy class |
|Business |Business class |
|First |First class |