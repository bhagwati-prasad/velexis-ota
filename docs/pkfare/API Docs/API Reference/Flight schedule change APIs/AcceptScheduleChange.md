# AcceptScheduleChange

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/scheduleChange/acceptScheduleChange:
    post:
      summary: AcceptScheduleChange
      deprecated: false
      description: >+
        ## Function Description

        Through AcceptScheduleChange API, you are able to accept a the schedule
        change by passenger. Sensitivity Level in the schedule change message
        indicated whether it required to be accept or not. Airline may cancel
        the seat due to passenger does not accept schedule change. It is highly
        appreciated to use this API to accept schedule change.



        ##  Error Code List

        |   errorCode       |   errorMsg                        |   
        Description                             |

        |----|----|----|

        |   0               |   ok                                            
        |   Request has been processed successfully.                       |

        |   S001            |   System error                                  
        |   System error.                          |

        |   P001            |   xxx is illegal                          |  
        Request parameter is illegal, xxx will display request
        parameter           |

        |   B002            |   Partner is not
        exists                                 |   Partner does not
        exist.                    |

        |   B003            |   Illegal sign                                  
        |   Illegal sign.               |

        |   B037            |    Order is not exists.       |   Order does not
        exist.                 |

        |   B048            |    Invalid buyer       |   Buyer is
        invalid.                 |

        |   B130            |    Message is not exist.       |   Schedule change
        message does not exist.                 |

        |   B131            |    Accept reject, duplicated to accept schedule
        change.       |   One passenger is allowed to accept once, if the
        passenger accept again, this message will be returned.                 |

        |   B132            |    Accept reject, wrong passenger indicated.      
        |   The passenger is not in the order, please kindly
        check.                 |

        |   B133            |    Accept reject, flight has departured.       |  
        After flight is departured, system will not allow to
        accept.                 |

        |B186|The flight change has been confirmed and is already being
        processed. Please kindly contact online service for help.|The flight
        change has been confirmed and is already being processed.|

        |B187|Infant confirmation cannot be done separately.|Infant confirmation
        cannot be done separately.|


        ## Type of Travel Document

        | Enum   | Description   |

        |----|----|

        |  P       |  Passport    |

        |  N       |  Chinese Identity    |

        |  O       | Others    |


        ## Passenger Type

        | Enum   | Description   |

        |----|----|

        |  ADT     |  adult         |

        |  CHD     |  children[2-12 years old]  |


        ## Gender

        | Enum   | Description   |

        |----|----|

        |  M       |  Male    |

        |  F       |  Female    |

      tags:
        - API Reference/Flight schedule change APIs
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
                    messageId:
                      type: string
                      description: "PKFARE message ID. You can get specific message by indicating the messageId\t"
                    email:
                      type: string
                      description: "Email address for contacting after we completed accpeting schedule change procedure\t"
                    passengers:
                      type: array
                      items:
                        type: object
                        properties:
                          lastName:
                            type: string
                            description: "Last name\t"
                          firstName:
                            type: string
                            description: "First name\t"
                          birthday:
                            type: string
                            description: "Date of birth [yyyy-mm-dd]\t"
                          sex:
                            type: string
                            description: 'Gender, M - male, F - Female. '
                          psgType:
                            type: string
                            description: 'ADT - adult, CHD - child , INF-Infant. '
                          cardType:
                            type: string
                            description: >-
                              Travel document type ,[P-Passport,N-Chinese
                              Identity , O-Others]
                          cardNum:
                            type: string
                            description: "Travel document number\t"
                          cardExpiredDate:
                            type: string
                            description: "Nationality of the passenger, 2 letters country code\t"
                          nationality:
                            type: string
                            description: "Nationality of the passenger, 2 letters country code\t"
                        x-apifox-orders:
                          - lastName
                          - firstName
                          - birthday
                          - sex
                          - psgType
                          - cardType
                          - cardNum
                          - cardExpiredDate
                          - nationality
                        required:
                          - lastName
                          - firstName
                          - birthday
                          - sex
                          - psgType
                          - nationality
                        x-apifox-ignore-properties: []
                      description: "Passenger information who accept the schedule change\t"
                  required:
                    - messageId
                    - email
                    - passengers
                  x-apifox-orders:
                    - messageId
                    - email
                    - passengers
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HWA9HG6678328RRZ9FDXHS20
                - data
              x-apifox-refs:
                01HWA9HG6678328RRZ9FDXHS20:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: '{{partnerId}}'
                sign: '{{sign}}'
              data:
                messageId: '2944666'
                email: jaylee.li@pkfare.com
                passengers:
                  - birthday: '2003-04-20'
                    firstName: CHRISTOPHER
                    lastName: KING
                    nationality: US
                    psgType: ADT
                    sex: M
                    cardType: P
                    cardNum: P76541234
                    cardExpiredDate: '2025-05-10'
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
                    description: Error Code
                  errorMsg:
                    type: string
                    description: "Error Message\t"
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
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
                    errorCode: P001
                    errorMsg: Invalid authentication.
          headers: {}
          x-apifox-name: Success
      security: []
      x-apifox-folder: API Reference/Flight schedule change APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469940-run
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