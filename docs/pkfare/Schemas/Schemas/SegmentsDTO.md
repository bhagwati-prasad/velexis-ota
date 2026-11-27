# SegmentsDTO

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
    SegmentsDTO:
      type: object
      properties:
        airline:
          type: string
          description: Airline code
        arrival:
          type: string
          description: Arrival airport
        arrivalDate:
          type: string
          description: Arrival date [yyyy-mm-dd]
        arrivalTerminal:
          type: string
          description: Arrival airport terminal
        arrivalTime:
          type: string
          description: Arrival time [hh:mm]
        codeShare:
          type: string
          description: 'Code share or not: [Y-yes, N-no]'
        departure:
          type: string
          description: Departure airport
        departureDate:
          type: string
          description: Departure date [yyyy-mm-dd]
        departureTerminal:
          type: string
          description: Departure airport terminal
        departureTime:
          type: string
          description: Departure time [hh:mm]
        equipment:
          type: string
          description: Equipment
        flightNum:
          type: string
          description: Flight number
        flightTime:
          type: integer
          format: int32
          description: 'Flight time, unit: minute'
        opFltAirline:
          type: string
          description: Operated carrier
        opFltNo:
          type: string
          description: Flight number of operated carrier
        segmentIndex:
          type: integer
          format: int32
          description: Segment index
        stayTime:
          type: integer
          format: int32
          description: 'Stay time, valid with ''stopover'', unit: minute'
        stopover:
          type: string
          description: Stopover airport
      title: SegmentsDTO
      x-apifox-orders:
        - airline
        - arrival
        - arrivalDate
        - arrivalTerminal
        - arrivalTime
        - codeShare
        - departure
        - departureDate
        - departureTerminal
        - departureTime
        - equipment
        - flightNum
        - flightTime
        - opFltAirline
        - opFltNo
        - segmentIndex
        - stayTime
        - stopover
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```