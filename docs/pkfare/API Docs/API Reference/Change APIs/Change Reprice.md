# Change Reprice

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/change/reprice:
    post:
      summary: Change Reprice
      deprecated: false
      description: ''
      tags:
        - API Reference/Change APIs
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                data:
                  type: object
                  properties:
                    orderNum:
                      type: string
                      description: PKFARE Origin Order Number
                    voluntaryType:
                      type: integer
                      description: Voluntary type：0 - Voluntary, 1 - Involuntary
                    changeReason:
                      type: integer
                      description: >-
                        Change reason： 0-Voluntary, 1-Flight reschedule /
                        cancellation, 2-Reissue due to medical reasons,
                        3-Reissue due to visa refusal， 4-Others
                    passengerList:
                      type: array
                      items:
                        type: object
                        properties:
                          birthday:
                            type: string
                            description: Birthday
                          cardNum:
                            type: string
                            description: Travel document number
                          cardType:
                            type: string
                            description: Travel document type
                          firstName:
                            type: string
                            description: First name
                          lastName:
                            type: string
                            description: Last name
                          nationality:
                            type: string
                            description: Nationality
                          sex:
                            type: string
                            description: Gender
                        required:
                          - birthday
                          - firstName
                          - lastName
                          - nationality
                          - sex
                        x-apifox-orders:
                          - birthday
                          - cardNum
                          - cardType
                          - firstName
                          - lastName
                          - nationality
                          - sex
                      description: Passengers who you want to change
                    solutionKey:
                      type: string
                    journeys:
                      type: object
                      properties:
                        journey_x:
                          type: array
                          items:
                            type: object
                            properties:
                              airline:
                                type: string
                                description: Airline code
                              flightNum:
                                type: string
                                description: Flight No.
                              arrival:
                                type: string
                                description: Destination[IATA airport code]
                              arrivalDate:
                                type: string
                                description: Arrival Date[yyyy-mm-dd]
                              arrivalTime:
                                type: string
                                description: Arrival Time[hh:mm]
                              departure:
                                type: string
                                description: Departure[IATA airport code]
                              departureDate:
                                type: string
                                description: Departure Date[yyyy-mm-dd]
                              departureTime:
                                type: string
                                description: Departure Time[hh:mm]
                              bookingCode:
                                type: string
                                description: Cabin code
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
                              - arrivalDate
                              - arrival
                              - arrivalTime
                              - departureTime
                              - departureDate
                              - departure
                              - bookingCode
                          description: journey_0 outboundtrip, journey_1 inbound trip
                      description: 'Change reshop journey. '
                      x-apifox-orders:
                        - journey_x
                      required:
                        - journey_x
                  required:
                    - orderNum
                    - voluntaryType
                    - changeReason
                    - passengerList
                    - journeys
                    - solutionKey
                  x-apifox-orders:
                    - orderNum
                    - solutionKey
                    - voluntaryType
                    - changeReason
                    - passengerList
                    - journeys
                Authentication:
                  type: object
                  properties:
                    sign:
                      type: string
                    partnerId:
                      type: string
                  required:
                    - sign
                    - partnerId
                  x-apifox-orders:
                    - sign
                    - partnerId
              required:
                - Authentication
                - data
              x-apifox-orders:
                - Authentication
                - data
              x-apifox-refs: {}
            example:
              authentication:
                sign: '{{sign}}'
                partnerId: '{{partnerId}}'
              data:
                orderNum: '916958958684833601'
                solutionKey: de43c371998ad3b809401b78cb09f16d
                voluntaryType: 0
                changeReason: 0
                passengerList:
                  - birthday: '2003-09-28'
                    cardNum: ''
                    cardType: PP
                    firstName: yi
                    lastName: bao
                    nationality: CN
                    sex: M
                  - birthday: '2017-09-28'
                    cardNum: ''
                    cardType: PP
                    firstName: san
                    lastName: bao
                    nationality: CN
                    sex: M
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
                      flights:
                        type: array
                        items:
                          type: object
                          properties:
                            flightId:
                              type: string
                            journeyTime:
                              type: string
                            segmentIds:
                              type: array
                              items:
                                type: string
                            transferCount:
                              type: string
                          required:
                            - flightId
                            - journeyTime
                            - segmentIds
                            - transferCount
                          x-apifox-orders:
                            - flightId
                            - journeyTime
                            - segmentIds
                            - transferCount
                      passengers:
                        type: array
                        items:
                          type: object
                          properties:
                            birthday:
                              type: string
                              description: Birthday of the passenger
                            cardExpiredDate:
                              type: string
                              description: Travel document expired date
                            cardNum:
                              type: string
                              description: Travel document number
                            cardType:
                              type: string
                              description: Travel document type
                            firstName:
                              type: string
                              description: First name
                            lastName:
                              type: string
                              description: Last name
                            nationality:
                              type: string
                              description: Nationality
                            psgType:
                              type: string
                              description: Passenger type
                            sex:
                              type: string
                              description: Gender
                          required:
                            - birthday
                            - cardExpiredDate
                            - firstName
                            - lastName
                            - nationality
                            - psgType
                            - sex
                          x-apifox-orders:
                            - birthday
                            - cardExpiredDate
                            - cardNum
                            - cardType
                            - firstName
                            - lastName
                            - nationality
                            - psgType
                            - sex
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
                              description: Arrival airport code
                            arrivalDate:
                              type: string
                              description: Arrival date timestamp
                            arrivalTerminal:
                              type: string
                              description: Arrival Terminal
                            bookingCode:
                              type: string
                              description: >-
                                Booking code. It will be return along with a
                                change price. If the price is not able to be
                                returned, please refer to classCodes.
                            cabinClass:
                              type: string
                              description: Cabin class
                            codeShare:
                              type: string
                              description: >-
                                Codeshare flight flag, N - Not codeshare flight,
                                Y - Codeshare flight
                            departure:
                              type: string
                              description: Departure airport code
                            departureDate:
                              type: string
                              description: Departure date timestamp
                            departureTerminal:
                              type: string
                              description: Departure Terminal
                            equipment:
                              type: string
                              description: Equipment
                            flightNum:
                              type: string
                              description: Flight number
                            flightTime:
                              type: string
                              description: Flight time
                            opFltAirline:
                              type: string
                              description: Operation airline of codeshare flight
                            segmentId:
                              type: string
                              description: Segment ID, unique identification
                            strArrivalDate:
                              type: string
                              description: Arrival date[yyyy-MM-dd], local time
                            strArrivalTime:
                              type: string
                              description: Arrival time[HH:mm], local time
                            strDepartureDate:
                              type: string
                              description: Departure date[yyyy-MM-dd], local time
                            strDepartureTime:
                              type: string
                              description: Departure time[HH:mm], local time
                            stayTime:
                              type: string
                              description: Stay time of stopover flight
                            fareBasis:
                              type: string
                              description: >-
                                Fare basis of the price. It will be return along
                                with a change price. If the price is not able to
                                be returned, it will not return
                            classCodes:
                              type: string
                              description: >-
                                Class code of this flight. It will be return
                                when the price is not able to be returned.
                            opFltNo:
                              type: string
                              description: Operation flight number of codeshare flight
                            stopover:
                              type: string
                              description: Airport code of stopover point
                            availabilityCount:
                              type: integer
                              description: >-
                                Availablity count of booking code.  It will be
                                return along with a change price. If the price
                                is not able to be returned, please refer to
                                classCodes.
                          required:
                            - airline
                            - arrival
                            - arrivalDate
                            - codeShare
                            - departure
                            - departureDate
                            - equipment
                            - flightNum
                            - flightTime
                            - segmentId
                            - strArrivalDate
                            - strArrivalTime
                            - strDepartureDate
                            - strDepartureTime
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
                            - departureDate
                            - departureTerminal
                            - arrivalDate
                            - arrivalTerminal
                            - flightTime
                            - stayTime
                            - codeShare
                            - opFltNo
                            - opFltAirline
                            - stopover
                            - strArrivalDate
                            - strArrivalTime
                            - strDepartureDate
                            - strDepartureTime
                            - fareBasis
                            - classCodes
                      solution:
                        type: array
                        items:
                          type: object
                          properties:
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
                                      baggageAmount:
                                        type: string
                                        description: >-
                                          Free baggage amount allowance. '1PC' for
                                          1 piece
                                      baggageWeight:
                                        type: string
                                        description: Free baggage weight allownance
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
                                    required:
                                      - carryOnSize
                                  description: '''ADT''、''CHD'' OR ''INF'''
                              required:
                                - ADT
                              x-apifox-orders:
                                - ADT
                            currency:
                              type: string
                              description: Currency
                            fareType:
                              type: string
                              description: Fare type, PUBLIC or PRIVATE
                            journeys:
                              type: object
                              properties:
                                journey_1:
                                  type: array
                                  items:
                                    type: string
                                  description: >-
                                    journey_0 outboundtrip, journey_1 inbound
                                    trip
                                journey_0:
                                  type: array
                                  items:
                                    type: string
                                  description: >-
                                    journey_0 outboundtrip, journey_1 inbound
                                    trip
                              x-apifox-orders:
                                - journey_1
                                - journey_0
                              required:
                                - journey_0
                            miniRuleMap:
                              type: object
                              properties:
                                CHD:
                                  type: array
                                  items:
                                    type: object
                                    properties:
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
                                              description: >-
                                                Allow refund/change or not. [0 - not
                                                allow, 1 - allow, 2 - unknown]
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
                                              description: Penalty amount
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
                                          required:
                                            - baseType
                                      segmentIndex:
                                        type: array
                                        items:
                                          type: integer
                                    required:
                                      - miniRules
                                      - segmentIndex
                                    x-apifox-orders:
                                      - miniRules
                                      - segmentIndex
                                  description: '''ADT''、''CHD'' OR ''INF'''
                              required:
                                - CHD
                              x-apifox-orders:
                                - CHD
                            solutionKey:
                              type: string
                            changeServiceFee:
                              type: number
                              description: Change service fee per passenger
                            adtAdditionalFare:
                              type: number
                              description: Addtional fare of adult
                            adtAdditionalTax:
                              type: number
                              description: Addtional tax of adult
                            adtChangeAmount:
                              type: number
                              description: Change amount of adult
                            chdAdditionalFare:
                              type: number
                              description: Addtional fare of child
                            chdChangeFee:
                              type: number
                              description: Change fee of child
                            chdChangeAmount:
                              type: number
                              description: Change amount of child
                            infAdditionalFare:
                              type: number
                              description: Addtional fare of infant
                            infChangeFee:
                              type: number
                              description: Change fee of infant
                            infChangeAmount:
                              type: number
                              description: Change amount of infant
                            totalChangeAmount:
                              type: number
                              description: Total change amount of all passengers
                            adtChangeFee:
                              type: number
                              description: Change fee of child
                            merchantFee:
                              type: number
                              description: Payment transaction fee
                            lastTktTime:
                              type: string
                              description: Latest ticketing time
                            platingCarrier:
                              type: string
                              description: Ticketing airline
                            chdAdditionalTax:
                              type: number
                              description: Addtional tax of child
                            infAdditionalTax:
                              type: number
                              description: Addtional tax of infant
                          required:
                            - baggageMap
                            - journeys
                            - miniRuleMap
                            - solutionKey
                            - totalChangeAmount
                          x-apifox-orders:
                            - solutionKey
                            - fareType
                            - currency
                            - changeServiceFee
                            - adtAdditionalFare
                            - adtAdditionalTax
                            - adtChangeFee
                            - adtChangeAmount
                            - chdAdditionalFare
                            - chdAdditionalTax
                            - chdChangeFee
                            - chdChangeAmount
                            - infAdditionalFare
                            - infAdditionalTax
                            - infChangeFee
                            - infChangeAmount
                            - totalChangeAmount
                            - merchantFee
                            - lastTktTime
                            - platingCarrier
                            - miniRuleMap
                            - baggageMap
                            - journeys
                    required:
                      - flights
                      - solution
                      - passengers
                      - segments
                    x-apifox-orders:
                      - solution
                      - passengers
                      - flights
                      - segments
                  errorCode:
                    type: string
                  errorMsg:
                    type: string
                  rejectReason:
                    type: string
                    description: Change reject reason
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - rejectReason
                  - data
              examples:
                '1':
                  summary: Instant Repricing for Changes
                  value:
                    data:
                      flights:
                        - flightId: a26d645b1d2d5c71ba0749fa9fd96f01
                          journeyTime: '1525'
                          segmentIds:
                            - f77a96773b837d0f86d19b5458a4b9c3
                            - fa2296922596330db9db53a7e2607432
                          transferCount: '1'
                      solution:
                        adtChangeAmount: 0
                        adtChangeFee: 0
                        baggageMap:
                          ADT:
                            - baggageWeight: 20KG
                              segmentIndexList:
                                - '1'
                                - '2'
                          CHD: []
                        chdChangeAmount: 0
                        chdChangeFee: 0
                        currency: CNY
                        fareType: PUBLIC
                        journeys:
                          journey_1:
                            - a26d645b1d2d5c71ba0749fa9fd96f01
                        lastTktTime: '2023-10-07 23:59:00'
                        merchantFee: 0
                        miniRuleMap:
                          CHD:
                            - miniRules: []
                              segmentIndex:
                                - '1'
                            - miniRules: []
                              segmentIndex:
                                - '2'
                        platingCarrier: OD
                        solutionId: de43c371998ad3b809401b78cb09f16d
                        solutionKey: de43c371998ad3b809401b78cb09f16d
                        totalChangeAmount: 0
                      passengers:
                        - birthday: '2020-03-04'
                          cardExpiredDate: '2025-06-07'
                          cardNum: E12345678
                          cardType: PP
                          firstName: TIFFANY
                          lastName: YANGC
                          nationality: CN
                          psgType: CHD
                          sex: M
                        - birthday: '1990-08-23'
                          cardExpiredDate: '2024-03-17'
                          cardNum: E07700466
                          cardType: PP
                          firstName: TIFFANY
                          lastName: YANGA
                          nationality: CN
                          psgType: ADT
                          sex: M
                      segments:
                        - airline: OD
                          arrival: HKG
                          arrivalDate: '1697558400000'
                          arrivalTerminal: '2'
                          availabilityCount: 9
                          bookingCode: X
                          cabinClass: ECONOMY
                          codeShare: 'N'
                          departure: KUL
                          departureDate: '1697558400000'
                          departureTerminal: '1'
                          equipment: '738'
                          flightNum: '605'
                          flightTime: 240
                          opFltAirline: ''
                          segmentId: fa2296922596330db9db53a7e2607432
                          strArrivalDate: '2023-10-18'
                          strArrivalTime: '14:15'
                          strDepartureDate: '2023-10-18'
                          strDepartureTime: '10:15'
                        - airline: OD
                          arrival: KUL
                          arrivalDate: '1697472000000'
                          arrivalTerminal: '1'
                          availabilityCount: 9
                          bookingCode: X
                          cabinClass: ECONOMY
                          codeShare: 'N'
                          departure: DMK
                          departureDate: '1697472000000'
                          departureTerminal: '0'
                          equipment: '738'
                          flightNum: '521'
                          flightTime: 135
                          opFltAirline: ''
                          segmentId: f77a96773b837d0f86d19b5458a4b9c3
                          strArrivalDate: '2023-10-17'
                          strArrivalTime: '15:05'
                          strDepartureDate: '2023-10-17'
                          strDepartureTime: '11:50'
                    errorCode: '0'
                    errorMsg: ok
                '2':
                  summary: Async Repricing for Changes
                  value:
                    data:
                      flights:
                        - flightId: a26d645b1d2d5c71ba0749fa9fd96f01
                          journeyTime: '1525'
                          segmentIds:
                            - f77a96773b837d0f86d19b5458a4b9c3
                            - fa2296922596330db9db53a7e2607432
                          transferCount: '1'
                      solution:
                        baggageMap:
                          ADT:
                            - baggageWeight: 20KG
                              segmentIndexList:
                                - '1'
                                - '2'
                          CHD: []
                        journeys:
                          journey_1:
                            - a26d645b1d2d5c71ba0749fa9fd96f01
                        lastTktTime: '2023-10-07 23:59:00'
                        miniRuleMap:
                          CHD:
                            - miniRules: []
                              segmentIndex:
                                - '1'
                            - miniRules: []
                              segmentIndex:
                                - '2'
                        platingCarrier: OD
                        solutionKey: de43c371998ad3b809401b78cb09f16d
                      passengers:
                        - birthday: '2020-03-04'
                          cardExpiredDate: '2025-06-07'
                          cardNum: E12345678
                          cardType: PP
                          firstName: TIFFANY
                          lastName: YANGC
                          nationality: CN
                          psgType: CHD
                          sex: M
                        - birthday: '1990-08-23'
                          cardExpiredDate: '2024-03-17'
                          cardNum: E07700466
                          cardType: PP
                          firstName: TIFFANY
                          lastName: YANGA
                          nationality: CN
                          psgType: ADT
                          sex: M
                      segments:
                        - airline: OD
                          arrival: HKG
                          arrivalDate: '1697558400000'
                          arrivalTerminal: '2'
                          availabilityCount: 9
                          bookingCode: X
                          cabinClass: ECONOMY
                          codeShare: 'N'
                          departure: KUL
                          departureDate: '1697558400000'
                          departureTerminal: '1'
                          equipment: '738'
                          flightNum: '605'
                          flightTime: 240
                          opFltAirline: ''
                          segmentId: fa2296922596330db9db53a7e2607432
                          strArrivalDate: '2023-10-18'
                          strArrivalTime: '14:15'
                          strDepartureDate: '2023-10-18'
                          strDepartureTime: '10:15'
                        - airline: OD
                          arrival: KUL
                          arrivalDate: '1697472000000'
                          arrivalTerminal: '1'
                          availabilityCount: 9
                          bookingCode: X
                          cabinClass: ECONOMY
                          codeShare: 'N'
                          departure: DMK
                          departureDate: '1697472000000'
                          departureTerminal: '0'
                          equipment: '738'
                          flightNum: '521'
                          flightTime: 135
                          opFltAirline: ''
                          segmentId: f77a96773b837d0f86d19b5458a4b9c3
                          strArrivalDate: '2023-10-17'
                          strArrivalTime: '15:05'
                          strDepartureDate: '2023-10-17'
                          strDepartureTime: '11:50'
                    errorCode: '0'
                    errorMsg: ok
                '3':
                  summary: Change rejected
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    rejectReason: Insufficient necessary materials.
          headers: {}
          x-apifox-name: Success
      security: []
      x-apifox-folder: API Reference/Change APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470724-run
components:
  schemas: {}
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```