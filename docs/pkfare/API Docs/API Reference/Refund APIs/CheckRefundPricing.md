# CheckRefundPricing

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/refundPricing/check:
    post:
      summary: CheckRefundPricing
      deprecated: false
      description: "### Function\nThis API is used through RefundPricingId returned by the RefundPricing interface for the active query of the refund price.\n\n### Error Code List\n|error code |error message |description |\n| :--- | :--- | :--- |\n| 0\t| Ok\t| success| \n|P001\t|xxx is illegal\t|invalid parameters|\n|B002\t|Partner is not exists\t|Partner is not exists|\n|B003\t|Illegal sign\t|Illegal sign|\n|B048\t|Invalid buyer\t|Invalid buyer|\n|B137\t|RefundPricingId is not exist\t|RefundPricingId is not exist|\n|S001\t|System error\t|System error|"
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
                    refundPricingId:
                      type: string
                      description: |
                        refundPricingId that returnd by refundPricing API
                  x-apifox-orders:
                    - refundPricingId
                  required:
                    - refundPricingId
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HWFPXS4XP7315Q7ERKWVD1XW
                - data
              x-apifox-refs:
                01HWFPXS4XP7315Q7ERKWVD1XW:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: ''
                partnerId: ''
              data:
                refundPricingId: '16786982431662414'
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
                        description: refund price ID
                      refundPricingStatus:
                        type: string
                        description: >-
                          refund status： 1-Refund Pricing和Supplier
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
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - warningMsg
                  - data
                x-apifox-ignore-properties: []
              example:
                data:
                  merchantFee: 0
                  needUploadFileId: 0
                  orderNum: '917141251521581901'
                  passengerPriceList:
                    - birthday: '1999-04-22'
                      cardNum: K06065609
                      cardType: P
                      firstName: Hoi Ching
                      lastName: Ng
                      segmentList:
                        - airPnr: 42NN8L
                          arrival: TPE
                          bookingCode: 'N'
                          cabinClass: ECONOMY
                          departure: HKG
                          flightNum: CI924
                          pnr: 42NN8L
                          segmentNo: 1
                          ticketNum: '29770346473'
                        - airPnr: 42NN8L
                          arrival: HKG
                          bookingCode: 'N'
                          cabinClass: ECONOMY
                          departure: TPE
                          flightNum: CI921
                          pnr: 42NN8L
                          segmentNo: 1
                          ticketNum: '29770346473'
                      sex: F
                  refundPriceId: '17142189997610810'
                  refundPricingStatus: refund pricing
                  refundReason: 0
                  refundType: 0
                errorCode: '0'
                errorMsg: ok
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
                errorCode: B137
                errorMsg: RefundPricing is not exist.
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Refund APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469942-run
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