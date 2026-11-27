# OtherDTO

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
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```