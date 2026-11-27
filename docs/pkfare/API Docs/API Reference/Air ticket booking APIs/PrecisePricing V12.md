# PrecisePricing V12

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/precisePricing_V12:
    post:
      summary: PrecisePricing V12
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

        |PrecisePricing_V11(json
        foramt)|https://api.pkfare.com/json/precisePricing_V11|Support more
        precise structrued fare rules [miniRules] with time tiers|

        |PrecisePricing_V12(json
        foramt)|https://api.pkfare.com/json/precisePricing_V12|Validates price
        and availability for a selected or directly specified itinerary with
        Brand Fare and MultiTag support.|


        *Below is the most updated version*





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
        - API Reference/Air ticket booking APIs
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
                    brandFare:
                      type: string
                      description: >-
                        Replaces the tag field used in the previous version.
                        Specify one brand fare code recognized by PKFARE. If
                        omitted in a non-direct pricing request, PKFARE
                        validates the cached brand fare associated with the
                        solutionId
                    multiTags:
                      type: object
                      properties:
                        '{tagType}':
                          type: array
                          items:
                            type: object
                            properties:
                              tagCode:
                                type: string
                                description: >-
                                  Required. Code of the tag under the specified
                                  tagType. It must be one of the codes returned
                                  for that tagType by the PKFARE Tag Information
                                  API. Custom values are not supported.
                              constraintType:
                                type: integer
                                description: >-
                                  Required. Specifies how the tag is applied: 1
                                  means required match, 2 means preferred match,
                                  and 3 means excluded match.
                            x-apifox-orders:
                              - tagCode
                              - constraintType
                            required:
                              - tagCode
                              - constraintType
                            x-apifox-ignore-properties: []
                          description: >-
                            Type of the product tag. Both tagType and its
                            available tagCode values must follow the definitions
                            returned by the PKFARE Tag Information API. 
                      x-apifox-orders:
                        - '{tagType}'
                      description: >-
                        MultiTag information for the Pricing request. It
                        identifies the selected Shopping product for non-direct
                        pricing, or acts as the tag constraint for direct
                        pricing.
                      x-apifox-ignore-properties: []
                    returnMultiTagPrice:
                      type: string
                      description: >-
                        Set to Y to enable MultiTag price processing for direct
                        pricing requests. For non-direct pricing requests, this
                        parameter can be omitted and has no effect on the
                        pricing result.
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
                    - brandFare
                    - multiTags
                    - returnMultiTagPrice
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
                          adtTax:
                            type: number
                            description: adult tax
                          chdFare:
                            type: integer
                          chdTax:
                            type: integer
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
                            type: integer
                          platformServiceFee:
                            type: integer
                          journeys:
                            type: object
                            properties:
                              journey_0:
                                type: array
                                items:
                                  type: string
                                  description: refer to flightId
                                description: journey_0 or journey_1
                            required:
                              - journey_0
                            x-apifox-orders:
                              - journey_0
                            description: >-
                              journey_0 outboundtrip, journey_1 inbound trip,
                              refer to flightId
                            x-apifox-ignore-properties: []
                          platingCarrier:
                            type: string
                            description: ticketing airline
                          merchantFee:
                            type: integer
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
                                required:
                                  - baggage
                                  - carryOn
                                x-apifox-orders:
                                  - baggage
                                  - carryOn
                                description: >-
                                  Index of journey sequence number 1 corresponds
                                  to Journey_0, 2 corresponds to Journey_1.
                                x-apifox-ignore-properties: []
                              '2':
                                type: object
                                properties:
                                  carryOn:
                                    type: string
                                  baggage:
                                    type: string
                                required:
                                  - carryOn
                                  - baggage
                                x-apifox-orders:
                                  - carryOn
                                  - baggage
                                x-apifox-ignore-properties: []
                            required:
                              - '1'
                              - '2'
                            x-apifox-orders:
                              - '1'
                              - '2'
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
                                    baggageAmount:
                                      type: string
                                      description: >-
                                        Free baggage amount allowance. '1PC' for
                                        1 piece
                                    baggageWeight:
                                      type: string
                                      description: Free baggage weight allowance
                                    carryOnAmount:
                                      type: string
                                      description: >-
                                        Free carry-on baggage amount allowance.
                                        '1PC' for 1 piece
                                    carryOnWeight:
                                      type: string
                                      description: Free carry-on baggage weight allowance
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
                            required:
                              - ADT
                            x-apifox-orders:
                              - ADT
                            description: >-
                              Baggage rule. For reference only. Including
                              'ADT'、'CHD' and 'INF'. If the request does not
                              include children or infants, 'CHD' or 'INF' would
                              be NULL.
                            x-apifox-ignore-properties: []
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
                                          when:
                                            type: integer
                                            description: "Applicable\_situations.\_[0\_-\_Both\_Outbound\_and\_Inbound\_are\_not\_used,\_1-\_Outbound\_Flight\_used,\_2\_-\_all\_Situation]"
                                          isPermitted:
                                            type: integer
                                            description: "Volunatry Allowable/Noshow Volunatry Allowable:\_0 - Not allowed,\_1 - Allowed,\_2 - Depends on airlines"
                                          remark:
                                            type: string
                                          conditions:
                                            type: array
                                            items:
                                              type: object
                                              properties:
                                                currency:
                                                  type: string
                                                  description: Currency
                                                feeType:
                                                  type: string
                                                  description: >-
                                                    Fee Type: percent – percentage (by
                                                    default calculated based on the fare
                                                    price), fixed – fixed amount.
                                                feeValue:
                                                  type: integer
                                                  description: >-
                                                    Amount + No-show Fee Amount (if
                                                    applicable)；If feetype is percent, the
                                                    feevalue will be from 1 to 100.
                                                isPermitted:
                                                  type: integer
                                                  description: "Volunatry Allowable/Noshow Volunatry Allowable:\_0 - Not allowed,\_1 - Allowed,\_2 - Depends on airlines"
                                                timeFrom:
                                                  type: integer
                                                  description: >-
                                                    The start time of a time window always
                                                    represents the left-hand point on the
                                                    timeline. In accordance with
                                                    mathematical logic, negative values
                                                    represent time before departure,
                                                    positive values represent time after
                                                    departure, and 0 represents the
                                                    departure time
                                                timeFromUnit:
                                                  type: string
                                                  description: >-
                                                    Time unit for the start of the time
                                                    window: M – minutes, H – hours, D –
                                                    days.
                                                timeTo:
                                                  type: integer
                                                  description: "The\_start\_time\_of\_a\_time\_window\_always\_represents\_the\_left-hand\_point\_on\_the\_timeline.\_In\_accordance\_with\_mathematical\_logic,\_negative\_values\_represent\_time\_before\_departure,\_positive\_values\_represent\_time\_after\_departure,\_and\_0\_represents\_the\_departure\_time"
                                                timeToUnit:
                                                  type: string
                                                  description: >-
                                                    Time unit for the start of the time
                                                    window: M – minutes, H – hours, D –
                                                    days.
                                              required:
                                                - currency
                                                - feeType
                                                - feeValue
                                                - isPermitted
                                                - timeFrom
                                                - timeFromUnit
                                                - timeTo
                                                - timeToUnit
                                              x-apifox-orders:
                                                - currency
                                                - feeType
                                                - feeValue
                                                - isPermitted
                                                - timeFrom
                                                - timeFromUnit
                                                - timeTo
                                                - timeToUnit
                                              x-apifox-ignore-properties: []
                                        required:
                                          - penaltyType
                                          - when
                                          - isPermitted
                                          - remark
                                          - conditions
                                        x-apifox-orders:
                                          - penaltyType
                                          - when
                                          - isPermitted
                                          - remark
                                          - conditions
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
                          brandFare:
                            type: string
                            description: >-
                              Brand Fare code. This field replaces `tag` from
                              the previous version.  The brand fare
                              corresponding to the solution.
                          multiTags:
                            type: object
                            properties:
                              '{tagType}':
                                type: array
                                items:
                                  type: object
                                  properties:
                                    tagCode:
                                      type: string
                                      description: >-
                                        Required. Valid code under the specified
                                        `tagType`.
                                    tagName:
                                      type: string
                                      description: >-
                                        Required. Valid tag name under the
                                        specified `tagType`.
                                  x-apifox-orders:
                                    - tagCode
                                    - tagName
                                  required:
                                    - tagCode
                                    - tagName
                                  description: One tag constraint or selected tag item.
                                  x-apifox-ignore-properties: []
                                description: >-
                                  Product tag type defined by the PKFARE Tag
                                  Query API.
                            x-apifox-orders:
                              - '{tagType}'
                            required:
                              - '{tagType}'
                            description: >-
                              For non-direct pricing, the MultiTag snapshot of
                              the selected Shopping solution. For direct
                              pricing, the MultiTag constraints for the current
                              request. See section 3.1 for the child structure.
                            x-apifox-ignore-properties: []
                          adults:
                            type: integer
                          children:
                            type: integer
                          infants:
                            type: integer
                        required:
                          - solutionId
                          - solutionKey
                          - fareType
                          - currency
                          - adtFare
                          - adtTax
                          - chdFare
                          - chdTax
                          - tktFee
                          - platformServiceFee
                          - journeys
                          - platingCarrier
                          - merchantFee
                          - baggages
                          - baggageMap
                          - miniRuleMap
                          - bookingWithoutCard
                          - adults
                          - children
                          - infants
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
                          - brandFare
                          - multiTags
                          - adults
                          - children
                          - infants
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
                            arrivalDate:
                              type: integer
                              description: Arrival date [unix time], deprecated
                            flightTime:
                              type: integer
                              description: 'Flight time, unit: minute'
                            stayTime:
                              type: 'null'
                            codeShare:
                              type: string
                              description: 'Code share or not: [Y-yes, N-no]'
                            opFltNo:
                              type: 'null'
                            opFltAirline:
                              type: 'null'
                            stopover:
                              type: 'null'
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
                          required:
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
                        required:
                          - paidBag
                          - paidSeat
                        x-apifox-orders:
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
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Air ticket booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470820-run
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