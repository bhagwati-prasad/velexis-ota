# ChangeRepricePush

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /ChangeRepricePush:
    post:
      summary: ChangeRepricePush
      deprecated: false
      description: ''
      tags:
        - API Reference/Change APIs
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                orderNum:
                  type: string
                  description: '[PKFARE] order number'
                priceStatus:
                  type: string
                  description: Price status, it contains:PRICED
                remark:
                  type: string
                  description: Remark
                solution:
                  type: object
                  properties:
                    currency:
                      type: string
                    changeServiceFee:
                      type: integer
                    adtAdditionalFare:
                      type: integer
                    adtAdditionalTax:
                      type: integer
                    adtChangeFee:
                      type: integer
                    adtChangeAmount:
                      type: integer
                    chdAdditionalFare:
                      type: integer
                    chdAdditionalTax:
                      type: integer
                    chdChangeFee:
                      type: integer
                    chdChangeAmount:
                      type: integer
                    infAdditionalFare:
                      type: integer
                    infAdditionalTax:
                      type: integer
                    infChangeFee:
                      type: integer
                    infChangeAmount:
                      type: integer
                    totalChangeAmount:
                      type: integer
                  required:
                    - currency
                    - changeServiceFee
                    - adtAdditionalFare
                    - adtAdditionalTax
                    - adtChangeFee
                    - adtChangeAmount
                  x-apifox-orders:
                    - currency
                    - changeServiceFee
                    - adtAdditionalFare
                    - adtAdditionalTax
                    - adtChangeFee
                    - adtChangeAmount
                    - chdAdditionalFare
                    - chdAdditionalTax
                    - chdChangeFee
                    - chdChangeAmount
                    - infAdditionalFare
                    - infAdditionalTax
                    - infChangeFee
                    - infChangeAmount
                    - totalChangeAmount
              required:
                - orderNum
                - priceStatus
                - solution
              x-apifox-orders:
                - orderNum
                - priceStatus
                - remark
                - solution
            example:
              orderNum: '917070354395357001'
              priceStatus: PRICED
              remark: xxxx
              solution:
                currency: CNY
                changeServiceFee: 1574
                adtAdditionalFare: 291
                adtAdditionalTax: 0
                adtChangeFee: 0
                adtChangeAmount: 0
                chdAdditionalFare: 0
                chdAdditionalTax: 0
                chdChangeFee: 0
                chdChangeAmount: 0
                infAdditionalFare: 0
                infAdditionalTax: 0
                infChangeFee: 0
                infChangeAmount: 0
                totalChangeAmount: 1865
                merchantFee: 0
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
                  errorMsg:
                    type: string
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                required:
                  - errorCode
                  - errorMsg
          headers: {}
          x-apifox-name: Success
      security: []
      x-apifox-folder: API Reference/Change APIs
      x-apifox-status: developing
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470725-run
components:
  schemas: {}
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```