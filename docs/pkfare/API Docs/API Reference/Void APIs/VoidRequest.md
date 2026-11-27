# VoidRequest

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/voiding/v2:
    post:
      summary: VoidRequest
      deprecated: false
      description: >
        ### Function Description


        Through VoidRequest API, users could apply for voiding tickets after
        tickets are issued. Passengers that are included in the order are
        allowed to void ticket if void service time is available.  Please refer
        to void service time that is provided in `TicketingNumPush_V2` API.



        `note`VoidRequest_V2 API has different structure with
        VoidRequest，VoidRequest_V2 API adds passenger name and passenger
        sex，while removes passenger card number and card type。


        ### Error Code List


        | errorCode |
        errorMsg                                                     |
        Description                                                  |

        | --------- |
        ------------------------------------------------------------ |
        ------------------------------------------------------------ |

        | 0         |
        ok                                                           | request
        has been processed successfully                      |

        | S001      | System
        error                                                 | system
        error                                                 |

        | P001      |
        -                                                            | wrong
        parameter                                              |

        | P002      | XXXXX is
        missing.                                            | parameter is
        missing                                         |

        | P006      | Invalid
        parameter.                                           | wrong
        parameter                                              |

        | B002      | Partner is not
        exists                                        | PartnerID does not
        exist.                                    |

        | B003      | Illegal
        sign                                                 | Illegal sign.
        Please check your signature.                   |

        | B009      | order status
        invalid                                         | order status is
        invalid                                      |

        | B010      | order not
        exist                                              | order number does
        not exist                                  |

        | B048      | Invaild
        buyer                                                | buyer does not
        match                                         |

        | V001      | Illegal void
        time                                            | the time limit for
        voiding tickets has been exceeded          |

        | V002      | passenger(s) not allowed to void. Origin order has no ADT
        remain | passenger(s) not allowed to void. Origin order has no ADT
        remain |

        | O001      | passenger does not match the
        order                           | passenger does not match the
        order                           |

        | O002      | some passengers submitted other after sale requests, so
        failure to submit void request. | some passengers submitted other after
        sale requests, so failure to submit void request. |

        | O003      | the new or original journey exists unaccompanied
        minor.      | the new or original journey contains unaccompanied
        minor.      |


        ### Sex


        | Name | Description |

        | ---- | ----------- |

        | M    | Male        |

        | F    | Female      |
      tags:
        - API Reference/Void APIs
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
                VoidRequest:
                  type: object
                  properties:
                    passenger:
                      type: array
                      items:
                        type: string
                      description: >-
                        passengers that request to void. Please make sure that
                        void service time is available
                    orderNum:
                      type: string
                      description: '[PKFARE] order Number'
                  x-apifox-orders:
                    - passenger
                    - orderNum
                  required:
                    - passenger
                    - orderNum
                  x-apifox-ignore-properties: []
              x-apifox-orders:
                - 01HYHN80F2J78ZFF09YGKRPMD4
                - VoidRequest
              required:
                - Authentication
                - VoidRequest
              x-apifox-refs:
                01HYHN80F2J78ZFF09YGKRPMD4:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: '{{sign}}'
                partnerId: '{{partnerId}}'
              voidRequest:
                passengers:
                  - lastName: WONG
                    firstName: LEONB
                    birthday: '1990-01-01'
                    sex: M
                orderNum: '915656792701128401'
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
                    description: error number
                  errorMsg:
                    type: string
                    description: error message
                  data:
                    type: object
                    properties:
                      orderNum:
                        type: string
                        description: '[PKFARE] order Number'
                      voidOrderNum:
                        type: string
                        description: >-
                          [PKFARE] void order number (after a void request is
                          submitted, a void order would be generated in PKFARE
                          system)
                      passengers:
                        type: array
                        items:
                          type: object
                          properties:
                            lastName:
                              type: string
                              description: first name
                            firstName:
                              type: string
                              description: last name
                            birthday:
                              type: string
                              description: "birthday [yyyy-mm-dd]\t"
                            sex:
                              type: string
                              description: "Sex，M-Male，F-Female\t"
                          x-apifox-orders:
                            - lastName
                            - firstName
                            - birthday
                            - sex
                          x-apifox-ignore-properties: []
                        description: "passengers\_that\_request\_to\_void."
                    required:
                      - orderNum
                      - voidOrderNum
                      - passengers
                    x-apifox-orders:
                      - orderNum
                      - voidOrderNum
                      - passengers
                    description: return data. Not empty when error code is ‘0’
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-ignore-properties: []
              example:
                errorCode: '0'
                errorMsg: ok
                data:
                  orderNum: '915634179313900301'
                  voidOrderNum: '915634179313900302'
                  passengers:
                    - lastName: WONG
                      firstName: LEONB
                      birthday: '1990-01-01'
                      sex: M
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
                    description: error number
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
                errorCode: B054
                errorMsg: Void request is offline, please contact PKFARE.
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Void APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469949-run
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