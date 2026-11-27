# ShoppingReq

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
    SearchDTO:
      type: object
      properties:
        airline:
          type: string
          description: Search for specific airline; IATA airlines code
        cabinClass:
          type: string
          description: Cabin class [first/business/super_economy/economy]
        journeys:
          type: array
          items:
            $ref: '#/components/schemas/JourneysDTO_1'
          refType: JourneysDTO_1
        maxConnections:
          type: integer
          format: int32
          description: The maximum number of connections
        passengers:
          $ref: '#/components/schemas/PassengersDTO'
        solutions:
          type: integer
          format: int32
          description: Quantity of returned solutions
      title: SearchDTO
      x-apifox-orders:
        - airline
        - cabinClass
        - journeys
        - maxConnections
        - passengers
        - solutions
      required:
        - cabinClass
        - journeys
        - passengers
      x-apifox-folder: ''
    ShoppingReq:
      type: object
      properties:
        authentication:
          $ref: '#/components/schemas/Authentication'
        search:
          $ref: '#/components/schemas/SearchDTO'
      title: ShoppingReq
      x-apifox-orders:
        - authentication
        - search
      required:
        - search
      x-apifox-folder: ''
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
      title: Authentication
      x-apifox-orders:
        - Authentication
      required:
        - Authentication
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```