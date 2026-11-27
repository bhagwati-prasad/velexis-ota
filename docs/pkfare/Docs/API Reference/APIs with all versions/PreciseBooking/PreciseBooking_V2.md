# PreciseBooking_V2

## 1 Function

Through PreciseBooking_v2 API, users can create an order in PKAFRE. It also supports booking baggage with the order.

Currently, we don't support booking multiple paid bags for same passenger on one flight. If you request booking more than one paid bag for same passenger on one flight, we will only book the heaviest baggage by default.

It is necessary to use PrecisePricing service before using this interface. The whole process should be limited to 30 mins. 

## 2 Versioning

|Version|Sandbox Invoking Address|Update|
|:----|:----|:----|
|preciseBooking|[https://api.pkfare.com/preciseBooking](https://api.pkfare.com/preciseBooking_V2)|    |
|preciseBooking_V2|[https://api.pkfare.com/preciseBooking_V2](https://api.pkfare.com/preciseBooking_V2)|It is capable of buying ancillaries.|

## 
## 3 Charater Encoding

The character code of this API is UTF-8. 

## 
## 4 Request 

### 4.1 Schema

Please structure parameter as JSON format. Request should be transmitted after BASE64 encrypted. 

|Name|Type|Required|Description|Sample|
|:----|:----|:----|:----|:----|
|Authentification|    |    |    |    |
|partnerId|string|Yes|Partner ID|RksVSX7PfZm1yF04adBWYsCD7M4=|
|sign|string|Yes|signature, sign=MD5 (partnerId+partnerKey)|17e707b5d9dae8459065dbb139e5f1bd<br> |
|Booking|    |    |    |    |
|passengers|Array|Yes|passenger information|-|
|solution|Object|Yes|journey information|-|
|buyerOrder|String|No|Your order number if you want to store at PKFARE side.|-|
|ancillaries|Object|Yes|ancillary information|-|
|passengers|    |    |    |    |
|birthday|String|Yes|date of birth|2015-01-10|
|cardType|String|No|type of travel document, refer to 5.3. Passengers could make reservations with Chinese Identity if the itinerary is China domestic journey (NOT including Hong Kong, Macao and Taiwan). If using Chinese Identity please input 'N' into 'cardType' and input name in Chinese character.If bookingWithoutCard is 1 in responds of PrecisePricing_V2, you can leave it as blank.|P|
|cardNum|String|No|travel document number. If bookingWithoutCard is 1 in responds of PrecisePricing_V2, you can leave it as blank.|G2568574|
|cardExpiredDate|String|No|travel document expired date. If using Chinese Identity please input a fake cardExpiredDate to pass the parameter validation. If bookingWithoutCard is 1 in responds of PrecisePricing_V2, you can leave it as blank.|2020-05-06|
|lastName|String|Yes|last name. Please use a real name and do not use "TEST"|Wang|
|firstName|String|Yes|first name. Please use a real name and do not use "TEST"|Jango|
|nationality|String|Yes|nationality [country code].|CN|
|psgType|String|Yes|passenger type|ADT|
|sex|String|Yes|gender|M|
|solution|    |    |    |    |
|fareType|String|No|the type of fare, refer to |PUBLIC|
|adtFare|BigDecimal|No|adult fare|1206|
|adtTax|BigDecimal|No|adult tax|1298|
|chdFare|BigDecimal|No|child[age 2-12] fare|803|
|chdTax|BigDecimal|No|child[age 2-12] tax|200|
|comments|String|No|comments|-|
|journeys|Object[]|Yes|journey, refer to below|-|
|journey|    |    |    |    |
|airline|String|Yes|airline code|SA|
|flightNum|String|Yes|flight No.|102|
|arrival|String|Yes|destination[IATA airport code]|CPT|
|arrivalDate|String|Yes|arrival Date[yyyy-mm-dd]|2015-11-11|
|arrivalTime|String|Yes|arrival Time[hh:mm]|11:45|
|departure|String|Yes|departure[IATA airport code]|BKK|
|departureDate|String|Yes|departure Date[yyyy-mm-dd]|2015-11-30|
|departureTime|String|Yes|departure Time[hh:mm]|07:05|
|bookingCode|String|Yes|cabin code|N|
|ancillaries|    |    |    |    |
|ancillaryPassenger|Object|Yes|booking ancillary passenger (This field is required when booking)|-|
|ancillary|Object|Yes|ancillary data (This field is required when booking)|-|
|ancillary|    |    |    |    |
|baggage|Object|Yes|baggage details (This field is required when booking)|-|
|baggage|    |    |    |    |
|ancillaryType|Integer|Yes|baggage details (This field is required when booking); 1-baggage|1|
|ancillaryKey|String|Yes|unique ID returned in AncillaryPricing (This field is required when booking)|62613b9298386105acb75ed148af00cb|
|payBaggageType|Integer|Yes|baggage type (This field is required when booking); 1-checked baggage, 2-carry-on baggage|1|
|baggagePiece|Integer|Yes|baggage piece (This field is required when booking); -1 - no limit to baggage piece|1|
|baggageWeight|String|Yes|baggage weight (This field is required when booking)|20KG|
|baggageCurrency|String|Yes|currency (This field is required when booking)|CNY|
|baggagePrice|bigDecimal|Yes|price (This field is required when booking)|198.00|
|description|String|No|baggage description|-|
|ancillaryJourneys|Array|Yes|itinerary information (This field is required when booking)|-|
|buyerOrder|String|No|buyer ancillary order number|-|
|ancillaryPassengers|    |    |    |    |
|lastName|String|Yes|last name (This field is required when booking)|WANG|
|firstName|String|Yes|first name (This field is required when booking)|JANGO|
|psgType|String|Yes|passenger type (This field is required when booking); ADT-Adult, CHD-Child[2-12 years old]|ADT|
|ancillaryJourney|    |    |    |    |
|airline|String|Yes|airline code|FD|
|departure|String|Yes|origin[IATA airport code]|DMK|
|departureDate|String|Yes|departure date[yyyy-MM-dd]|2022-10-01|
|departureTime|String|Yes|departure time[hh:mm]|09:55|
|arrival|String|Yes|destination[IATA airport code]|CNX|
|arrivalDate|String|Yes|arrival date[yyyy-MM-dd]|2022-10-01|
|arrivalTime|String|Yes|arrival time[hh:mm]|11:25|
|flightNum|String|Yes|flight number|513|
|bookingCode|String|Yes|cabin code|N|
|Contact|    |    |    |    |
|name|string|No|Name format: FirstnameLastname|AndyGuan|
|email|string|No|email|andy.guan@pkfare.com|
|telCode|string|No|Area Code|+86|
|mobile|string|No|Telephone|17826050868|
|postcode|string|No|Postcode|    |
|address|string|No|Address|    |

### 4.3 Example

1. Round Journey with ancillary booking
```plain
{
    "authentication": {
        "partnerId": "ABCDEFGHIGKLMNOPQRST=",
        "sign": "0q0w1e1r2t2y3y3u5h5j5k6l6nddiesa"
    },
    "booking": {
        "buyerOrder": "7878787878",
        "passengers": [  
            {
                "birthday": "1997-06-22",
                "firstName": "Jason",
                "lastName": "Smith",
                "nationality": "PH",
                "psgType": "ADT",
                "sex": "M"
            }
        ],
        "ancillary": [
            {
                "ancillaryPassenger": {
                    "firstName": "Jason",
                    "lastName": "Smith",
                    "psgType": "ADT"
                },
                "ancillaries": {
                    "baggage": [
                        {
                            "ancillaryKey": "91a3502dc966d911494239612d6d7765",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "20KG",
                            "baggageCurrency": "USD",
                            "baggagePrice": "18.940",
                            "ancillaryJourneys": [
                                {
                                    "airline": "5J",
                                    "flightNum": "506",
                                    "arrival": "TUG",
                                    "arrivalDate": "2022-12-04",
                                    "arrivalTime": "12:15",
                                    "departure": "MNL",
                                    "departureDate": "2022-12-04",
                                    "departureTime": "11:05",
                                    "bookingCode": "K"
                                }
                            ]
                        },
                        {
                            "ancillaryKey": "2e81b09af4c2eb137248f5af29ffe2ce",
                            "payBaggageType": 1,
                            "baggagePiece": 1,
                            "baggageWeight": "20KG",
                            "baggageCurrency": "USD",
                            "baggagePrice": "18.940",
                            "ancillaryJourneys": [
                                {
                                    "airline": "5J",
                                    "flightNum": "507",
                                    "arrival": "MNL",
                                    "arrivalDate": "2022-12-07",
                                    "arrivalTime": "14:05",
                                    "departure": "TUG",
                                    "departureDate": "2022-12-07",
                                    "departureTime": "12:45",
                                    "bookingCode": "V"
                                }
                            ]
                        }
                    ]
                }
            }
        ],
        "solution": {
            "adtFare": 153.22,
            "adtTax": 25.49,
            "chdFare": 0.0,
            "chdTax": 0.0,
            "journeys": {
                "journey_0": [
                    {
                        "airline": "5J",
                        "flightNum": "506",
                        "arrival": "TUG",
                        "arrivalDate": "2022-12-04",
                        "arrivalTime": "12:15",
                        "departure": "MNL",
                        "departureDate": "2022-12-04",
                        "departureTime": "11:05",
                        "bookingCode": "K"
                    }
                ],
                "journey_1": [
                    {
                        "airline": "5J",
                        "flightNum": "507",
                        "arrival": "MNL",
                        "arrivalDate": "2022-12-07",
                        "arrivalTime": "14:05",
                        "departure": "TUG",
                        "departureDate": "2022-12-07",
                        "departureTime": "12:45",
                        "bookingCode": "V"
                    }
                ]
            }
        },
        "contact": {
            "name": "AndyGuan",
            "email": "andy.guan@pkfare.com",
            "telCode": "+86",
            "mobile": "17826050868"
        }
    }
}
```
## 5 Response

### 5.1 Schema

|Name|Type|Description|Sample|
|:----|:----|:----|:----|
|Basic Parameters|    |    |    |
|errorCode|String|error code; refer to error code list|0|
|errorMsg|String|error message|OK|
|data|Object|only if the errorCode returns "0", returned data would not be null. Data is in JSON format, which contains three collection objects: solutions, flights, segments |-|
|data|    |    |    |
|solution|Object|refer to |-|
|flights|Array|refer to |-|
|segments|Array|refer to |-|
|pnr|String|pnr|KKXJS2|
|orderNum|String|order number|1014766841|
|ancillary|Object|ancillary information|-|
|5.1 Solution|    |    |    |
|solutionKey|String|unique identification|0357301bf213453389fcb55c379a4667|
|fareType|String|fare type, refer to 5.2 Fare Type|PUBLIC|
|currency|String|currency|CNY|
|adtFare|BigDecimal|adult fare|1011|
|adtTax|BigDecimal|adult tax|527|
|chdFare|BigDecimal|children [age 2-12] fare|500|
|chdTax|BigDecimal|children [age 2-12] tax|250|
|qCharge|BigDecimal|Q charge, bunker adjustment surcharge, for reference only|0|
|tktFee|BigDecimal|ticketing service fee|0|
|platformServiceFee|BigDecimal|platform service fee, defaults to 0|0|
|journeys|String[]|JSON format string array. Content: flightID(3.1.4)|-|
|platingCarrier|String|ticketing airline|CA|
|merchantFee|BigDecimal|payment transaction fee|7.39|
|afterSaleRule|Obejct|after sale rule, not supported yet|-|
|Flights|    |    |    |
|flightId|String|flight ID， unique identification|9ef88fd9dae30560c683911f534c6c49|
|journeyTime|Long|journey Time, unit: minute|350|
|transferCount|Integer|number of Transfer|1|
|lastTktTime|String|latest ticketing time (GMT)|2015-10-28 23:59:00|
|segmengtIds|String[]|number of segment arrays (please note the segmengtIds is a typo due to history edition)|-|
|Segments|    |    |    |
|segmentId|String|segment ID, unique identification|4ee200cb7feab403d6babbf797ac92aa|
|airline|String|airline code|CA|
|flightNum|String|flight number|6509|
|equipment|String|equipment|737|
|cabinClass|String|cabin class, refer to 5.3 Cabin Class|Economy|
|bookingCode|String|cabin code|E|
|availabilityCount|Integer|available seats, for reference only|7|
|departure|String|departure airport|PEK|
|arrival|String|arrival airport|HKG|
|departureTerminal|String|departure airport terminal|3|
|arrivalTerminal|String|arrival airport terminal|1|
|departureDate|Long|departure date [unix time]|1446009600000|
|arrivalDate|Long|arrival date [unix time]|1446017400000|
|flightTime|Integer|flight time, unit: minute|130|
|stayTime|Integer|stay time, valid with 'stopover' , unit: minute|60|
|codeShare|String|code share or not: [Y-yes, N-no]|Y|
|opFltNo|String|flight number of operated carrier|202|
|opFltAirline|String|operated carrier|KA|
|stopover|String|stopover airport|PEK|
|strDepartureDate|String|departure date[yyyy-mm-dd], local time|2016-08-27|
|strDepartureTime|String|departure time[hh:mm], local time|09:30|
|strArrivalDate|String|arrival date[yyyy-mm-dd], local time|2016-08-27|
|strArrivalTime|String|arrival time[hh:mm], local time|11:50|
|ancillary|    |    |    |
|lastName|String|last name|WANG|
|firstName|String|first name|JANGO|
|psgType|String|passenger type; ADT-Adult, CHD-Child[2-12 years old]|ADT|
|ancillaries|Object|ancillary data|-|
|ancillaries|    |    |    |
|baggage|Object|baggage details|-|
|baggage|    |    |    |
|ancillaryType|Integer|baggage details; 1-baggage|1|
|ancillaryKey|String|unique ID returned in AncillaryPricing|62613b9298386105acb75ed148af00cb|
|payBaggageType|Integer|baggage type; 1-checked baggage, 2-carry-on baggage|1|
|baggagePiece|Integer|baggage piece; -1 - no limit to baggage piece|1|
|baggageWeight|String|baggage weight|20KG|
|baggageCurrency|String|currency|CNY|
|baggagePrice|bigDecimal|price|198.00|
|description|String|baggage description|-|
|journeys|Object|itinerary information|-|
|buyerOrder|String|buyer ancillary order number|-|
|journey|    |    |    |
|airline|String|airline code|FD|
|departure|String|origin[IATA airport code]|DMK|
|departureDate|String|departure date[yyyy-MM-dd]|2022-10-01|
|departureTime|String|departure time[hh:mm]|09:55|
|arrival|String|destination[IATA airport code]|CNX|
|arrivalDate|String|arrival date[yyyy-MM-dd]|2022-10-01|
|arrivalTime|String|arrival time[hh:mm]|11:25|
|flightNum|String|flight number|513|
|bookingCode|String|cabin code|N|

### 5.2 Example

Success response

```plain
{
    "data": {
        "flights": [
            {
                "flightId": "ef8caaf829406399310863e678196849",
                "journeyTime": 450,
                "lastTktTime": "2017-07-07 23:59:00",
                "segmengtIds": [
                    "b8ea011c2f09f69cfe9311ceef3e3a5b",
                    "43ee963d98ef57314e55677c10b86ca0"
                ],
                "transferCount": 1
            }
        ],
        "orderNum": 1014766841,
        "pnr": "SQFTQJ",
        "segments": [
            {
                "airline": "MU",
                "arrival": "HKG",
                "arrivalDate": 1499399400000,
                "arrivalTerminal": "1",
                "availabilityCount": 1,
                "bookingCode": "B",
                "cabinClass": "ECONOMY",
                "codeShare": "N",
                "departure": "PVG",
                "departureDate": 1499391000000,
                "departureTerminal": "1",
                "equipment": "320",
                "flightNum": "501",
                "flightTime": 140,
                "opFltAirline": "",
                "segmentId": "43ee963d98ef57314e55677c10b86ca0",
                "strArrivalDate": "2017-07-07",
                "strArrivalTime": "11:50",
                "strDepartureDate": "2017-07-07",
                "strDepartureTime": "09:30"
            },
            {
                "airline": "MU",
                "arrival": "PVG",
                "arrivalDate": 1499383200000,
                "arrivalTerminal": "1",
                "availabilityCount": 1,
                "bookingCode": "R",
                "cabinClass": "ECONOMY",
                "codeShare": "Y",
                "departure": "KUL",
                "departureDate": 1499364600000,
                "departureTerminal": "M",
                "equipment": "738",
                "flightNum": "9862",
                "flightTime": 310,
                "opFltAirline": "FM",
                "opFltNo": "862",
                "segmentId": "b8ea011c2f09f69cfe9311ceef3e3a5b",
                "strArrivalDate": "2017-07-07",
                "strArrivalTime": "07:20",
                "strDepartureDate": "2017-07-07",
                "strDepartureTime": "02:10"
            }
        ],
        "solution": {
            "adtFare": 1330,
            "adtTax": 753.0,
            "afterSaleRule": null,
            "buyerExchRate": 0,
            "chdFare": 0,
            "chdTax": 0,
            "currency": "CNY",
            "fareType": "PUBLIC",
            "journeys": {
                "journey_0": [
                    "ef8caaf829406399310863e678196849"
                ]
            },
            "merchantFee": 2.08,
            "platformServiceFee": 0,
            "platingCarrier": "MU",
            "qCharge": 0,
            "solutionKey": "3aed0b90f0c04b5ea51ad01f3470f254",
            "tktFee": 0.0
        }
        "ancillary": [
            {
                "ancillaries": {
                    "baggage": [
                        {
                            "ancillaryJourneys": [
                                {
                                    "airline": "TR",
                                    "arrival": "SIN",
                                    "arrivalDate": "2022-04-01",
                                    "arrivalTime": "14:25",
                                    "bookingCode": "Y",
                                    "departure": "HKG",
                                    "departureDate": "2022-04-01",
                                    "departureTime": "10:50",
                                    "flightNum": "981"
                                },
                                {
                                    "airline": "TR",
                                    "arrival": "BKK",
                                    "arrivalDate": "2022-04-02",
                                    "arrivalTime": "09:50",
                                    "bookingCode": "M",
                                    "departure": "SIN",
                                    "departureDate": "2022-04-02",
                                    "departureTime": "08:20",
                                    "flightNum": "624"
                                }
                            ],
                            "ancillaryId": "9b43ce6302e3ae8e130b94112f992771",
                            "ancillaryType": 1,
                            "baggageCurrency": "CNY",
                            "baggagePiece": 1,
                            "baggagePrice": 663,
                            "baggageWeight": "50KG",
                            "description": "extra 1 piece baggage",
                            "payBaggageType": 1,
                        }
                    ]
                },
                "firstName": "TEEMO",
                "lastName": "CUI",
                "psgType": "ADT"
            }
        ],
    },
    "errorCode": "0",
    "errorMsg": "ok"
}
```
Failure response
```plain
{
    "errorCode": "P001", 
    "errorMsg": "Invalid authentication.", 
    "data": null
}
```
## 6 Error Code List

|errorCode|errorMsg|Description|
|:----|:----|:----|
|0|ok|Request has been processed successfully.|
|S001|System error.|System error.|
|B002|Partner is not exists.|PartnerID does not exist.|
|B003|Illegal sign.|Illegal sign. Please check your signature.|
|B035|Concurrency limited. Please contact PKFARE API support team for assistant.|Concurrency exceeded system limits.|
|P001|XXX is illegal.|The field of XXX is illegal.|
|P002|XXX is missing.|The field of XXX is missing.|
|P006|Invalid parameter.|Value of request cannot pass the validation, please check on the request.|
|0307|Reservation failed - Booking class is sold out.|Reservation failed. Seats have been sold out.|
|B005|Can not find any matching precisePricing result within 30 minutes.|Can not find the corresponding precisePricing record. Please check the itinerary and passenger numbers. PreciseBooking has to be invoked within 30 minutes after pricing.|
|B006|Reservation failed - Other. OrderNum is XXX.|Booking fail for other reason. The order has been created which is indicated in Other.OrderNum field|
|B006|Reservation failed.|Booking fail for other reason.|
|B007|Reservation failed - Segment status is not HK.|Segment status is invalid from GDS. Please select other flight options.|
|B008|Itinerary is different between PNR and order.|Itinerary in reservation is different from precisePricing. There might be a flight re-schedule. Please select other flight options.|
|B011|Reservation failed - Fare is unavailable.|Fare is unavailable form GDS. Please select other flight options.|
|B012|Reservation failed - Create PNR time out.|Create PNR time out from GDS. Please wait some minutes or select other flight options.|
|B017|Price is changed.|Price is changed.|
|B023|Reservation failed - Save price fail.|Fail to save price from GDS.|
|B025|Reservation failed - RT PNR fail.|Fail to retieve PNR from GDS.|
|B027|Airline PNR is missing.|Airline PNR is missing from GDS.|
|B028|Reservation failed - Time out.|Booking time out from GDS.|
|B029|Duplicate reservations have been found for passenger XXX/XXX in order XXX, in pnr XXX.|Duplicated reservation is not allowed. If there is an order with same segment and passenger, system will block the second reservation and return error. Please cancel the last duplicated order or pay the last order directly.|
|B030|Illegal passenger name, please use Chinese character.|Wrong passenger name. If passengers use Chinese ID card to make reservation for China domestic flight, please use Chinese character.|
|B031|Illegal passenger name, please use correct Chinese character.|Wrong passenger name. If passengers use chinese ID card to make reservation, the chinese name length is over the limitation.|
|B032|Illegal passport, please use 'N' as document type if you are using Chinese ID card to make reservation.|Illegal passport. If passengers book Chinese flight, please use correct passport.|
|B043|Reservation failed: Create PNR failed.|Booking failed from GDS.|
|B044|Reservation failed - Create PNR failed, end transaction failed.|Booking failed from GDS.|
|B062|The length of passenger name should be 40 English alphabet including / between last name and first name.|Passenger's name should be within 40 English alphabet, including "/" between last name and first name.|
|B064|The lastName of passegner should be within 2-30 English alphabet.|Passenger's last name should be within 2-30 English alphabet.|
|B065|Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality.|Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality.Please contact PKFARE API support.|
|B069|Reservation failed, this fare has passenger age limitation.|Reservation failed, because this fare has a passenger age limition.|
|B121|Supplier is offline|Supplier is not at working time, please contact PKFARE API support.|


