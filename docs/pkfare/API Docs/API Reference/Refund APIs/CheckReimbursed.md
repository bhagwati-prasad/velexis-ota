# CheckReimbursed

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/refundReimburse/check:
    post:
      summary: CheckReimbursed
      deprecated: false
      description: >-
        ### Function Description


        Through CheckReimbursed API, you are able to request with a order number
        to check reimbursement status.


        ### Error Code List


        |Error Code|Error Message|Description|

        |:----|:----|:----|

        |0|Ok|Success|

        |P001|xxx is illegal|Request parameter is illegal, xxx will display
        request parameter|

        |B002|Partner is not exists|Partner is not exists.|

        |B003|Illegal sign|Signature is illegal|

        |B048|Invalid buyer|Buyer is invalid, please contact PKFARE account
        manager|

        |S001|System error|System error|

        |B037|Order is not exist|Order is not exist|

        |B141|Order is not a refund order.|Order number in the request is not a
        refund order|
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
                    description: Error Code，0-Success，Others-Failed
                  errorMsg:
                    type: string
                    description: Error Message
                  "warningMsg\t":
                    type: string
                    description: Warning Message
                  data:
                    type: object
                    properties:
                      reimbursedOrderNum:
                        type: string
                        description: PKFARE order number - Refund Order or Void Order
                      reimbursedOrderStatus:
                        type: string
                        description: Order Status：REFUND, REIMBURSED; VOID, REIMBURSED
                      payGate:
                        type: string
                        description: 'Payment gateway: Prepay, Alipay, Voucher'
                      paySerialNum:
                        type: string
                        description: Payment serial number
                      currency:
                        type: string
                        description: Currency
                      "reimbursedAmount\t":
                        type: number
                        description: Reimbursed amount
                      voucherList:
                        type: array
                        items:
                          type: object
                          properties:
                            lastName:
                              type: string
                              description: Last name
                            firstName:
                              type: string
                              description: First Name
                            birthday:
                              type: string
                              description: Birtheay，format[yyyy-mm-dd]
                            sex:
                              type: string
                              description: Gender
                            psgType:
                              type: string
                              description: Passenger Type
                            voucherNumber:
                              type: string
                              description: Voucher number, for payment gateway as voucher
                            voucherCurrency:
                              type: string
                              description: Voucher currency, for payment gateway as voucher
                            voucherAmount:
                              type: number
                              description: Voucher amount, for payment gateway as voucher
                            voucherValidFrom:
                              type: string
                              description: >-
                                Voucher valid date from, for payment gateway as
                                voucher
                            voucherValidEnd:
                              type: string
                              description: >-
                                Voucher valid date to, for payment gateway as
                                voucher
                            useFor:
                              type: array
                              items:
                                type: integer
                              description: >-
                                Voucher usage, for payment gateway as
                                voucher：1-Issue ticket，2-Change
                                ticket，3-Purchase ancillaries product
                            usageLimitation:
                              type: integer
                              description: >-
                                Voucher usage limitaion, for payment gateway as
                                voucher： 0 - Uncertain， 1-Passenger only， 2-No
                                limitation
                          x-apifox-orders:
                            - lastName
                            - firstName
                            - birthday
                            - sex
                            - psgType
                            - voucherNumber
                            - voucherCurrency
                            - voucherAmount
                            - voucherValidFrom
                            - voucherValidEnd
                            - useFor
                            - usageLimitation
                          x-apifox-ignore-properties: []
                        description: >-
                          When payment gateway is voucher, voucher information
                          will return.
                      voucherFileId:
                        type: array
                        items:
                          type: string
                        description: >-
                          When payment gateway is voucher, a file ID may be
                          returned. You can download the file by DownloadFile
                          API.
                    required:
                      - reimbursedOrderNum
                      - reimbursedOrderStatus
                      - currency
                      - "reimbursedAmount\t"
                    x-apifox-orders:
                      - reimbursedOrderNum
                      - reimbursedOrderStatus
                      - payGate
                      - paySerialNum
                      - currency
                      - "reimbursedAmount\t"
                      - voucherList
                      - voucherFileId
                    description: Return data, will not be empty when error code is "0".
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - "warningMsg\t"
                  - data
                x-apifox-ignore-properties: []
              example:
                errorCode: '0'
                errorMsg: ok
                data:
                  reimbursedOrderNum: '916787120452531002'
                  reimbursedOrderStatus: Reimbursed
                  payGate: Voucher
                  currency: USD
                  voucherList:
                    - lastName: YANGABC
                      firstName: TIFFANY
                      birthday: '1990-08-23'
                      sex: F
                      psgType: ADT
                      voucherNumber: '1234567890123'
                      voucherCurrency: THB
                      voucherAmount: 222.22
                      voucherValidFrom: '2023-03-20'
                      voucherValidEnd: '2023-03-22'
                      useFor:
                        - 1
                      usageLimitation: 0
                  voucherFileId:
                    - cc20fde65a836ad3e1555729c11745eb
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
                    description: Error Code，0-Success，Others-Failed
                  errorMsg:
                    type: string
                    description: Error Message
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                x-apifox-ignore-properties: []
              example:
                errorCode: B037
                errorMsg: 'Order is not exists. OrderNum: 916783298501993902'
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Refund APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469945-run
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