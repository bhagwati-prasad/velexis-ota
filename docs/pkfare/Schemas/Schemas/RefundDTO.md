# RefundDTO

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths: {}
components:
  schemas:
    RefundDTO:
      type: object
      properties:
        allowed:
          type: boolean
          description: 是否可退票
        description:
          type: string
          description: 描述
        penaltyAmount:
          type: number
          description: 退票费用
        penaltyCurrency:
          type: string
          description: 退票费用币种
      title: RefundDTO
      x-apifox-orders:
        - allowed
        - description
        - penaltyAmount
        - penaltyCurrency
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```