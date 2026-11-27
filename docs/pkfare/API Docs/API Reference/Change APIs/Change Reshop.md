# Change Reshop

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/change/reshop:
    post:
      summary: Change Reshop
      deprecated: false
      description: >-
        ###  Function


        This API is used for a change reshop. User can indicate order number,
        origin, destination, and departure date to check flight availability by
        using relevant parameters. Order number is refer to PKFARE order number,
        the change is able to raise base on issued order or change order.


        ### Error Code List


        |errorCode<img width=10/> |errorMessage |description |

        | :--- | :--- | :--- |

        |0        |ok |Request has been processed successfully. |

        |S001     |System error |System error. |

        |P001     |xxx is illegal |Parameter in the request is illegal. </br>xxx
        will be replaced by the element name |

        |P002 |xxx is missing |Parameter is not in the request, which is
        mandatory. xxx will be replaced by the element name. |

        |P006 |Invalid parameter |Invalid parameter. |

        |B002 |Partner is not exists |Partner is not exists. |

        |B003 |Illegal sign |Illigal sign, please check signature session |

        |B009 |Order status is invalid |Order status is not allow to change. |

        |B037 |Order is not exist. |Order number is not exists. |

        |B038 |Departure date must be today to a year. |Departure date must be
        today to a year. |

        |B048 |Invalid buyer |Buyer is invalid, please contact with PKFARE
        administrator |

        |B135 |Passenger or ticket number is not in the order |Passenger or
        ticket number in the request is not in the order. |

        |B148 |UploadedFileId is not exist. |UploadedFileIds in the request is
        not exist. |

        |B150 |The order was changed, please kindly use change order number.
        |The order was changed before. Please use the latest order number to
        raise change. |

        |B152 |pnrList information is not same as order, please kindly check.
        |pnrList information is not same as order, please kindly check. |

        |B156 |Order#[Order number] is not applicable for change |The order is
        neither origin order nor change order. Change request is not allowed. |

        |B157 |Duplicate change has been found for passenger[passenger name] in
        order [order number] |A duplicated request is found, and  order for
        previous request was created succesfully. You are able to use order
        number in the message to request OrderDetails API for more information.
        |

        |B160 |You have the option to select any day within a {x}-day window
        prior to the original departure date or {x} days window following the
        original departure date as the new departure date, but not allow change
        to {Blackout date range}. |According to airline rules, the change is
        only allowed in a time window. |

        |B162 |Change is not applicable for passenger xxx/xxx |Passenger has
        requested for void or refund, change is not allowed. |

        |B163 |Ticket(s) [ticket number] is No-show, change is not applicable.
        |The ticket is noshow per airline rules, change is not allowed. |

        |B164 |Passenger(s) must has same routing and request to change. If
        routing isvaries, please request per passenger. |One of multiple
        Passenger(s) in the request has requested to change the routing. Change
        is not allow to raise togther. |

        |B165 |Uncompleted segmentList, it should contain segments of whole
        journey |Itinerary in the request is part of the journey, change by
        segment is not support for this order. |

        |B174 |Reason is not match with voluntary type. |Reason is not match
        with voluntary type. |

        |B175 |Reason is not match with involuntary type. |Reason is not match
        with involuntary type. |

        |B176 |Infant is not support for change. Please kindly contact online
        service for help. |Infant is not support for change. Please kindly
        contact online service for help. |

         
        ### Cabin Class



        |Value               | Description     |

        | ------ | ------ |

        |Economy |Enconomy class |

        |PremiumEconomy |Premium Economy class |

        |Business |Business class |

        |First |First class |
      tags:
        - API Reference/Change APIs
        - V2
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
                data:
                  type: object
                  properties:
                    orderNum:
                      type: string
                      description: "Order Number\t"
                    voluntaryType:
                      type: integer
                      description: 'Voluntary type: 0 - Voluntary, 1 - Involuntary'
                    changeReason:
                      type: integer
                      description: >-
                        Change reason: 0 - Voluntary, 1 - Flight reschedule /
                        cancellation, 2 - Reissue due to medical reasons, 3 -
                        Reissue due to visa refusal, 4 - Others
                    passengerList:
                      type: array
                      items:
                        type: object
                        properties:
                          lastName:
                            type: string
                            description: Last name
                          firstName:
                            type: string
                            description: First name
                          nationality:
                            type: string
                            description: "Nationality\t"
                          sex:
                            type: string
                            description: Gender
                          birthday:
                            type: string
                            description: "Date of birth[YYYY-MM-DD]\t"
                          cardType:
                            type: string
                            description: "Travel document type, which used for creating the booking.\t"
                          cardNum:
                            type: string
                            description: "Travel document number, which used for creating the booking.\t"
                        required:
                          - lastName
                          - firstName
                          - nationality
                          - sex
                          - birthday
                        x-apifox-orders:
                          - lastName
                          - firstName
                          - nationality
                          - sex
                          - birthday
                          - cardType
                          - cardNum
                        x-apifox-ignore-properties: []
                      description: Passengers who you want to change
                    changeAirLegs:
                      type: array
                      items:
                        type: object
                        properties:
                          journeySeq:
                            type: integer
                            description: "Journey sequences, 0 for outbound journey, 1 for inbound journey\t"
                          cabinClass:
                            type: string
                            description: Cabin class
                          airportOrCity:
                            type: integer
                            description: "Indicated the destination or origin is by airport or by city: 0-City, 1-Airport\t"
                          destination:
                            type: string
                            description: "Destination - 3 letters IATA city or airport code\t"
                          origin:
                            type: string
                            description: "Origin - 3 letters IATA city or airport code\t"
                          departureDate:
                            type: string
                            description: "Departure date\t"
                        required:
                          - journeySeq
                          - airportOrCity
                          - destination
                          - origin
                          - departureDate
                        x-apifox-orders:
                          - journeySeq
                          - cabinClass
                          - airportOrCity
                          - destination
                          - origin
                          - departureDate
                        x-apifox-ignore-properties: []
                      description: New journey after change
                  required:
                    - orderNum
                    - voluntaryType
                    - changeReason
                    - passengerList
                    - changeAirLegs
                  x-apifox-orders:
                    - orderNum
                    - voluntaryType
                    - changeReason
                    - passengerList
                    - changeAirLegs
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HWHZSHQCCCRQD8QRGYY2VYFQ
                - data
              x-apifox-refs:
                01HWHZSHQCCCRQD8QRGYY2VYFQ:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: '{{sign}}'
                partnerId: '{{partnerId}}'
              data:
                orderNum: '916958958684833601'
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
                changeAirLegs:
                  - journeySeq: 0
                    airportOrCity: 1
                    destination: BKK
                    origin: HKG
                    departureDate: '2024-10-07'
                  - journeySeq: 1
                    airportOrCity: 1
                    destination: HKG
                    origin: BKK
                    departureDate: '2024-10-20'
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
                    description: 'Error code, refer to error code list '
                  errorMsg:
                    type: string
                    description: Error message
                  rejectReason:
                    type: string
                    description: "Warning message\t"
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
                              description: Journey ID，unique identification
                            journeyTime:
                              type: string
                              description: "Journey time, unit: minute\t"
                            segmentIds:
                              type: array
                              items:
                                type: string
                              description: Segment ID list
                            transferCount:
                              type: string
                              description: "Transfer count\t"
                          x-apifox-orders:
                            - flightId
                            - journeyTime
                            - segmentIds
                            - transferCount
                          x-apifox-ignore-properties: []
                        description: "Journey information\t"
                      solutions:
                        type: array
                        items:
                          type: object
                          properties:
                            solutionKey:
                              type: string
                              description: "Unique identification of this solution\t"
                            fareType:
                              type: string
                              description: Fare type, PUBLIC or PRIVATE
                            currency:
                              type: string
                              description: "Currency code\t"
                            changeServiceFee:
                              type: number
                              description: "Change service fee per passenger\t"
                            adtAdditionalFare:
                              type: number
                              description: "Additional fare per adult\t"
                            adtAdditionalTax:
                              type: number
                              description: "Additional tax per adult\t"
                            adtChangeFee:
                              type: number
                              description: "Adult change fee which is charged per penalty or goverment in some special area\t"
                            adtChangeAmount:
                              type: number
                              description: "Total change amount per adult\t"
                            "chdAdditionalFare\t":
                              type: number
                              description: "Additional fare per child\t"
                            chdAdditionalTax:
                              type: number
                              description: "Additional tax per child\t"
                            chdChangeFee:
                              type: number
                              description: "Child change fee which is charged per penalty or goverment in some special area\t"
                            chdChangeAmount:
                              type: number
                              description: "Total change amount per child\t"
                            infAdditionalFare:
                              type: number
                              description: "Additional fare per infant\t"
                            infAdditionalTax:
                              type: number
                              description: "Additional tax per infant\t"
                            infChangeFee:
                              type: number
                              description: "Infant change fee which is charged per penalty or goverment in some special area\t"
                            infChangeAmount:
                              type: number
                              description: "Total change amount per infant\t"
                            totalChangeAmount:
                              type: number
                              description: "Total change amount of this change request\t"
                            merchantFee:
                              type: number
                              description: "Payment transaction fee\t"
                            lastTktTime:
                              type: string
                              description: "Latest ticketing time\t"
                            platingCarrier:
                              type: string
                              description: "Ticketing airline\t"
                            journeys:
                              type: object
                              properties:
                                journey_1:
                                  type: array
                                  items:
                                    type: string
                                journey_0:
                                  type: array
                                  items:
                                    type: string
                              required:
                                - journey_1
                                - journey_0
                              x-apifox-orders:
                                - journey_1
                                - journey_0
                              description: Changable journey infomration of the price
                              x-apifox-ignore-properties: []
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
                                              description: "Penalty type: 0-refund, 1-noShow refund, 2-change, 3-noShow change\t"
                                            isPermited:
                                              type: integer
                                              description: "Allow refund/change or not; 0-not allow, 1-allow, 2-unknown\t"
                                            when:
                                              type: integer
                                              description: "Appropriate situationL 0-Both Outbound and inbound are not used, 1-Outbound flight used, 2-All situation\t"
                                            noShowTime:
                                              type: string
                                              description: "NoShow definition. Apply with 'noShowTimeUnit'\t"
                                            noShowTimeUnit:
                                              type: string
                                              description: "NoShow unit. Apply with 'noShowTime': H-hour, M-minute\t"
                                            amount:
                                              type: number
                                              description: "Penalty amount\t"
                                            currencyCode:
                                              type: string
                                              description: "Penalty currency code\t"
                                            percent:
                                              type: number
                                              description: "Penalty percentage. Apply with 'baseType'. Penalty and penalty percentage would not go into effect at the same. Please take the strict one. Unit:%\t"
                                            baseType:
                                              type: integer
                                              description: "Apply with 'percent'. Multiply corresponding value of 'baseType' by 'percent' would be penalty. 0-fare, 1-fare+taxes+ticketing fee, 2-cabin basic fare\t"
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
                                        description: "Mini-rules information\t"
                                      segmentIndex:
                                        type: array
                                        items:
                                          type: string
                                        description: >-
                                          egment index list for mini-rule. Index
                                          begins with "1". If 1st segment has same
                                          rules allowance with 3rd segment, please
                                          refer to sample
                                    x-apifox-orders:
                                      - miniRules
                                      - segmentIndex
                                    x-apifox-ignore-properties: []
                                  description: '''ADT''、''CHD'' OR ''INF'''
                              x-apifox-orders:
                                - CHD
                              description: >-
                                Penalty rule. For reference only, please find
                                precise penalty rule on Penalty API.
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
                                          type: string
                                        description: >-
                                          Segment index list for baggage. Index
                                          begins with "1". If 1st segment has same
                                          baggage allowance with 3rd segment,
                                          please refer to sample
                                      baggageWeight:
                                        type: string
                                        description: "Free baggage weight allownance\t"
                                      baggageAmount:
                                        type: string
                                        description: "Free baggage amount allowance. '1PC' for 1 piece\t"
                                      carryOnAmount:
                                        type: string
                                        description: "Free carry-on baggage amount allownance. '1PC' for 1 piece\t"
                                      carryOnWeight:
                                        type: string
                                        description: "Free carry-on baggage weight allownance\t"
                                      carryOnSize:
                                        type: array
                                        items:
                                          type: string
                                        description: >-
                                          Carry-on Baggage Dimensions [Length,
                                          Width, Height] in centimeters
                                    x-apifox-orders:
                                      - segmentIndexList
                                      - baggageWeight
                                      - baggageAmount
                                      - carryOnAmount
                                      - carryOnWeight
                                      - carryOnSize
                                    required:
                                      - carryOnSize
                                    x-apifox-ignore-properties: []
                              x-apifox-orders:
                                - ADT
                              description: >-
                                Baggage allowance for reference only. Including
                                'ADT' and 'CHD'. If the request does not include
                                children, 'CHD' would be NULL.
                              x-apifox-ignore-properties: []
                          x-apifox-orders:
                            - solutionKey
                            - fareType
                            - currency
                            - changeServiceFee
                            - adtAdditionalFare
                            - adtAdditionalTax
                            - adtChangeFee
                            - adtChangeAmount
                            - "chdAdditionalFare\t"
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
                            - journeys
                            - miniRuleMap
                            - baggageMap
                          x-apifox-ignore-properties: []
                        description: Passenger pricing information
                      passengers:
                        type: array
                        items:
                          type: object
                          properties:
                            lastName:
                              type: string
                              description: Last name
                            firstName:
                              type: string
                              description: "First name\t"
                            cardType:
                              type: string
                              description: "Travel document type\t"
                            cardNum:
                              type: string
                              description: "Travel document number\t"
                            cardExpiredDate:
                              type: string
                              description: "Travel document expired date\t"
                            nationality:
                              type: string
                              description: "Nationality\t"
                            psgType:
                              type: string
                              description: "Passenger type\t"
                            sex:
                              type: string
                              description: Gender
                            birthday:
                              type: string
                              description: "Date of birth\t"
                          x-apifox-orders:
                            - lastName
                            - firstName
                            - cardType
                            - cardNum
                            - cardExpiredDate
                            - nationality
                            - psgType
                            - sex
                            - birthday
                          x-apifox-ignore-properties: []
                        description: "Passenger information\t"
                      segments:
                        type: array
                        items:
                          type: object
                          properties:
                            segmentId:
                              type: string
                              description: "Segment ID, unique identification\t"
                            airline:
                              type: string
                              description: "Airline code [IATA airline code]\t"
                            flightNum:
                              type: string
                              description: "Flight Number\t"
                            equipment:
                              type: string
                              description: Equipment
                            cabinClass:
                              type: string
                              description: Cabin class
                            bookingCode:
                              type: string
                              description: >-
                                Booking code. It will be return along with a
                                change price. If the price is not able to be
                                returned, please refer to classCodes
                            availabilityCount:
                              type: integer
                              description: "Availability count of booking code. It will be return along with a change price. If the price is not able to be returned, please refer to classCodes\t"
                            departure:
                              type: string
                              description: "Departure airport code\t"
                            arrival:
                              type: string
                              description: "Arrival airport code\t"
                            departureTerminal:
                              type: string
                              description: "Departure terminal\t"
                            arrivalTerminal:
                              type: string
                              description: "Arrival terminal\t"
                            departureDate:
                              type: string
                              description: Departure date [unix time]
                            strDepartureDate:
                              type: string
                              description: "Departure date [yyyy-mm-dd], local time of departure city\t"
                            strDepartureTime:
                              type: string
                              description: "Departure time [hh:mm], local time of departure city\t"
                            arrivalDate:
                              type: string
                              description: "Arrival date [unix time]\t"
                            strArrivalDate:
                              type: string
                              description: "Arrival date [yyyy-mm-dd], local time of arrival city\t"
                            strArrivalTime:
                              type: string
                              description: "Arrival time [hh:mm], local time of arrival city\t"
                            flightTime:
                              type: integer
                              description: "Flight time, unit: minute\t"
                            stayTime:
                              type: integer
                              description: "Stay time, valid with 'stopover', unit: minute\t"
                            codeShare:
                              type: string
                              description: "Code share flight or not [Y - Yes, N - No]\t"
                            opFltNo:
                              type: string
                              description: "Flight number of operated carrier. It will not return if the flight is not a code share flight\t"
                            opFltAirline:
                              type: string
                              description: "Operated carrier. It will not return if the flight is not a code share flight\t"
                            stopover:
                              type: string
                              description: "Stopover airport [IATA airport code]. It will not return if there is no stopover\t"
                            fareBasis:
                              type: string
                              description: "Fare basis of the price. It will be return along with a change price. If the price is not able to be returned, it will not return\t"
                            classCodes:
                              type: string
                              description: >-
                                Class code of this flight. It will be return
                                when the price is not able to be returned.
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
                            - strDepartureDate
                            - strDepartureTime
                            - arrivalDate
                            - strArrivalDate
                            - strArrivalTime
                            - flightTime
                            - stayTime
                            - codeShare
                            - opFltNo
                            - opFltAirline
                            - stopover
                            - fareBasis
                            - classCodes
                          x-apifox-ignore-properties: []
                        description: Flight information
                    x-apifox-orders:
                      - flights
                      - solutions
                      - passengers
                      - segments
                    description: >-
                      The return data, this parameter is not empty only when the
                      errorCode retruns "0"
                    x-apifox-ignore-properties: []
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - rejectReason
                  - data
                x-apifox-ignore-properties: []
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
                        - flightId: 6815cbebca0cf5ba590967ee438d573d
                          journeyTime: '1145'
                          segmentIds:
                            - 370004a702073eeec91c6e4324d0fc39
                            - fa2296922596330db9db53a7e2607432
                          transferCount: '1'
                        - flightId: 14c6b6bf0287e9705a04e7665e120f95
                          journeyTime: '1690'
                          segmentIds:
                            - 4bd7b30e064883d5f76045ecd5d1dddb
                            - fa2296922596330db9db53a7e2607432
                          transferCount: '1'
                      solutions:
                        - adtChangeAmount: 0
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
                          solutionKey: de43c371998ad3b809401b78cb09f16d
                          totalChangeAmount: 0
                        - adtChangeAmount: 0
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
                              - 6815cbebca0cf5ba590967ee438d573d
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
                          solutionId: a211f7574da54aae7d0a6f0bbf5742c6
                          solutionKey: a211f7574da54aae7d0a6f0bbf5742c6
                          totalChangeAmount: 0
                        - adtChangeAmount: 0
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
                              - 14c6b6bf0287e9705a04e7665e120f95
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
                          solutionId: 0c62b654ef24bbb8dd4c6295bf34198c
                          solutionKey: 0c62b654ef24bbb8dd4c6295bf34198c
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
                          flightNum: '525'
                          flightTime: 135
                          opFltAirline: ''
                          segmentId: 4bd7b30e064883d5f76045ecd5d1dddb
                          strArrivalDate: '2023-10-17'
                          strArrivalTime: '12:20'
                          strDepartureDate: '2023-10-17'
                          strDepartureTime: '09:05'
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
                          flightNum: '523'
                          flightTime: 135
                          opFltAirline: ''
                          segmentId: 370004a702073eeec91c6e4324d0fc39
                          strArrivalDate: '2023-10-17'
                          strArrivalTime: '21:25'
                          strDepartureDate: '2023-10-17'
                          strDepartureTime: '18:10'
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
                        - flightId: 6815cbebca0cf5ba590967ee438d573d
                          journeyTime: '1145'
                          segmentIds:
                            - 370004a702073eeec91c6e4324d0fc39
                            - fa2296922596330db9db53a7e2607432
                          transferCount: '1'
                        - flightId: 14c6b6bf0287e9705a04e7665e120f95
                          journeyTime: '1690'
                          segmentIds:
                            - 4bd7b30e064883d5f76045ecd5d1dddb
                            - fa2296922596330db9db53a7e2607432
                          transferCount: '1'
                      solutions:
                        - baggageMap:
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
                        - adtChangeAmount: 0
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
                              - 6815cbebca0cf5ba590967ee438d573d
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
                          solutionId: a211f7574da54aae7d0a6f0bbf5742c6
                          solutionKey: a211f7574da54aae7d0a6f0bbf5742c6
                          totalChangeAmount: 0
                        - adtChangeAmount: 0
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
                              - 14c6b6bf0287e9705a04e7665e120f95
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
                          solutionId: 0c62b654ef24bbb8dd4c6295bf34198c
                          solutionKey: 0c62b654ef24bbb8dd4c6295bf34198c
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
                          flightNum: '525'
                          flightTime: 135
                          opFltAirline: ''
                          segmentId: 4bd7b30e064883d5f76045ecd5d1dddb
                          strArrivalDate: '2023-10-17'
                          strArrivalTime: '12:20'
                          strDepartureDate: '2023-10-17'
                          strDepartureTime: '09:05'
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
                          flightNum: '523'
                          flightTime: 135
                          opFltAirline: ''
                          segmentId: 370004a702073eeec91c6e4324d0fc39
                          strArrivalDate: '2023-10-17'
                          strArrivalTime: '21:25'
                          strDepartureDate: '2023-10-17'
                          strDepartureTime: '18:10'
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
        x-200:Error:
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties:
                  errorCode:
                    type: string
                    description: error code
                  errorMsg:
                    type: string
                    description: error message
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                x-apifox-ignore-properties: []
              example:
                errorCode: B155
                errorMsg: Change function is offline, please contact PKFARE.
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Change APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469946-run
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