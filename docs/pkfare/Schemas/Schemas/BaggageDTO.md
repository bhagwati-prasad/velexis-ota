# BaggageDTO

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
    BaggageDTO:
      type: object
      properties:
        amount:
          type: integer
          format: int32
          description: 行李数量
        segmentIndex:
          type: integer
          format: int32
          description: 航段序号
        size:
          type: string
          description: 行李尺寸
        type:
          type: string
          description: 行李类型:carryon,checked(baggage)
        weight:
          type: integer
          format: int32
          description: 行李重量
      title: BaggageDTO
      x-apifox-orders:
        - amount
        - segmentIndex
        - size
        - type
        - weight
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```