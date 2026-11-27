# CheckRefund

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/refund-api/checkRefund:
    post:
      summary: CheckRefund
      deprecated: false
      description: >-
        ### Function


        This API is used to inquire about the progress of the refund order
        refund. The purchaser initiates a request based on the refund order
        number. After the application and verification is successful, the refund
        progress information will be returned.


        ### Error Code List


        |error code|error message|description|

        |:----|:----|:----|

        |0|ok|success|

        |S001|System error|System error|

        |P001|xxx is illegal|illegal parameter|

        |P001|xxx is missing|missing parameters|

        |B002|Partner is not exists|Partner is not exists|

        |B003|Illegal sign|Illegal signature|

        |B048|Invalid buyer|invalid buyer|

        |B035|Concurrency limited. Please contact PKFARE API support team for
        assistant.|Concurrency limited. Please contact PKFARE API support team
        for assistant.|

        |B037|Order is not exist|Order is not exist|

        |B141|Order is not a refund order.|Order is not a refund order.|
      tags:
        - API Reference/Refund APIs
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
                      description: PKFARE order number- refund order
                  required:
                    - orderNum
                  x-apifox-orders:
                    - orderNum
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HWHAZQH71CF1ZA5Q54C9H9VV
                - data
              x-apifox-refs:
                01HWHAZQH71CF1ZA5Q54C9H9VV:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: ''
                sign: ''
              data:
                orderNum: '916783298501993902'
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
                    description: error code，refer to error code list
                  errorMsg:
                    type: string
                    description: error message
                  warningMsg:
                    type: string
                    description: warning message
                  data:
                    type: object
                    properties:
                      orderNum:
                        type: string
                        description: PKFARE refund order number
                      parentOrderNum:
                        type: string
                        description: >-
                          PKFARE Parent Order number of this refund order, it
                          could be issued order number or change order number
                      refOrderNum:
                        type: string
                        description: >-
                          PKFARE general order number, it may include more
                          orders
                      createTime:
                        type: string
                        description: >-
                          Order creation time, format yyyy-MM-dd HH:mm:ss
                          (UTC+0)
                      passengerPriceList:
                        type: array
                        items:
                          type: object
                          properties:
                            segmentList:
                              type: array
                              items:
                                type: object
                                properties:
                                  segmentNo:
                                    type: integer
                                    description: Segment sequency, start from "1"
                                  departure:
                                    type: string
                                    description: Departure airport code
                                  arrival:
                                    type: string
                                    description: Arrival airport code
                                  flightNum:
                                    type: string
                                    description: Flight number
                                  cabinClass:
                                    type: string
                                    description: Cabin class
                                  bookingCode:
                                    type: string
                                    description: Booking code
                                  pnr:
                                    type: string
                                    description: PNR
                                  airPnr:
                                    type: string
                                    description: Airline PNR
                                  ticketNum:
                                    type: string
                                    description: Ticket number
                                required:
                                  - segmentNo
                                  - departure
                                  - arrival
                                  - flightNum
                                  - cabinClass
                                  - bookingCode
                                x-apifox-orders:
                                  - segmentNo
                                  - departure
                                  - arrival
                                  - flightNum
                                  - cabinClass
                                  - bookingCode
                                  - pnr
                                  - airPnr
                                  - ticketNum
                                x-apifox-ignore-properties: []
                              description: Segment information
                            lastName:
                              type: string
                              description: Last Name
                            firstName:
                              type: string
                              description: First Name
                            cardType:
                              type: string
                              description: Travel document type
                            cardNum:
                              type: string
                              description: Travel document number
                            cardExpiredDate:
                              type: string
                              description: Travel document expired date
                            nationality:
                              type: string
                              description: Nationality【Country 2 letters code】
                            psgType:
                              type: string
                              description: Passenger Type
                            sex:
                              type: string
                              description: Gender
                            birthday:
                              type: string
                              description: Birthday，Format[yyyy-MM-dd]
                            solutions:
                              type: array
                              items:
                                type: object
                                properties:
                                  currency:
                                    type: string
                                    description: currency
                                  paidAmount:
                                    type: number
                                    description: Paid amount
                                  usedAmount:
                                    type: number
                                    description: Used fare and tax amount
                                  nonRefundableAmount:
                                    type: number
                                    description: >-
                                      nonrefundable amount（Includes airline
                                      penalties, non-refundable taxes, and
                                      supplier ticketing service fees）
                                  refundServiceFee:
                                    type: number
                                    description: Refund service fee
                                  refundAmount:
                                    type: number
                                    description: Refund amount
                                  formOfPayment:
                                    type: string
                                    description: >-
                                      Refund form of payment：Depends on payment
                                      method， Airline voucher， Depends on refund
                                      result， EMD
                                  voucherNumber:
                                    type: string
                                    description: >-
                                      Voucher number, for refund form of payment
                                      as Airline voucher or EMD
                                  voucherFileId:
                                    type: string
                                    description: >-
                                      Voucher File ID, for refund form of
                                      payment as Airline voucher. You can
                                      download this file by DownloadFile API
                                  voucherCurrency:
                                    type: string
                                    description: >-
                                      Voucher currency, for refund form of
                                      payment as Airline voucher or EMD
                                  voucherAmount:
                                    type: number
                                    description: >-
                                      Voucher amount, for refund form of payment
                                      as Airline voucher or EMD
                                  voucherValidFrom:
                                    type: string
                                    description: >-
                                      Voucher valid date from, for refund form
                                      of payment as Airline voucher or EMD
                                  voucherValidEnd:
                                    type: string
                                    description: >-
                                      Voucher valid date to, for refund form of
                                      payment as Airline voucher or EMD
                                  useFor:
                                    type: string
                                    description: >
                                      Usage of Airline voucher or EMD：1-Issue
                                      ticket，2-Change ticket，3-Purchase
                                      ancillaries product
                                  usageLimitation:
                                    type: array
                                    items:
                                      type: integer
                                    description: >-
                                      Usage limitation: 0 - Uncertain，
                                      1-Passenger only， 2-No limitation
                                x-apifox-orders:
                                  - currency
                                  - paidAmount
                                  - usedAmount
                                  - nonRefundableAmount
                                  - refundServiceFee
                                  - refundAmount
                                  - formOfPayment
                                  - voucherNumber
                                  - voucherFileId
                                  - voucherCurrency
                                  - voucherAmount
                                  - voucherValidFrom
                                  - voucherValidEnd
                                  - useFor
                                  - usageLimitation
                                required:
                                  - currency
                                  - paidAmount
                                  - usedAmount
                                  - nonRefundableAmount
                                  - refundServiceFee
                                  - refundAmount
                                  - formOfPayment
                                x-apifox-ignore-properties: []
                              description: Refund Pricing information
                          x-apifox-orders:
                            - segmentList
                            - lastName
                            - firstName
                            - cardType
                            - cardNum
                            - cardExpiredDate
                            - nationality
                            - psgType
                            - sex
                            - birthday
                            - solutions
                          required:
                            - segmentList
                            - lastName
                            - firstName
                            - nationality
                            - psgType
                            - sex
                            - birthday
                          x-apifox-ignore-properties: []
                        description: Passenger and refund pricing information
                      refundType:
                        type: integer
                        description: Refund type：0-Voluntary, 1-Involuntary
                      refundReason:
                        type: integer
                        description: >-
                          Refund reason：0-Personal Reason, 1-Illness Reason,
                          2-Schedule Change Reason, 3-Crisis Reason， 4-Visa
                          Refusal
                      orderStatus:
                        type: string
                        description: Order status
                      pnr:
                        type: string
                        description: PNR of order
                      airPnr:
                        type: string
                        description: Airline PNR of order
                      platingCarrier:
                        type: string
                        description: Plating carrier
                      journeys:
                        type: array
                        items:
                          type: object
                          properties:
                            journeyTime:
                              type: integer
                              description: Journey Time, Unit：minutes
                            transferCount:
                              type: integer
                              description: Transfer count
                            departureDate:
                              type: string
                              description: Departure date, format [yyyy-mm-dd]（local time）
                            arrivalDate:
                              type: string
                              description: Arrival data, format [yyyy-mm-dd]（local time）
                            departureTime:
                              type: string
                              description: Departure time, format[hh:mm]（local time）
                            arrivalTime:
                              type: string
                              description: Arrival time, format[hh:mm]（local time）
                            segments:
                              type: array
                              items:
                                type: object
                                properties:
                                  airline:
                                    type: string
                                    description: Airline code
                                  flightNum:
                                    type: string
                                    description: Flight number
                                  equipment:
                                    type: string
                                    description: Equipment code
                                  cabinClass:
                                    type: string
                                    description: Cabin class
                                  bookingCode:
                                    type: string
                                    description: Booking code
                                  departure:
                                    type: string
                                    description: Departure airport code
                                  arrival:
                                    type: string
                                    description: Arrival airport code
                                  departureTerminal:
                                    type: string
                                    description: Departure terminal
                                  arrivalTerminal:
                                    type: string
                                    description: Arrival terminal
                                  departureDate:
                                    type: string
                                    description: >-
                                      Departure Date, format [yyyy-mm-dd]（local
                                      time）
                                  arrivalDate:
                                    type: string
                                    description: >-
                                      Arrival Date, format [yyyy-mm-dd]（local
                                      time）
                                  departureTime:
                                    type: string
                                    description: Departure time, format [hh:mm]（local time）
                                  arrivalTime:
                                    type: string
                                    description: Arrival time, format [hh:mm] （local time）
                                  flightTime:
                                    type: integer
                                    description: 'Flying time, Unit: minutes'
                                  stayTime:
                                    type: string
                                    description: 'Stay time, Unit: minutes'
                                  codeShare:
                                    type: string
                                    description: Code-share flight identifier [Y-Yes, N-No]
                                  opFltNo:
                                    type: string
                                    description: Operating flight number
                                  opFltAirline:
                                    type: string
                                    description: Operating airline
                                  stopover:
                                    type: string
                                    description: Stopover airport code
                                required:
                                  - airline
                                  - flightNum
                                  - equipment
                                  - cabinClass
                                  - bookingCode
                                  - departure
                                  - arrival
                                  - departureDate
                                  - arrivalDate
                                  - departureTime
                                  - arrivalTime
                                  - flightTime
                                  - codeShare
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
                              description: Segment information
                          required:
                            - journeyTime
                            - departureDate
                            - arrivalDate
                            - departureTime
                            - arrivalTime
                            - segments
                          x-apifox-orders:
                            - journeyTime
                            - transferCount
                            - departureDate
                            - arrivalDate
                            - departureTime
                            - arrivalTime
                            - segments
                          x-apifox-ignore-properties: []
                        description: Journey information
                    required:
                      - orderNum
                      - refOrderNum
                      - createTime
                      - passengerPriceList
                      - refundType
                      - refundReason
                      - orderStatus
                      - platingCarrier
                      - journeys
                    x-apifox-orders:
                      - orderNum
                      - parentOrderNum
                      - refOrderNum
                      - createTime
                      - passengerPriceList
                      - refundType
                      - refundReason
                      - orderStatus
                      - pnr
                      - airPnr
                      - platingCarrier
                      - journeys
                    description: Return data, will not be empty when error code is "0".
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                  - errorMsg
                  - warningMsg
                  - data
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - warningMsg
                  - data
                x-apifox-ignore-properties: []
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
                    description: error code，refer to error code list
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
      x-apifox-folder: API Reference/Refund APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469944-run
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