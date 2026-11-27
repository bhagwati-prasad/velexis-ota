# ChangeDTO

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
    ChangeDTO:
      type: object
      properties:
        allowed:
          type: boolean
          description: 是否可改期
        description:
          type: string
          description: 描述
        penaltyAmount:
          type: number
          description: 改期费用
        penaltyCurrency:
          type: string
          description: 改期费用币种
      title: ChangeDTO
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