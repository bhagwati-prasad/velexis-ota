# AncillaryTicketing

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/ancillaryTicketingV2:
    post:
      summary: AncillaryTicketing
      deprecated: false
      description: >-
        ## Function
          Through AncillaryTicketing API, you can request PKFARE to deduct ancillary order payment (currently only Prepay is supported). 
        It’s not allowed to pay multiple ancillary orders with the same
        ancillary product type at the same time.

        After the payment, the status of the ancillary order will turn to be
        issued.



        ## Error Code List


        |errorCode|errorMsg|

        |:----|:----|

        |0 |ok |

        |S001 |System error |

        |P001 |ancillaryOrderNum is illegal |

        |B002 |Partner is not exists |

        |B003 |Illegal sign |

        |B009 |Order status is invalid |

        |B010 |Order number not exist |

        |B022 |Ticketing failed |

        |B024 |Order has been paid |

        |B082 |It's not allowed to pay multiple ancillary orders with the same
        ancillary type at the same time. |
      tags:
        - API Reference/Ancillary booking APIs
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
                ticketing:
                  type: object
                  properties:
                    ancillaryOrderNum:
                      type: array
                      items:
                        type: string
                      description: >-
                        PKFARE ancillary order number, which is returned from
                        AncillaryBooking； only one oder number could be Ticketed
                        each time
                  required:
                    - ancillaryOrderNum
                  x-apifox-orders:
                    - ancillaryOrderNum
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - ticketing
              x-apifox-orders:
                - 01HVREYREY6J45NSP1R6K5XZ7V
                - ticketing
              x-apifox-refs:
                01HVREYREY6J45NSP1R6K5XZ7V:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: '{{sign}}'
                partnerId: '{{partnerId}}'
              ticketing:
                ancillaryOrderNum:
                  - '917739227145652402'
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
                    description: "error msg\t"
                  data:
                    type: object
                    properties:
                      ancillaryOrderNum:
                        type: string
                        description: "PKFARE ancillary order number\t"
                      orderAmount:
                        type: integer
                        description: "ancillary order amount\t"
                      transactionExpense:
                        type: integer
                        description: "merchant fee\t"
                      payAmount:
                        type: integer
                        description: "actual payment amount\t"
                    x-apifox-orders:
                      - ancillaryOrderNum
                      - orderAmount
                      - transactionExpense
                      - payAmount
                    description: "Only if the errorCode returns \"0\", returned data would not be null.\t"
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-ignore-properties: []
              example:
                errorCode: '0'
                errorMsg: ok
                data:
                  ancillaryOrderNum: '917134367036776903'
                  orderAmount: 21
                  transactionExpense: 0
                  payAmount: 21
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
                  errorMsg:
                    type: string
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                x-apifox-ignore-properties: []
              example:
                errorCode: P001
                errorMsg: ancillaryOrderNum is illegal.
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Ancillary booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469935-run
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