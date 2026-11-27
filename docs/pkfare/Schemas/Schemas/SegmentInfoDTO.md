# SegmentInfoDTO

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
    SegmentInfoDTO:
      type: object
      properties:
        availabilityCount:
          type: integer
          format: int32
          description: 剩余舱位数
        bookingCode:
          type: string
          description: 舱位
        cabinClass:
          type: string
          description: 舱等
        fareBasis:
          type: string
          description: fareBasis
        segmentIndex:
          type: integer
          format: int32
          description: 航段序号
      title: SegmentInfoDTO
      x-apifox-orders:
        - availabilityCount
        - bookingCode
        - cabinClass
        - fareBasis
        - segmentIndex
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```