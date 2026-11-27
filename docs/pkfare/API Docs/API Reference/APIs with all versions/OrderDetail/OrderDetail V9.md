# OrderDetail V9

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/orderDetail/v9:
    post:
      summary: OrderDetail V9
      deprecated: false
      description: >+
        ##  Function


        Through OrderDetail_V9 API, users can check order details including all
        journey details, ancillary bookings, order status, Airline's PNR
        schedule change history. 


        Besides, users could check more detailed schedule change acceptance
        status regarding a specific flight change.


        ##  Versioning


        |Version|Sandbox Invoking Address|Update|

        |:----|:----|:----|

        |OrderDetail|[https://api.pkfare.com/orderDetail/v2?param=reqParam](https://api.pkfare.com/orderDetail/v2?param=reqParam)|   
        |

        |OrderDetail_V3|[https://api.pkfare.com/orderDetail/v3?param=reqParam](https://api.pkfare.com/orderDetail/v3?param=reqParam)|Paid
        baggage information is available in order details.|

        |OrderDetail_V4|[https://api.pkfare.com/orderDetail/v4?param=reqParam](https://api.pkfare.com/orderDetail/v4?param=reqParam)|   
        |

        |OrderDetail_V5|[https://api.pkfare.com/orderDetail/v5?param=reqParam](https://api.pkfare.com/orderDetail/v5?param=reqParam)|Schedule
        change information is available in order details.|

        |OrderDetail_V6|[https://api.pkfare.com/orderDetail/v6?param=reqParam](https://api.pkfare.com/orderDetail/v6?param=reqParam)|Infant
        ticket info is available in order details. Ticket voidable info and
        reject info for change orders is provided. ScheduleChange is optional in
        includeFields.|

        |OrderDetail_V7|http://api.pkfare.com/orderDetail/v7?param=reqParam|seat
        information is available in order details; Checkin information is
        available as well|

        |OrderDetail_V7 (json
        format)|http://api.pkfare.com/json/orderDetail/v7|seat information is
        available in order details; Checkin information is available as well;
        Support json-formatted requesting structure|

        |OrderDetail_V8 (json format)|http://api.pkfare.com/json/orderDetail/v8
        |Includes more details (message ID and acceptance status) for schedule
        change history information 

        |OrderDetail_V9 (json format)|http://api.pkfare.com/json/orderDetail/v9
        |Includes more details for passengers' associated seat information per
        flight






        ##  Order Status List


        |Order Status List|    |

        |:----|:----|

        |Enum|Description|

        |ISS_PRC|Ticket is issuing.|

        |CHG_PRC|Change order is proceeding.|

        |REFD_PRC|Refund order is proceeding.|

        |VOID_PRC|Ticket is voiding.|

        |TO_BE_PAID|To be Paid.|

        |ISSED|Ticket issued.|

        |TO_BE_RSV|To be reserved.|

        |UNDER_REVIEW|Under review.|

        |HOLD|Order is holding manually, please contact customer service for
        further action.|

        |RSV_FAIL|Reservation failed|

        |CLOSED|Order closed.|

        |CNCL|Order Cancelled.|

        |CNCL_TO_BE_REIM|Order Cancelled, and reimbursement is under
        processing.|

        |CNCL_REIMED|Order Cancelled, and payment has been reimbused.|

        |CHG_RQ|Change Order is requested.|

        |CHG_TO_BE_PAID|Change Order is to be paid.|

        |CHG_REJ|Change Order is rejected.|

        |CHGD|Change Order is changed.|

        |REDF_RQ|Refund Order is under review.|

        |REFD_REJ|Refund Order is rejected.|

        |REFD_TO_BE_REIM|Refunded to be reimbursed.|

        |REFD_REIMED|Refunded and reimbursed.|

        |REFD|Refunded|

        |VOID_REJ|Void request is rejected.|

        |VOID_TO_BE_REIM|Void to be reimbursed.|

        |VOID_REIMED|Void and reimbursed|

        |VOID|Void|

        ##  Error Code List


        |erroCode|erroMsg|Description|

        |:----|:----|:----|

        |0|ok|Request has been processed successfully.|

        |S001|System error|System error|

        |S002|timeout|Request timeout|

        |P001|-|Parameter is illegal|

        |B002|Partner is not exists.|PartnerID does not exist|

        |B003|Illegal sign|Illegal sign. Please check your signature|

        |B048|Invalid buyer|Request buyer is not matched with order.|

        |B037|Order is not exists.|Order is not exist.|

      tags:
        - API Reference/APIs with all versions/OrderDetail
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                Authentication:
                  type: object
                  properties:
                    partnerId:
                      type: string
                      description: Partner Id
                    sign:
                      type: string
                      description: Signature
                  x-apifox-orders:
                    - partnerId
                    - sign
                  required:
                    - partnerId
                    - sign
                  x-apifox-ignore-properties: []
                data:
                  type: object
                  properties:
                    orderNum:
                      type: string
                      description: Order Number
                    includeFields:
                      type: string
                      description: "User\_could\_request\_with 6\_options:\_passengers, journeys, solutions, ancillary, scheduleChange, checkinInfo.\_The \"passenger\" is required, while the remaining items are optional."
                  required:
                    - orderNum
                    - includeFields
                  x-apifox-orders:
                    - orderNum
                    - includeFields
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HVNEX66TKNY38XZFRS10QZY8
                - data
              x-apifox-refs:
                01HVNEX66TKNY38XZFRS10QZY8:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: '{{partnerId}}'
                sign: '{{sign}}'
              data:
                orderNum: '917133223962851001'
                includeFields: >-
                  passengers,journeys,solutions,ancillary,scheduleChange,checkinInfo
      responses:
        '200':
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties:
                  errorCode:
                    type: string
                    description: error code, refer to Error Code List
                  errorMsg:
                    type: string
                    description: error message
                  data:
                    type: object
                    properties:
                      orderStatus:
                        type: string
                        description: Order Status，refer to Order Status List
                      orderNum:
                        type: string
                        description: 【PKFARE】Order Number
                      parentOrderNum:
                        type: string
                        description: >-
                          【PKFARE】Applicatable to VOID/CHANGE/REFUND order. For
                          VOID order, this is original ticketing order number.
                          For CHANGE order, this is original ticketing order
                          number or previous change order number. For REFUND
                          order, this is original ticketing order number or
                          previous change order number.
                      refOrderNum:
                        type: string
                        description: >-
                          【PKFARE】Main order number, it could be consider as the
                          original ticketing order number, it will related with
                          multiple orders if VOID/CHANGE/REFUND requested.
                      orderType:
                        type: string
                        description: >-
                          Order type: O-Ticketing Order, V-Void Order, C-Change
                          Order, R-Refund Order
                      createdTime:
                        type: string
                        description: 'Order created time, format: yyyy-mm-dd hh:ss:mm (GMT)'
                      postingDate:
                        type: string
                        description: >-
                          Order completed time. For Ticketing and Change order,
                          it is ticketing time. For Void order, it is voided
                          time. For Refund order, it is refunded time. Format:
                          yyyy-mm-dd hh:ss:mm (GMT)
                      permitVoid:
                        type: integer
                        description: Allow to void ticket or not. [1-yes, 0-not allow]
                      lastVoidTime:
                        type: string
                        description: >-
                          Voiding deadline. Voiding operation would not be allow
                          after lastVoidTime. (GMT) [yyyy-mm-dd hh : mm :ss]
                      voidServiceFee:
                        type: number
                        description: Void service fee
                      rejectReason:
                        type: string
                        description: Reject reason
                      remark:
                        type: string
                        description: Reject reason remark
                      pnr:
                        type: string
                        description: A reference number in the PKFARE's sysrem
                      airPnr:
                        type: string
                        description: Airline PNR
                      pnrList:
                        type: array
                        items:
                          type: object
                          properties:
                            segmentNo:
                              type: integer
                              description: segment No.
                            departure:
                              type: string
                              description: departure[IATA airport code]
                            arrival:
                              type: string
                              description: destination[IATA airport code]
                            flightNum:
                              type: string
                              description: flight No.
                            cabinClass:
                              type: string
                              description: >-
                                cabin class, including ECONOMY，PREMIUM
                                ECONOMY，BUSINESS and FIRST
                            bookingCode:
                              type: string
                              description: cabin code
                            airPnr:
                              type: string
                              description: airline PNR
                            pnr:
                              type: string
                              description: PNR
                            ticketNums:
                              type: array
                              items:
                                type: object
                                properties:
                                  passengerIndex:
                                    type: integer
                                    description: >-
                                      Passenger sequence no. Consistent with the
                                      passengerIndex under each passenger.
                                  ticketNum:
                                    type: string
                                    description: ticket number
                                x-apifox-orders:
                                  - passengerIndex
                                  - ticketNum
                                x-apifox-ignore-properties: []
                              description: passengers and corresponding ticket num
                          x-apifox-orders:
                            - segmentNo
                            - departure
                            - arrival
                            - flightNum
                            - cabinClass
                            - bookingCode
                            - airPnr
                            - pnr
                            - ticketNums
                          x-apifox-ignore-properties: []
                        description: >-
                          PNR list as per passengers and flight segments[When it
                          is empty, please check airPNR under data object]
                      platingCarrier:
                        type: string
                        description: Ticket issued Airline
                      payGate:
                        type: string
                        description: Form of payment, Alipay or prepayment
                      paySerialNum:
                        type: string
                        description: Serial Number of payment transaction
                      passengers:
                        type: array
                        items:
                          type: object
                          properties:
                            passengerIndex:
                              type: integer
                              description: >-
                                Passenger sequence no. Positive and continous
                                integer starting from 1. If this booking
                                contains infants. The passengerIndex all the
                                same with the those in the booking request. If
                                no infant , the passengerIndex(s) are generated
                                by system automatically.
                            birthday:
                              type: string
                              description: birthday, format[yyyy-mm-dd]
                            cardExpiredDate:
                              type: string
                              description: travel document expired date, format[yyyy-mm-dd]
                            cardNum:
                              type: string
                              description: travel document number
                            cardType:
                              type: string
                              description: >-
                                travel document type including P for Passport,
                                HK for Hongkong and Macau permit for Chinese, TW
                                for Mainland Travel Permit for Taiwan Residents,
                                BH for Home Return Permit，NI for Chinese
                                Identity, TH for Others
                            firstName:
                              type: string
                              description: first name
                            lastName:
                              type: string
                              description: last name
                            nationality:
                              type: string
                              description: nationality [country code]
                            psgType:
                              type: string
                              description: >-
                                The associated adult passengerIndex. Only infant
                                passenger(s) have this parameter.
                            sex:
                              type: string
                              description: gender, including M for male, F for female
                            associatedPassengerIndex:
                              type: integer
                              description: >-
                                the associated adult passengerId. Only a booking
                                contains infant passenger(s) and only infant
                                passenger(s) have this parameter.
                            ticketNum:
                              type: string
                              description: >-
                                ticket number, multiple number will be separated
                                by '/', like 9991234567890/9991234567891
                            seats:
                              type: array
                              items:
                                type: object
                                properties:
                                  airline:
                                    type: string
                                    description: airline of the flight
                                  flightNum:
                                    type: string
                                    description: 'flight No. '
                                  seatNum:
                                    type: string
                                    description: >-
                                      seat No. if available; N/A if not
                                      determined 
                                x-apifox-orders:
                                  - airline
                                  - flightNum
                                  - seatNum
                                required:
                                  - airline
                                  - flightNum
                                  - seatNum
                                x-apifox-ignore-properties: []
                              description: >-
                                Passenger's associated seat information per
                                flight 
                          x-apifox-orders:
                            - passengerIndex
                            - birthday
                            - cardExpiredDate
                            - cardNum
                            - cardType
                            - firstName
                            - lastName
                            - nationality
                            - psgType
                            - sex
                            - associatedPassengerIndex
                            - ticketNum
                            - seats
                          required:
                            - seats
                          x-apifox-ignore-properties: []
                        description: Passenger information
                      journeys:
                        type: array
                        items:
                          type: object
                          properties:
                            journeyTime:
                              type: integer
                              description: >-
                                Journey time from departure to arrival, unit:
                                minutes
                            transferCount:
                              type: integer
                              description: Count of transfer times
                            departureDate:
                              type: string
                              description: >-
                                Departure Date [yyyy-mm-dd]（Local time of
                                departure location）
                            departureTime:
                              type: string
                              description: >-
                                Departure Time [hh:mm]（Local time of departure
                                location）
                            arrivalDate:
                              type: string
                              description: >-
                                Arrival Date [yyyy-mm-dd]（Local time of arrival
                                location）
                            arrivalTime:
                              type: string
                              description: >-
                                Arrival Time [hh:mm]（Local time of arrival
                                location）
                            segments:
                              type: array
                              items:
                                type: object
                                properties:
                                  airline:
                                    type: string
                                    description: Airline
                                  flightNum:
                                    type: string
                                    description: Flight Number
                                  equipment:
                                    type: string
                                    description: Equipment
                                  cabinClass:
                                    type: string
                                    description: >-
                                      cabin class, including ECONOMY，PREMIUM
                                      ECONOMY，BUSINESS and FIRST
                                  bookingCode:
                                    type: string
                                    description: Booking Code
                                  departure:
                                    type: string
                                    description: Departure Airport
                                  arrival:
                                    type: string
                                    description: Arrival Airport
                                  departureTerminal:
                                    type: string
                                    description: Departure Terminal
                                  arrivalTerminal:
                                    type: string
                                    description: "Arrival Terminal\t"
                                  departureDate:
                                    type: string
                                    description: >-
                                      Departure Date [yyyy-mm-dd]（Local time of
                                      departure location）
                                  arrivalDate:
                                    type: string
                                    description: >-
                                      Arrival Date [yyyy-mm-dd]（Local time of
                                      arrival location）
                                  departureTime:
                                    type: string
                                    description: "Departure Time [hh:mm]（Local time of departure location）\t"
                                  arrivalTime:
                                    type: string
                                    description: "Arrival Time [hh:mm] （Local time of arrival location）\t"
                                  flightTime:
                                    type: integer
                                    description: "Fly Time, Unit: minutes\t"
                                  stayTime:
                                    type: string
                                    description: "Stay Time, Unit：minutes\t"
                                  codeShare:
                                    type: string
                                    description: "Code Share Indicator [Y-Code Share flight, N-Not Code Share flight]\t"
                                  opFltNo:
                                    type: string
                                    description: Operating Flight Number
                                  opFltAirline:
                                    type: string
                                    description: Operating Carrier
                                  stopover:
                                    type: string
                                    description: Stopover Airport
                                x-apifox-orders:
                                  - airline
                                  - flightNum
                                  - equipment
                                  - cabinClass
                                  - bookingCode
                                  - departure
                                  - arrival
                                  - departureTerminal
                                  - arrivalTerminal
                                  - departureDate
                                  - arrivalDate
                                  - departureTime
                                  - arrivalTime
                                  - flightTime
                                  - stayTime
                                  - codeShare
                                  - opFltNo
                                  - opFltAirline
                                  - stopover
                                x-apifox-ignore-properties: []
                              description: segment information
                          x-apifox-orders:
                            - journeyTime
                            - transferCount
                            - departureDate
                            - departureTime
                            - arrivalDate
                            - arrivalTime
                            - segments
                          x-apifox-ignore-properties: []
                        description: Itinerary information
                      solutions:
                        type: array
                        items:
                          type: object
                          properties:
                            currency:
                              type: string
                              description: Currency
                            adtFare:
                              type: integer
                            adtTax:
                              type: integer
                            chdFare:
                              type: number
                              description: Fare Amount per child of original order
                            chdTax:
                              type: number
                              description: "Tax Amount per child of original order\t"
                            infFare:
                              type: number
                              description: "Fare Amount per infant of original order\t"
                            infTax:
                              type: number
                              description: "Tax Amount per infant of original order\t"
                            tktFee:
                              type: integer
                            merchantFee:
                              type: integer
                            distCost:
                              type: integer
                            coupon:
                              type: integer
                            buyerAmount:
                              type: integer
                            voidServFee:
                              type: number
                              description: "Void Service Fee per person of void order\t"
                            voidReimTktFee:
                              type: number
                              description: "Ticket Fee reimbursed amount of void order\t"
                            voidReimMerFee:
                              type: number
                              description: "Merchant Fee reimbursed amount of void order\t"
                            voidReimDistCost:
                              type: number
                              description: "Distribution Cost reimbursed amount of void order\t"
                            voidReimCoupon:
                              type: number
                              description: "Coupon reimbursed amount of void order\t"
                            voidReimAmount:
                              type: number
                              description: "Reimbused amount of void order\t"
                            adtChgFee:
                              type: number
                              description: Change Fee per adult of change order
                            chdChgFee:
                              type: number
                              description: "Change Fee per child of change order\t"
                            infChgFee:
                              type: number
                              description: "Change Fee per infant of change order\t"
                            adtChgAddFee:
                              type: number
                              description: Fare difference per adult of change order
                            chdChgAddFee:
                              type: number
                              description: Fare difference per child of change order
                            infChgAddFee:
                              type: number
                              description: Fare difference per infant of change order
                            chgServFee:
                              type: number
                              description: Change Service Fee per adult of change order
                            chgMerFee:
                              type: number
                              description: Change Merchant Fee of change order
                            chgBuyerAmount:
                              type: number
                              description: Buyer Amount of change order
                            adtRfdFee:
                              type: number
                              description: Refund Fee per adult of refund order
                            chdRfdFee:
                              type: number
                              description: Refund Fee per child of refund order
                            infRfdFee:
                              type: number
                              description: Refund Fee per infant of refund order
                            adtUsedFee:
                              type: number
                              description: Used fare per adult of refund order
                            chdUsedFee:
                              type: number
                              description: Used fare per child of refund order
                            infUsedFee:
                              type: number
                              description: Used fare per inf of refund order
                            adtReimChgAddFee:
                              type: number
                              description: "Reimbursed fare difference per adult of refund order\t"
                            chdReimChgAddFee:
                              type: number
                              description: "Reimbursed fare difference per child of refund order\t"
                            rfdServFee:
                              type: number
                              description: Refund Service Fee per person of refund order
                            rfdReimTktFee:
                              type: number
                              description: Reimbursed Ticket Fee per person of refund order
                            rfdReimMerFee:
                              type: number
                              description: Reimbursed Merchant Fee of refund order
                            rfdReimDistCost:
                              type: number
                              description: Reimbursed Distribution Cost of refund order
                            rfdReimCoupon:
                              type: number
                              description: Reimbursed Coupon of refund order
                            rfdReimAmount:
                              type: number
                              description: Reimbursed amount of refund order
                          x-apifox-orders:
                            - currency
                            - adtFare
                            - adtTax
                            - chdFare
                            - chdTax
                            - infFare
                            - infTax
                            - tktFee
                            - merchantFee
                            - distCost
                            - coupon
                            - buyerAmount
                            - voidServFee
                            - voidReimTktFee
                            - voidReimMerFee
                            - voidReimDistCost
                            - voidReimCoupon
                            - voidReimAmount
                            - adtChgFee
                            - chdChgFee
                            - infChgFee
                            - adtChgAddFee
                            - chdChgAddFee
                            - infChgAddFee
                            - chgServFee
                            - chgMerFee
                            - chgBuyerAmount
                            - adtRfdFee
                            - chdRfdFee
                            - infRfdFee
                            - adtUsedFee
                            - chdUsedFee
                            - infUsedFee
                            - adtReimChgAddFee
                            - chdReimChgAddFee
                            - rfdServFee
                            - rfdReimTktFee
                            - rfdReimMerFee
                            - rfdReimDistCost
                            - rfdReimCoupon
                            - rfdReimAmount
                          x-apifox-ignore-properties: []
                        description: Pricing information
                      lastTktTime:
                        type: string
                        description: latest ticketing time (GMT)
                      ancillaryItems:
                        type: array
                        items:
                          type: object
                          properties:
                            itemNumber:
                              type: string
                              description: "ancillary order number\t"
                            itemStatus:
                              type: string
                              description: "ancillary order status, refer to Order Status List\t"
                            createdTime:
                              type: string
                              description: "ancillary order created time\t"
                            saleStage:
                              type: integer
                              description: "sale stage; 0-on sale, 1-after sale\t"
                            ancillaryType:
                              type: integer
                              description: ancillary type; 1-baggage;2-seat
                            ancillaryInfo:
                              type: array
                              items:
                                type: object
                                properties:
                                  baggage:
                                    type: object
                                    properties:
                                      payBaggageType:
                                        type: integer
                                        description: >-
                                          baggage type; 1-checked baggage,
                                          2-carry-on baggage
                                      baggagePiece:
                                        type: integer
                                        description: "baggage piece; -1 - no limit to baggage piece\t"
                                      baggageWeight:
                                        type: string
                                        description: baggage weight
                                      baggageCurrency:
                                        type: string
                                        description: currency
                                      baggagePrice:
                                        type: integer
                                        description: price
                                      description:
                                        type: string
                                        description: baggage description
                                      lastName:
                                        type: string
                                        description: last name
                                      firstName:
                                        type: string
                                        description: first name
                                      psgType:
                                        type: string
                                        description: "passenger type including ADT and CHD only\t"
                                      emdNumber:
                                        type: string
                                        description: "EMD number\t"
                                      segments:
                                        type: array
                                        items:
                                          type: object
                                          properties:
                                            airline:
                                              type: string
                                              description: "airline code\t"
                                            departure:
                                              type: string
                                              description: "origin[IATA airport code]\t"
                                            departureDate:
                                              type: string
                                              description: departure date[yyyy-MM-dd]
                                            departureTime:
                                              type: string
                                              description: "departure time[hh:mm]\t"
                                            arrival:
                                              type: string
                                              description: "destination[IATA airport code]\t"
                                            arrivalDate:
                                              type: string
                                              description: "arrival date[yyyy-MM-dd]\t"
                                            arrivalTime:
                                              type: string
                                              description: "arrival time[hh:mm]\t"
                                            flightNum:
                                              type: string
                                              description: "flight number\t"
                                            bookingCode:
                                              type: string
                                              description: "cabin code\t"
                                            cabinClassType:
                                              type: integer
                                          required:
                                            - airline
                                            - departure
                                            - departureDate
                                            - departureTime
                                            - arrival
                                            - arrivalDate
                                            - arrivalTime
                                            - flightNum
                                            - bookingCode
                                            - cabinClassType
                                          x-apifox-orders:
                                            - airline
                                            - departure
                                            - departureDate
                                            - departureTime
                                            - arrival
                                            - arrivalDate
                                            - arrivalTime
                                            - flightNum
                                            - bookingCode
                                            - cabinClassType
                                          x-apifox-ignore-properties: []
                                        description: associated segment information
                                      ancillaryType:
                                        type: integer
                                    required:
                                      - payBaggageType
                                      - baggagePiece
                                      - baggageWeight
                                      - baggageCurrency
                                      - baggagePrice
                                      - lastName
                                      - firstName
                                      - psgType
                                      - segments
                                      - ancillaryType
                                    x-apifox-orders:
                                      - payBaggageType
                                      - baggagePiece
                                      - baggageWeight
                                      - baggageCurrency
                                      - baggagePrice
                                      - description
                                      - lastName
                                      - firstName
                                      - psgType
                                      - emdNumber
                                      - segments
                                      - ancillaryType
                                    description: baggage details
                                    x-apifox-ignore-properties: []
                                  seat:
                                    type: object
                                    properties:
                                      lastName:
                                        type: string
                                        description: last name
                                      firstName:
                                        type: string
                                        description: "first name\t"
                                      psgType:
                                        type: string
                                        description: "passenger type including ADT and CHD only\t"
                                      seatName:
                                        type: string
                                        description: seat Name
                                      column:
                                        type: string
                                        description: "seat column\t"
                                      row:
                                        type: string
                                        description: seat row
                                      seatCategory:
                                        type: string
                                        description: seat category
                                      seatCurrency:
                                        type: string
                                        description: currency
                                      seatPrice:
                                        type: string
                                        description: price
                                      characteristics:
                                        type: array
                                        items:
                                          type: string
                                        description: the traits of seats
                                      segment:
                                        type: object
                                        properties:
                                          airline:
                                            type: string
                                            description: "airline code\t"
                                          departure:
                                            type: string
                                            description: "origin[IATA airport code]\t"
                                          departureDate:
                                            type: string
                                            description: departure date[yyyy-MM-dd]
                                          departureTime:
                                            type: string
                                            description: "departure time[hh:mm]\t"
                                          arrival:
                                            type: string
                                            description: "destination[IATA airport code]\t"
                                          arrivalDate:
                                            type: string
                                            description: "arrival date[yyyy-MM-dd]\t"
                                          arrivalTime:
                                            type: string
                                            description: "arrival time[hh:mm]\t"
                                          flightNum:
                                            type: string
                                            description: "flight number\t"
                                          bookingCode:
                                            type: string
                                            description: "cabin code\t"
                                          cabinClassType:
                                            type: integer
                                        required:
                                          - airline
                                          - departure
                                          - departureDate
                                          - departureTime
                                          - arrival
                                          - arrivalDate
                                          - arrivalTime
                                          - flightNum
                                          - bookingCode
                                          - cabinClassType
                                        x-apifox-orders:
                                          - airline
                                          - departure
                                          - departureDate
                                          - departureTime
                                          - arrival
                                          - arrivalDate
                                          - arrivalTime
                                          - flightNum
                                          - bookingCode
                                          - cabinClassType
                                        x-apifox-ignore-properties: []
                                    required:
                                      - lastName
                                      - firstName
                                      - psgType
                                      - seatName
                                      - column
                                      - row
                                      - seatCurrency
                                      - seatPrice
                                      - characteristics
                                      - segment
                                    x-apifox-orders:
                                      - lastName
                                      - firstName
                                      - psgType
                                      - seatName
                                      - column
                                      - row
                                      - seatCategory
                                      - seatCurrency
                                      - seatPrice
                                      - characteristics
                                      - segment
                                    description: seat details
                                    x-apifox-ignore-properties: []
                                required:
                                  - baggage
                                x-apifox-orders:
                                  - baggage
                                  - seat
                                x-apifox-ignore-properties: []
                              description: ancillary information
                          required:
                            - itemNumber
                            - itemStatus
                            - createdTime
                            - saleStage
                            - ancillaryType
                            - ancillaryInfo
                          x-apifox-orders:
                            - itemNumber
                            - itemStatus
                            - createdTime
                            - saleStage
                            - ancillaryType
                            - ancillaryInfo
                          x-apifox-ignore-properties: []
                        description: ancillary order information
                      scheduleChangeList:
                        type: array
                        items:
                          type: object
                          properties:
                            scheduleChangeVersion:
                              type: string
                              description: >-
                                Schedule Change Version number, the biggest
                                number is latest schedule change information
                            journeys:
                              type: array
                              items:
                                type: object
                                properties:
                                  journeyTime:
                                    type: integer
                                  transferCount:
                                    type: integer
                                  segments:
                                    type: array
                                    items:
                                      type: object
                                      properties:
                                        airline:
                                          type: string
                                        flightNum:
                                          type: string
                                        equipment:
                                          type: string
                                        cabinClass:
                                          type: string
                                        bookingCode:
                                          type: string
                                        departure:
                                          type: string
                                        arrival:
                                          type: string
                                        departureTerminal:
                                          type: string
                                        arrivalTerminal:
                                          type: string
                                        departureDate:
                                          type: string
                                        arrivalDate:
                                          type: string
                                        departureTime:
                                          type: string
                                        arrivalTime:
                                          type: string
                                        flightTime:
                                          type: integer
                                        codeShare:
                                          type: string
                                        opFltAirline:
                                          type: string
                                      required:
                                        - airline
                                        - flightNum
                                        - cabinClass
                                        - bookingCode
                                        - departure
                                        - arrival
                                        - departureTerminal
                                        - arrivalTerminal
                                        - departureDate
                                        - arrivalDate
                                        - departureTime
                                        - arrivalTime
                                        - flightTime
                                      x-apifox-orders:
                                        - airline
                                        - flightNum
                                        - equipment
                                        - cabinClass
                                        - bookingCode
                                        - departure
                                        - arrival
                                        - departureTerminal
                                        - arrivalTerminal
                                        - departureDate
                                        - arrivalDate
                                        - departureTime
                                        - arrivalTime
                                        - flightTime
                                        - codeShare
                                        - opFltAirline
                                      x-apifox-ignore-properties: []
                                  departureTime:
                                    type: string
                                  arrivalTime:
                                    type: string
                                  departureDate:
                                    type: string
                                  arrivalDate:
                                    type: string
                                required:
                                  - journeyTime
                                  - transferCount
                                  - segments
                                  - departureTime
                                  - arrivalTime
                                  - departureDate
                                  - arrivalDate
                                x-apifox-orders:
                                  - journeyTime
                                  - transferCount
                                  - segments
                                  - departureTime
                                  - arrivalTime
                                  - departureDate
                                  - arrivalDate
                                x-apifox-ignore-properties: []
                            messageId:
                              type: string
                              description: PKFARE message id
                            passengers:
                              type: array
                              items:
                                type: object
                                properties:
                                  lastName:
                                    type: string
                                  firstName:
                                    type: string
                                  acceptStatus:
                                    type: string
                                x-apifox-orders:
                                  - lastName
                                  - firstName
                                  - acceptStatus
                                x-apifox-ignore-properties: []
                          required:
                            - scheduleChangeVersion
                            - journeys
                          x-apifox-orders:
                            - scheduleChangeVersion
                            - journeys
                            - messageId
                            - passengers
                          x-apifox-ignore-properties: []
                        description: >-
                          Schedule Change information, the latest version is
                          current routing
                      checkInInfos:
                        type: array
                        items:
                          type: object
                          properties:
                            firstName:
                              type: string
                              description: Passenger first name
                            lastName:
                              type: string
                              description: Passenger last name
                            ticketNum:
                              type: string
                              description: >-
                                ticket number, multiple number will be separated
                                by '/', like 9991234567890/9991234567891
                            pnr:
                              type: string
                              description: PNR
                            airPnr:
                              type: string
                              description: airline PNR
                            airline:
                              type: string
                              description: airline
                            mailAccount:
                              type: string
                              description: "email\_adress"
                            airlineWebsite:
                              type: string
                              description: "airline\_official\_website\_url"
                          x-apifox-orders:
                            - firstName
                            - lastName
                            - ticketNum
                            - pnr
                            - airPnr
                            - airline
                            - mailAccount
                            - airlineWebsite
                          x-apifox-ignore-properties: []
                        description: "Check\_In\_Information"
                    required:
                      - orderStatus
                      - orderNum
                      - refOrderNum
                      - orderType
                      - createdTime
                      - postingDate
                      - permitVoid
                      - pnr
                      - airPnr
                      - pnrList
                      - platingCarrier
                      - payGate
                      - paySerialNum
                      - passengers
                      - journeys
                      - solutions
                      - lastTktTime
                      - ancillaryItems
                      - scheduleChangeList
                      - checkInInfos
                    x-apifox-orders:
                      - orderStatus
                      - orderNum
                      - parentOrderNum
                      - refOrderNum
                      - orderType
                      - createdTime
                      - postingDate
                      - permitVoid
                      - lastVoidTime
                      - voidServiceFee
                      - rejectReason
                      - remark
                      - pnr
                      - airPnr
                      - pnrList
                      - platingCarrier
                      - payGate
                      - paySerialNum
                      - passengers
                      - journeys
                      - solutions
                      - lastTktTime
                      - ancillaryItems
                      - scheduleChangeList
                      - checkInInfos
                    description: >-
                      Only if the errorCode returns "0", returned data would not
                      be null. Data is refer to Data
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-ignore-properties: []
              examples:
                '1':
                  summary: Response including all
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderStatus: ISSED
                      orderNum: '917070354395357001'
                      refOrderNum: '9170703543953570'
                      orderType: O
                      createdTime: '2024-02-04 16:30:40'
                      postingDate: '2024-02-04 16:31:13'
                      pnr: 6y6d34
                      airPnr: C3pyn0
                      platingCarrier: VJ
                      payGate: Prepay
                      paySerialNum: PREPAY_20240204163055_917070354395357001_2477
                      passengers:
                        - firstName: SHASHA
                          lastName: XIA
                          psgType: ADT
                          nationality: CN
                          sex: M
                          birthday: '2003-03-23'
                          cardType: P
                          cardNum: E11887134
                          cardExpiredDate: '2027-03-31'
                          ticketNum: C3pyn0
                          passengerIndex: 1
                          seats:
                            - airline: VJ
                              flightNum: '813'
                              seatNum: 30C
                      journeys:
                        - journeyTime: 145
                          transferCount: 0
                          segments:
                            - airline: VJ
                              flightNum: '813'
                              equipment: '321'
                              cabinClass: ECONOMY
                              bookingCode: T
                              departure: SGN
                              arrival: SIN
                              departureTerminal: '2'
                              arrivalTerminal: '4'
                              departureDate: '2024-03-04'
                              arrivalDate: '2024-03-04'
                              departureTime: '06:50'
                              arrivalTime: '10:15'
                              flightTime: 145
                              codeShare: 'N'
                          departureTime: '06:50'
                          arrivalTime: '10:15'
                          departureDate: '2024-03-04'
                          arrivalDate: '2024-03-04'
                      solutions:
                        - currency: CNY
                          adtFare: 1574
                          adtTax: 291
                          tktFee: 0
                          merchantFee: 0
                          distCost: 0
                          coupon: 0
                          buyerAmount: 1865
                      lastTktTime: '2024-02-04 18:30:00'
                      ancillaryItems:
                        - itemNumber: '917070354395357002'
                          itemStatus: ISSED
                          createdTime: '2024-02-04 16:30:40'
                          saleStage: 0
                          ancillaryType: 1
                          ancillaryInfo:
                            - baggage:
                                lastName: XIA
                                firstName: SHASHA
                                psgType: ADT
                                ancillaryType: 1
                                payBaggageType: 2
                                baggagePiece: 1
                                baggageWeight: 30KG
                                baggageCurrency: CNY
                                baggagePrice: 40
                                segments:
                                  - airline: VJ
                                    departure: SGN
                                    departureDate: '2024-03-04'
                                    departureTime: '06:50'
                                    arrival: SIN
                                    arrivalDate: '2024-03-04'
                                    arrivalTime: '10:15'
                                    flightNum: '813'
                                    bookingCode: T
                                    cabinClassType: 3
                        - itemNumber: '917070354395357004'
                          itemStatus: ISSED
                          createdTime: '2024-02-04 16:31:18'
                          saleStage: 1
                          ancillaryType: 1
                          ancillaryInfo:
                            - baggage:
                                lastName: XIA
                                firstName: SHASHA
                                psgType: ADT
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: 1
                                baggageWeight: 10KG
                                baggageCurrency: CNY
                                baggagePrice: 20
                                segments:
                                  - airline: VJ
                                    departure: SGN
                                    departureDate: '2024-03-04'
                                    departureTime: '06:50'
                                    arrival: SIN
                                    arrivalDate: '2024-03-04'
                                    arrivalTime: '10:15'
                                    flightNum: '813'
                                    bookingCode: T
                                    cabinClassType: 3
                        - itemNumber: '917070354395357003'
                          itemStatus: ISSED
                          createdTime: '2024-02-04 16:30:40'
                          saleStage: 0
                          ancillaryType: 2
                          ancillaryInfo:
                            - seat:
                                lastName: XIA
                                firstName: SHASHA
                                psgType: ADT
                                seatName: 5A
                                column: A
                                row: '5'
                                seatCurrency: CNY
                                seatPrice: '81.00'
                                characteristics:
                                  - window
                                segment:
                                  airline: VJ
                                  departure: SGN
                                  departureDate: '2024-03-04'
                                  departureTime: '06:50'
                                  arrival: SIN
                                  arrivalDate: '2024-03-04'
                                  arrivalTime: '10:15'
                                  flightNum: '813'
                                  bookingCode: T
                                  cabinClassType: 3
                      pnrList:
                        - segmentNo: 1
                          departure: SGN
                          arrival: SIN
                          flightNum: '813'
                          pnr: 6y6d34
                          airPnr: C3pyn0
                          cabinClass: ECONOMY
                          bookingCode: T
                          ticketNums:
                            - ticketNum: C3pyn0
                              passengerIndex: 1
                      scheduleChangeList:
                        - scheduleChangeVersion: '1'
                          journeys:
                            - journeyTime: 205
                              transferCount: 0
                              segments:
                                - airline: VJ
                                  flightNum: '813'
                                  equipment: '321'
                                  cabinClass: ECONOMY
                                  bookingCode: T
                                  departure: SGN
                                  arrival: SIN
                                  departureTerminal: '2'
                                  arrivalTerminal: '4'
                                  departureDate: '2024-03-04'
                                  arrivalDate: '2024-03-04'
                                  departureTime: '06:50'
                                  arrivalTime: '10:15'
                                  flightTime: 205
                              departureTime: '06:50'
                              arrivalTime: '10:15'
                              departureDate: '2024-03-04'
                              arrivalDate: '2024-03-04'
                        - scheduleChangeVersion: '2'
                          journeys:
                            - journeyTime: 200
                              transferCount: 0
                              segments:
                                - airline: VJ
                                  flightNum: '813'
                                  cabinClass: 'Y'
                                  bookingCode: 'Y'
                                  departure: SGN
                                  arrival: SIN
                                  departureTerminal: ''
                                  arrivalTerminal: ''
                                  departureDate: '2024-03-04'
                                  arrivalDate: '2024-03-04'
                                  departureTime: '06:55'
                                  arrivalTime: '10:15'
                                  flightTime: 200
                                  codeShare: 'N'
                              departureTime: '06:55'
                              arrivalTime: '10:15'
                              departureDate: '2024-03-04'
                              arrivalDate: '2024-03-04'
                          messageId: '4431377'
                          passengers:
                            - lastName: XIA
                              firstName: SHASHA
                              acceptStatus: ACCEPTED
                      permitVoid: 0
                      checkInInfos:
                        - firstName: SHASHA
                          lastName: XIA
                          ticketNum: C3pyn0
                          pnr: C3pyn0
                          airPnr: C3pyn0
                          airline: VJ
                          mailAccount: aaaaaa
                          airlineWebsite: https://www.spirit.com/home-check-in
                '3':
                  summary: >-
                    Response  including Infant Passenger Journey and
                    ScheduleChange
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderStatus: ISSED
                      orderNum: '916711515478196501'
                      refOrderNum: '9167115154781965'
                      orderType: O
                      createdTime: '2022-04-16 08:45:48'
                      postingDate: '2022-04-16'
                      pnr: NLVX8J1|NLVX8J2
                      airPnr: 1NLVX8J|2NLVX8J
                      platingCarrier: AC
                      payGate: Prepay
                      paySerialNum: PREPAY_20221216084555_916711515478196501_3682
                      lastTktTime: '2022-04-16 11:45:48'
                      passengers:
                        - passengerIndex: 1
                          firstName: SHEENA
                          lastName: PACHECO
                          psgType: ADT
                          nationality: US
                          sex: M
                          birthday: '1993-01-14'
                          cardType: P
                          cardNum: '89374924'
                          cardExpiredDate: '2024-12-26'
                          ticketNum: '6476781'
                        - passengerIndex: 2
                          firstName: APRIL
                          lastName: CLAY
                          psgType: CHD
                          nationality: US
                          sex: M
                          birthday: '2015-03-27'
                          cardType: P
                          cardNum: '293874123'
                          cardExpiredDate: '2025-01-03'
                          ticketNum: '6476782'
                        - passengerIndex: 3
                          firstName: APRIL
                          lastName: CLAY
                          psgType: INF
                          nationality: US
                          sex: M
                          associatedPassengerIndex: 1
                          birthday: '2022-11-12'
                          cardType: P
                          cardNum: '793871957'
                          cardExpiredDate: '2042-01-15'
                          ticketNum: '6476783'
                      pnrList:
                        - airPnr: 1NLVX8J
                          arrival: YVR
                          bookingCode: P
                          cabinClass: ECONOMY
                          departure: YYC
                          flightNum: '211'
                          pnr: NLVX8J1
                          segmentNo: 1
                          ticketNums:
                            - passengerIndex: 1
                              ticketNum: '6476781'
                            - passengerIndex: 3
                              ticketNum: '6476783'
                        - airPnr: 2NLVX8J
                          arrival: YVR
                          bookingCode: P
                          cabinClass: ECONOMY
                          departure: YYC
                          flightNum: '211'
                          pnr: NLVX8J2
                          segmentNo: 1
                          ticketNums:
                            - passengerIndex: 2
                              ticketNum: '6476782'
                      journeys:
                        - journeyTime: 102
                          transferCount: 0
                          segments:
                            - airline: AC
                              flightNum: '211'
                              equipment: 7M8
                              cabinClass: ECONOMY
                              bookingCode: P
                              departure: YYC
                              arrival: YVR
                              departureTerminal: ''
                              arrivalTerminal: M
                              departureDate: '2023-11-27'
                              arrivalDate: '2023-11-27'
                              departureTime: '10:40'
                              arrivalTime: '11:22'
                              flightTime: 102
                              codeShare: 'N'
                              opFltAirline: ''
                      scheduleChangeList:
                        - scheduleChangeVersion: '1'
                          journeys:
                            - journeyTime: 102
                              transferCount: 0
                              segments:
                                - airline: AC
                                  flightNum: '211'
                                  equipment: 7M8
                                  cabinClass: ECOMONY
                                  bookingCode: P
                                  departure: YYC
                                  arrival: YVR
                                  departureTerminal: ''
                                  arrivalTerminal: M
                                  departureDate: '2023-11-27'
                                  arrivalDate: '2023-11-27'
                                  departureTime: '10:40'
                                  arrivalTime: '11:22'
                                  flightTime: 102
                                  codeShare: 'N'
                                  opFltAirline: ''
                '4':
                  summary: Response  including Passenger Schedulechange  and Ancillary
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderStatus: ISSED
                      orderNum: '916711515478196501'
                      refOrderNum: '9167115154781965'
                      orderType: O
                      createdTime: '2022-04-16 08:45:48'
                      postingDate: '2022-04-16'
                      pnr: NLVX8J1|NLVX8J2
                      airPnr: 1NLVX8J|2NLVX8J
                      platingCarrier: AC
                      payGate: Prepay
                      paySerialNum: PREPAY_20221216084555_916711515478196501_3682
                      lastTktTime: '2022-04-16 11:45:48'
                      passengers:
                        - passengerIndex: 1
                          firstName: SHEENA
                          lastName: PACHECO
                          psgType: ADT
                          nationality: US
                          sex: M
                          birthday: '1993-01-14'
                          cardType: P
                          cardNum: '89374924'
                          cardExpiredDate: '2024-12-26'
                          ticketNum: '6476781'
                        - passengerIndex: 2
                          firstName: APRIL
                          lastName: CLAY
                          psgType: CHD
                          nationality: US
                          sex: M
                          birthday: '2015-03-27'
                          cardType: P
                          cardNum: '293874123'
                          cardExpiredDate: '2025-01-03'
                          ticketNum: '6476782'
                      pnrList:
                        - airPnr: 1NLVX8J
                          arrival: YVR
                          bookingCode: P
                          cabinClass: ECONOMY
                          departure: YYC
                          flightNum: '211'
                          pnr: NLVX8J1
                          segmentNo: 1
                          ticketNums:
                            - passengerIndex: 1
                              ticketNum: '6476781'
                        - airPnr: 2NLVX8J
                          arrival: YVR
                          bookingCode: P
                          cabinClass: ECONOMY
                          departure: YYC
                          flightNum: '211'
                          pnr: NLVX8J2
                          segmentNo: 1
                          ticketNums:
                            - passengerIndex: 2
                              ticketNum: '6476782'
                      ancillaryItems:
                        - itemNumber: 123456878803
                          itemStatus: ISSED
                          createdTime: '2023-04-16 09:12:44'
                          saleStage: 0
                          ancillaryType: 1
                          ancillaryInfo:
                            - baggage:
                                payBaggageType: 1
                                baggagePiece: 1
                                baggageWeight: 20KG
                                baggageCurrency: USD
                                baggagePrice: 134
                                description: extra 1 piece baggage
                                lastName: PACHECO
                                firstName: SHEENA
                                psgType: ADT
                                emdNumber: ''
                                segments:
                                  - airline: AC
                                    departure: YYC
                                    departureDate: '2023-11-27'
                                    departureTime: '11:50'
                                    arrival: YVR
                                    arrivalDate: '2023-11-27'
                                    arrivalTime: '11:22'
                                    flightNum: '211'
                                    bookingCode: P
                      scheduleChangeList:
                        - scheduleChangeVersion: '1'
                          journeys:
                            - journeyTime: 102
                              transferCount: 0
                              segments:
                                - airline: AC
                                  flightNum: '211'
                                  equipment: 7M8
                                  cabinClass: ECOMONY
                                  bookingCode: P
                                  departure: YYC
                                  arrival: YVR
                                  departureTerminal: ''
                                  arrivalTerminal: M
                                  departureDate: '2023-11-27'
                                  arrivalDate: '2023-11-27'
                                  departureTime: '10:40'
                                  arrivalTime: '11:22'
                                  flightTime: 102
                                  codeShare: 'N'
                                  opFltAirline: ''
                '5':
                  summary: >-
                    Response with Passenger Solutions and Ancillary  including
                    baggage and seat
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderStatus: ISS_PRC
                      orderNum: '916995304456203701'
                      refOrderNum: '9169953044562037'
                      orderType: O
                      createdTime: '2023-11-09 19:47:26'
                      pnr: A8GS1Q
                      platingCarrier: VJ
                      payGate: Prepay
                      paySerialNum: PREPAY_20231109194736_916995304456203701_9501
                      passengers:
                        - firstName: LIHONG
                          lastName: LIN
                          psgType: ADT
                          nationality: CN
                          sex: M
                          birthday: '2003-03-23'
                          cardType: P
                          cardNum: E21415326
                          cardExpiredDate: '2027-03-31'
                          ticketNum: ''
                          passengerIndex: 1
                      journeys:
                        - journeyTime: 1020
                          transferCount: 1
                          segments:
                            - airline: VJ
                              flightNum: '896'
                              cabinClass: ECONOMY
                              bookingCode: I
                              departure: DEL
                              arrival: SGN
                              departureTerminal: ''
                              arrivalTerminal: ''
                              departureDate: '2023-11-30'
                              arrivalDate: '2023-11-30'
                              departureTime: '00:05'
                              arrivalTime: '06:20'
                              flightTime: 285
                              codeShare: 'N'
                            - airline: VJ
                              flightNum: '632'
                              cabinClass: ECONOMY
                              bookingCode: I
                              departure: SGN
                              arrival: DAD
                              departureTerminal: ''
                              arrivalTerminal: ''
                              departureDate: '2023-11-30'
                              arrivalDate: '2023-11-30'
                              departureTime: '17:20'
                              arrivalTime: '18:35'
                              flightTime: 75
                              codeShare: 'N'
                          departureTime: '00:05'
                          arrivalTime: '18:35'
                          departureDate: '2023-11-30'
                          arrivalDate: '2023-11-30'
                      solutions:
                        - currency: CNY
                          adtFare: 2000
                          adtTax: 1211
                          chdFare: 0
                          chdTax: 0
                          tktFee: 0
                          merchantFee: 0
                          distCost: 0
                          coupon: 0
                          buyerAmount: 3211
                      lastTktTime: '2023-11-09 21:47:00'
                      ancillaryItems:
                        - itemNumber: '916995304456203702'
                          itemStatus: ISS_PRC
                          createdTime: '2023-11-09 19:47:26'
                          saleStage: 0
                          ancillaryType: 1
                          ancillaryInfo:
                            - baggage:
                                lastName: LIN
                                firstName: LIHONG
                                psgType: ADT
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: 2
                                baggageWeight: 36KG
                                baggageCurrency: CNY
                                baggagePrice: 95
                                segments:
                                  - airline: VJ
                                    departure: DEL
                                    departureDate: '2023-11-30'
                                    departureTime: '00:05'
                                    arrival: SGN
                                    arrivalDate: '2023-11-30'
                                    arrivalTime: '06:20'
                                    flightNum: '896'
                                    bookingCode: I
                                  - airline: VJ
                                    departure: SGN
                                    departureDate: '2023-11-30'
                                    departureTime: '17:20'
                                    arrival: DAD
                                    arrivalDate: '2023-11-30'
                                    arrivalTime: '18:35'
                                    flightNum: '632'
                                    bookingCode: I
                        - itemNumber: '916995304456203703'
                          itemStatus: ISS_PRC
                          createdTime: '2023-11-09 19:47:26'
                          saleStage: 0
                          ancillaryType: 2
                          ancillaryInfo:
                            - seat:
                                lastName: LIN
                                firstName: LIHONG
                                psgType: ADT
                                seatName: 46A
                                column: A
                                row: '46'
                                seatCurrency: CNY
                                seatPrice: '40.00'
                                characteristics:
                                  - middle
                                segment:
                                  airline: VJ
                                  departure: DEL
                                  departureDate: '2023-11-30'
                                  departureTime: '00:05'
                                  arrival: SGN
                                  arrivalDate: '2023-11-30'
                                  arrivalTime: '06:20'
                                  flightNum: '896'
                                  bookingCode: I
                            - seat:
                                lastName: LIN
                                firstName: LIHONG
                                psgType: ADT
                                seatName: 15A
                                column: A
                                row: '15'
                                seatCurrency: CNY
                                seatPrice: '40.00'
                                characteristics:
                                  - middle
                                segment:
                                  airline: VJ
                                  departure: SGN
                                  departureDate: '2023-11-30'
                                  departureTime: '17:20'
                                  arrival: DAD
                                  arrivalDate: '2023-11-30'
                                  arrivalTime: '18:35'
                                  flightNum: '632'
                                  bookingCode: I
                      pnrList:
                        - airPnr: 1NLVX8J
                          arrival: SGN
                          bookingCode: I
                          cabinClass: ECONOMY
                          departure: DEL
                          flightNum: '896'
                          pnr: NLVX8J1
                          segmentNo: 1
                          ticketNums:
                            - passengerIndex: 1
                              ticketNum: '6476781'
                        - airPnr: 2NLVX8J
                          arrival: DAD
                          bookingCode: I
                          cabinClass: ECONOMY
                          departure: SGN
                          flightNum: '632'
                          pnr: NLVX8J2
                          segmentNo: 1
                          ticketNums:
                            - passengerIndex: 2
                              ticketNum: '6476782'
                '6':
                  summary: Response including passenger's seat information
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderStatus: ISSED
                      orderNum: '917070354395357001'
                      refOrderNum: '9170703543953570'
                      orderType: O
                      createdTime: '2024-02-04 16:30:40'
                      postingDate: '2024-02-04 16:31:13'
                      pnr: 6y6d34
                      airPnr: C3pyn0
                      platingCarrier: VJ
                      payGate: Prepay
                      paySerialNum: PREPAY_20240204163055_917070354395357001_2477
                      passengers:
                        - firstName: SHASHA
                          lastName: XIA
                          psgType: ADT
                          nationality: CN
                          sex: M
                          birthday: '2003-03-23'
                          cardType: P
                          cardNum: E11887134
                          cardExpiredDate: '2027-03-31'
                          ticketNum: C3pyn0
                          passengerIndex: 1
                          seats:
                            - airline: VJ
                              flightNum: '813'
                              seatNum: 30C
                        - firstName: Long
                          lastName: XIA
                          psgType: ADT
                          nationality: CN
                          sex: M
                          birthday: '2005-03-23'
                          cardType: P
                          cardNum: E11887454
                          cardExpiredDate: '2028-03-31'
                          ticketNum: C3pyn0
                          passengerIndex: 2
                          seats:
                            - airline: VJ
                              flightNum: '813'
                              seatNum: 30A
                      journeys:
                        - journeyTime: 145
                          transferCount: 0
                          segments:
                            - airline: VJ
                              flightNum: '813'
                              equipment: '321'
                              cabinClass: ECONOMY
                              bookingCode: T
                              departure: SGN
                              arrival: SIN
                              departureTerminal: '2'
                              arrivalTerminal: '4'
                              departureDate: '2024-03-04'
                              arrivalDate: '2024-03-04'
                              departureTime: '06:50'
                              arrivalTime: '10:15'
                              flightTime: 145
                              codeShare: 'N'
                          departureTime: '06:50'
                          arrivalTime: '10:15'
                          departureDate: '2024-03-04'
                          arrivalDate: '2024-03-04'
                      solutions:
                        - currency: CNY
                          adtFare: 1574
                          adtTax: 291
                          tktFee: 0
                          merchantFee: 0
                          distCost: 0
                          coupon: 0
                          buyerAmount: 1865
                      lastTktTime: '2024-02-04 18:30:00'
                      ancillaryItems:
                        - itemNumber: '917070354395357002'
                          itemStatus: ISSED
                          createdTime: '2024-02-04 16:30:40'
                          saleStage: 0
                          ancillaryType: 1
                          ancillaryInfo:
                            - baggage:
                                lastName: XIA
                                firstName: SHASHA
                                psgType: ADT
                                ancillaryType: 1
                                payBaggageType: 2
                                baggagePiece: 1
                                baggageWeight: 30KG
                                baggageCurrency: CNY
                                baggagePrice: 40
                                segments:
                                  - airline: VJ
                                    departure: SGN
                                    departureDate: '2024-03-04'
                                    departureTime: '06:50'
                                    arrival: SIN
                                    arrivalDate: '2024-03-04'
                                    arrivalTime: '10:15'
                                    flightNum: '813'
                                    bookingCode: T
                                    cabinClassType: 3
                        - itemNumber: '917070354395357004'
                          itemStatus: ISSED
                          createdTime: '2024-02-04 16:31:18'
                          saleStage: 1
                          ancillaryType: 1
                          ancillaryInfo:
                            - baggage:
                                lastName: XIA
                                firstName: SHASHA
                                psgType: ADT
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: 1
                                baggageWeight: 10KG
                                baggageCurrency: CNY
                                baggagePrice: 20
                                segments:
                                  - airline: VJ
                                    departure: SGN
                                    departureDate: '2024-03-04'
                                    departureTime: '06:50'
                                    arrival: SIN
                                    arrivalDate: '2024-03-04'
                                    arrivalTime: '10:15'
                                    flightNum: '813'
                                    bookingCode: T
                                    cabinClassType: 3
                        - itemNumber: '917070354395357003'
                          itemStatus: ISSED
                          createdTime: '2024-02-04 16:30:40'
                          saleStage: 0
                          ancillaryType: 2
                          ancillaryInfo:
                            - seat:
                                lastName: XIA
                                firstName: SHASHA
                                psgType: ADT
                                seatName: 5A
                                column: A
                                row: '5'
                                seatCurrency: CNY
                                seatPrice: '81.00'
                                characteristics:
                                  - window
                                segment:
                                  airline: VJ
                                  departure: SGN
                                  departureDate: '2024-03-04'
                                  departureTime: '06:50'
                                  arrival: SIN
                                  arrivalDate: '2024-03-04'
                                  arrivalTime: '10:15'
                                  flightNum: '813'
                                  bookingCode: T
                                  cabinClassType: 3
                      pnrList:
                        - segmentNo: 1
                          departure: SGN
                          arrival: SIN
                          flightNum: '813'
                          pnr: 6y6d34
                          airPnr: C3pyn0
                          cabinClass: ECONOMY
                          bookingCode: T
                          ticketNums:
                            - ticketNum: C3pyn0
                              passengerIndex: 1
                            - ticketNum: C3pyn0
                              passengerIndex: 2
                      permitVoid: 0
          headers: {}
          x-apifox-name: Success
        x-200:Error:
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties:
                  errorCode:
                    type: string
                    description: error code, refer to Error Code List
                  errorMsg:
                    type: string
                    description: error message
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                x-apifox-ignore-properties: []
              example:
                errorCode: B037
                errorMsg: 'Order is not exists. OrderNum: 917133223962851001'
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/APIs with all versions/OrderDetail
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470514-run
components:
  schemas:
    Authentication:
      type: object
      properties:
        Authentication:
          type: object
          properties:
            partnerId:
              type: string
              description: Partner Id
            sign:
              type: string
              description: Signature
          x-apifox-orders:
            - partnerId
            - sign
          required:
            - partnerId
            - sign
          x-apifox-ignore-properties: []
      title: Authentication
      x-apifox-orders:
        - Authentication
      required:
        - Authentication
      x-apifox-ignore-properties: []
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```