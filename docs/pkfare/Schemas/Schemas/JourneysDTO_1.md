# JourneysDTO_1

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
    JourneysDTO_1:
      type: object
      properties:
        departureDate:
          type: string
          description: Departure date [yyyy-MM-dd]
        destination:
          type: string
          description: Destination [IATA airport/city code]
        origin:
          type: string
          description: Origin [IATA airport/city code]
      title: JourneysDTO_1
      x-apifox-orders:
        - departureDate
        - destination
        - origin
      required:
        - departureDate
        - destination
        - origin
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```