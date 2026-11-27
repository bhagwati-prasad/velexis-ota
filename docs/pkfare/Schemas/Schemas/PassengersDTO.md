# PassengersDTO

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
    PassengersDTO:
      type: object
      properties:
        adults:
          type: integer
          format: int32
          description: Number of adult passenger
        children:
          type: integer
          format: int32
          description: Number of child passenger
        infants:
          type: integer
          format: int32
          description: Number of infant passenger
      title: PassengersDTO
      x-apifox-orders:
        - adults
        - children
        - infants
      required:
        - adults
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```