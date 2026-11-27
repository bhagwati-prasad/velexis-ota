# RefundRequest

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/refund-api/refundRequest:
    post:
      summary: RefundRequest
      deprecated: false
      description: >
        ### Function Description


        Through RefundRequest API, you are able to request with the passenger
        who wuold like to make a refund on which segment. System will create a
        refund request(which is refund order). If you have got a refund pricing
        ID, which is still valid, you can request with refund pricing ID. If you
        don't have refund pricing ID, you can make a refund request directly
        withou refund pricing ID. System will create refund request accordingly.



        ### Error Code List


        |errorCode|errorMsg|Description|

        |:----|:----|:----|

        |0|ok|Success|

        |S001|System error|System error|

        |P001|xxx is illegal|Request parameter is illegal, xxx will display
        request parameter|

        |P001|xxx is missing|Request parameter is required, xxx will display
        request parameter|

        |B002|Partner is not exists|Partner is not exists.|

        |B003|Illegal sign|Signature is illegal|

        |B048|Invalid buyer|Buyer is invalid, please contact PKFARE account
        manager|

        |B037|Order is not exist|Order is not exist|

        |B035|Concurrency limited. Please contact PKFARE API support team for
        assistant.|Request is over the limiation of concurrency.|

        |B134|Refund is not applicable for passenger [passenger name]|Passenger
        or segment in the request has already request for refund or void, which
        order status is processing or completed.|

        |B135|Passenger or ticket number is not in the order|Passenger or ticket
        number in the request is not same as order.|

        |B136|This is not all passengers and routings of the order, please
        kindly check|"allPaxOfOrder" is 1，but pnrList does not contains all
        passenger and routings.|

        |B137|RefundPricing is not exist|Refund Pricing ID is not exist|

        |B145|Passenger(s) must request to refund same routing for one time. If
        routing is varies, please request per passenger.|Multiple passengers
        request for refund different segments in this request. Please raise
        refund per passenger.|

        |B146|Order#[Order number] is not applicable for refund.|Order number in
        the request is not issue order and not change order. Refund is not
        allowed.|

        |B149|Refund Pricing ID#(Refund Pricing ID) has been expired. Please
        check refund pricing again.|Refund Pricing ID has been expired. |

        |B150|This order was changed, please kindly use change order
        number.|Passenger and segment in PnrList has requested for change,
        please use change order number.|

        |B152|pnrList information is not same as order, please kindly
        check.|pnrList in the request is not same as order.|

        |B153|Duplicated refund request, please kindly check|Passenger and
        segment in the request has already submit refund, and the refund is
        still in processing. System does not allow to request again.|

        |B154|pnrList information is not same as refund pricing ID, please
        kindly check|PnrList information in the request is not same as refund
        pricing ID, please kindly check.|

        |B190 |Please select all passengers and  segments before submitting. |In
        cases of refund for the whole order, please select every passengers and
        segments before sending the request.|
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
                    allPaxOfOrder:
                      type: integer
                      description: >-
                        Identifier for all passengers of the order, 0-No，1-Yes.
                        If request with "1", system will validate whether the
                        request contains all passengers and routings of the
                        order.
                    refundPricingId:
                      type: string
                      description: >-
                        Refund Pricing ID which is returned in Refund Pricing
                        API or Check Refund Pricing API.
                    orderNum:
                      type: string
                      description: >-
                        PKFARE order number, issued order and change order are
                        supported.
                    refundType:
                      type: integer
                      description: Refund request type:0-Voluntary, 1-Involuntary.
                    refundReason:
                      type: integer
                      description: >-
                        Refund reason：0-Personal Reason, 1-Illness Reason,
                        2-Schedule Change Reason, 3-Crisis Reason， 4-Visa
                        Refusal
                    contactPerson:
                      type: string
                      description: >-
                        Contact person for refund order. The contact information
                        from Origin Order will be used if contactPerson is not
                        in the request.
                    email:
                      type: string
                      description: >-
                        Email for refund order. The email from Origin Order will
                        be used if email is not in the request.
                    telNum:
                      type: string
                      description: >-
                        Contact telephone number for refund order. The contact
                        information from Origin Order will be used if telNum is
                        not in the request.
                    uploadFilesIds:
                      type: array
                      items:
                        type: string
                      description: File Id, support 99 files per request
                    pnrList:
                      type: array
                      items:
                        type: object
                        properties:
                          segmentNo:
                            type: string
                            description: Segment sequence, start from "1"
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
                            description: Cabin calss
                          bookingCode:
                            type: string
                            description: Booking code
                          airPnr:
                            type: string
                            description: Airline PNR
                          pnr:
                            type: string
                            description: PNR
                          ticketNums:
                            type: array
                            items:
                              type: object
                              properties:
                                ticketNum:
                                  type: string
                                  description: Ticket Number
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
                                sex:
                                  type: string
                                  description: Gender
                                birthday:
                                  type: string
                                  description: Birthday, format[yyyy-MM-dd]
                              x-apifox-orders:
                                - ticketNum
                                - lastName
                                - firstName
                                - cardType
                                - cardNum
                                - sex
                                - birthday
                              required:
                                - lastName
                                - firstName
                                - sex
                                - birthday
                              x-apifox-ignore-properties: []
                            description: Passenger and ticket information
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
                        required:
                          - segmentNo
                          - departure
                          - arrival
                          - flightNum
                          - cabinClass
                          - bookingCode
                        x-apifox-ignore-properties: []
                      description: PNR and ticket information
                    canceledReservationBeforeDeparture:
                      type: integer
                      description: >-
                        PNR has been canceled. 0-PNR has not yet been canceled.
                        1-PNR has been canceled before departure. If the element
                        was not indicated, it will be consider as 0-PNR has not
                        yet been canceled.
                  required:
                    - allPaxOfOrder
                    - orderNum
                    - refundType
                    - refundReason
                    - pnrList
                  x-apifox-orders:
                    - allPaxOfOrder
                    - refundPricingId
                    - orderNum
                    - refundType
                    - refundReason
                    - contactPerson
                    - email
                    - telNum
                    - uploadFilesIds
                    - pnrList
                    - canceledReservationBeforeDeparture
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HWFRSHZN5CTTHCGNDB9SZNGX
                - data
              x-apifox-refs:
                01HWFRSHZN5CTTHCGNDB9SZNGX:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: ''
                partnerId: ''
              data:
                refundPricingId: '16787330658156729'
                allPaxOfOrder: 1
                orderNum: '916783290901993901'
                pnrList:
                  - airPnr: EDTCZP
                    arrival: SIN
                    bookingCode: E
                    cabinClass: ECONOMY
                    departure: HKG
                    flightNum: CX635
                    pnr: EDTCZP
                    segmentNo: '1'
                    ticketNums:
                      - birthday: '2003-01-09'
                        cardNum: P1234567
                        cardType: P
                        firstName: CHUN
                        lastName: XIN
                        sex: M
                        ticketNum: EDTCAA
                refundReason: 0
                refundType: 0
                uploadFilesIds:
                  - 7a570c0877099e8faaaa
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
                    description: Error Code, 0-Success，Others-Failed
                  errorMsg:
                    type: string
                    description: Error reason
                  warningMsg:
                    type: string
                    description: Warning Message
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
                        type: string
                        description: >-
                          Refund reasons：0-Personal Reason, 1-Illness Reason,
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
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - warningMsg
                  - data
                x-apifox-ignore-properties: []
              examples:
                '1':
                  summary: Success
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderNum: '916783298501993902'
                      parentOrderNum: '916783298501993901'
                      refOrderNum: '9167832985019939'
                      createTime: '2023-03-10 10:04:02'
                      passengerPriceList:
                        - segmentList:
                            - segmentNo: 2
                              departure: YVR
                              arrival: MEX
                              flightNum: AC996
                              cabinClass: ECONOMY
                              bookingCode: P
                          lastName: YANG
                          firstName: TIFFANYBVC
                          cardType: P
                          cardNum: E07700466
                          sex: F
                          birthday: '1990-08-23'
                      refundType: '0'
                      refundReason: '0'
                      orderStatus: Under review
                      pnr: NGLVYT
                      platingCarrier: AC
                      journeys:
                        - journeyTime: 815
                          segments:
                            - airline: AC
                              flightNum: '996'
                              equipment: 7M8
                              cabinClass: ECONOMY
                              bookingCode: P
                              departure: YVR
                              arrival: MEX
                              departureTerminal: ''
                              arrivalTerminal: ''
                              departureDate: '2023-02-17'
                              arrivalDate: '2023-02-17'
                              departureTime: '16:30'
                              arrivalTime: '23:50'
                              flightTime: 440
                              codeShare: 'N'
                          departureTime: '10:15'
                          arrivalTime: '23:50'
                          departureDate: '2023-02-17'
                          arrivalDate: '2023-02-17'
                '2':
                  summary: Error
                  value:
                    errorCode: B037
                    errorMsg: Order is not exist.
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
                    description: Error Code, 0-Success，Others-Failed
                  errorMsg:
                    type: string
                    description: Error reason
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
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469943-run
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