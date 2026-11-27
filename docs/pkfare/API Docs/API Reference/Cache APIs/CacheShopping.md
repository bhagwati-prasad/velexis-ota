# CacheShopping

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /airline-data/cacheShopping:
    post:
      summary: CacheShopping
      deprecated: false
      description: >
        ##  Function


        Through CacheShopping API, users can check flight availability and its
        price by using relevant parameters. 


        ##  Versioning


        |Version|Sandbox Invoking Address|Update|

        |:----|:----|:----|

        |Shopping|[http://data-cache-api-test.pkfare.com/airline-data/cacheShopping](http://data-cache-api-test.pkfare.com/airline-data/cacheShopping)|   
        |


        *Below is the most updated version*







        ##  Error Code List


        |erroCode|erroMsg|Description|

        |:----|:----|:----|

        |0|ok|Request has been processed successfully.|

        |S001|System error.|System error.|

        |B002|Partner is not exists.|PartnerID does not exist.|

        |B003|Illegal sign.|Illegal sign. Please check your signature.|

        |P001|XXX is illegal.|The field of XXX is illegal.|

        |P002|XXX is missing.|The field of XXX is missing.|

        |P004|The maximum number of passengers with seat is 9.|Wrong parameter.
        The maximum number of passengers with seat is 9.|

        |P005|There should be at least one adult.|Wrong parameter. There should
        be at least one adult.|

        |P009|The number of infant passengers can not exceed the number of adult
        passengers.|Wrong parameter. The number of infant passengers can not
        exceed the number of adult passengers.|

        |B013|Interface is limited, please contact the system administrator.|The
        route that you request is limited, please contact system administrator.|

        |B014|Shopping failed.|Shopping failed caused by other reasons.|

        |B024|Time-out, please try later.|Time-out. You can try the second
        searching after a few seconds.|

        |B034|Shopping interface is offline.|Shopping service is limited.|

        |B035|Concurrency limited. Please contact PKFARE API support team for
        assistant.|Concurrent users control. Please contact PKFARE API support
        for assistant.|

        |B038|Departure date must be today to a year.|Wrong parameter. Departure
        date must be today to a year.|

        |B039|Can't find the related data of XXX.|Wrong parameter. Can't find
        the related data of XXX, like illegal city/country/area/airline.|

        |B046|Interface is limited, the routing is offlined by PKFARE.|Look to
        book control. If you need this routing, please contact PKFARE API for
        assistant.|

        |B059|Shopping failed from upstream.|Shopping failed, shopping error
        from upstream. Please contact PKFARE API support.|

        |B060|Interface is limited, please contact PKFARE.|Interface is limited,
        due to restriction rules, please contact PKFARE API support.|

        |B009|Supplier is offline|Supplier is not at working time, please
        contact PKFARE API support.|

        |B066|Only 2 journeys can be supported, please check your
        itinerary.|System support maximum 2 journeys shopping at this moment.|
      operationId: shoppingUsingPOST
      tags:
        - API Reference/Cache APIs
        - shopping-controller
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              x-apifox-refs: {}
              x-apifox-orders:
                - authentication
                - search
              properties:
                authentication:
                  type: object
                  x-apifox-refs: {}
                  x-apifox-orders:
                    - partnerId
                    - sign
                  properties:
                    partnerId:
                      type: string
                      description: Partner Id
                    sign:
                      type: string
                      description: Signature
                  required:
                    - partnerId
                    - sign
                search:
                  type: object
                  x-apifox-refs: {}
                  x-apifox-orders:
                    - airline
                    - cabinClass
                    - journeys
                    - maxConnections
                    - passengers
                    - solutions
                  properties:
                    airline:
                      type: string
                      description: Search for specific airline; IATA airlines code
                      examples:
                        - FR
                    cabinClass:
                      type: string
                      description: Cabin class
                      enum:
                        - economy
                        - super_economy
                        - business
                        - first
                      x-apifox:
                        enumDescriptions:
                          economy: ''
                          super_economy: ''
                          business: ''
                          first: ''
                      examples:
                        - economy
                    journeys:
                      type: array
                      description: Journey details
                      items:
                        type: object
                        properties:
                          departureDate:
                            type: string
                            description: Departure date [yyyy-MM-dd]
                            examples:
                              - '2024-10-26'
                          destination:
                            type: string
                            description: Destination [IATA airport/city code]
                            examples:
                              - MIL
                          origin:
                            type: string
                            description: Origin [IATA airport/city code ]
                            examples:
                              - DUB
                        x-apifox-refs: {}
                        x-apifox-orders:
                          - origin
                          - destination
                          - departureDate
                        required:
                          - origin
                          - destination
                          - departureDate
                      refType: JourneysDTO_1
                    maxConnections:
                      type: integer
                      description: Maximum connection of flights
                      format: int32
                      nullable: true
                    passengers:
                      type: object
                      properties:
                        adults:
                          type: integer
                          description: Number of adult passenger
                          format: int32
                          minimum: 1
                        children:
                          type: integer
                          format: int32
                          description: Number of child passenger
                        infants:
                          type: integer
                          format: int32
                          description: Number of infant passenger
                        teens:
                          type: integer
                          format: int32
                          description: Number of teenager passenger
                      x-apifox-refs: {}
                      x-apifox-orders:
                        - adults
                        - teens
                        - children
                        - infants
                      required:
                        - adults
                    solutions:
                      type: integer
                      description: Suggested quantity of returned solutions
                      format: int32
                      nullable: true
                  required:
                    - cabinClass
                    - journeys
                    - passengers
            example: ''
      responses:
        '200':
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: object
                    properties:
                      searchKey:
                        type: string
                        description: Unique identification of a search
                      segments:
                        type: array
                        items:
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
                              description: Arrival date [yyyy-MM-dd]
                            arrivalTerminal:
                              type: string
                              description: Arrival airport terminal
                            arrivalTime:
                              type: string
                              description: Arrival time [HH:mm]
                            codeShare:
                              type: string
                              description: 'Code share or not: [Y-yes, N-no]'
                            departure:
                              type: string
                              description: 'Departure airport '
                            departureDate:
                              type: string
                              description: Departure date [yyyy-MM-dd]
                            departureTerminal:
                              type: string
                              description: Departure airport terminal
                            departureTime:
                              type: string
                              description: Departure time [HH:mm]
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
                              description: Index of the flight segement
                            stayTime:
                              type: integer
                              format: int32
                              description: 'Stay time, valid with ''stopover'', unit: minute'
                            stopover:
                              type: string
                              description: Stopover airport
                          x-apifox-refs: {}
                          x-apifox-orders:
                            - segmentIndex
                            - airline
                            - flightNum
                            - equipment
                            - departure
                            - departureDate
                            - departureTime
                            - departureTerminal
                            - arrival
                            - arrivalDate
                            - arrivalTime
                            - arrivalTerminal
                            - flightTime
                            - codeShare
                            - opFltAirline
                            - opFltNo
                            - stopover
                            - stayTime
                        refType: SegmentsDTO
                      solutions:
                        type: array
                        items:
                          type: object
                          properties:
                            adultFare:
                              type: number
                              description: Adult fare
                            adultTax:
                              type: number
                              description: Adult tax
                            adultTotalPerPerson:
                              type: number
                              description: 'Adult price in total per person '
                            baggages:
                              description: Baggage details
                              type: object
                              properties:
                                adt:
                                  description: >-
                                    Including 'adt', 'teen', 'chd' and 'inf'. If
                                    the request does not include teenagers,
                                    children or infants, 'teen', 'chd' or 'inf'
                                    would be NULL.
                                  type: object
                                  properties:
                                    amount:
                                      type: integer
                                      format: int32
                                      description: Quantity of baggage
                                    segmentIndex:
                                      type: integer
                                      format: int32
                                      description: Segment index for baggage
                                    size:
                                      type: string
                                      description: Baggage size
                                    type:
                                      type: string
                                      description: 'Baggage type: carryon, checked'
                                    weight:
                                      type: integer
                                      format: int32
                                      description: 'Weight of baggage, unit: kg'
                                  x-apifox-refs: {}
                                  x-apifox-orders:
                                    - segmentIndex
                                    - type
                                    - amount
                                    - weight
                                    - size
                              x-apifox-refs: {}
                              x-apifox-orders:
                                - adt
                              required:
                                - adt
                            childFare:
                              type: number
                              description: 'Child fare '
                            childTax:
                              type: number
                              description: 'Child tax '
                            childTotalPerPerson:
                              type: number
                              description: Child price in total per person
                            conditions:
                              type: object
                              properties:
                                change:
                                  type: object
                                  properties:
                                    allowed:
                                      type: boolean
                                      description: Whether it is changeable
                                    description:
                                      type: string
                                      description: Description of the change rule
                                    penaltyAmount:
                                      type: number
                                      description: Change fee
                                    penaltyCurrency:
                                      type: string
                                      description: Currency
                                  x-apifox-refs: {}
                                  x-apifox-orders:
                                    - allowed
                                    - description
                                    - penaltyAmount
                                    - penaltyCurrency
                                other:
                                  type: array
                                  description: Other service
                                  items:
                                    type: object
                                    properties:
                                      available:
                                        type: boolean
                                        description: 'Whether it is available '
                                      description:
                                        type: string
                                        description: 'Description of the service '
                                      serviceName:
                                        type: string
                                        description: 'Name of service '
                                    x-apifox-refs: {}
                                    x-apifox-orders:
                                      - serviceName
                                      - available
                                      - description
                                  refType: OtherDTO
                                priorityBoarding:
                                  type: boolean
                                  description: 'Whether priority boarding is available '
                                refund:
                                  type: object
                                  properties:
                                    allowed:
                                      type: boolean
                                      description: Whether it is refundable
                                    description:
                                      type: string
                                      description: Description of the refund rule
                                    penaltyAmount:
                                      type: number
                                      description: Refund fee
                                    penaltyCurrency:
                                      type: string
                                      description: Currency
                                  x-apifox-refs: {}
                                  x-apifox-orders:
                                    - allowed
                                    - description
                                    - penaltyAmount
                                    - penaltyCurrency
                                seatSelection:
                                  type: boolean
                                  description: 'Whether seat selection is available '
                              x-apifox-refs: {}
                              x-apifox-orders:
                                - seatSelection
                                - priorityBoarding
                                - other
                                - change
                                - refund
                            currency:
                              type: string
                              description: Currency
                            fareName:
                              type: string
                              description: Airline official fare name
                            fareType:
                              type: string
                              description: Fare type [PUBLIC or PRIVATE]
                            infantFare:
                              type: number
                              description: Infant fare
                            infantTax:
                              type: number
                              description: Infant tax
                            infantTotalPerPerson:
                              type: number
                              description: infant price in total per person
                            journeys:
                              type: array
                              items:
                                type: object
                                properties:
                                  segments:
                                    type: array
                                    items:
                                      type: object
                                      properties:
                                        availabilityCount:
                                          type: integer
                                          format: int32
                                          description: Available seats, for reference only
                                        bookingCode:
                                          type: string
                                          description: Cabin code
                                        cabinClass:
                                          type: string
                                          description: >-
                                            Cabin class including Economy,
                                            PremiumEconomy, Business, First
                                        fareBasis:
                                          type: string
                                          description: Fare basis code
                                        segmentIndex:
                                          type: integer
                                          format: int32
                                          description: Index of the flight segement
                                      x-apifox-refs: {}
                                      x-apifox-orders:
                                        - segmentIndex
                                        - cabinClass
                                        - bookingCode
                                        - availabilityCount
                                        - fareBasis
                                    refType: SegmentInfoDTO
                                x-apifox-refs: {}
                                x-apifox-orders:
                                  - segments
                              refType: JourneysDTO
                            platingCarrier:
                              type: string
                              description: ticketing airline
                            solutionKey:
                              type: string
                              description: Unique identification of a solution
                            teenFare:
                              type: number
                              description: Teen fare
                            teenTax:
                              type: number
                              description: Teen tax
                            teenTotalPerPerson:
                              type: number
                              description: Teen price in total per person
                          x-apifox-refs: {}
                          x-apifox-orders:
                            - solutionKey
                            - fareType
                            - fareName
                            - currency
                            - adultFare
                            - adultTax
                            - adultTotalPerPerson
                            - teenFare
                            - teenTax
                            - teenTotalPerPerson
                            - childFare
                            - childTax
                            - childTotalPerPerson
                            - infantFare
                            - infantTax
                            - infantTotalPerPerson
                            - platingCarrier
                            - baggages
                            - conditions
                            - journeys
                        refType: SolutionsDTO
                    x-apifox-refs: {}
                    x-apifox-orders:
                      - searchKey
                      - segments
                      - solutions
                  errorCode:
                    type: string
                    description: Error code, refer to error code list
                  errorMsg:
                    type: string
                    description: Error message
                x-apifox-refs: {}
                x-apifox-orders:
                  - data
                  - errorCode
                  - errorMsg
                required:
                  - errorCode
                  - errorMsg
              example:
                data:
                  searchKey: DUBMIL20241026Y1000
                  segments:
                    - segmentIndex: 1
                      airline: FR
                      flightNum: '4038'
                      equipment: 7M8
                      departure: DUB
                      departureDate: '2024-10-26'
                      departureTime: '12:25'
                      departureTerminal: '1'
                      arrival: BGY
                      arrivalDate: '2024-10-26'
                      arrivalTime: '15:55'
                      arrivalTerminal: '1'
                      flightTime: 150
                      codeShare: 'Y'
                      opFltAirline: KM
                      opFltNo: null
                      stopover: null
                      stayTime: null
                    - segmentIndex: 2
                      airline: FR
                      flightNum: '4844'
                      equipment: 73H
                      departure: DUB
                      departureDate: '2024-10-26'
                      departureTime: '16:30'
                      departureTerminal: '1'
                      arrival: BGY
                      arrivalDate: '2024-10-26'
                      arrivalTime: '20:00'
                      arrivalTerminal: '1'
                      flightTime: 150
                      codeShare: 'N'
                      opFltAirline: null
                      opFltNo: null
                      stopover: null
                      stayTime: null
                    - segmentIndex: 3
                      airline: FR
                      flightNum: '1454'
                      equipment: 7S8
                      departure: DUB
                      departureDate: '2024-10-26'
                      departureTime: '18:30'
                      departureTerminal: '1'
                      arrival: MXP
                      arrivalDate: '2024-10-26'
                      arrivalTime: '22:10'
                      arrivalTerminal: '1'
                      flightTime: 160
                      codeShare: 'N'
                      opFltAirline: null
                      opFltNo: null
                      stopover: null
                      stayTime: null
                  solutions:
                    - solutionKey: 1q2w3e4r
                      fareType: PUBPISH
                      fareName: BASIC
                      currency: EUR
                      adultFare: 83.09
                      adultTax: 30
                      adultTotalPerPerson: 113.09
                      teenFare: 0
                      teenTax: 0
                      teenTotalPerPerson: 0
                      childFare: 0
                      childTax: 0
                      childTotalPerPerson: 0
                      infantFare: 0
                      infantTax: 0
                      infantTotalPerPerson: 0
                      platingCarrier: FR
                      baggages: {}
                      conditions:
                        seatSelection: false
                        priorityBoarding: false
                        other: []
                        change:
                          allowed: false
                          description: ''
                          penaltyAmount: 0
                          penaltyCurrency: ''
                        refund:
                          allowed: false
                          description: ''
                          penaltyAmount: 0
                          penaltyCurrency: ''
                      journeys:
                        - segments:
                            - segmentIndex: 1
                              cabinClass: economy
                              bookingCode: 'Y'
                              availabilityCount: 9
                              fareBasis: ''
                    - solutionKey: 2w3e4r5t
                      fareType: PUBPISH
                      fareName: REGULAR
                      currency: EUR
                      adultFare: 113.09
                      adultTax: 30
                      adultTotalPerPerson: 143.09
                      teenFare: 0
                      teenTax: 0
                      teenTotalPerPerson: 0
                      childFare: 0
                      childTax: 0
                      childTotalPerPerson: 0
                      infantFare: 0
                      infantTax: 0
                      infantTotalPerPerson: 0
                      platingCarrier: FR
                      baggages:
                        adt:
                          segmentIndex: 1
                          type: carryon
                          amount: 1
                          weight: 10
                          size: 55 x 40 x 20 cm
                      conditions:
                        seatSelection: true
                        priorityBoarding: true
                        other: []
                        change:
                          allowed: false
                          description: ''
                          penaltyAmount: 0
                          penaltyCurrency: ''
                        refund:
                          allowed: false
                          description: ''
                          penaltyAmount: 0
                          penaltyCurrency: ''
                      journeys:
                        - segments:
                            - segmentIndex: 1
                              cabinClass: economy
                              bookingCode: 'Y'
                              availabilityCount: 9
                              fareBasis: ''
                    - solutionKey: 3e4r5t6y
                      fareType: PUBPISH
                      fareName: PLUS
                      currency: EUR
                      adultFare: 118.09
                      adultTax: 30
                      adultTotalPerPerson: 148.09
                      teenFare: 0
                      teenTax: 0
                      teenTotalPerPerson: 0
                      childFare: 0
                      childTax: 0
                      childTotalPerPerson: 0
                      infantFare: 0
                      infantTax: 0
                      infantTotalPerPerson: 0
                      platingCarrier: FR
                      baggages:
                        adt:
                          segmentIndex: 1
                          type: checked
                          amount: 1
                          weight: 20
                          size: ''
                      conditions:
                        seatSelection: true
                        priorityBoarding: false
                        other:
                          - serviceName: Free check-in at the airport
                            available: true
                            description: Up to 40 minutes before flying
                        change:
                          allowed: false
                          description: ''
                          penaltyAmount: 0
                          penaltyCurrency: ''
                        refund:
                          allowed: false
                          description: ''
                          penaltyAmount: 0
                          penaltyCurrency: ''
                      journeys:
                        - segments:
                            - segmentIndex: 1
                              cabinClass: economy
                              bookingCode: 'Y'
                              availabilityCount: 9
                              fareBasis: ''
                    - solutionKey: 4r5t6y7u
                      fareType: PUBPISH
                      fareName: FLEXI PLUS
                      currency: EUR
                      adultFare: 183.09
                      adultTax: 30
                      adultTotalPerPerson: 213.09
                      teenFare: 0
                      teenTax: 0
                      teenTotalPerPerson: 0
                      childFare: 0
                      childTax: 0
                      childTotalPerPerson: 0
                      infantFare: 0
                      infantTax: 0
                      infantTotalPerPerson: 0
                      platingCarrier: FR
                      baggages:
                        adt:
                          segmentIndex: 1
                          type: carryon
                          amount: 1
                          weight: 10
                          size: 55 x 40 x 20 cm
                      conditions:
                        seatSelection: true
                        priorityBoarding: true
                        other:
                          - serviceName: Free check-in at the airport
                            available: true
                            description: Up to 40 minutes before flying
                          - serviceName: Speed through security
                            available: true
                            description: Beat the queues with Fast Track
                        change:
                          allowed: true
                          description: >-
                            https://www.ryanair.com/gb/en/useful-info/help-centre/fees
                          penaltyAmount: 0
                          penaltyCurrency: EUR
                        refund:
                          allowed: false
                          description: ''
                          penaltyAmount: 0
                          penaltyCurrency: ''
                      journeys:
                        - segments:
                            - segmentIndex: 1
                              cabinClass: economy
                              bookingCode: 'Y'
                              availabilityCount: 9
                              fareBasis: ''
                    - solutionKey: 5t6y7u8i
                      fareType: PUBPISH
                      fareName: BASIC
                      currency: EUR
                      adultFare: 23.37
                      adultTax: 30
                      adultTotalPerPerson: 53.37
                      teenFare: 0
                      teenTax: 0
                      teenTotalPerPerson: 0
                      childFare: 0
                      childTax: 0
                      childTotalPerPerson: 0
                      infantFare: 0
                      infantTax: 0
                      infantTotalPerPerson: 0
                      platingCarrier: FR
                      baggages: {}
                      conditions:
                        seatSelection: false
                        priorityBoarding: false
                        other: []
                        change:
                          allowed: false
                          description: ''
                          penaltyAmount: 0
                          penaltyCurrency: ''
                        refund:
                          allowed: false
                          description: ''
                          penaltyAmount: 0
                          penaltyCurrency: ''
                      journeys:
                        - segments:
                            - segmentIndex: 2
                              cabinClass: economy
                              bookingCode: 'Y'
                              availabilityCount: 5
                              fareBasis: ''
                errorCode: '0'
                errorMsg: success
          headers: {}
          x-apifox-name: Success
        '201':
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties: {}
                x-apifox-orders: []
          headers: {}
          x-apifox-name: Created
        '401':
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties: {}
                x-apifox-orders: []
          headers: {}
          x-apifox-name: Unauthorized
        '403':
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties: {}
                x-apifox-orders: []
          headers: {}
          x-apifox-name: Forbidden
        '404':
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties: {}
                x-apifox-orders: []
          headers: {}
          x-apifox-name: Not Found
      security: []
      x-apifox-folder: API Reference/Cache APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470107-run
components:
  schemas: {}
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```