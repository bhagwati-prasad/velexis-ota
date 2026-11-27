# Refund Pricing

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/refundPricing/generate:
    post:
      summary: Refund Pricing
      deprecated: false
      description: >-
        ### Function


        This API is used for price inquiries for refunded tickets. The purchaser
        request initiates an application according to the order number and the
        ticket number for which the refund is to be processed. After the
        application and verification is successful, the system will generate a
        Refund Pricing inquiry record in the system.

        <br>

        `Note`  This API provides Postman examples, which you can obtain by
        contacting your account manager.


        ### Error Code List



        |error code |error message |description |

        | :--- | :--- | :--- |

        |0 |Ok |success |

        |P001 |xxx is illegal |invalid parameters |

        |B002 |Partner is not exists |invalid partner |

        |B003 |Illegal sign |Illegal sign |

        |B048 |Invalid buyer |Invalid buyer |

        |B037 |Order is not exist |Order is not exist |

        |S001 |System error |system error |

        |B134 |Refund is not applicable for passenger [pax name] |The passenger
        and ticket in the application already have an associated voided ticket
        or refund order and the status of the voided ticket or refund order is
        valid, and it is not allowed to initiate another refund offer
        application. |

        |B142 |Passenger or ticket number is not in the order |The order number
        in the request does not match the passenger or ticket number |

        |B143 |Involuntary Refund is not applicable to check refundable price,
        please request refund request directly. |Refund Pricing does not provide
        quotes for Involuntary Refund. |

        |B136 |This is not all passengers and routings of the order, please
        kindly check. |The parameter "allPaxOfOrder" is 1, but part of the
        ticket information is missing from the pnrList. |

        |B146 |Order#[Order number] is not applicable for refund. |The order in
        the request is not a ticket issuance or change order and cannot be
        requested for a refund. |

        |B140 |Refund is not applicable for ticket number [ticket number] |The
        ticket in the application is found to have a status of USED for all
        segments after the ticket is extracted, and it is not allowed to
        initiate a refund offer request again. |

        |B147 |Ticket(s) [ticket number] is No-show, refund is not applicable.
        |The ticket in the application has exceeded the No-show time limit and
        no refunds are allowed. |

        |B145 |Passenger(s) must request to refund same routing for one time. If
        routing is varies, please request per passenger. |In the case of
        multiple passengers, the itineraries for which refunds are requested
        must be the same. If the itineraries are not identical, the itinerary
        must be as requested by the passenger |

        |B148 |UploadFileId is not exist. |The Upload Filed ID in the request
        does not exist |

        |B150 |This order was changed, please kindly use change order number.
        |The order number specified in the request is the original order, and
        the passenger+segment specified in the PnrList already has a change
        order |

        |B152 |pnrList information is not same as order, please kindly check.
        |In the request, the journey of the order number and the information of
        the pnrList do not match |

        |B166 |Please request refund for whole routings of the ticket(s). |For
        some GDS orders, the system rules do not allow partial refund, please
        re-try by selecting the whole journey|

        |B168 |Ticket is not applicable to check refund pricing, please call
        refund request directly. |In the request, if the ticket has been
        confirmed and reissued, the rules could not be applied automatically and
        please raise Refund Request directly|

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
                        tag for all passengers，0-No，1-Yes。If the value is “1”,
                        system will check whether pnrlist includes all
                        passengers.
                    orderNum:
                      type: string
                      description: order number
                    refundType:
                      type: integer
                      description: Refund Type：0-Voluntary, 1-Involuntary
                    refundReason:
                      type: string
                      description: >-
                        Refund reason：0-Personal Reason, 1-Illness Reason,
                        2-Schedule Change Reason, 3-Crisis Reason， 4-Visa
                        Refusal
                    uploadedFileIds:
                      type: array
                      items:
                        type: string
                      description: File ID, At most 99 files are supported.
                    pnrList:
                      type: array
                      items:
                        type: object
                        properties:
                          segmentNo:
                            type: integer
                            description: segment sequence
                            nullable: true
                          departure:
                            type: string
                            description: departure airport
                          arrival:
                            type: string
                            description: arrival airport
                          flightNum:
                            type: string
                            description: flight number
                          cabinClass:
                            type: string
                            description: cabin code
                          bookingCode:
                            type: string
                            description: booking code
                          pnr:
                            type: string
                            description: PNR
                          airPnr:
                            type: string
                            description: airlines PNR
                          ticketNums:
                            type: array
                            items:
                              type: object
                              properties:
                                ticketNum:
                                  type: string
                                  description: ticket number
                                lastName:
                                  type: string
                                  description: last name
                                firstName:
                                  type: string
                                  description: first name
                                cardType:
                                  type: string
                                  description: ID type
                                cardNum:
                                  type: string
                                  description: ID number
                                birthday:
                                  type: string
                                  description: date of birth，format[YYYY-MM-DD]
                                sex:
                                  type: string
                                  description: sex
                              x-apifox-orders:
                                - ticketNum
                                - lastName
                                - firstName
                                - cardType
                                - cardNum
                                - birthday
                                - sex
                              required:
                                - lastName
                                - firstName
                                - birthday
                                - sex
                              x-apifox-ignore-properties: []
                            description: passengers and ticket numbers
                        x-apifox-orders:
                          - segmentNo
                          - departure
                          - arrival
                          - flightNum
                          - cabinClass
                          - bookingCode
                          - pnr
                          - airPnr
                          - ticketNums
                        required:
                          - departure
                          - arrival
                          - flightNum
                          - cabinClass
                          - bookingCode
                          - ticketNums
                        x-apifox-ignore-properties: []
                      description: PNR list and ticket number list.
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
                    - orderNum
                    - refundType
                    - refundReason
                    - uploadedFileIds
                    - pnrList
                    - canceledReservationBeforeDeparture
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HWFEK9VTAA7YBBQWKZSDYWD5
                - data
              x-apifox-refs:
                01HWFEK9VTAA7YBBQWKZSDYWD5:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: ''
                sign: ''
              data:
                allPaxOfOrder: 0
                canceledReservationBeforeDeparture: 0
                refundReason: 2
                refundType: '1'
                uploadedFileIds:
                  - 42cf3947df03da6ce1555729c11745eb
                orderNum: '916783592892089401'
                pnrList:
                  - arrival: SEA
                    bookingCode: string
                    cabinClass: string
                    departure: LAX
                    flightNum: DL1473
                    segmentNo: 1
                    ticketNums:
                      - birthday: '2003-05-11'
                        cardNum: string
                        cardType: string
                        firstName: Joshua
                        pnr: AB8SED
                        airPnr: AB8SED
                        lastName: Perez
                        sex: M
                        ticketNum: '123456'
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
                      refundPriceId:
                        type: string
                        description: "refund\_price\_ID；It\_will\_be\_valid\_only\_for\_2\_hours."
                      refundPricingStatus:
                        type: string
                        description: >-
                          refund status： 1-Refund Pricing and Supplier
                          Pricing，2-Refund Priced， 3-Canceled
                      orderNum:
                        type: string
                        description: PKFARE order number
                      lastComfirmTime:
                        type: string
                        description: >-
                          last mintue to confirm refund; YYYY-MM-DD HH:MM
                          (UTC+0)
                      passengerPriceList:
                        type: array
                        items:
                          type: object
                          properties:
                            lastName:
                              type: string
                              description: last name
                            firstName:
                              type: string
                              description: first name
                            cardType:
                              type: string
                              description: identification type
                            cardNum:
                              type: string
                              description: ID number
                            sex:
                              type: string
                              description: Gender, including M for male, F for female
                            birthday:
                              type: string
                              description: Date of birth
                            segmentList:
                              type: array
                              items:
                                type: object
                                properties:
                                  segmentNo:
                                    type: integer
                                    description: segment sequence
                                  departure:
                                    type: string
                                    description: departure airport
                                  arrival:
                                    type: string
                                    description: arrival airport
                                  flightNum:
                                    type: string
                                    description: flight number
                                  cabinClass:
                                    type: string
                                    description: cabin class
                                  bookingCode:
                                    type: string
                                    description: booking code
                                  pnr:
                                    type: string
                                    description: PNR
                                  airPnr:
                                    type: string
                                    description: airlines PNR
                                  ticketNum:
                                    type: string
                                    description: ticket number
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
                              description: segment information
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
                                    description: paid amount
                                  usedAmount:
                                    type: number
                                    description: used amount
                                  nonRefundableAmount:
                                    type: number
                                    description: >-
                                      non-refundable amount（Includes airline
                                      penalties, non-refundable taxes, and
                                      supplier refund service fees）
                                  refundServiceFee:
                                    type: number
                                    description: refund service fees（PKFARE）
                                  refundAmount:
                                    type: number
                                    description: refundable amount
                                  formOfPayment:
                                    type: string
                                    description: >-
                                      payment method：Depends on payment method，
                                      Airline voucher， Depends on refund result，
                                      EMD
                                required:
                                  - currency
                                  - paidAmount
                                  - usedAmount
                                  - nonRefundableAmount
                                  - refundServiceFee
                                  - refundAmount
                                  - formOfPayment
                                x-apifox-orders:
                                  - currency
                                  - paidAmount
                                  - usedAmount
                                  - nonRefundableAmount
                                  - refundServiceFee
                                  - refundAmount
                                  - formOfPayment
                                x-apifox-ignore-properties: []
                          required:
                            - lastName
                            - firstName
                            - sex
                            - birthday
                            - segmentList
                          x-apifox-orders:
                            - lastName
                            - firstName
                            - cardType
                            - cardNum
                            - sex
                            - birthday
                            - segmentList
                            - solutions
                          x-apifox-ignore-properties: []
                        description: >-
                          the flight segments that are refunded and price
                          information
                      refundType:
                        type: integer
                        description: refund type：0-Voluntary, 1-Involuntary -
                      refundReason:
                        type: integer
                        description: >-
                          reasons for refund：0-Personal Reason, 1-Illness
                          Reason, 2-Schedule Change Reason, 3-Crisis Reason，
                          4-Visa Refusal
                      needUploadFileId:
                        type: integer
                        description: >-
                          When submit refund request, sometimes the supporting
                          documents are needed, including passport photo and so
                          on; 0-no need; 1-need
                    required:
                      - refundPriceId
                      - refundPricingStatus
                      - orderNum
                      - passengerPriceList
                      - refundType
                      - refundReason
                      - needUploadFileId
                    x-apifox-orders:
                      - refundPriceId
                      - refundPricingStatus
                      - orderNum
                      - lastComfirmTime
                      - passengerPriceList
                      - refundType
                      - refundReason
                      - needUploadFileId
                    description: >-
                      The returned data, this parameter is not empty only when
                      the error code returns "0"
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - warningMsg
                  - data
                x-apifox-ignore-properties: []
              example:
                data:
                  lastConfirmTime: '2024-04-27 11:24:10'
                  merchantFee: 0
                  needUploadFileId: 0
                  orderNum: '917138447433426701'
                  passengerPriceList:
                    - birthday: '1981-06-19'
                      cardType: ''
                      firstName: KIM
                      lastName: JUNGWOOK
                      segmentList:
                        - airPnr: LZPIZS
                          arrival: TAG
                          bookingCode: H
                          cabinClass: ECONOMY
                          departure: PUS
                          flightNum: 7C2151
                          pnr: LZPIZS
                          segmentNo: 1
                          ticketNum: '8065401551090'
                      sex: M
                      solutions:
                        - currency: USD
                          formOfPayment: Depends on payment method
                          nonRefundableAmount: 0
                          paidAmount: 86.24
                          refundAmount: 9.02
                          refundServiceFee: 8
                          usedAmount: 69.22
                    - birthday: '2020-06-26'
                      cardType: ''
                      firstName: KIM
                      lastName: JINSEO
                      segmentList:
                        - airPnr: LZPIZS
                          arrival: TAG
                          bookingCode: H
                          cabinClass: ECONOMY
                          departure: PUS
                          flightNum: 7C2151
                          pnr: LZPIZS
                          segmentNo: 1
                          ticketNum: '8065401551092'
                      sex: M
                      solutions:
                        - currency: USD
                          formOfPayment: Depends on payment method
                          nonRefundableAmount: 0
                          paidAmount: 86.24
                          refundAmount: 9.02
                          refundServiceFee: 8
                          usedAmount: 69.22
                    - birthday: '2016-06-27'
                      cardType: ''
                      firstName: KIM
                      lastName: RIAN
                      segmentList:
                        - airPnr: LZPIZS
                          arrival: TAG
                          bookingCode: H
                          cabinClass: ECONOMY
                          departure: PUS
                          flightNum: 7C2151
                          pnr: LZPIZS
                          segmentNo: 1
                          ticketNum: '8065401546696'
                      sex: F
                      solutions:
                        - currency: USD
                          formOfPayment: Depends on payment method
                          nonRefundableAmount: 0
                          paidAmount: 86.24
                          refundAmount: 9.02
                          refundServiceFee: 8
                          usedAmount: 69.22
                    - birthday: '1982-11-30'
                      cardType: ''
                      firstName: LEE
                      lastName: SUKKYOUNG
                      segmentList:
                        - airPnr: LZPIZS
                          arrival: TAG
                          bookingCode: H
                          cabinClass: ECONOMY
                          departure: PUS
                          flightNum: 7C2151
                          pnr: LZPIZS
                          segmentNo: 1
                          ticketNum: '8065401546695'
                      sex: F
                      solutions:
                        - currency: USD
                          formOfPayment: Depends on payment method
                          nonRefundableAmount: 0
                          paidAmount: 86.24
                          refundAmount: 9.02
                          refundServiceFee: 8
                          usedAmount: 69.22
                  refundPriceId: '17142098504554584'
                  refundPricingStatus: refund_priced
                  refundReason: 0
                  refundType: 0
                errorCode: '0'
                errorMsg: ok
                success: true
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
              example:
                errorCode: B037
                errorMsg: 'Order is not exists. OrderNum: 916783592892089401'
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Refund APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469941-run
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