# PrecisePricing V10

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/precisePricing_V10:
    post:
      summary: PrecisePricing V10
      deprecated: false
      description: >+
        ##  Function


        Through PrecisePricing API, the precise price will be shown with
        specific flight details, including booking code and seat availability.
        If specific cabin class is requested (cabin class should be specified in
        all segments), the lowest fare corresponding to the specified class will
        be shown. 


        PrecisePricing service is able to check flight price based on cabin
        class. We will respond the real-time price and availability.



        ##  Versioning


        |Version|Sandbox Invoking Address|Update|

        |:----|:----|:----|

        |PrecisePricing|[https://api.pkfare.com/precisePricing](https://api.pkfare.com/precisePricing)|   
        |

        |PrecisePricing_V2|[https://api.pkfare.com/precisePricing_V2](https://api.pkfare.com/precisePricing_V2)|Add
        baggageMap and miniRuleMap, only for reference. Offer BookingWithoutCard
        notification in response.|

        |PrecisePricing_V4|[https://api.pkfare.com/precisePricing_V4](https://api.pkfare.com/precisePricing_V4)|Support
        infant (no seat) .|

        |PrecisePricing_V5|[https://api.pkfare.com/precisePricing_V5](https://api.pkfare.com/precisePricing_V5)|Add
        Ancillary flag to indicate which ancillary service is available|

        |PrecisePricing_V6|[https://api.pkfare.com/precisePricing_V6](https://api.pkfare.com/precisePricing_V6)|Add
        solutionId to enhance tracebility and data visibility|

        |PrecisePricing_V6(json
        foramt)|https://api.pkfare.com/json/precisePricing_V6|Add solutionId to
        enhance tracebility and data visibility;Support json formatted
        requesting structure|

        |PrecisePricing_V9(json
        foramt)|https://api.pkfare.com/json/precisePricing_V9|Support pricing
        virtual interlining content|

        |PrecisePricing_V10(json
        foramt)|https://api.pkfare.com/json/precisePricing_V10|Support pricing
        different product tags, including PKFARE-defined special product types
        and airline-standard branded fares, etc.|


        *Below is the most updated version"





        ##  Error Code List


        |erroCode|erroMsg|Description|

        |:----|:----|:----|

        |0|ok|Request has been processed successfully.|

        |S001|System error.|System error.|

        |B002|Partner does not exists.|PartnerID does not exist.|

        |B003|Illegal sign.|Illegal sign. Please check your signature.|

        |B035|Concurrency limited. Please contact PKFARE API support team for
        assistant.|Concurrency exceeded system limits.|

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

        |B015|Pricing failed.|Pricing failed for other reason.|

        |B016|Flight near take-off, can’t offer pricing service.|Pricing fail.
        Can not pricing for flights that is near taking off.|

        |B018|Airline or flight restriction.|Airline or flight restriction.|

        |B019|Can not find any supplier for current search.|Can not find any
        supplier for current search.|

        |B020|Can not find any price for this flight.|Pricing fail. Can not find
        any price for this flight option.|

        |B021|The booking code you choose has only 0 seat available.|Pricing
        fail. The booking code you choose has 0 seat left. Please choose other
        booking code or flight.|

        |B026|LatestTktTime: yyyy-mm-dd hh : mm: ss.|Last ticketing time is not
        enough to issue ticket.|

        |B024|Pricing TimeOut.|Pricing TimeOut.|

        |B035|Concurrency limited. Please contact PKFARE API support team for
        assistant.|Concurrent users control. Please contact PKFARE API support
        for assistant.|

        |B039|Can't find the related data of XXX.|Wrong parameter. Can't find
        the related data of XXX, like illegal city/country/area/airline.|

        |B046|Interface is limited, the routing is offlined by PKFARE.|Look to
        book control. If you need this routing, please contact PKFARE API for
        assistant.|

        |B068|The segment detail is different between solutionid field and
        journey field.|Please verify whether the information in the pricing
        request matches the details from the shopping response.|

        |B121|Supplier is offline|Supplier is not at working time, please
        contact PKFARE API support.|

      tags:
        - API Reference/APIs with all versions/PrecisePricing
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
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
                  x-apifox-ignore-properties: []
                pricing:
                  type: object
                  properties:
                    journeys:
                      type: object
                      properties:
                        journey_0:
                          type: array
                          items:
                            type: object
                            properties:
                              airline:
                                type: string
                                description: Airline code
                              flightNum:
                                type: string
                                description: Flight number
                              arrival:
                                type: string
                                description: Destination[IATA airport code]
                              arrivalDate:
                                type: string
                                description: Arrival Date[yyyy-MM-dd]
                              arrivalTime:
                                type: string
                                description: Arrival Time[HH:mm]
                              departure:
                                type: string
                                description: Origin[IATA airport code]
                              departureDate:
                                type: string
                                description: Departure Date[yyyy-MM-dd]
                              departureTime:
                                type: string
                                description: Departure Time[HH:mm]
                              bookingCode:
                                type: string
                                description: "Code\_representing\_RBD. Needed\_to\_request\_with\_this\_parameter\_in\_order\_to\_keep\_the\_price\_stable\_and\_pricing\_success\_rate."
                            x-apifox-orders:
                              - airline
                              - flightNum
                              - arrival
                              - arrivalDate
                              - arrivalTime
                              - departure
                              - departureDate
                              - departureTime
                              - bookingCode
                            required:
                              - airline
                              - flightNum
                              - arrival
                              - arrivalDate
                              - arrivalTime
                              - departure
                              - departureDate
                              - departureTime
                              - bookingCode
                            x-apifox-ignore-properties: []
                      required:
                        - journey_0
                      x-apifox-orders:
                        - journey_0
                      description: journey_0 outboundtrip, journey_1 inbound trip,
                      x-apifox-ignore-properties: []
                    adults:
                      type: integer
                      description: Number of adult passenger
                    children:
                      type: integer
                      description: Number of child[age 2-12/14] passenger
                    infants:
                      type: integer
                      description: Number of infant [age 0-2, no seat] passenger
                    solutionId:
                      type: string
                      description: >-
                        Unique identification of each solution from Shopping
                        API, request with it for associating with the Shopping
                        solution and linking to the entire request process. In
                        the case of a pricing failure, please retry by filling
                        in this parameter with 'direct pricing' string to
                        trigger the direct pricing mechanism.
                    cabin:
                      type: string
                      description: >-
                        Cabin class ["" - the lowest cabin, Y - Economy, W -
                        PremiumEconomy, C - business class, F - first class] if
                        both 'cabin' and 'bookingCode' is valued and not
                        inconsistent, precisePricing service would base on
                        'bookingCode'.
                    solutionKey:
                      type: string
                      description: >-
                        Recommend to request with this parameters for the sake
                        of data quality monitor.
                    tag:
                      type: string
                      description: >-
                        Product tag, must use the code defined by PKFARE. Only
                        one tag can be specified in this version. When making a
                        direct pricing request with a tag, PKFARE may return
                        multiple prices with different tags for the requested
                        flight. For non-direct pricing requests, the tag can be
                        omitted, in which case PKFARE will always perform
                        single-price validation based on the Shopping cached
                        price tag associated with the solutionId.​
                  required:
                    - journeys
                    - adults
                    - children
                    - infants
                    - solutionId
                  x-apifox-orders:
                    - journeys
                    - adults
                    - children
                    - infants
                    - solutionId
                    - cabin
                    - solutionKey
                    - tag
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - pricing
              x-apifox-orders:
                - 01HV3S8HKKP86X6FKPNN4RDP66
                - pricing
              x-apifox-refs:
                01HV3S8HKKP86X6FKPNN4RDP66:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: ''
                sign: ''
              pricing:
                journeys:
                  journey_0:
                    - airline: FD
                      flightNum: '501'
                      arrival: DMK
                      arrivalDate: '2024-12-15'
                      arrivalTime: '16:40'
                      departure: HKG
                      departureDate: '2024-12-15'
                      departureTime: '14:40'
                      bookingCode: Z
                  journey_1:
                    - airline: FD
                      flightNum: '504'
                      arrival: HKG
                      arrivalDate: '2024-12-30'
                      arrivalTime: '19:15'
                      departure: DMK
                      departureDate: '2024-12-30'
                      departureTime: '15:30'
                      bookingCode: A
                adults: 1
                children: 1
                infants: 0
                solutionId: >-
                  iXf1ufZoOsBU+MpHfwQD6vzfcE3X5BFe1Vxl3oa9iNn1Noc75XschKYpLVXfU17PcPI7oU/EVSKjQj2Xuxt9QoSJGTP7oW12BBtDUQvlAzaZ1z0zhjr4N5cJVh2fElsdEXXtCGI00H3Nvx98/d2z6lUfU0Yhuny0kj/rOz4IMMmghIhWyGDa4e4T7y3BrTjFwEPZh0nHoEykVO13sMp0vXt8ub60T12OXl9dooXkhpqN51MhNjyCkSYjIYff//DJ1cRBps9+3e58SI0ifR8P6FiCKSCYOmCQLFKKLU0P8+Xlv4BsqxNY0pdOKT7LeR3w2YGgt1zSCyEXZCwy/+BBLA66j01ytAzieUvdZ3sqLyc8+7IG23vo1JfqVtlJo/pvRdlQyp6gQGJDPraSkTCSvA==
                cabin: ''
                tag: SAVER
      responses:
        '200':
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties:
                  errorCode:
                    type: string
                    description: Error code, refer to Error Code List
                  errorMsg:
                    type: string
                    description: Error message
                  data:
                    type: object
                    properties:
                      solution:
                        type: object
                        properties:
                          solutionId:
                            type: string
                            description: Unique identification
                          solutionKey:
                            type: string
                            description: Unique identification
                          category:
                            type: array
                            items:
                              type: string
                            description: Product type, e.g. VI[means virtual interlining]
                          fareType:
                            type: string
                            description: Fare type, including PUBLIC and PRIVATE
                          currency:
                            type: string
                            description: currency
                          adtFare:
                            type: number
                            description: adult fare
                            default: 0
                          adtTax:
                            type: number
                            description: adult tax
                            default: 0
                          chdFare:
                            type: number
                            description: children [age 2-12] fare
                            default: 0
                          chdTax:
                            type: number
                            description: children [age 2-12] tax
                            default: 0
                          infFare:
                            type: number
                            description: infant [age 0-2, no seat] fare
                            default: 0
                            nullable: true
                          infTax:
                            type: number
                            description: infant [age 0-2, no seat] tax
                            default: 0
                            nullable: true
                          qCharge:
                            type: number
                            description: >-
                              Q charge, bunker adjustment surcharge, for
                              reference only
                            default: 0
                          tktFee:
                            type: number
                            default: 0
                            description: Ticketing service fee
                          platformServiceFee:
                            type: number
                            description: platform service fee, defaults to 0
                            default: 0
                          journeys:
                            type: object
                            properties:
                              journey_0:
                                type: array
                                items:
                                  type: string
                                  description: refer to flightId
                                description: journey_0 or journey_1
                            description: >-
                              journey_0 outboundtrip, journey_1 inbound trip,
                              refer to flightId
                            required:
                              - journey_0
                            x-apifox-orders:
                              - journey_0
                            x-apifox-ignore-properties: []
                            nullable: true
                          platingCarrier:
                            type: string
                            description: ticketing airline
                          merchantFee:
                            type: number
                            description: payment transaction fee
                            default: 0
                            nullable: true
                          baggages:
                            type: object
                            properties:
                              '1':
                                type: object
                                properties:
                                  baggage:
                                    type: string
                                    description: >-
                                      Free baggage allowance. The field would be
                                      null if the information is failed to
                                      collected. Different segment baggage rule
                                      would be separated by ','
                                  carryOn:
                                    type: string
                                    description: >-
                                      Free carry-on bag allowance. The field
                                      would be null if the information is failed
                                      to collected. Different segment baggage
                                      rule would be separated by ','. Part of
                                      carry-on info would be included size
                                      limitation, as sample
                                description: >-
                                  Index of journey sequence number 1 corresponds
                                  to Journey_0, 2 corresponds to Journey_1.
                                x-apifox-orders:
                                  - baggage
                                  - carryOn
                                required:
                                  - carryOn
                                x-apifox-ignore-properties: []
                            x-apifox-orders:
                              - '1'
                            description: 'Baggage rule. '
                            x-apifox-ignore-properties: []
                          baggageMap:
                            type: object
                            properties:
                              ADT:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    segmentIndexList:
                                      type: array
                                      items:
                                        type: integer
                                      description: >-
                                        Segment index list for baggage. Index
                                        begins with '1'. If 1st segment has same
                                        baggage allowance with 3rd segment,such
                                        as [1,3]
                                      nullable: true
                                    baggageAmount:
                                      type: string
                                      description: >-
                                        Free baggage amount allowance. '1PC' for
                                        1 piece
                                      nullable: true
                                    baggageWeight:
                                      type: string
                                      description: Free baggage weight allowance
                                    carryOnAmount:
                                      type: string
                                      description: >-
                                        Free carry-on baggage amount allowance.
                                        '1PC' for 1 piece
                                      nullable: true
                                    carryOnWeight:
                                      type: string
                                      description: Free carry-on baggage weight allowance
                                      nullable: true
                                    carryOnSize:
                                      type: array
                                      items:
                                        type: string
                                      description: >-
                                        Carry-on Baggage Dimensions [Length,
                                        Width, Height] in centimeters
                                  x-apifox-orders:
                                    - segmentIndexList
                                    - baggageAmount
                                    - baggageWeight
                                    - carryOnAmount
                                    - carryOnWeight
                                    - carryOnSize
                                  x-apifox-ignore-properties: []
                                description: ' Including ''ADT''、''CHD'' and ''INF''. If the request does not include children or infants, ''CHD'' or ''INF'' would be NULL.'
                            description: >-
                              Baggage rule. For reference only. Including
                              'ADT'、'CHD' and 'INF'. If the request does not
                              include children or infants, 'CHD' or 'INF' would
                              be NULL.
                            x-apifox-orders:
                              - ADT
                            x-apifox-ignore-properties: []
                            nullable: true
                          miniRuleMap:
                            type: object
                            properties:
                              ADT:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    segmentIndex:
                                      type: array
                                      items:
                                        type: integer
                                      description: >-
                                        Segment index list for penalty. Index
                                        begins with '1'. If 1st segment has same
                                        penalty rule with 3rd segment, such as
                                        [1,3]
                                    miniRules:
                                      type: array
                                      items:
                                        type: object
                                        properties:
                                          penaltyType:
                                            type: integer
                                            description: >-
                                              Penalty type. [0 - refund, 1 - noShow
                                              refund, 2 - change, 3 - noShow change]
                                          isPermited:
                                            type: integer
                                            description: "Allow refund/change or not. [0 - not allow, 1 - allow, 2 - unknown]\t"
                                          when:
                                            type: integer
                                            description: >-
                                              Appropriate situation. [0 - Both
                                              Outbound and Inbound are not used, 1-
                                              Outbound Flight used, 2 - all Situation]
                                          noShowTime:
                                            type: string
                                            description: >-
                                              NoShow definition. Apply with
                                              'noShowTimeUnit'
                                          noShowTimeUnit:
                                            type: string
                                            description: >-
                                              NoShow Unit. Apply with 'noShowTime'. [H
                                              - hour, M - minute]
                                          amount:
                                            type: number
                                            description: Penalty
                                          currencyCode:
                                            type: string
                                            description: Penalty currency
                                          percent:
                                            type: number
                                            description: >-
                                              Penalty percentage. Apply with
                                              'baseType'. Penalty and penalty
                                              percentage would not go into effect at
                                              the same. Please take the strict one.
                                              Unit: %
                                          baseType:
                                            type: integer
                                            description: >-
                                              Apply with 'percent'. Multiply
                                              corresponding value of 'baseType' by
                                              'percent' would be the penalty. [0 -
                                              fare, 1 - fare+tax+ticketingFee, 2 -
                                              cabin basic fare]
                                        required:
                                          - when
                                        x-apifox-orders:
                                          - penaltyType
                                          - isPermited
                                          - when
                                          - noShowTime
                                          - noShowTimeUnit
                                          - amount
                                          - currencyCode
                                          - percent
                                          - baseType
                                        x-apifox-ignore-properties: []
                                  required:
                                    - segmentIndex
                                    - miniRules
                                  x-apifox-orders:
                                    - segmentIndex
                                    - miniRules
                                  x-apifox-ignore-properties: []
                                description: '''ADT''、''CHD'' OR ''INF'''
                            required:
                              - ADT
                            x-apifox-orders:
                              - ADT
                            description: >-
                              Penalty rule. For reference only, please find
                              precise penalty rule on Penalty API.
                            x-apifox-ignore-properties: []
                            nullable: true
                          otherFareRules:
                            type: object
                            properties:
                              ADT:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    segmentIndexList:
                                      type: array
                                      items:
                                        type: integer
                                    detail:
                                      type: array
                                      items:
                                        type: string
                                  x-apifox-orders:
                                    - segmentIndexList
                                    - detail
                                  x-apifox-ignore-properties: []
                            x-apifox-orders:
                              - ADT
                            description: Other fare rules corresponding to the solution.
                            x-apifox-ignore-properties: []
                          bookingWithoutCard:
                            type: integer
                            description: >-
                              Travel document require indicator, 0 - need travel
                              document for booking, 1 - no need travel document
                              for booking
                          tag:
                            type: string
                            description: The product tag corresponding to the solution.
                        required:
                          - solutionId
                          - fareType
                          - currency
                          - adtFare
                          - adtTax
                          - chdFare
                          - chdTax
                          - tktFee
                          - platformServiceFee
                          - platingCarrier
                          - bookingWithoutCard
                        x-apifox-orders:
                          - solutionId
                          - solutionKey
                          - category
                          - fareType
                          - currency
                          - adtFare
                          - adtTax
                          - chdFare
                          - chdTax
                          - infFare
                          - infTax
                          - qCharge
                          - tktFee
                          - platformServiceFee
                          - journeys
                          - platingCarrier
                          - merchantFee
                          - baggages
                          - baggageMap
                          - miniRuleMap
                          - otherFareRules
                          - bookingWithoutCard
                          - tag
                        x-apifox-ignore-properties: []
                      flights:
                        type: array
                        items:
                          type: object
                          properties:
                            flightId:
                              type: string
                              description: Flight ID，unique identification
                            journeyTime:
                              type: integer
                              description: 'Journey time，unit: minute'
                            transferCount:
                              type: integer
                              description: Count of transfer times
                            latestTktTime:
                              type: string
                              description: Latest ticketing time (GMT)
                            segmentIds:
                              type: array
                              items:
                                type: string
                                description: >-
                                  Refer to segmentId (please note the
                                  segmengtIds is a typo due to history edition)
                              description: >-
                                Including segment [segmentId] array, refer to
                                segmentId (please note the segmengtIds is a typo
                                due to history edition)
                            selfTransferSegmentIds:
                              type: array
                              items:
                                type: string
                              description: >-
                                self transfer， Identifies the flight segments
                                where passengers must self-transfer upon arrival
                                at the departure airport
                          x-apifox-orders:
                            - flightId
                            - journeyTime
                            - transferCount
                            - latestTktTime
                            - segmentIds
                            - selfTransferSegmentIds
                          x-apifox-ignore-properties: []
                      segments:
                        type: array
                        items:
                          type: object
                          properties:
                            segmentId:
                              type: string
                              description: Segment ID, unique identification
                            airline:
                              type: string
                              description: Airline code
                            flightNum:
                              type: string
                              description: Flight number
                            equipment:
                              type: string
                              description: Equipment
                            cabinClass:
                              type: string
                              description: >-
                                Cabin class including Economy, PremiumEconomy,
                                Business, First
                            bookingCode:
                              type: string
                              description: Cabin code
                            availabilityCount:
                              type: integer
                              description: Available seats, for reference only
                            departure:
                              type: string
                              description: Departure airport
                            arrival:
                              type: string
                              description: Arrival airport
                            departureTerminal:
                              type: string
                              description: Departure airport terminal
                            arrivalTerminal:
                              type: string
                              description: Arrival airport terminal
                            departureDate:
                              type: integer
                              description: 'Departure date [unix time], deprecated '
                              format: long
                            arrivalDate:
                              type: integer
                              format: long
                              description: Arrival date [unix time], deprecated
                            flightTime:
                              type: integer
                              description: 'Flight time, unit: minute'
                            stayTime:
                              type: string
                              description: 'Stay time, valid with ''stopover'' , unit: minute'
                            codeShare:
                              type: string
                              description: 'Code share or not: [Y-yes, N-no]'
                            opFltNo:
                              type: string
                              description: Flight number of operated carrier
                            opFltAirline:
                              type: string
                              description: Operated carrier
                            stopover:
                              type: string
                              description: Stopover airport
                            strDepartureDate:
                              type: string
                              description: Departure date[yyyy-MM-dd], local time
                            strDepartureTime:
                              type: string
                              description: Departure time[HH:mm], local time
                            strArrivalDate:
                              type: string
                              description: Arrival date[yyyy-MM-dd], local time
                            strArrivalTime:
                              type: string
                              description: Arrival time[HH:mm], local time
                            fareBasis:
                              type: string
                              description: Fare basis code
                          x-apifox-orders:
                            - segmentId
                            - airline
                            - flightNum
                            - equipment
                            - cabinClass
                            - bookingCode
                            - availabilityCount
                            - departure
                            - arrival
                            - departureTerminal
                            - arrivalTerminal
                            - departureDate
                            - arrivalDate
                            - flightTime
                            - stayTime
                            - codeShare
                            - opFltNo
                            - opFltAirline
                            - stopover
                            - strDepartureDate
                            - strDepartureTime
                            - strArrivalDate
                            - strArrivalTime
                            - fareBasis
                          x-apifox-ignore-properties: []
                      ancillaryAvailability:
                        type: object
                        properties:
                          paidBag:
                            type: boolean
                            description: "Whether paid bag service is available, true-available, false-unavailable\t"
                          paidSeat:
                            type: boolean
                            description: >-
                              Whether paid seat service is available,
                              true-available, false-unavailable
                        x-apifox-orders:
                          - paidBag
                          - paidSeat
                        required:
                          - paidBag
                          - paidSeat
                        x-apifox-ignore-properties: []
                    required:
                      - solution
                      - flights
                      - segments
                      - ancillaryAvailability
                    x-apifox-orders:
                      - solution
                      - flights
                      - segments
                      - ancillaryAvailability
                    description: >-
                      Returned data, will not be empty when error code is "0".
                      Data is in JSON format, which contains three collection
                      objects: solutions, flights, segments.
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-ignore-properties: []
              examples:
                '2':
                  summary: Success(One Way Journey)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      solution:
                        solutionKey: cadce3d7a693476e02a0e841d586fbcb
                        solutionId: >-
                          DMHkxtUMupBvCYeSAZKvI2XPSDdKRK2kK27eMKAEE+F2gdW8n4ZhopICv6eJNS40zcS8otwiL7wFzPBaAV7LVv2D95+F/d+5de4BWOJA5bK31lUgTmtnRxndjrSZ1zzN3Mi6x5gpdI9FeWUc7EQnsceDYXG39qudoyIneDp4SIXpUF8vpposuSdigXFrVDzpymiC438EKaAZir9UEp4DEeLyOjTCo1/PvTyURv9tRMj53bdg+S694JVZycYIq04SQ7mk2NfOZ1rVVHcNgSHvDAORkJ2rv/U9ZjzI5sLdcyS7zdu/MyOpCt3KHXet6Onr
                        fareType: PRIVATE
                        currency: USD
                        adtFare: 25.69
                        adtTax: 59.39
                        chdFare: 0
                        chdTax: 0
                        tktFee: 0
                        platformServiceFee: 0
                        journeys:
                          journey_0:
                            - 07177e6e653830b4b2e151f215c8fd19
                        platingCarrier: VJ
                        merchantFee: 0
                        adults: 1
                        children: 0
                        infants: 0
                        baggages:
                          '1':
                            carryOn: 1PC7KG
                            baggage: 0PC
                          '2':
                            carryOn: 1PC7KG
                            baggage: 0PC
                        baggageMap:
                          ADT:
                            - segmentIndexList:
                                - 1
                                - 2
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                        miniRuleMap:
                          ADT:
                            - segmentIndex:
                                - 1
                                - 2
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                        bookingWithoutCard: 1
                      flights:
                        - flightId: 07177e6e653830b4b2e151f215c8fd19
                          journeyTime: 265
                          transferCount: 0
                          segmentIds:
                            - 5b6e4e840bb3321ca4ca21c422c99af6
                            - 7292bd918a99e91c03bb3323c22d99
                      segments:
                        - segmentId: 5b6e4e840bb3321ca4ca21c422c99af6
                          airline: VJ
                          flightNum: '503'
                          equipment: 32S
                          cabinClass: ECONOMY
                          bookingCode: K
                          availabilityCount: 4
                          departure: HKG
                          arrival: SGN
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1734272400000
                          arrivalDate: 1734279600000
                          flightTime: 180
                          stayTime: null
                          codeShare: 'N'
                          opFltNo: null
                          opFltAirline: null
                          stopover: null
                          fareBasis: YOW
                          strDepartureDate: '2024-12-15'
                          strDepartureTime: '22:20'
                          strArrivalDate: '2024-12-16'
                          strArrivalTime: '00:20'
                        - segmentId: 7292bd918a99e91c03bb3323c22d99
                          airline: FD
                          flightNum: '665'
                          equipment: A320
                          cabinClass: ECONOMY
                          bookingCode: J
                          availabilityCount: 6
                          departure: SGN
                          arrival: DMK
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1734287400000
                          arrivalDate: 1734291900000
                          flightTime: 75
                          stayTime: null
                          codeShare: 'N'
                          opFltNo: null
                          opFltAirline: null
                          stopover: null
                          fareBasis: YOW
                          strDepartureDate: '2024-12-16'
                          strDepartureTime: '02:30'
                          strArrivalDate: '2024-12-16'
                          strArrivalTime: '03:45'
                      ancillaryAvailability:
                        paidBag: false
                        paidSeat: false
                '4':
                  summary: Success(Round Trip Journey)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      solution:
                        solutionKey: 2a6b473f599002a7fa59bc40499ea074
                        solutionId: >-
                          iXf1ufZoOsBU+MpHfwQD6vzfcE3X5BFe1Vxl3oa9iNn1Noc75XschKYpLVXfU17PcPI7oU/EVSKjQj2Xuxt9QoSJGTP7oW12BBtDUQvlAzaZ1z0zhjr4N5cJVh2fElsdEXXtCGI00H3Nvx98/d2z6lUfU0Yhuny0kj/rOz4IMMmghIhWyGDa4e4T7y3BrTjFwEPZh0nHoEykVO13sMp0vXt8ub60T12OXl9dooXkhpqN51MhNjyCkSYjIYff//DJ1cRBps9+3e58SI0ifR8P6FiCKSCYOmCQLFKKLU0P8+Xlv4BsqxNY0pdOKT7LeR3w2YGgt1zSCyEXZCwy/+BBLA66j01ytAzieUvdZ3sqLyc8+7IG23vo1JfqVtlJo/pvRdlQyp6gQGJDPraSkTCSvA==
                        fareType: PRIVATE
                        currency: USD
                        adtFare: 198.13
                        adtTax: 104.02
                        chdFare: 180.49
                        chdTax: 104.02
                        tktFee: 0
                        platformServiceFee: 0
                        journeys:
                          journey_0:
                            - 61c4b92a477da82490aee92382fb6fc9
                          journey_1:
                            - 5fb64796bcffde1c4c76af5971fa7257
                        platingCarrier: FD
                        merchantFee: 0
                        adults: 1
                        children: 1
                        infants: 0
                        baggages:
                          '1':
                            carryOn: 1PC7KG
                            baggage: 0PC
                          '2':
                            carryOn: 1PC7KG
                            baggage: 0PC
                        baggageMap:
                          ADT:
                            - segmentIndexList:
                                - 1
                                - 2
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                          CHD:
                            - segmentIndexList:
                                - 1
                                - 2
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                        miniRuleMap:
                          ADT:
                            - segmentIndex:
                                - 1
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                            - segmentIndex:
                                - 2
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                          CHD:
                            - segmentIndex:
                                - 1
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                            - segmentIndex:
                                - 2
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                        bookingWithoutCard: 1
                      flights:
                        - flightId: 61c4b92a477da82490aee92382fb6fc9
                          journeyTime: 180
                          transferCount: 0
                          segmentIds:
                            - 74a975f21ad0ce3cfc49d11c32c168ab
                        - flightId: 5fb64796bcffde1c4c76af5971fa7257
                          journeyTime: 165
                          transferCount: 0
                          segmentIds:
                            - f4606c103ce1eeadf38c201f6a57e031
                      segments:
                        - segmentId: 74a975f21ad0ce3cfc49d11c32c168ab
                          airline: FD
                          flightNum: '501'
                          equipment: 32S
                          cabinClass: ECONOMY
                          bookingCode: Z
                          availabilityCount: 5
                          departure: HKG
                          arrival: DMK
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1734244800000
                          arrivalDate: 1734252000000
                          flightTime: 180
                          codeShare: 'N'
                          fareBasis: YRT
                          strDepartureDate: '2024-12-15'
                          strDepartureTime: '14:40'
                          strArrivalDate: '2024-12-15'
                          strArrivalTime: '16:40'
                        - segmentId: f4606c103ce1eeadf38c201f6a57e031
                          airline: FD
                          flightNum: '504'
                          equipment: 32S
                          cabinClass: ECONOMY
                          bookingCode: A
                          availabilityCount: 5
                          departure: DMK
                          arrival: HKG
                          departureTerminal: '2'
                          arrivalTerminal: '1'
                          departureDate: 1735543800000
                          arrivalDate: 1735557300000
                          flightTime: 165
                          codeShare: 'N'
                          fareBasis: YRT
                          strDepartureDate: '2024-12-30'
                          strDepartureTime: '15:30'
                          strArrivalDate: '2024-12-30'
                          strArrivalTime: '19:15'
                      ancillaryAvailability:
                        paidBag: true
                        paidSeat: true
                '5':
                  summary: Success(One Way Journey VI)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      solution:
                        solutionKey: cadce3d7a693476e02a0e841d586fbcb
                        solutionId: >-
                          DMHkxtUMupBvCYeSAZKvI2XPSDdKRK2kK27eMKAEE+F2gdW8n4ZhopICv6eJNS40zcS8otwiL7wFzPBaAV7LVv2D95+F/d+5de4BWOJA5bK31lUgTmtnRxndjrSZ1zzN3Mi6x5gpdI9FeWUc7EQnsceDYXG39qudoyIneDp4SIXpUF8vpposuSdigXFrVDzpymiC438EKaAZir9UEp4DEeLyOjTCo1/PvTyURv9tRMj53bdg+S694JVZycYIq04SQ7mk2NfOZ1rVVHcNgSHvDAORkJ2rv/U9ZjzI5sLdcyS7zdu/MyOpCt3KHXet6Onr
                        fareType: PRIVATE
                        currency: USD
                        adtFare: 25.69
                        adtTax: 59.39
                        chdFare: 0
                        chdTax: 0
                        tktFee: 0
                        platformServiceFee: 0
                        journeys:
                          journey_0:
                            - 07177e6e653830b4b2e151f215c8fd19
                        platingCarrier: VJ
                        merchantFee: 0
                        adults: 1
                        children: 0
                        infants: 0
                        baggages:
                          '1':
                            carryOn: 1PC7KG
                            baggage: 0PC
                          '2':
                            carryOn: 1PC7KG
                            baggage: 0PC
                        baggageMap:
                          ADT:
                            - segmentIndexList:
                                - 1
                                - 2
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                        miniRuleMap:
                          ADT:
                            - segmentIndex:
                                - 1
                                - 2
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                        bookingWithoutCard: 1
                        category:
                          - VI
                      flights:
                        - flightId: 07177e6e653830b4b2e151f215c8fd19
                          journeyTime: 265
                          transferCount: 0
                          segmentIds:
                            - 5b6e4e840bb3321ca4ca21c422c99af6
                            - 7292bd918a99e91c03bb3323c22d99
                          selfTransferSegmentIds:
                            - 5b6e4e840bb3321ca4ca21c422c99af6
                      segments:
                        - segmentId: 5b6e4e840bb3321ca4ca21c422c99af6
                          airline: VJ
                          flightNum: '503'
                          equipment: 32S
                          cabinClass: ECONOMY
                          bookingCode: K
                          availabilityCount: 4
                          departure: HKG
                          arrival: SGN
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1734272400000
                          arrivalDate: 1734279600000
                          flightTime: 180
                          stayTime: null
                          codeShare: 'N'
                          opFltNo: null
                          opFltAirline: null
                          stopover: null
                          fareBasis: YOW
                          strDepartureDate: '2024-12-15'
                          strDepartureTime: '22:20'
                          strArrivalDate: '2024-12-16'
                          strArrivalTime: '00:20'
                        - segmentId: 7292bd918a99e91c03bb3323c22d99
                          airline: FD
                          flightNum: '665'
                          equipment: A320
                          cabinClass: ECONOMY
                          bookingCode: J
                          availabilityCount: 6
                          departure: SGN
                          arrival: DMK
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1734287400000
                          arrivalDate: 1734291900000
                          flightTime: 75
                          stayTime: null
                          codeShare: 'N'
                          opFltNo: null
                          opFltAirline: null
                          stopover: null
                          fareBasis: YOW
                          strDepartureDate: '2024-12-16'
                          strDepartureTime: '02:30'
                          strArrivalDate: '2024-12-16'
                          strArrivalTime: '03:45'
                      ancillaryAvailability:
                        paidBag: false
                        paidSeat: false
                '7':
                  summary: Success(One Way Journey Fare Family)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      solution:
                        solutionKey: cadce3d7a693476e02a0e841d586fbcb
                        solutionId: >-
                          DMHkxtUMupBvCYeSAZKvI2XPSDdKRK2kK27eMKAEE+F2gdW8n4ZhopICv6eJNS40zcS8otwiL7wFzPBaAV7LVv2D95+F/d+5de4BWOJA5bK31lUgTmtnRxndjrSZ1zzN3Mi6x5gpdI9FeWUc7EQnsceDYXG39qudoyIneDp4SIXpUF8vpposuSdigXFrVDzpymiC438EKaAZir9UEp4DEeLyOjTCo1/PvTyURv9tRMj53bdg+S694JVZycYIq04SQ7mk2NfOZ1rVVHcNgSHvDAORkJ2rv/U9ZjzI5sLdcyS7zdu/MyOpCt3KHXet6Onr
                        fareType: PRIVATE
                        currency: USD
                        adtFare: 25.69
                        adtTax: 59.39
                        chdFare: 0
                        chdTax: 0
                        tktFee: 0
                        platformServiceFee: 0
                        journeys:
                          journey_0:
                            - 07177e6e653830b4b2e151f215c8fd19
                        platingCarrier: VJ
                        merchantFee: 0
                        adults: 1
                        children: 0
                        infants: 0
                        baggages:
                          '1':
                            carryOn: 1PC7KG
                            baggage: 0PC
                          '2':
                            carryOn: 1PC7KG
                            baggage: 0PC
                        baggageMap:
                          ADT:
                            - segmentIndexList:
                                - 1
                                - 2
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                        miniRuleMap:
                          ADT:
                            - segmentIndex:
                                - 1
                                - 2
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                        bookingWithoutCard: 1
                        tag: SAVER
                        otherFareRules:
                          ADT:
                            - segmentIndexList:
                                - 1
                              detail:
                                - free meal
                      flights:
                        - flightId: 07177e6e653830b4b2e151f215c8fd19
                          journeyTime: 265
                          transferCount: 0
                          segmentIds:
                            - 5b6e4e840bb3321ca4ca21c422c99af6
                            - 7292bd918a99e91c03bb3323c22d99
                      segments:
                        - segmentId: 5b6e4e840bb3321ca4ca21c422c99af6
                          airline: VJ
                          flightNum: '503'
                          equipment: 32S
                          cabinClass: ECONOMY
                          bookingCode: K
                          availabilityCount: 4
                          departure: HKG
                          arrival: SGN
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1734272400000
                          arrivalDate: 1734279600000
                          flightTime: 180
                          stayTime: null
                          codeShare: 'N'
                          opFltNo: null
                          opFltAirline: null
                          stopover: null
                          fareBasis: YOW
                          strDepartureDate: '2024-12-15'
                          strDepartureTime: '22:20'
                          strArrivalDate: '2024-12-16'
                          strArrivalTime: '00:20'
                        - segmentId: 7292bd918a99e91c03bb3323c22d99
                          airline: FD
                          flightNum: '665'
                          equipment: A320
                          cabinClass: ECONOMY
                          bookingCode: J
                          availabilityCount: 6
                          departure: SGN
                          arrival: DMK
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1734287400000
                          arrivalDate: 1734291900000
                          flightTime: 75
                          stayTime: null
                          codeShare: 'N'
                          opFltNo: null
                          opFltAirline: null
                          stopover: null
                          fareBasis: YOW
                          strDepartureDate: '2024-12-16'
                          strDepartureTime: '02:30'
                          strArrivalDate: '2024-12-16'
                          strArrivalTime: '03:45'
                      ancillaryAvailability:
                        paidBag: false
                        paidSeat: false
                '8':
                  summary: Success(Round Trip Journey Fare Family)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      solution:
                        solutionKey: 2a6b473f599002a7fa59bc40499ea074
                        solutionId: >-
                          iXf1ufZoOsBU+MpHfwQD6vzfcE3X5BFe1Vxl3oa9iNn1Noc75XschKYpLVXfU17PcPI7oU/EVSKjQj2Xuxt9QoSJGTP7oW12BBtDUQvlAzaZ1z0zhjr4N5cJVh2fElsdEXXtCGI00H3Nvx98/d2z6lUfU0Yhuny0kj/rOz4IMMmghIhWyGDa4e4T7y3BrTjFwEPZh0nHoEykVO13sMp0vXt8ub60T12OXl9dooXkhpqN51MhNjyCkSYjIYff//DJ1cRBps9+3e58SI0ifR8P6FiCKSCYOmCQLFKKLU0P8+Xlv4BsqxNY0pdOKT7LeR3w2YGgt1zSCyEXZCwy/+BBLA66j01ytAzieUvdZ3sqLyc8+7IG23vo1JfqVtlJo/pvRdlQyp6gQGJDPraSkTCSvA==
                        fareType: PRIVATE
                        currency: USD
                        adtFare: 198.13
                        adtTax: 104.02
                        chdFare: 180.49
                        chdTax: 104.02
                        tktFee: 0
                        platformServiceFee: 0
                        journeys:
                          journey_0:
                            - 61c4b92a477da82490aee92382fb6fc9
                          journey_1:
                            - 5fb64796bcffde1c4c76af5971fa7257
                        platingCarrier: FD
                        merchantFee: 0
                        adults: 1
                        children: 1
                        infants: 0
                        baggages:
                          '1':
                            carryOn: 1PC7KG
                            baggage: 0PC
                          '2':
                            carryOn: 1PC7KG
                            baggage: 0PC
                        baggageMap:
                          ADT:
                            - segmentIndexList:
                                - 1
                                - 2
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                          CHD:
                            - segmentIndexList:
                                - 1
                                - 2
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                        miniRuleMap:
                          ADT:
                            - segmentIndex:
                                - 1
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                            - segmentIndex:
                                - 2
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                          CHD:
                            - segmentIndex:
                                - 1
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                            - segmentIndex:
                                - 2
                              miniRules:
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 0
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 1
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 0
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 0
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                                - penaltyType: 2
                                  isPermited: 0
                                  when: 1
                                - penaltyType: 3
                                  isPermited: 0
                                  when: 1
                                  noShowTime: '0'
                                  noShowTimeUnit: H
                        bookingWithoutCard: 1
                        tag: SAVER
                        otherFareRules:
                          ADT:
                            - segmentIndexList:
                                - 1
                              detail:
                                - free meal
                      flights:
                        - flightId: 61c4b92a477da82490aee92382fb6fc9
                          journeyTime: 180
                          transferCount: 0
                          segmentIds:
                            - 74a975f21ad0ce3cfc49d11c32c168ab
                        - flightId: 5fb64796bcffde1c4c76af5971fa7257
                          journeyTime: 165
                          transferCount: 0
                          segmentIds:
                            - f4606c103ce1eeadf38c201f6a57e031
                      segments:
                        - segmentId: 74a975f21ad0ce3cfc49d11c32c168ab
                          airline: FD
                          flightNum: '501'
                          equipment: 32S
                          cabinClass: ECONOMY
                          bookingCode: Z
                          availabilityCount: 5
                          departure: HKG
                          arrival: DMK
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1734244800000
                          arrivalDate: 1734252000000
                          flightTime: 180
                          codeShare: 'N'
                          fareBasis: YRT
                          strDepartureDate: '2024-12-15'
                          strDepartureTime: '14:40'
                          strArrivalDate: '2024-12-15'
                          strArrivalTime: '16:40'
                        - segmentId: f4606c103ce1eeadf38c201f6a57e031
                          airline: FD
                          flightNum: '504'
                          equipment: 32S
                          cabinClass: ECONOMY
                          bookingCode: A
                          availabilityCount: 5
                          departure: DMK
                          arrival: HKG
                          departureTerminal: '2'
                          arrivalTerminal: '1'
                          departureDate: 1735543800000
                          arrivalDate: 1735557300000
                          flightTime: 165
                          codeShare: 'N'
                          fareBasis: YRT
                          strDepartureDate: '2024-12-30'
                          strDepartureTime: '15:30'
                          strArrivalDate: '2024-12-30'
                          strArrivalTime: '19:15'
                      ancillaryAvailability:
                        paidBag: true
                        paidSeat: true
          headers: {}
          x-apifox-name: Success
        x-200:Error:
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties:
                  errorCode:
                    type: string
                  errorMsg:
                    type: string
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                x-apifox-ignore-properties: []
              examples:
                '1':
                  summary: Error(P001)
                  value:
                    errorCode: P001
                    errorMsg: '''arrivalDate'' of journeys.journey_0[0] is illegal.'
                '3':
                  summary: Error(B020)
                  value: >-
                    {
                      "errorCode": "B020",
                      "errorMsg": "Can not find any price for this flight."
                    }


                    Remark: This error occurs as the price is no longer
                    available for the particular solution. 


                    Suggestion: You could re-send the requests but setting value
                    of 'solutionId' as 000 and with empty 'bookingCode'
                    paramter, PKFARE will respond with other available solutions
                    perhaps with different booking code and price. If the new
                    solutions tackle the need, you can proceed with the new
                    bookings
                '6':
                  summary: Error(B021)
                  value: >-
                    {
                      "errorCode": "B021",
                      "errorMsg": "The booking code you choose has only 0 seat available."
                    }


                    Remark: This error occurs as the seat is no longer available
                    for the particular solution. 


                    Suggestion: You could re-send the requests but setting value
                    of 'solutionId' as 000 and with empty 'bookingCode'
                    paramter, PKFARE will respond with other available solutions
                    perhaps with different booking code and price. If the new
                    solutions tackle the need, you can proceed with the new
                    bookings
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/APIs with all versions/PrecisePricing
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469925-run
components:
  schemas:
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
          x-apifox-ignore-properties: []
      title: Authentication
      x-apifox-orders:
        - Authentication
      required:
        - Authentication
      x-apifox-ignore-properties: []
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```