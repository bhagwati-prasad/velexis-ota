# ModifyOrderStatus

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/buyer/fake/modifyOrder:
    post:
      summary: ModifyOrderStatus
      deprecated: false
      description: >
        ## Function Description


        Using the ModifyOrderStatus API, users can set order status as 'ISSED'
        for flight orders if the current order status is 'Paid, to be issued' 
        in **sandbox environment**.



        :::caution


        #### You can only make ticket issuance for flight orders in the test
        environment. It does not support ticket issuance modification for the
        real orders.


        :::


        ## Target Reader


        The ModifyOrderStatus interface documentation is intended for web
        developers, maintenance and managers with some web development skills,
        an understanding of one of the major development languages such as Java,
        Python, ASP.NET, PHP, Node.js, and a basic knowledge of HTTP network
        protocols.



        ## URLs



        |Version|Sandbox Invoking Address|Update|

        |:----|:----|:----|

        |ModifyOrderStatus 
        (jsonformat)|https://api.pkfare.com/json/buyer/fake/modifyOrder| |
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
                fakeModifyOrder:
                  type: object
                  properties:
                    orderNum:
                      type: string
                      description: Fake order number
                  required:
                    - orderNum
                  x-apifox-orders:
                    - orderNum
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - fakeModifyOrder
              x-apifox-orders:
                - 01HYWA6JNM3TBKHBGPNN61X92P
                - fakeModifyOrder
              x-apifox-refs:
                01HYWA6JNM3TBKHBGPNN61X92P:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: '{{partnerId}}'
                sign: '{{sign}}'
              fakeModifyOrder:
                orderNum: '917167813545685601'
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
                    errorCode: B034
                    errorMsg: Order status is invalid
          headers: {}
          x-apifox-name: Success
      security: []
      x-apifox-folder: API Reference/Air ticket booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469955-run
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