# ConditionsDTO

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
    OtherDTO:
      type: object
      properties:
        available:
          type: boolean
          description: 是否可用
        description:
          type: string
          description: 描述
        serviceName:
          type: string
          description: 服务名称
      title: OtherDTO
      x-apifox-orders:
        - available
        - description
        - serviceName
      x-apifox-folder: ''
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
    ConditionsDTO:
      type: object
      properties:
        change:
          $ref: '#/components/schemas/ChangeDTO'
        other:
          type: array
          description: 其它的服务
          items:
            $ref: '#/components/schemas/OtherDTO'
          refType: OtherDTO
        priorityBoarding:
          type: boolean
          description: 是否可选餐
        refund:
          $ref: '#/components/schemas/RefundDTO'
        seatSelection:
          type: boolean
          description: 是否可选座
      title: ConditionsDTO
      x-apifox-orders:
        - change
        - other
        - priorityBoarding
        - refund
        - seatSelection
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```