# CancelAncillaryOrder

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/cancelAncillaryOrder:
    post:
      summary: CancelAncillaryOrder
      deprecated: false
      description: >-
        ##  Function
          You can cancel the ancillary order through CancelAncillaryOrder API before AncillaryTicketing.
         

        ##  Error Code List

        |errorCode|errorMsg|

        |:----|:----|

        |0 |ok |

        |B001 |Business exception |

        |B002 |Partner does not exist. |

        |B003 |Illegal sign. |

        |P006 |Invalid parameter. |

        |B182 |Invalid AncillaryOrderNum |

        |B183 |The ancillary order has been canceled and please don't make
        duplicate cancellations. |

        |B184 |Cancel failed due to invalid ancillary status |
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
                cancel:
                  type: object
                  properties:
                    ancillaryOrderNum:
                      type: string
                      description: "Ancillary order number returned from AncillaryBooking\t"
                  required:
                    - ancillaryOrderNum
                  x-apifox-orders:
                    - ancillaryOrderNum
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - cancel
              x-apifox-orders:
                - 01HVREYREY6J45NSP1R6K5XZ7V
                - cancel
              x-apifox-refs:
                01HVREYREY6J45NSP1R6K5XZ7V:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: '{{sign}}'
                partnerId: '{{partnerId}}'
              cancel:
                ancillaryOrderNum: '917049521951368303'
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
                    description: "error code\t"
                  errorMsg:
                    type: string
                    description: "error message\t"
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - 01HVREZWAF6X058D295ZZ1V4YT
                  - errorCode
                  - errorMsg
                x-apifox-ignore-properties: []
              examples:
                '1':
                  summary: Success
                  value:
                    errorCode: '0'
                    errorMsg: ok
                '2':
                  summary: Error
                  value:
                    errorCode: B182
                    errorMsg: Invalid AncillaryOrderNum
          headers: {}
          x-apifox-name: Success
      security: []
      x-apifox-folder: API Reference/Ancillary booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469933-run
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