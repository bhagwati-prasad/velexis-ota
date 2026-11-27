# AcknowledgeScheduleChange

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/scheduleChange/acknowledge:
    post:
      summary: AcknowledgeScheduleChange
      deprecated: false
      description: >-
        ###  Function Description

        Through AcknowledgeScheduleChange API, you are able to remove a the
        schedule change message, which you do NOT want to get it from
        GetScheduleChange API.


        #### Error Code List

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

        |   B037            |    Order is not exist.       |   Order does not
        exist.                 |

        |   B048            |    Invalid buyer       |   Buyer is
        invalid.                 |

        |   B130            |    Message is not exist.       |   Schedule change
        message does not exist.                 |
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
                      description: >-
                        PKFARE message ID. You can get specific message by
                        indicating the messageId
                  required:
                    - messageId
                  x-apifox-orders:
                    - messageId
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HW8A0BQAA92A1AFAAKD54Z4B
                - data
              x-apifox-refs:
                01HW8A0BQAA92A1AFAAKD54Z4B:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example: ''
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
                    description: Error Message
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
                    errorCode: B130
                    errorMsg: Message is not exist
          headers: {}
          x-apifox-name: Success
      security: []
      x-apifox-folder: API Reference/Flight schedule change APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469939-run
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