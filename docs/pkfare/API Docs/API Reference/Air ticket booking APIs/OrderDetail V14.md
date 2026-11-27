# OrderDetail V14

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/orderDetail/V14:
    post:
      summary: OrderDetail V14
      deprecated: false
      description: >+
        ##  Function


        Through OrderDetail_V9 API, users can check order details including all
        journey details, ancillary bookings, order status, Airline's PNR
        schedule change history. 


        Besides, users could check more detailed schedule change acceptance
        status regarding a specific flight change.


        Through orderDetail_V12 API, the information of the origional order and
        all associated post-booking service orders will be displayed in the
        response. Except for the original order and the current queried order
        types, only basic informations are returned for other orders.


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

        |OrderDetail_V7|https://api.pkfare.com/orderDetail/v7?param=reqParam|seat
        information is available in order details; Checkin information is
        available as well|

        |OrderDetail_V7 (json
        format)|https://api.pkfare.com/json/orderDetail/v7|seat information is
        available in order details; Checkin information is available as well;
        Support json-formatted requesting structure|

        |OrderDetail_V8 (json format)|https://api.pkfare.com/json/orderDetail/v8
        |Includes more details (message ID and acceptance status) for schedule
        change history information 

        |OrderDetail_V9 (json format)|https://api.pkfare.com/json/orderDetail/v9
        |Includes more details for passengers' associated seat information per
        flight

        |OrderDetail_V10 (json
        format)|https://api.pkfare.com/json/orderDetail/v10 |Includes more
        details for different product tags, including PKFARE-defined special
        product types and airline-standard branded fares, etc.

        |OrderDetail_V12 (json
        format)|https://api.pkfare.com/json/orderDetail/v12 |Includes function
        to check information of both the parent order and associated
        post-booking service orders (void, change, refund)

        |OrderDetail_V13 (json
        format)|https://api.pkfare.com/json/orderDetail/v13 |When orderStatus is
        CHG_RQ, UNDER_REVIEW, CNCL, CHG_REJ, REFD_REJ, VOID_REJ, the price
        realted fields will not be returned.

        |OrderDetail_V14 (json
        format)|https://api.pkfare.com/json/orderDetail/v14 | Retrieves order
        details, including the Brand Fare and MultiTag information stored for
        each solution.






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
        - API Reference/Air ticket booking APIs
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
                      description: "User\_could\_request\_with\_6\_options:\_passengers,\_journeys,\_solutions, ancillary,\_scheduleChange,\_checkinInfo.\_The\_\"passenger\", \"journeys\", and \"solutions\"\_are\_required,\_while\_the\_remaining\_items\_are\_optional."
                    includeOrderTypes:
                      type: array
                      items:
                        type: string
                      description: >-
                        ["C","R","V","O"]  O-original order number, C-change
                        order number, V-void order number, R-refund order
                        number. Can choose which post-booking service order info
                        would want to receive in the response (e.g. ["O", "R"]
                        ). This parameter is optional, if leave empty, will
                        respond with the information of the order inputted in
                        orderNum if leave as null. 
                  required:
                    - orderNum
                    - includeFields
                  x-apifox-orders:
                    - orderNum
                    - includeFields
                    - includeOrderTypes
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
                includeOrderTypes:
                  - O
                  - R
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
                      curOrderNum:
                        type: string
                        description: The current order number being queried
                      originOrder:
                        type: object
                        properties:
                          orderStatus:
                            type: string
                            description: >-
                              Order Status，refer to Order Status List, Note :
                              Only when the order status changes to "ISSED",
                              airline PNR will be provided
                          orderNum:
                            type: string
                            description: 【PKFARE】Order Number
                          refOrderNum:
                            type: string
                            description: >-
                              【PKFARE】Main order number, it could be consider as
                              the original ticketing order number, it will
                              related with multiple orders if VOID/CHANGE/REFUND
                              requested.
                          orderType:
                            type: string
                            description: >-
                              Order type: O-Ticketing Order, V-Void Order,
                              C-Change Order, R-Refund Order
                          createdTime:
                            type: string
                            description: >-
                              Order created time, format: yyyy-mm-dd hh:ss:mm
                              (GMT)
                          postingDate:
                            type: string
                            description: >-
                              Order completed time. For Ticketing and Change
                              order, it is ticketing time. For Void order, it is
                              voided time. For Refund order, it is refunded
                              time. Format: yyyy-mm-dd hh:ss:mm (GMT)
                          pnr:
                            type: string
                            description: A reference number in the PKFARE's sysrem
                          airPnr:
                            type: string
                            description: Airline PNR
                          platingCarrier:
                            type: string
                            description: Ticket issued Airline
                          payGate:
                            type: string
                            description: Form of payment, Alipay or prepayment
                          paySerialNum:
                            type: string
                            description: Serial Number of payment transaction
                          paidTime:
                            type: string
                            description: 'Payment time, format: yyyy-mm-dd hh:ss:mm (GMT)'
                          contactName:
                            type: string
                            description: 'Name format: FirstnameLastname'
                          contactMobile:
                            type: string
                            description: Telephonenumber
                          contactTel:
                            type: string
                            description: Telephone Area Code
                          contactEmail:
                            type: string
                            description: >-
                              Email address, only supports three special
                              characters: 1.@ (at sign), 2. _ (underscore), 3. -
                              (dash)
                          passengers:
                            type: array
                            items:
                              type: object
                              properties:
                                firstName:
                                  type: string
                                  description: First name
                                lastName:
                                  type: string
                                  description: Last name
                                psgType:
                                  type: string
                                  description: >-
                                    Passenger type including ADT for adults, CHD
                                    for children, INF for infants (no seat)
                                nationality:
                                  type: string
                                  description: Nationality [country code]
                                sex:
                                  type: string
                                  description: Gender, including M for male, F for female
                                birthday:
                                  type: string
                                  description: Birthday, format[yyyy-mm-dd]
                                cardType:
                                  type: string
                                  description: >-
                                    Type of travel document, P as passport, N as
                                    Chinese Identity, O as others. 
                                cardNum:
                                  type: string
                                  description: Travel document number
                                cardExpiredDate:
                                  type: string
                                  description: >-
                                    Travel document expired date,
                                    format[yyyy-mm-dd]
                                ticketNum:
                                  type: string
                                  description: >-
                                    Ticket number, multiple number will be
                                    separated by '/', like
                                    9991234567890/9991234567891
                                passengerIndex:
                                  type: integer
                                  description: >-
                                    Passenger sequence number. Positive and
                                    continous integer starting from 1. If this
                                    booking contains infants. The passengerIndex
                                    all the same with the those in the booking
                                    request. If no infant , the
                                    passengerIndex(s) are generated by system
                                    automatically.
                                associatedPassengerIndex:
                                  type: integer
                                  description: >-
                                    The associated adult passengerId. Only a
                                    booking contains infant passenger(s) and
                                    only infant passenger(s) have this
                                    parameter.
                                seats:
                                  type: array
                                  items:
                                    type: object
                                    properties:
                                      airline:
                                        type: string
                                        description: Airline of the flight
                                      flightNum:
                                        type: string
                                        description: 'Flight No. '
                                      seatNum:
                                        type: string
                                        description: >-
                                          Seat No. if available; N/A if not
                                          determined 
                                    x-apifox-orders:
                                      - airline
                                      - flightNum
                                      - seatNum
                                    x-apifox-ignore-properties: []
                                  description: >-
                                    Passenger's associated seat information per
                                    flight 
                              x-apifox-orders:
                                - firstName
                                - lastName
                                - psgType
                                - nationality
                                - sex
                                - birthday
                                - cardType
                                - cardNum
                                - cardExpiredDate
                                - ticketNum
                                - passengerIndex
                                - associatedPassengerIndex
                                - seats
                              required:
                                - firstName
                                - lastName
                                - psgType
                                - nationality
                                - sex
                                - birthday
                                - ticketNum
                              x-apifox-ignore-properties: []
                          journeys:
                            type: array
                            items:
                              type: object
                              properties:
                                journeyTime:
                                  type: integer
                                  description: >-
                                    Journey time from departure to arrival,
                                    unit: minutes
                                transferCount:
                                  type: integer
                                  description: Count of transfer times
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
                                        description: Arrival Terminal
                                      departureDate:
                                        type: string
                                        description: >-
                                          Departure Date [yyyy-mm-dd]（Local time
                                          of departure location）
                                      arrivalDate:
                                        type: string
                                        description: >-
                                          Arrival Date [yyyy-mm-dd]（Local time of
                                          arrival location）
                                      departureTime:
                                        type: string
                                        description: >-
                                          Departure Time [hh:mm]（Local time of
                                          departure location）
                                      arrivalTime:
                                        type: string
                                        description: >-
                                          Arrival Time [hh:mm] （Local time of
                                          arrival location）
                                      flightTime:
                                        type: integer
                                        description: 'Fly Time, Unit: minutes'
                                      codeShare:
                                        type: string
                                        description: >-
                                          Code Share Indicator [Y-Code Share
                                          flight, N-Not Code Share flight]
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
                                    required:
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
                                    x-apifox-ignore-properties: []
                                  description: segment information
                                departureTime:
                                  type: string
                                  description: >-
                                    Departure Time [hh:mm]（Local time of
                                    departure location）
                                arrivalTime:
                                  type: string
                                  description: >-
                                    Arrival Time [hh:mm]（Local time of arrival
                                    location）
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
                              x-apifox-orders:
                                - journeyTime
                                - transferCount
                                - segments
                                - departureTime
                                - arrivalTime
                                - departureDate
                                - arrivalDate
                              required:
                                - journeyTime
                                - transferCount
                                - segments
                                - departureTime
                                - arrivalTime
                                - departureDate
                                - arrivalDate
                              x-apifox-ignore-properties: []
                            description: Itinerary information
                          solutions:
                            type: array
                            items:
                              type: object
                              properties:
                                adtFare:
                                  type: integer
                                  description: Adult Fare
                                adtTax:
                                  type: integer
                                  description: Adult Tax
                                baggageMap:
                                  type: object
                                  properties: {}
                                  x-apifox-orders: []
                                  x-apifox-ignore-properties: []
                                baggages:
                                  type: object
                                  properties: {}
                                  x-apifox-orders: []
                                  x-apifox-ignore-properties: []
                                otherFareRules:
                                  type: object
                                  properties: {}
                                  x-apifox-orders: []
                                  x-apifox-ignore-properties: []
                                currency:
                                  type: string
                                  description: Currency
                                chdFare:
                                  type: integer
                                  description: Child Fare
                                chdTax:
                                  type: integer
                                  description: Child Tax
                                tktFee:
                                  type: integer
                                  description: Ticking service fee
                                merchantFee:
                                  type: integer
                                  description: ''
                                distCost:
                                  type: integer
                                  description: ''
                                coupon:
                                  type: integer
                                  description: ''
                                buyerAmount:
                                  type: integer
                                  description: ''
                                brandFare:
                                  type: string
                                  description: >-
                                    Brand Fare code stored for the order price
                                    item.
                                multiTags:
                                  type: object
                                  properties:
                                    '{tagType}':
                                      type: array
                                      items:
                                        type: object
                                        properties:
                                          tagCode:
                                            type: string
                                            description: Code of the stored product tag.
                                          tagName:
                                            type: string
                                            description: >-
                                              Name stored in the original-order
                                              MultiTag snapshot.
                                        x-apifox-orders:
                                          - tagCode
                                          - tagName
                                        required:
                                          - tagCode
                                          - tagName
                                        x-apifox-ignore-properties: []
                                      description: Type of the stored product tag.
                                  x-apifox-orders:
                                    - '{tagType}'
                                  description: >-
                                    MultiTag product attributes stored for the
                                    order price item. Returned when a matching
                                    order-item snapshot is found.
                                  x-apifox-ignore-properties: []
                              x-apifox-orders:
                                - adtFare
                                - adtTax
                                - baggageMap
                                - baggages
                                - otherFareRules
                                - currency
                                - chdFare
                                - chdTax
                                - tktFee
                                - merchantFee
                                - distCost
                                - coupon
                                - buyerAmount
                                - brandFare
                                - multiTags
                              required:
                                - adtFare
                                - adtTax
                                - currency
                                - chdFare
                                - chdTax
                                - tktFee
                              x-apifox-ignore-properties: []
                            description: Pricing information
                          lastTktTime:
                            type: string
                            description: Latest ticketing time (GMT)
                          ancillaryItems:
                            type: array
                            items:
                              type: object
                              properties:
                                itemNumber:
                                  type: string
                                  description: ancillary order number
                                itemStatus:
                                  type: string
                                  description: >-
                                    ancillary order status, refer to Order
                                    Status List
                                createdTime:
                                  type: string
                                  description: ancillary order created time
                                saleStage:
                                  type: integer
                                  description: sale stage; 0-on sale, 1-after sale
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
                                          lastName:
                                            type: string
                                            description: last name
                                          firstName:
                                            type: string
                                            description: first name
                                          psgType:
                                            type: string
                                            description: >-
                                              passenger type including ADT and CHD
                                              only
                                          ancillaryType:
                                            type: integer
                                            description: Baggage details; 1-baggage
                                          payBaggageType:
                                            type: integer
                                            description: >-
                                              baggage type; 1-checked baggage,
                                              2-carry-on baggage
                                          baggagePiece:
                                            type: integer
                                            description: >-
                                              baggage piece; -1 - no limit to baggage
                                              piece
                                          baggageWeight:
                                            type: string
                                            description: baggage weight
                                          baggageCurrency:
                                            type: string
                                            description: currency
                                          baggagePrice:
                                            type: integer
                                            description: price
                                          segments:
                                            type: array
                                            items:
                                              type: object
                                              properties:
                                                airline:
                                                  type: string
                                                  description: airline code
                                                departure:
                                                  type: string
                                                  description: origin[IATA airport code]
                                                departureDate:
                                                  type: string
                                                  description: departure date[yyyy-MM-dd]
                                                departureTime:
                                                  type: string
                                                  description: departure time[hh:mm]
                                                arrival:
                                                  type: string
                                                  description: destination[IATA airport code]
                                                arrivalDate:
                                                  type: string
                                                  description: arrival date[yyyy-MM-dd]
                                                arrivalTime:
                                                  type: string
                                                  description: arrival time[hh:mm]
                                                flightNum:
                                                  type: string
                                                  description: flight number
                                                bookingCode:
                                                  type: string
                                                  description: cabin code
                                                cabinClassType:
                                                  type: integer
                                                  description: ''
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
                                        description: baggage details
                                        x-apifox-orders:
                                          - lastName
                                          - firstName
                                          - psgType
                                          - ancillaryType
                                          - payBaggageType
                                          - baggagePiece
                                          - baggageWeight
                                          - baggageCurrency
                                          - baggagePrice
                                          - segments
                                        x-apifox-ignore-properties: []
                                      seat:
                                        type: object
                                        properties:
                                          lastName:
                                            type: string
                                            description: last name
                                          firstName:
                                            type: string
                                            description: first name
                                          psgType:
                                            type: string
                                            description: >-
                                              passenger type including ADT and CHD
                                              only
                                          seatName:
                                            type: string
                                            description: seat Name
                                          column:
                                            type: string
                                            description: seat column
                                          row:
                                            type: string
                                            description: seat row
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
                                            description: the traits of seats, (e.g. "window")
                                          segment:
                                            type: object
                                            properties:
                                              airline:
                                                type: string
                                                description: airline code
                                              departure:
                                                type: string
                                                description: origin[IATA airport code]
                                              departureDate:
                                                type: string
                                                description: departure date[yyyy-MM-dd]
                                              departureTime:
                                                type: string
                                                description: departure time[hh:mm]
                                              arrival:
                                                type: string
                                                description: destination[IATA airport code]
                                              arrivalDate:
                                                type: string
                                                description: arrival date[yyyy-MM-dd]
                                              arrivalTime:
                                                type: string
                                                description: arrival time[hh:mm]
                                              flightNum:
                                                type: string
                                                description: flight number
                                              bookingCode:
                                                type: string
                                                description: cabin code
                                              cabinClassType:
                                                type: integer
                                                description: ''
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
                                        description: seat details
                                        x-apifox-orders:
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
                                        x-apifox-ignore-properties: []
                                    x-apifox-orders:
                                      - baggage
                                      - seat
                                    x-apifox-ignore-properties: []
                                  description: ancillary information
                              x-apifox-orders:
                                - itemNumber
                                - itemStatus
                                - createdTime
                                - saleStage
                                - ancillaryType
                                - ancillaryInfo
                              x-apifox-ignore-properties: []
                            description: Ancillary order information
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
                                pnr:
                                  type: string
                                  description: PNR
                                airPnr:
                                  type: string
                                  description: airline PNR
                                cabinClass:
                                  type: string
                                  description: >-
                                    cabin class, including ECONOMY，PREMIUM
                                    ECONOMY，BUSINESS and FIRST
                                bookingCode:
                                  type: string
                                  description: cabin code
                                ticketNums:
                                  type: array
                                  items:
                                    type: object
                                    properties:
                                      ticketNum:
                                        type: string
                                        description: ticket number
                                      passengerIndex:
                                        type: integer
                                        description: >-
                                          Passenger sequence no. Consistent with
                                          the passengerIndex under each passenger.
                                    x-apifox-orders:
                                      - ticketNum
                                      - passengerIndex
                                    required:
                                      - ticketNum
                                      - passengerIndex
                                    x-apifox-ignore-properties: []
                                  description: passengers and corresponding ticket num
                              x-apifox-orders:
                                - segmentNo
                                - departure
                                - arrival
                                - flightNum
                                - pnr
                                - airPnr
                                - cabinClass
                                - bookingCode
                                - ticketNums
                              required:
                                - departure
                                - arrival
                                - flightNum
                                - pnr
                                - airPnr
                                - cabinClass
                                - bookingCode
                                - ticketNums
                              x-apifox-ignore-properties: []
                            description: >-
                              PNR list as per passengers and flight
                              segments[When it is empty, please check airPNR
                              under data object]
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
                                        description: ''
                                      transferCount:
                                        type: integer
                                        description: ''
                                      segments:
                                        type: array
                                        items:
                                          type: object
                                          properties:
                                            airline:
                                              type: string
                                              description: ''
                                            flightNum:
                                              type: string
                                              description: ''
                                            equipment:
                                              type: string
                                              description: ''
                                            cabinClass:
                                              type: string
                                              description: ''
                                            bookingCode:
                                              type: string
                                              description: ''
                                            departure:
                                              type: string
                                              description: ''
                                            arrival:
                                              type: string
                                              description: ''
                                            departureTerminal:
                                              type: string
                                              description: ''
                                            arrivalTerminal:
                                              type: string
                                              description: ''
                                            departureDate:
                                              type: string
                                              description: ''
                                            arrivalDate:
                                              type: string
                                              description: ''
                                            departureTime:
                                              type: string
                                              description: ''
                                            arrivalTime:
                                              type: string
                                              description: ''
                                            flightTime:
                                              type: integer
                                              description: ''
                                            codeShare:
                                              type: string
                                              description: ''
                                            opFltAirline:
                                              type: string
                                              description: ''
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
                                        description: ''
                                      arrivalTime:
                                        type: string
                                        description: ''
                                      departureDate:
                                        type: string
                                        description: ''
                                      arrivalDate:
                                        type: string
                                        description: ''
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
                                latestAfterSalesRefundTime:
                                  type: string
                                  description: latest after sales refund time,UTC+8
                                passengers:
                                  type: array
                                  items:
                                    type: object
                                    properties:
                                      lastName:
                                        type: string
                                        description: ''
                                      firstName:
                                        type: string
                                        description: ''
                                      acceptStatus:
                                        type: string
                                        description: ''
                                    x-apifox-orders:
                                      - lastName
                                      - firstName
                                      - acceptStatus
                                    x-apifox-ignore-properties: []
                              x-apifox-orders:
                                - scheduleChangeVersion
                                - journeys
                                - messageId
                                - latestAfterSalesRefundTime
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
                                    ticket number, multiple number will be
                                    separated by '/', like
                                    9991234567890/9991234567891
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
                                  description: email adress
                                airlineWebsite:
                                  type: string
                                  description: airline official website url
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
                            description: Check In Information
                          permitVoid:
                            type: integer
                            description: Allow to void ticket or not. [1-yes, 0-not allow]
                          lastVoidTime:
                            type: string
                            description: >-
                              Last void time, only available when permitVoid =
                              1; format: yyyy-mm-dd hh:ss:mm (GMT)
                          extOrderNum:
                            type: string
                            description: 【PKFARE】Special Remark order number
                          fareRuleInfo:
                            type: object
                            properties:
                              refundRule:
                                type: object
                                properties:
                                  refundable:
                                    type: boolean
                                    description: true - refundable; false - non-refundable
                                  beforeDeparture:
                                    type: array
                                    items:
                                      type: object
                                      properties:
                                        timeRange:
                                          type: string
                                          description: When can the ticket be refunded
                                        fee:
                                          type: string
                                          description: Fee charged for refund
                                      x-apifox-orders:
                                        - timeRange
                                        - fee
                                      x-apifox-ignore-properties: []
                                    description: ''
                                description: ''
                                x-apifox-orders:
                                  - refundable
                                  - beforeDeparture
                                x-apifox-ignore-properties: []
                            description: ''
                            x-apifox-orders:
                              - refundRule
                            x-apifox-ignore-properties: []
                        x-apifox-orders:
                          - orderStatus
                          - orderNum
                          - refOrderNum
                          - orderType
                          - createdTime
                          - postingDate
                          - pnr
                          - airPnr
                          - platingCarrier
                          - payGate
                          - paySerialNum
                          - paidTime
                          - contactName
                          - contactMobile
                          - contactTel
                          - contactEmail
                          - passengers
                          - journeys
                          - solutions
                          - lastTktTime
                          - ancillaryItems
                          - pnrList
                          - scheduleChangeList
                          - checkInInfos
                          - permitVoid
                          - lastVoidTime
                          - extOrderNum
                          - fareRuleInfo
                        required:
                          - orderStatus
                          - orderNum
                          - refOrderNum
                          - orderType
                          - createdTime
                          - postingDate
                          - pnr
                          - airPnr
                          - platingCarrier
                          - payGate
                          - paySerialNum
                          - paidTime
                          - passengers
                          - journeys
                          - solutions
                          - lastTktTime
                          - pnrList
                          - permitVoid
                        x-apifox-ignore-properties: []
                      changeOrderList:
                        type: array
                        items:
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
                                【PKFARE】Applicatable to VOID/CHANGE/REFUND
                                order. For VOID order, this is original
                                ticketing order number. For CHANGE order, this
                                is original ticketing order number or previous
                                change order number. For REFUND order, this is
                                original ticketing order number or previous
                                change order number.
                            refOrderNum:
                              type: string
                              description: >-
                                【PKFARE】Main order number, it could be consider
                                as the original ticketing order number, it will
                                related with multiple orders if
                                VOID/CHANGE/REFUND requested.
                            orderType:
                              type: string
                              description: >-
                                Order type: O-Ticketing Order, V-Void Order,
                                C-Change Order, R-Refund Order
                            createdTime:
                              type: string
                              description: >-
                                Order created time, format: yyyy-mm-dd hh:ss:mm
                                (GMT)
                            postingDate:
                              type: string
                              description: >-
                                Order completed time. For Ticketing and Change
                                order, it is ticketing time. For Void order, it
                                is voided time. For Refund order, it is refunded
                                time. Format: yyyy-mm-dd hh:ss:mm (GMT)
                            pnr:
                              type: string
                              description: A reference number in the PKFARE's sysrem
                            airPnr:
                              type: string
                              description: Airline PNR
                            platingCarrier:
                              type: string
                              description: Ticket issued Airline
                            payGate:
                              type: string
                              description: Form of payment, Alipay or prepayment
                            paySerialNum:
                              type: string
                              description: Serial Number of payment transaction
                            paidTime:
                              type: string
                              description: 'Payment time, format: yyyy-mm-dd hh:ss:mm (GMT)'
                            contactName:
                              type: string
                              description: 'Name format: FirstnameLastname'
                            contactMobile:
                              type: string
                              description: Telephonenumber
                            contactTel:
                              type: string
                              description: Telephone Area Code
                            contactEmail:
                              type: string
                              description: >-
                                Email address, only supports three special
                                characters: 1.@ (at sign), 2. _ (underscore), 3.
                                - (dash)
                            passengers:
                              type: array
                              items:
                                type: object
                                properties:
                                  firstName:
                                    type: string
                                    description: First name
                                  lastName:
                                    type: string
                                    description: Last name
                                  psgType:
                                    type: string
                                    description: >-
                                      Passenger type including ADT for adults,
                                      CHD for children, INF for infants (no
                                      seat)
                                  nationality:
                                    type: string
                                    description: Nationality [country code]
                                  sex:
                                    type: string
                                    description: Gender, including M for male, F for female
                                  birthday:
                                    type: string
                                    description: Birthday, format[yyyy-mm-dd]
                                  cardType:
                                    type: string
                                    description: >-
                                      Type of travel document, P as passport, N
                                      as Chinese Identity, O as others. 
                                  cardNum:
                                    type: string
                                    description: Travel document number
                                  cardExpiredDate:
                                    type: string
                                    description: >-
                                      Travel document expired date,
                                      format[yyyy-mm-dd]
                                  ticketNum:
                                    type: string
                                    description: >-
                                      Ticket number, multiple number will be
                                      separated by '/', like
                                      9991234567890/9991234567891
                                  passengerIndex:
                                    type: integer
                                    description: >-
                                      Passenger sequence number. Positive and
                                      continous integer starting from 1. If this
                                      booking contains infants. The
                                      passengerIndex all the same with the those
                                      in the booking request. If no infant , the
                                      passengerIndex(s) are generated by system
                                      automatically.
                                  associatedPassengerIndex:
                                    type: integer
                                    description: >-
                                      The associated adult passengerId. Only a
                                      booking contains infant passenger(s) and
                                      only infant passenger(s) have this
                                      parameter.
                                  seats:
                                    type: array
                                    items:
                                      type: object
                                      properties:
                                        airline:
                                          type: string
                                          description: Airline of the flight
                                        flightNum:
                                          type: string
                                          description: 'Flight No. '
                                        seatNum:
                                          type: string
                                          description: >-
                                            Seat No. if available; N/A if not
                                            determined 
                                      x-apifox-orders:
                                        - airline
                                        - flightNum
                                        - seatNum
                                      x-apifox-ignore-properties: []
                                    description: >-
                                      Passenger's associated seat information
                                      per flight 
                                x-apifox-orders:
                                  - firstName
                                  - lastName
                                  - psgType
                                  - nationality
                                  - sex
                                  - birthday
                                  - cardType
                                  - cardNum
                                  - cardExpiredDate
                                  - ticketNum
                                  - passengerIndex
                                  - associatedPassengerIndex
                                  - seats
                                x-apifox-ignore-properties: []
                            journeys:
                              type: array
                              items:
                                type: object
                                properties:
                                  journeyTime:
                                    type: integer
                                    description: >-
                                      Journey time from departure to arrival,
                                      unit: minutes
                                  transferCount:
                                    type: integer
                                    description: Count of transfer times
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
                                          description: Arrival Terminal
                                        departureDate:
                                          type: string
                                          description: >-
                                            Departure Date [yyyy-mm-dd]（Local time
                                            of departure location）
                                        arrivalDate:
                                          type: string
                                          description: >-
                                            Arrival Date [yyyy-mm-dd]（Local time of
                                            arrival location）
                                        departureTime:
                                          type: string
                                          description: >-
                                            Departure Time [hh:mm]（Local time of
                                            departure location）
                                        arrivalTime:
                                          type: string
                                          description: >-
                                            Arrival Time [hh:mm] （Local time of
                                            arrival location）
                                        flightTime:
                                          type: integer
                                          description: 'Fly Time, Unit: minutes'
                                        codeShare:
                                          type: string
                                          description: >-
                                            Code Share Indicator [Y-Code Share
                                            flight, N-Not Code Share flight]
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
                                      x-apifox-ignore-properties: []
                                    description: segment information
                                  departureTime:
                                    type: string
                                    description: >-
                                      Departure Time [hh:mm]（Local time of
                                      departure location）
                                  arrivalTime:
                                    type: string
                                    description: >-
                                      Arrival Time [hh:mm]（Local time of arrival
                                      location）
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
                                x-apifox-orders:
                                  - journeyTime
                                  - transferCount
                                  - segments
                                  - departureTime
                                  - arrivalTime
                                  - departureDate
                                  - arrivalDate
                                x-apifox-ignore-properties: []
                              description: Itinerary information
                            solutions:
                              type: array
                              items:
                                type: string
                              description: Pricing information
                            lastTktTime:
                              type: string
                              description: latest ticketing time (GMT)
                            ancillaryItems:
                              type: array
                              items:
                                type: string
                              description: ancillary order information
                            pnrList:
                              type: array
                              items:
                                type: string
                              description: >-
                                PNR list as per passengers and flight
                                segments[When it is empty, please check airPNR
                                under data object]
                            scheduleChangeList:
                              type: array
                              items:
                                type: string
                              description: >-
                                Schedule Change information, the latest version
                                is current routing
                            checkInInfos:
                              type: array
                              items:
                                type: string
                              description: Check In Information
                            rejectReason:
                              type: string
                              description: Reject reason
                            remark:
                              type: string
                              description: Reject reason remark
                            permitVoid:
                              type: integer
                              description: >-
                                Allow to void ticket or not. [1-yes, 0-not
                                allow]
                            lastVoidTime:
                              type: string
                              description: >-
                                Voiding deadline. Voiding operation would not be
                                allow after lastVoidTime. (GMT) [yyyy-mm-dd hh :
                                mm :ss]
                            voidServiceFee:
                              type: number
                              description: Void service fee
                            extOrderNum:
                              type: string
                              description: 【PKFARE】Special Remark order number
                            fareRuleInfo:
                              type: object
                              description: ''
                              properties: {}
                              x-apifox-orders: []
                              x-apifox-ignore-properties: []
                          x-apifox-orders:
                            - orderStatus
                            - orderNum
                            - parentOrderNum
                            - refOrderNum
                            - orderType
                            - createdTime
                            - postingDate
                            - pnr
                            - airPnr
                            - platingCarrier
                            - payGate
                            - paySerialNum
                            - paidTime
                            - contactName
                            - contactMobile
                            - contactTel
                            - contactEmail
                            - passengers
                            - journeys
                            - solutions
                            - lastTktTime
                            - ancillaryItems
                            - pnrList
                            - scheduleChangeList
                            - checkInInfos
                            - rejectReason
                            - remark
                            - permitVoid
                            - lastVoidTime
                            - voidServiceFee
                            - extOrderNum
                            - fareRuleInfo
                          x-apifox-ignore-properties: []
                        description: >-
                          Return when the query order is a change order and the
                          "includeOrderTypes" contains "C"
                      refundOrderList:
                        type: array
                        items:
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
                                【PKFARE】Applicatable to VOID/CHANGE/REFUND
                                order. For REFUND order, this is original
                                ticketing order number or previous change order
                                number.
                            refOrderNum:
                              type: string
                              description: >-
                                【PKFARE】Main order number, it could be consider
                                as the original ticketing order number, it will
                                related with multiple orders if
                                VOID/CHANGE/REFUND requested.
                            orderType:
                              type: string
                              description: >-
                                Order type: O-Ticketing Order, V-Void Order,
                                C-Change Order, R-Refund Order
                            createdTime:
                              type: string
                              description: >-
                                Order created time, format: yyyy-mm-dd hh:ss:mm
                                (GMT)
                            postingDate:
                              type: string
                              description: >-
                                Order completed time. For Ticketing and Change
                                order, it is ticketing time. For Void order, it
                                is voided time. For Refund order, it is refunded
                                time. Format: yyyy-mm-dd hh:ss:mm (GMT)
                            pnr:
                              type: string
                              description: A reference number in the PKFARE's sysrem
                            airPnr:
                              type: string
                              description: Airline PNR
                            platingCarrier:
                              type: string
                              description: Ticket issued Airline
                            payGate:
                              type: string
                              description: Form of payment, Alipay or prepayment
                            paySerialNum:
                              type: string
                              description: Serial Number of payment transaction
                            paidTime:
                              type: string
                              description: 'Payment time, format: yyyy-mm-dd hh:ss:mm (GMT)'
                            contactName:
                              type: string
                              description: 'Name format: FirstnameLastname'
                            contactMobile:
                              type: string
                              description: Telephonenumber
                            contactTel:
                              type: string
                              description: Telephone Area Code
                            contactEmail:
                              type: string
                              description: >-
                                Email address, only supports three special
                                characters: 1.@ (at sign), 2. _ (underscore), 3.
                                - (dash)
                            passengers:
                              type: array
                              items:
                                type: object
                                properties:
                                  firstName:
                                    type: string
                                    description: First name
                                  lastName:
                                    type: string
                                    description: Last name
                                  psgType:
                                    type: string
                                    description: >-
                                      Passenger type including ADT for adults,
                                      CHD for children, INF for infants (no
                                      seat)
                                  nationality:
                                    type: string
                                    description: Nationality [country code]
                                  sex:
                                    type: string
                                    description: Gender, including M for male, F for female
                                  birthday:
                                    type: string
                                    description: Birthday, format[yyyy-mm-dd]
                                  cardType:
                                    type: string
                                    description: >-
                                      Type of travel document, P as passport, N
                                      as Chinese Identity, O as others. 
                                  cardNum:
                                    type: string
                                    description: Travel document number
                                  cardExpiredDate:
                                    type: string
                                    description: >-
                                      Travel document expired date,
                                      format[yyyy-mm-dd]
                                  ticketNum:
                                    type: string
                                    description: >-
                                      Ticket number, multiple number will be
                                      separated by '/', like
                                      9991234567890/9991234567891
                                  passengerIndex:
                                    type: integer
                                    description: >-
                                      Passenger sequence number. Positive and
                                      continous integer starting from 1. If this
                                      booking contains infants. The
                                      passengerIndex all the same with the those
                                      in the booking request. If no infant , the
                                      passengerIndex(s) are generated by system
                                      automatically.
                                  associatedPassengerIndex:
                                    type: integer
                                    description: >-
                                      The associated adult passengerId. Only a
                                      booking contains infant passenger(s) and
                                      only infant passenger(s) have this
                                      parameter.
                                  seats:
                                    type: array
                                    items:
                                      type: string
                                    description: >-
                                      Passenger's associated seat information
                                      per flight 
                                x-apifox-orders:
                                  - firstName
                                  - lastName
                                  - psgType
                                  - nationality
                                  - sex
                                  - birthday
                                  - cardType
                                  - cardNum
                                  - cardExpiredDate
                                  - ticketNum
                                  - passengerIndex
                                  - associatedPassengerIndex
                                  - seats
                                x-apifox-ignore-properties: []
                            journeys:
                              type: array
                              items:
                                type: object
                                properties:
                                  journeyTime:
                                    type: integer
                                    description: >-
                                      Journey time from departure to arrival,
                                      unit: minutes
                                  transferCount:
                                    type: integer
                                    description: Count of transfer times
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
                                          description: Arrival Terminal
                                        departureDate:
                                          type: string
                                          description: >-
                                            Departure Date [yyyy-mm-dd]（Local time
                                            of departure location）
                                        arrivalDate:
                                          type: string
                                          description: >-
                                            Arrival Date [yyyy-mm-dd]（Local time of
                                            arrival location）
                                        departureTime:
                                          type: string
                                          description: >-
                                            Departure Time [hh:mm]（Local time of
                                            departure location）
                                        arrivalTime:
                                          type: string
                                          description: >-
                                            Arrival Time [hh:mm] （Local time of
                                            arrival location）
                                        flightTime:
                                          type: integer
                                          description: 'Fly Time, Unit: minutes'
                                        codeShare:
                                          type: string
                                          description: >-
                                            Code Share Indicator [Y-Code Share
                                            flight, N-Not Code Share flight]
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
                                      x-apifox-ignore-properties: []
                                    description: segment information
                                  departureTime:
                                    type: string
                                    description: >-
                                      Departure Time [hh:mm]（Local time of
                                      departure location）
                                  arrivalTime:
                                    type: string
                                    description: >-
                                      Arrival Time [hh:mm]（Local time of arrival
                                      location）
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
                                x-apifox-orders:
                                  - journeyTime
                                  - transferCount
                                  - segments
                                  - departureTime
                                  - arrivalTime
                                  - departureDate
                                  - arrivalDate
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
                                    description: ''
                                  adtTax:
                                    type: integer
                                    description: ''
                                  chdFare:
                                    type: integer
                                    description: ''
                                  chdTax:
                                    type: integer
                                    description: ''
                                  refundFee:
                                    type: integer
                                    description: ''
                                  refundAmount:
                                    type: integer
                                    description: ''
                                  buyerAmount:
                                    type: integer
                                    description: ''
                                x-apifox-orders:
                                  - currency
                                  - adtFare
                                  - adtTax
                                  - chdFare
                                  - chdTax
                                  - refundFee
                                  - refundAmount
                                  - buyerAmount
                                x-apifox-ignore-properties: []
                              description: Pricing information
                            lastTktTime:
                              type: string
                              description: latest ticketing time (GMT)
                            ancillaryItems:
                              type: array
                              items:
                                type: string
                              description: ancillary order information
                            pnrList:
                              type: array
                              items:
                                type: string
                              description: >-
                                PNR list as per passengers and flight
                                segments[When it is empty, please check airPNR
                                under data object]
                            scheduleChangeList:
                              type: array
                              items:
                                type: string
                              description: >-
                                Schedule Change information, the latest version
                                is current routing
                            checkInInfos:
                              type: array
                              items:
                                type: string
                              description: Check In Information
                            extOrderNum:
                              type: string
                              description: 【PKFARE】Special Remark order number
                            fareRuleInfo:
                              type: object
                              properties:
                                refundRule:
                                  type: object
                                  properties:
                                    refundable:
                                      type: boolean
                                      description: ''
                                    beforeDeparture:
                                      type: array
                                      items:
                                        type: object
                                        properties:
                                          timeRange:
                                            type: string
                                            description: ''
                                          fee:
                                            type: string
                                            description: ''
                                        x-apifox-orders:
                                          - timeRange
                                          - fee
                                        x-apifox-ignore-properties: []
                                      description: ''
                                  description: ''
                                  x-apifox-orders:
                                    - refundable
                                    - beforeDeparture
                                  x-apifox-ignore-properties: []
                              description: ''
                              x-apifox-orders:
                                - refundRule
                              x-apifox-ignore-properties: []
                          x-apifox-orders:
                            - orderStatus
                            - orderNum
                            - parentOrderNum
                            - refOrderNum
                            - orderType
                            - createdTime
                            - postingDate
                            - pnr
                            - airPnr
                            - platingCarrier
                            - payGate
                            - paySerialNum
                            - paidTime
                            - contactName
                            - contactMobile
                            - contactTel
                            - contactEmail
                            - passengers
                            - journeys
                            - solutions
                            - lastTktTime
                            - ancillaryItems
                            - pnrList
                            - scheduleChangeList
                            - checkInInfos
                            - extOrderNum
                            - fareRuleInfo
                          x-apifox-ignore-properties: []
                        description: >-
                          Return when the query order is a refund order and
                          "includeOrderTypes" contains "R"
                      voidOrderList:
                        type: array
                        items:
                          type: object
                          properties:
                            orderStatus:
                              type: string
                            orderNum:
                              type: string
                            parentOrderNum:
                              type: string
                            refOrderNum:
                              type: string
                            orderType:
                              type: string
                            createdTime:
                              type: string
                            pnr:
                              type: string
                            airPnr:
                              type: string
                            platingCarrier:
                              type: string
                            passengers:
                              type: array
                              items:
                                type: object
                                properties:
                                  firstName:
                                    type: string
                                  lastName:
                                    type: string
                                  psgType:
                                    type: string
                                  nationality:
                                    type: string
                                  sex:
                                    type: string
                                  birthday:
                                    type: string
                                  cardType:
                                    type: string
                                  cardNum:
                                    type: string
                                  cardExpiredDate:
                                    type: string
                                x-apifox-orders:
                                  - firstName
                                  - lastName
                                  - psgType
                                  - nationality
                                  - sex
                                  - birthday
                                  - cardType
                                  - cardNum
                                  - cardExpiredDate
                                x-apifox-ignore-properties: []
                            solutions:
                              type: array
                              items:
                                type: object
                                properties:
                                  currency:
                                    type: string
                                  voidServFee:
                                    type: string
                                    description: Void service fee
                                  voidReimTktFee:
                                    type: string
                                    description: >-
                                      Refundable Ticketing Fee per Passenger
                                      (Void Ticket)
                                  voidReimMerFee:
                                    type: string
                                    description: Refundable Payment Fee per Order
                                  voidReimDistCost:
                                    type: string
                                  voidReimCoupon:
                                    type: string
                                    description: Refundable Voucher/Coupon per Order
                                  voidReimAmount:
                                    type: string
                                    description: Refundable Amount per Order
                                x-apifox-orders:
                                  - currency
                                  - voidServFee
                                  - voidReimTktFee
                                  - voidReimMerFee
                                  - voidReimDistCost
                                  - voidReimCoupon
                                  - voidReimAmount
                                required:
                                  - currency
                                  - voidServFee
                                  - voidReimTktFee
                                  - voidReimMerFee
                                  - voidReimDistCost
                                  - voidReimCoupon
                                  - voidReimAmount
                                x-apifox-ignore-properties: []
                          x-apifox-orders:
                            - orderStatus
                            - orderNum
                            - parentOrderNum
                            - refOrderNum
                            - orderType
                            - createdTime
                            - pnr
                            - airPnr
                            - platingCarrier
                            - passengers
                            - solutions
                          x-apifox-ignore-properties: []
                        description: >-
                          Return when the query order is a void order and
                          "includeOrderTypes" contains "V"
                    description: >-
                      Only if the errorCode returns "0", returned data would not
                      be null. Data is refer to Data
                    x-apifox-orders:
                      - curOrderNum
                      - originOrder
                      - changeOrderList
                      - refundOrderList
                      - voidOrderList
                    required:
                      - curOrderNum
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
                      extOrderNum: '123456789'
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
                      lastVoidTime: '2024-02-04 16:31:18'
                      checkInInfos:
                        - firstName: SHASHA
                          lastName: XIA
                          ticketNum: C3pyn0
                          pnr: C3pyn0
                          airPnr: C3pyn0
                          airline: VJ
                          mailAccount: aaaaaa
                          airlineWebsite: https://www.spirit.com/home-check-in
                '2':
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
                '3':
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
                '4':
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
                '5':
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
                '6':
                  summary: Response With Fare Family
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
                              fareBasis: SOXVN
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
                          tag: SAVER
                          otherFareRules:
                            ADT:
                              - segmentIndexList:
                                  - 1
                                detail:
                                  - free meal
                          baggages:
                            '1':
                              carryOn: 1PC10KG
                              baggage: 2PC50KG
                          baggageMap:
                            ADT:
                              - segmentIndexList:
                                  - 1
                                baggageAmount: 2PC
                                baggageWeight: 50KG
                                carryOnAmount: 1PC
                                carryOnWeight: 10KG
                            CHD:
                              - segmentIndexList:
                                  - 1
                                baggageAmount: 2PC
                                baggageWeight: 50KG
                                carryOnAmount: 1PC
                                carryOnWeight: 10KG
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
                '7':
                  summary: Multiple PNRs - Single Passenger Round Trip
                  value:
                    airPnr: COSJSJ|WCMHOA
                    checkInInfos:
                      - airPnr: COSJSJ|WCMHOA
                        airline: UO
                        airlineWebsite: https://www.airline.com
                        firstName: WEI
                        lastName: OY
                        mailAccount: abc@abc.com
                        mailPassword: ''
                        pnr: WC21NB
                        ticketNum: COSJSJ/WCMHOA
                    createdTime: '2025-09-01 02:49:13'
                    journeys:
                      - arrivalDate: '2025-09-09'
                        arrivalTime: '06:10'
                        departureDate: '2025-09-09'
                        departureTime: '02:40'
                        journeyTime: 210
                        segments:
                          - airline: UO
                            arrival: HKG
                            arrivalDate: '2025-09-09'
                            arrivalTerminal: '1'
                            arrivalTime: '06:10'
                            bookingCode: X
                            cabinClass: ECONOMY
                            codeShare: 'N'
                            departure: PKX
                            departureDate: '2025-09-09'
                            departureTerminal: ''
                            departureTime: '02:40'
                            equipment: JET
                            fareBasis: YRT
                            flightNum: '235'
                            flightTime: 210
                        transferCount: 0
                      - arrivalDate: '2025-09-13'
                        arrivalTime: '01:40'
                        departureDate: '2025-09-12'
                        departureTime: '22:15'
                        journeyTime: 205
                        segments:
                          - airline: UO
                            arrival: PKX
                            arrivalDate: '2025-09-13'
                            arrivalTerminal: ''
                            arrivalTime: '01:40'
                            bookingCode: X
                            cabinClass: ECONOMY
                            codeShare: 'N'
                            departure: HKG
                            departureDate: '2025-09-12'
                            departureTerminal: '1'
                            departureTime: '22:15'
                            equipment: JET
                            fareBasis: YRT
                            flightNum: '234'
                            flightTime: 205
                        transferCount: 0
                    lastTktTime: '2025-09-01 04:49:15'
                    orderNum: '917566949527800101'
                    orderStatus: ISSED
                    orderType: O
                    passengers:
                      - birthday: '1997-06-11'
                        cardExpiredDate: '2029-06-13'
                        cardNum: ''
                        cardType: P
                        firstName: WEI
                        lastName: OY
                        nationality: CN
                        passengerIndex: 1
                        psgType: ADT
                        seats:
                          - airline: UO
                            flightNum: '235'
                            seatNum: ''
                          - airline: UO
                            flightNum: '234'
                            seatNum: ''
                        sex: M
                        ticketNum: COSJSJ/WCMHOA
                    payGate: Prepay
                    paySerialNum: ''
                    permitVoid: 0
                    platingCarrier: UO
                    pnr: WC21NB
                    pnrList:
                      - airPnr: COSJSJ
                        arrival: HKG
                        bookingCode: X
                        cabinClass: ECONOMY
                        departure: PKX
                        flightNum: '235'
                        pnr: WC21NB
                        segmentNo: 1
                        ticketNums:
                          - passengerIndex: 1
                            ticketNum: COSJSJ
                      - airPnr: WCMHOA
                        arrival: PKX
                        bookingCode: X
                        cabinClass: ECONOMY
                        departure: HKG
                        flightNum: '234'
                        pnr: WC21NB
                        segmentNo: 2
                        ticketNums:
                          - passengerIndex: 1
                            ticketNum: WCMHOA
                    postingDate: '2025-09-01 10:50:19'
                    refOrderNum: '9175669495278001'
                    solutions:
                      - adtFare: 899.49
                        adtTax: 7.13
                        baggageMap:
                          ADT:
                            - baggageAmount: 0PC
                              carryOnAmount: 0PC
                              segmentIndexList:
                                - 1
                            - baggageAmount: 0PC
                              carryOnAmount: 0PC
                              segmentIndexList:
                                - 2
                        baggages:
                          '1':
                            baggage: 0PC
                            carryOn: 0PC
                          '2':
                            baggage: 0PC
                            carryOn: 0PC
                '8':
                  summary: Response of orderDetail_V12 - request original order
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      curOrderNum: '917628263564844901'
                      originOrder:
                        orderStatus: ISSED
                        orderNum: '917628263564844901'
                        refOrderNum: '9176282635648449'
                        orderType: O
                        createdTime: '2025-11-11 01:59:17'
                        postingDate: '2025-11-11 10:00:31'
                        pnr: YOH9GW
                        airPnr: 1ZZJRC
                        platingCarrier: FD
                        contactName: penn_sub_buyer_user
                        contactMobile: '19520092403'
                        contactEmail: ''
                        passengers:
                          - firstName: PENG
                            lastName: QIN
                            psgType: ADT
                            nationality: CN
                            sex: M
                            birthday: '1997-10-13'
                            cardType: P
                            cardNum: G11111111
                            cardExpiredDate: '2020-02-02'
                            ticketNum: 3323232DSD
                            passengerIndex: 1
                            seats:
                              - airline: FD
                                flightNum: '505'
                                seatNum: ''
                        solutions:
                          - currency: CNY
                            adtFare: 60
                            adtTax: 456
                            tktFee: 0
                            merchantFee: 0
                            distCost: 0
                            coupon: 0
                            buyerAmount: 516
                            baggages:
                              '1':
                                carryOn: 0PC
                                baggage: 0PC
                            baggageMap:
                              ADT:
                                - segmentIndexList:
                                    - 1
                                  baggageAmount: 0PC
                                  carryOnAmount: 0PC
                        payGate: Prepay
                        paySerialNum: PREPAY_20251111095930_917628263564844901_4797
                        journeys:
                          - journeyTime: 185
                            transferCount: 0
                            segments:
                              - airline: FD
                                flightNum: '505'
                                equipment: '320'
                                cabinClass: ECONOMY
                                bookingCode: K
                                departure: HKG
                                arrival: BKK
                                departureTerminal: ''
                                arrivalTerminal: ''
                                departureDate: '2025-11-27'
                                arrivalDate: '2025-11-27'
                                departureTime: '20:10'
                                arrivalTime: '22:15'
                                flightTime: 185
                                codeShare: 'N'
                                fareBasis: YOW
                            departureTime: '20:10'
                            arrivalTime: '22:15'
                            departureDate: '2025-11-27'
                            arrivalDate: '2025-11-27'
                        lastTktTime: '2025-11-11 11:59:00'
                        paidTime: '2025-11-11 01:59:30'
                        ancillaryItems:
                          - itemNumber: '917628263564844902'
                            itemStatus: ISSED
                            createdTime: '2025-11-11 09:59:17'
                            saleStage: 0
                            ancillaryType: 1
                            ancillaryInfo:
                              - baggage:
                                  lastName: QIN
                                  firstName: PENG
                                  psgType: ADT
                                  ancillaryType: 1
                                  payBaggageType: 1
                                  baggagePiece: -1
                                  baggageWeight: 20KG
                                  baggageCurrency: CNY
                                  baggagePrice: 30
                                  segments:
                                    - airline: FD
                                      departure: HKG
                                      departureDate: '2025-11-27'
                                      departureTime: '20:10'
                                      arrival: BKK
                                      arrivalDate: '2025-11-27'
                                      arrivalTime: '22:15'
                                      flightNum: '505'
                                      bookingCode: K
                                      cabinClassType: 3
                              - baggage:
                                  lastName: QIN
                                  firstName: PENG
                                  psgType: ADT
                                  ancillaryType: 1
                                  payBaggageType: 2
                                  baggagePiece: -1
                                  baggageWeight: 10KG
                                  baggageCurrency: CNY
                                  baggagePrice: 60
                                  segments:
                                    - airline: FD
                                      departure: HKG
                                      departureDate: '2025-11-27'
                                      departureTime: '20:10'
                                      arrival: BKK
                                      arrivalDate: '2025-11-27'
                                      arrivalTime: '22:15'
                                      flightNum: '505'
                                      bookingCode: K
                                      cabinClassType: 3
                        pnrList:
                          - segmentNo: 1
                            departure: HKG
                            arrival: BKK
                            flightNum: '505'
                            pnr: YOH9GW
                            airPnr: 1ZZJRC
                            cabinClass: ECONOMY
                            bookingCode: K
                            ticketNums:
                              - ticketNum: 3323232DSD
                                passengerIndex: 1
                        permitVoid: 0
                        checkInInfos: []
                      changeOrderList:
                        - orderStatus: CHGD
                          orderNum: '917628263564844903'
                          parentOrderNum: '917628263564844901'
                          refOrderNum: '9176282635648449'
                          orderType: C
                          createdTime: '2025-11-11 02:13:33'
                          postingDate: '2025-11-11 10:16:02'
                          pnr: YOH9GW
                          airPnr: 1ZZJRC
                          platingCarrier: FD
                          passengers:
                            - firstName: PENG
                              lastName: QIN
                              psgType: ADT
                              nationality: CN
                              sex: M
                              birthday: '1997-10-13'
                              cardType: P
                              cardNum: G11111111
                              cardExpiredDate: '2020-02-02'
                          solutions:
                            - currency: CNY
                              adtChgFee: 5
                              adtChgAddFee: 0
                              chgServFee: 22
                              chgMerFee: 0
                              chgBuyerAmount: 27
                          permitVoid: 0
                      refundOrderList:
                        - orderStatus: REFD_PRC
                          orderNum: '917628263564844904'
                          parentOrderNum: '917628263564844903'
                          refOrderNum: '9176282635648449'
                          orderType: R
                          createdTime: '2025-11-11 03:42:06'
                          pnr: YOH9GW
                          airPnr: 1ZZJRC
                          platingCarrier: FD
                          passengers:
                            - firstName: PENG
                              lastName: QIN
                              psgType: ADT
                              nationality: CN
                              sex: M
                              birthday: '1997-10-13'
                              cardType: P
                              cardNum: G11111111
                              cardExpiredDate: '2020-02-02'
                          solutions:
                            - currency: CNY
                              adtRfdFee: 20
                              adtUsedFee: 1
                              rfdServFee: 23.18
                              rfdReimTktFee: 0
                              rfdReimMerFee: 0
                              rfdReimDistCost: 0
                              rfdReimCoupon: 0
                              rfdReimAmount: 471.82
                '9':
                  summary: >-
                    Response of orderDetail_V12 - request post-booking service
                    order
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      curOrderNum: '917628263564844903'
                      originOrder:
                        orderStatus: ISSED
                        orderNum: '917628263564844901'
                        refOrderNum: '9176282635648449'
                        orderType: O
                        createdTime: '2025-11-11 01:59:17'
                        postingDate: '2025-11-11 10:00:31'
                        pnr: YOH9GW
                        airPnr: 1ZZJRC
                        platingCarrier: FD
                        contactName: penn_sub_buyer_user
                        contactMobile: '19520092403'
                        contactEmail: ''
                        passengers:
                          - firstName: PENG
                            lastName: QIN
                            psgType: ADT
                            nationality: CN
                            sex: M
                            birthday: '1997-10-13'
                            cardType: P
                            cardNum: G11111111
                            cardExpiredDate: '2020-02-02'
                            ticketNum: 3323232DSD
                            passengerIndex: 1
                            seats:
                              - airline: FD
                                flightNum: '505'
                                seatNum: ''
                        solutions:
                          - currency: CNY
                            adtFare: 60
                            adtTax: 456
                            tktFee: 0
                            merchantFee: 0
                            distCost: 0
                            coupon: 0
                            buyerAmount: 516
                            baggages:
                              '1':
                                carryOn: 0PC
                                baggage: 0PC
                            baggageMap:
                              ADT:
                                - segmentIndexList:
                                    - 1
                                  baggageAmount: 0PC
                                  carryOnAmount: 0PC
                        payGate: Prepay
                        paySerialNum: PREPAY_20251111095930_917628263564844901_4797
                        journeys:
                          - journeyTime: 185
                            transferCount: 0
                            segments:
                              - airline: FD
                                flightNum: '505'
                                equipment: '320'
                                cabinClass: ECONOMY
                                bookingCode: K
                                departure: HKG
                                arrival: BKK
                                departureTerminal: ''
                                arrivalTerminal: ''
                                departureDate: '2025-11-27'
                                arrivalDate: '2025-11-27'
                                departureTime: '20:10'
                                arrivalTime: '22:15'
                                flightTime: 185
                                codeShare: 'N'
                                fareBasis: YOW
                            departureTime: '20:10'
                            arrivalTime: '22:15'
                            departureDate: '2025-11-27'
                            arrivalDate: '2025-11-27'
                        lastTktTime: '2025-11-11 11:59:00'
                        paidTime: '2025-11-11 01:59:30'
                        ancillaryItems:
                          - itemNumber: '917628263564844902'
                            itemStatus: ISSED
                            createdTime: '2025-11-11 09:59:17'
                            saleStage: 0
                            ancillaryType: 1
                            ancillaryInfo:
                              - baggage:
                                  lastName: QIN
                                  firstName: PENG
                                  psgType: ADT
                                  ancillaryType: 1
                                  payBaggageType: 1
                                  baggagePiece: -1
                                  baggageWeight: 20KG
                                  baggageCurrency: CNY
                                  baggagePrice: 30
                                  segments:
                                    - airline: FD
                                      departure: HKG
                                      departureDate: '2025-11-27'
                                      departureTime: '20:10'
                                      arrival: BKK
                                      arrivalDate: '2025-11-27'
                                      arrivalTime: '22:15'
                                      flightNum: '505'
                                      bookingCode: K
                                      cabinClassType: 3
                              - baggage:
                                  lastName: QIN
                                  firstName: PENG
                                  psgType: ADT
                                  ancillaryType: 1
                                  payBaggageType: 2
                                  baggagePiece: -1
                                  baggageWeight: 10KG
                                  baggageCurrency: CNY
                                  baggagePrice: 60
                                  segments:
                                    - airline: FD
                                      departure: HKG
                                      departureDate: '2025-11-27'
                                      departureTime: '20:10'
                                      arrival: BKK
                                      arrivalDate: '2025-11-27'
                                      arrivalTime: '22:15'
                                      flightNum: '505'
                                      bookingCode: K
                                      cabinClassType: 3
                        pnrList:
                          - segmentNo: 1
                            departure: HKG
                            arrival: BKK
                            flightNum: '505'
                            pnr: YOH9GW
                            airPnr: 1ZZJRC
                            cabinClass: ECONOMY
                            bookingCode: K
                            ticketNums:
                              - ticketNum: 3323232DSD
                                passengerIndex: 1
                        permitVoid: 0
                        checkInInfos: []
                      changeOrderList:
                        - orderStatus: CHGD
                          orderNum: '917628263564844903'
                          parentOrderNum: '917628263564844901'
                          refOrderNum: '9176282635648449'
                          orderType: C
                          createdTime: '2025-11-11 02:13:33'
                          postingDate: '2025-11-11 10:16:02'
                          pnr: YOH9GW
                          airPnr: 1ZZJRC
                          platingCarrier: FD
                          contactName: penn_sub_buyer_user
                          contactMobile: '19520092403'
                          contactEmail: 1025638792@qq.com
                          passengers:
                            - firstName: PENG
                              lastName: QIN
                              psgType: ADT
                              nationality: CN
                              sex: M
                              birthday: '1997-10-13'
                              cardType: P
                              cardNum: G11111111
                              cardExpiredDate: '2020-02-02'
                              ticketNum: 1000000DSD
                              passengerIndex: 1
                              seats: []
                            - firstName: PENG
                              lastName: QIN
                              psgType: ADT
                              nationality: CN
                              sex: M
                              birthday: '1997-10-13'
                              cardType: P
                              cardNum: G11111111
                              cardExpiredDate: '2020-02-02'
                              ticketNum: 1000000DSD
                              passengerIndex: 2
                              seats: []
                          solutions:
                            - currency: CNY
                              adtChgFee: 5
                              adtChgAddFee: 0
                              chgServFee: 22
                              chgMerFee: 0
                              chgBuyerAmount: 27
                              baggages:
                                '1':
                                  carryOn: 0PC
                                  baggage: 0PC
                              baggageMap:
                                ADT:
                                  - segmentIndexList:
                                      - 1
                                    baggageAmount: 0PC
                                    carryOnAmount: 0PC
                          payGate: Prepay
                          paySerialNum: PREPAY_20251111101536_917628263564844903_6142
                          journeys:
                            - journeyTime: 175
                              transferCount: 0
                              segments:
                                - airline: FD
                                  flightNum: '509'
                                  equipment: '320'
                                  cabinClass: ECONOMY
                                  bookingCode: K
                                  departure: HKG
                                  arrival: BKK
                                  departureTerminal: ''
                                  arrivalTerminal: ''
                                  departureDate: '2025-11-28'
                                  arrivalDate: '2025-11-28'
                                  departureTime: '10:45'
                                  arrivalTime: '12:40'
                                  flightTime: 175
                                  codeShare: 'N'
                                  fareBasis: YOW
                              departureTime: '10:45'
                              arrivalTime: '12:40'
                              departureDate: '2025-11-28'
                              arrivalDate: '2025-11-28'
                          lastTktTime: '2025-11-11 11:59:00'
                          paidTime: '2025-11-11 02:15:36'
                          ancillaryItems: []
                          pnrList:
                            - segmentNo: 1
                              departure: HKG
                              arrival: BKK
                              flightNum: '509'
                              pnr: YOH9GW
                              airPnr: 1ZZJRC
                              cabinClass: ECONOMY
                              bookingCode: K
                              ticketNums:
                                - ticketNum: 1000000DSD
                                  passengerIndex: 2
                          permitVoid: 0
                          checkInInfos: []
                      refundOrderList:
                        - orderStatus: REFD_PRC
                          orderNum: '917628263564844904'
                          parentOrderNum: '917628263564844903'
                          refOrderNum: '9176282635648449'
                          orderType: R
                          createdTime: '2025-11-11 03:42:06'
                          pnr: YOH9GW
                          airPnr: 1ZZJRC
                          platingCarrier: FD
                          passengers:
                            - firstName: PENG
                              lastName: QIN
                              psgType: ADT
                              nationality: CN
                              sex: M
                              birthday: '1997-10-13'
                              cardType: P
                              cardNum: G11111111
                              cardExpiredDate: '2020-02-02'
                          solutions:
                            - currency: CNY
                              adtRfdFee: 20
                              adtUsedFee: 1
                              rfdServFee: 23.18
                              rfdReimTktFee: 0
                              rfdReimMerFee: 0
                              rfdReimDistCost: 0
                              rfdReimCoupon: 0
                              rfdReimAmount: 471.82
                '10':
                  summary: Success(with multiTag)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      curOrderNum: '917863582953977101'
                      originOrder:
                        orderStatus: ISS_PRC
                        orderNum: '917863582953977101'
                        refOrderNum: '9178635829539771'
                        orderType: O
                        createdTime: '2026-08-10 10:38:16'
                        pnr: QDDS5X
                        platingCarrier: SG
                        contactName: PKFARE
                        contactMobile: '13378987653'
                        contactEmail: test@pkfare.com
                        passengers:
                          - firstName: Isaias
                            lastName: Bode
                            psgType: ADT
                            nationality: TR
                            sex: F
                            birthday: '1997-07-17'
                            cardType: P
                            cardNum: E67126214
                            cardExpiredDate: '2030-10-10'
                            ticketNum: ''
                            passengerIndex: 1
                            seats:
                              - airline: SG
                                flightNum: '169'
                                seatNum: ''
                              - airline: SG
                                flightNum: '152'
                                seatNum: ''
                        solutions:
                          - currency: CNY
                            adtFare: 3998
                            adtTax: 2412.66
                            tktFee: 0
                            merchantFee: 0
                            distCost: 0
                            coupon: 0
                            buyerAmount: 6410.66
                            otherFareRules:
                              ADT:
                                segmentIndexList:
                                  - 1
                                  - 2
                                detail:
                                  - Free Seat Selection
                                  - Free Meals
                                  - Free Priority Boarding
                            baggages:
                              '1':
                                carryOn: 1PC10KG
                                baggage: 1PC20KG
                              '2':
                                carryOn: 1PC10KG
                                baggage: 1PC20KG
                            baggageMap:
                              ADT:
                                - segmentIndexList:
                                    - 1
                                  baggageAmount: 1PC
                                  baggageWeight: 20KG
                                  carryOnAmount: 1PC
                                  carryOnWeight: 10KG
                                - segmentIndexList:
                                    - 2
                                  baggageAmount: 1PC
                                  baggageWeight: 20KG
                                  carryOnAmount: 1PC
                                  carryOnWeight: 10KG
                            brandFare: testlxy
                            multiTags:
                              SpecialProductType:
                                - tagCode: test-非标
                                  tagName: test-非标
                        payGate: Prepay
                        paySerialNum: PREPAY_20260810183816_917863582953977101_7599
                        journeys:
                          - journeyTime: 130
                            transferCount: 0
                            segments:
                              - airline: SG
                                flightNum: '169'
                                equipment: '737'
                                cabinClass: ECONOMY
                                bookingCode: E
                                departure: DEL
                                arrival: BOM
                                departureTerminal: T-1D
                                arrivalTerminal: T-1
                                departureDate: '2027-07-05'
                                arrivalDate: '2027-07-06'
                                departureTime: '22:00'
                                arrivalTime: '00:10'
                                flightTime: 130
                                codeShare: 'N'
                                fareBasis: YRT
                            departureTime: '22:00'
                            arrivalTime: '00:10'
                            departureDate: '2027-07-05'
                            arrivalDate: '2027-07-06'
                          - journeyTime: 145
                            transferCount: 0
                            segments:
                              - airline: SG
                                flightNum: '152'
                                equipment: '737'
                                cabinClass: ECONOMY
                                bookingCode: E
                                departure: BOM
                                arrival: DEL
                                departureTerminal: T-1
                                arrivalTerminal: T-1D
                                departureDate: '2027-07-10'
                                arrivalDate: '2027-07-10'
                                departureTime: '06:05'
                                arrivalTime: '08:30'
                                flightTime: 145
                                codeShare: 'N'
                                fareBasis: YRT
                            departureTime: '06:05'
                            arrivalTime: '08:30'
                            departureDate: '2027-07-10'
                            arrivalDate: '2027-07-10'
                        lastTktTime: '2026-08-10 12:38:00'
                        paidTime: '2026-08-10 10:38:16'
                        ancillaryItems: []
                        pnrList: []
                        permitVoid: 0
                '11':
                  summary: Error
                  value:
                    errorCode: B037
                    errorMsg: 'Order is not exists. OrderNum: 917133223962851001'
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
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Air ticket booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470824-run
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