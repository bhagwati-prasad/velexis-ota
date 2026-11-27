# Ticketing

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/ticketing:
    post:
      summary: Ticketing
      deprecated: false
      description: >
        ##  Function


        Through Ticketing API, users can request PKFARE to deduct credits
        (currently only Prepay and Alipay are supported). Ticket numbers would
        be provided by TickeitngNumPush or orderDetail API.


        ##  Versioning


        |Version|Sandbox Invoking Address|Update|

        |:----|:----|:----|

        |ticketing|[https://api.pkfare.com/ticketing](https://api.pkfare.com/ticketing)|   
        |

        |ticketing (json format)|https://api.pkfare.com/json/ticketing| Support
        json-formatted requesting strcuture   |

         *Below is  the most updated version.* 




        ##  Error Code List


        |errorCode|errorMsg|Description|

        |:----|:----|:----|

        |0|ok|request has been processed successfully|

        |S001|System error|system error|

        |P001|-|wrong parameter|

        |B002|Partner is not exists|partnerID does not exist|

        |B003|Illegal sign|illegal sign. Please check your signature|

        |B009|Order status is invalid|order status is invalid|

        |B010|Order number not exist|order number does not exist|

        |B022|Ticketing failed|balance left is not enough to pay the order|

        |B024|Order has been paid|order has already been paid. No need to pay
        again|
      tags:
        - API Reference/Air ticket booking APIs
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                authentication:
                  type: object
                  properties:
                    partnerId:
                      type: string
                    sign:
                      type: string
                  required:
                    - partnerId
                    - sign
                  x-apifox-orders:
                    - partnerId
                    - sign
                ticketing:
                  type: object
                  properties:
                    email:
                      type: string
                      description: email address [to receive schedule-changed notice]
                    name:
                      type: string
                      description: >-
                        contact name, formatted with "last name/first name" or
                        "first name"
                    orderNum:
                      type: string
                      description: '[PKFARE] Order number'
                    telNum:
                      type: string
                      description: contact phone number
                    PNR:
                      type: string
                      description: PNR returned by PreciseBooking
                  required:
                    - orderNum
                  x-apifox-orders:
                    - orderNum
                    - PNR
                    - email
                    - name
                    - telNum
              required:
                - authentication
                - ticketing
              x-apifox-orders:
                - authentication
                - ticketing
            example:
              authentication:
                partnerId: ''
                sign: ''
              ticketing:
                email: jango.wang@pkfare.com
                name: Jango/Wang
                orderNum: '1012674912'
                telNum: '13249073855'
                PNR: KHZ1WU
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
                    description: error code; refer to error code list
                  errorMsg:
                    type: string
                    description: error message
                  data:
                    type: object
                    properties:
                      orderNum:
                        type: string
                        description: order number in PKFARE system
                      orderAmount:
                        type: integer
                        description: order Amount
                      transactionExpense:
                        type: number
                        description: merchant fee
                      payAmount:
                        type: number
                        description: actual payment amount
                    x-apifox-orders:
                      - orderNum
                      - orderAmount
                      - transactionExpense
                      - payAmount
                    description: >-
                      only if the errorCode returns "0", returned data would not
                      be null. Data is in JSON format, which contains three
                      collection objects: solutions, flights, segments
                required:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
              example:
                errorCode: '0'
                errorMsg: ok
                data:
                  orderNum: '1012704540'
                  orderAmount: 2015
                  transactionExpense: 2.02
                  payAmount: 2017.02
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
                    description: error code; refer to error code list
                  errorMsg:
                    type: string
                    description: error message
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
              example:
                errorCode: B037
                errorMsg: 'Order is not exists. OrderNum: 1012674912'
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Air ticket booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469929-run
components:
  schemas: {}
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```