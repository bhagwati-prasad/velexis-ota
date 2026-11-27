# CancelOrder

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/cancel:
    post:
      summary: CancelOrder
      deprecated: false
      description: >
        ##  Function


        Through Cancel API, users can cancel orders and PNRs generated in GDS by
        PKFARE. Cancel API is used for canceling orders before ticketing.



        ##  Versioning


        |Version|Sandbox Invoking Address|Update|

        |:----|:----|:----|

        |cancelOrder|[https://api.pkfare.com/cancel](https://api.pkfare.com/cancel)|   
        |

        |cancelOrder (json format)|https://api.pkfare.com/json/cancel| Support
        json-formatted requesting structure  |





        ## Error Code List


        |errorCode|errorMsg|Description|

        |:----|:----|:----|

        |0|ok|request has been processed successfully|

        |S001|System error|system error|

        |P001|-|wrong parameter|

        |B002|Partner is not exists|partnerID does not exist|

        |B003|Illegal sign|illegal sign. Please check your signature|

        |B009|Order status is invalid|order status is not to_be_paid|

        |B010|Order number not exist|order number does not exist|

        |B037|Order is not exists. OrderNum:XXX|Order is not exists|

        |B041|The order has been cancelled|Order has been canceled|
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
                cancel:
                  type: object
                  properties:
                    orderNum:
                      type: string
                      description: orderNum returned from PreciseBooking
                    virtualPnr:
                      type: string
                      description: PNR
                  required:
                    - orderNum
                  x-apifox-orders:
                    - orderNum
                    - virtualPnr
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - cancel
              x-apifox-orders:
                - 01HVN92X6J73ZZTASN8QP3CQ1F
                - cancel
              x-apifox-refs:
                01HVN92X6J73ZZTASN8QP3CQ1F:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: '{{partnerId}}'
                sign: '{{sign}}'
              cancel:
                orderNum: '917132752968703001'
                virtualPnr: WC7JP4
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
                    x-apifox-mock: error code
                  errorMsg:
                    type: string
                    x-apifox-mock: >-
                      error message. If return to "OK", order cancels
                      successfully
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                x-apifox-ignore-properties: []
              example:
                errorCode: '0'
                errorMsg: OK
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
                    x-apifox-mock: error code
                  errorMsg:
                    type: string
                    x-apifox-mock: >-
                      error message. If return to "OK", order cancels
                      successfully
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                x-apifox-ignore-properties: []
              example:
                errorCode: B037
                errorMsg: 'Order is not exists. OrderNum: 91713275296803001'
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Air ticket booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469930-run
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