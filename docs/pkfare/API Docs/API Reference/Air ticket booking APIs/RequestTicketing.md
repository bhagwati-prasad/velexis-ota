# RequestTicketing

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/requestTicketing:
    post:
      summary: RequestTicketing
      deprecated: false
      description: >
        ### Function Description


        Using the TicketingRequest API, users can send ticket issuance reminders
        for flight orders.


        1. You can only prompt ticket issuance for flight orders. It does not
        support ticket issuance reminders for ancillary orders.

        2. It supports simultaneous ticket issuance reminders for multiple
        orders. The same order can only be prompted once within a 10-minute
        period.


        ## Target Reader


        The RequestTicketing interface documentation is intended for web
        developers, maintenance and managers with some web development skills,
        an understanding of one of the major development languages such as Java,
        Python, ASP.NET, PHP, Node.js, and a basic knowledge of HTTP network
        protocols.


        ## URLs



        |Version|Sandbox Invoking Address|Update|

        |:----|:----|:----|

        |requestTicketing|https://api.pkfare.com/requestTicketing| |

        |requestTicketing(json
        format)|https://api.pkfare.com/json/requestTicketing|Support json
        formatted requesting structure |

        ## Error Code List


        |erroCode|erroMsg|Description|

        |:----|:----|:----|

        |0|ok|Request has been processed successfully.|

        |S001|System error|System error|

        |S002|timeout|Request timeout|

        |P001|-|Parameter is illegal|

        |B037|Order is not exists.|Order is not exists.|

        |B179|Duplicate ticketing request within 10 minutes.|Duplicate ticketing
        request for the same order within 10 minutes.|

        |B180|The order status is not issuing.|Only Issuing order can be used in
        this API.|

        |B181|The ticketing reminder list contains more than 100 orders.|The
        ticketing reminder list contains more than 100 orders.|
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
                    issuingOrdersPush:
                      type: array
                      items:
                        type: string
                      description: Ticket issuance reminder order list. PKFARE orders
                  required:
                    - issuingOrdersPush
                  x-apifox-orders:
                    - issuingOrdersPush
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HW7DGFJWE4JW58JQAVXYYJNJ
                - data
              x-apifox-refs:
                01HW7DGFJWE4JW58JQAVXYYJNJ:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: '{{partnerId}}'
                sign: '{{sign}}'
              data:
                issuingOrdersPush:
                  - cillum dolore Ut
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
                    description: error code,refer to Error Code List
                  errorMsg:
                    type: string
                    description: error message
                  data:
                    type: array
                    items:
                      type: object
                      properties:
                        orderNum:
                          type: string
                          description: >-
                            Order numbers for failed ticket issuance orders.
                            【PKFARE】Order Number
                        errorCode:
                          type: string
                          description: >-
                            Error codes for failed ticket issuance orders. error
                            code,refer to Error Code List
                        errorMsg:
                          type: string
                          description: >-
                            Error messages for failed ticket issuance orders.
                            error message,refer to Error Code List
                      x-apifox-orders:
                        - orderNum
                        - errorCode
                        - errorMsg
                      x-apifox-ignore-properties: []
                    description: Showing details of failed ticket issuance orders.
                required:
                  - errorCode
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-ignore-properties: []
              examples:
                '1':
                  summary: >-
                    All orders have been successfully prompted for ticket
                    issuance.
                  value:
                    errorCode: '0'
                    errorMsg: OK
                    data: []
                '2':
                  summary: Some orders failed to be prompted for ticket issuance.
                  value:
                    errorCode: '0'
                    errorMsg: OK
                    data:
                      - orderNum: '9108282828101'
                        errorCode: B179
                        errorMsg: Duplicate ticketing request within 10 minutes.
                      - orderNum: '9108282828101'
                        errorCode: B180
                        errorMsg: Order is not in an unissued state.
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
                    description: error code,refer to Error Code List
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
                errorCode: B002
                errorMsg: Partner does not exist.
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Air ticket booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469937-run
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