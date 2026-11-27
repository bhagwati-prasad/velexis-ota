# Change Request

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/change/changeRequest:
    post:
      summary: Change Request
      deprecated: false
      description: >-
        ### Function


        This API is used for raising change request for change itineary. If you
        want to change passenger information, please read document of change
        request-change passenger information. User can indicate order number,
        voluntary type, change reason, booked itineary and new itinerary to
        create a change request. Order number is refer to PKFARE order number,
        the change is able to raise base on issued order or change order.


        ### Error Code List



        | errorCode<img width=10/>  | errorMsg                      
        |Description |

        |------- |--------- |--------- |

        |0 |ok |Request has been processed successfully. |

        |S001 |System error |System error. |

        |P001 |xxx is illegal |Parameter in the request is illegal. xxx will be
        replaced by the element name |

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

        |B167 |The change routing is not same as the routing in SolutionKey |We
        found the solutionKey in the request which routing information is
        different with requested routing. |

        |B172 |The departure date of return journey must be subsequent to the
        arrival date of outbound journey. |The departure date of return journey
        must be subsequent to the arrival date of outbound journey. |

        |B173 |Cabin class upgrading or downgrading is not allowed for
        involuntary change. |For involuntary change, the cabin class has to be
        same as booked cabin. |

        |B174 |Reason is not match with voluntary type. |Reason is not match
        with voluntary type. |

        |B175 |Reason is not match with involuntary type. |Reason is not match
        with involuntary type. |

        |B176 |Infant is not support for change. Please kindly contact online
        service for help. |Infant is not support for change. Please kindly
        contact online service for help. |

        |B178 |Request processing, please try again later |A change request is
        processing. Order is locked, other changes is rejected|
         
        ### Cabin Class



        |Value |Description |

        |------- |--------- |

        |Economy |Enconomy class |

        |PremiumEconomy |Premium Economy class |

        |Business |Business class |

        |First |First class |
      tags:
        - API Reference/Change APIs
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
                      description: Order Number
                    buyerOrder:
                      type: string
                      description: >-
                        Buyer order number. If you would like PKFARE to store
                        your order, please kindly put it in this element.
                    voluntaryType:
                      type: integer
                      description: "Voluntary type: 0 - Voluntary, 1 - Involuntary\t"
                    changeReason:
                      type: integer
                      description: "Change reason: 0 - Voluntary, 1 - Flight reschedule / cancellation, 2 - Reissue due to medical reasons, 3 - Reissue due to visa refusal, 4 - Others\t"
                    remark:
                      type: string
                      description: "Remark to support reason (maximum 500 characters)\t"
                    solutionKey:
                      type: string
                      description: >-
                        Solution key from change reshop response. If the change
                        is related to a reshop response which provided with
                        price, it is mandatory. If there is no solutionKey in
                        the response of Change Reshop, it is not required
                    uploadedFileIds:
                      type: array
                      items:
                        type: string
                      description: "Uploaded file ID(maximum 99 files per request)\t"
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
                          cardExpiredDate:
                            type: string
                            description: "Travel document expired date, which used for creating the booking\t"
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
                          - cardExpiredDate
                        x-apifox-ignore-properties: []
                      description: Passengers who you want to change
                    changeJourney:
                      type: object
                      properties:
                        journey_0:
                          type: array
                          items:
                            type: object
                            properties:
                              airline:
                                type: string
                                description: "Airline\t"
                              flightNum:
                                type: string
                                description: "Flight number\t"
                              departure:
                                type: string
                                description: "Departure airport code\t"
                              departureDate:
                                type: string
                                description: "Departure date\t"
                              departureTime:
                                type: string
                                description: "Departure time\t"
                              bookingCode:
                                type: string
                                description: "Booking Code\t"
                              cabinClass:
                                type: string
                                description: "Cabin class\t"
                              arrival:
                                type: string
                                description: "Arrival airport code\t"
                              arrivalDate:
                                type: string
                                description: "Arrival date\t"
                              arrivalTime:
                                type: string
                                description: "Arrival time\t"
                            required:
                              - airline
                              - flightNum
                              - departure
                              - departureDate
                              - departureTime
                              - bookingCode
                              - cabinClass
                              - arrival
                              - arrivalDate
                              - arrivalTime
                            x-apifox-orders:
                              - airline
                              - flightNum
                              - departure
                              - departureDate
                              - departureTime
                              - bookingCode
                              - cabinClass
                              - arrival
                              - arrivalDate
                              - arrivalTime
                            x-apifox-ignore-properties: []
                        journey_1:
                          type: array
                          items:
                            type: object
                            properties:
                              airline:
                                type: string
                                description: "Airline\t"
                              flightNum:
                                type: string
                                description: "Flight number\t"
                              departure:
                                type: string
                                description: "Departure airport code\t"
                              departureDate:
                                type: string
                                description: "Departure date\t"
                              departureTime:
                                type: string
                                description: "Departure time\t"
                              bookingCode:
                                type: string
                                description: "Booking Code\t"
                              cabinClass:
                                type: string
                                description: "Cabin class\t"
                              arrival:
                                type: string
                                description: "Arrival airport code\t"
                              arrivalDate:
                                type: string
                                description: "Arrival date\t"
                              arrivalTime:
                                type: string
                                description: "Arrival time\t"
                            required:
                              - airline
                              - flightNum
                              - departure
                              - departureDate
                              - departureTime
                              - bookingCode
                              - cabinClass
                              - arrival
                              - arrivalDate
                              - arrivalTime
                            x-apifox-orders:
                              - airline
                              - flightNum
                              - departure
                              - departureDate
                              - departureTime
                              - bookingCode
                              - cabinClass
                              - arrival
                              - arrivalDate
                              - arrivalTime
                            x-apifox-ignore-properties: []
                      x-apifox-orders:
                        - journey_0
                        - journey_1
                      description: New journey after change
                      x-apifox-ignore-properties: []
                    contactInfo:
                      type: object
                      properties:
                        name:
                          type: string
                          description: Contact name
                        telNum:
                          type: string
                          description: "Telephone number\t"
                        email:
                          type: string
                          description: "Email address\t"
                        telCode:
                          type: string
                          description: Area Code
                      x-apifox-orders:
                        - name
                        - telNum
                        - email
                        - telCode
                      description: >-
                        Contact information of this change request. If leave as
                        blank, contact of origin order will be used
                      required:
                        - name
                        - telNum
                        - email
                        - telCode
                      x-apifox-ignore-properties: []
                  required:
                    - orderNum
                    - voluntaryType
                    - changeReason
                    - passengerList
                    - changeJourney
                    - contactInfo
                  x-apifox-orders:
                    - orderNum
                    - buyerOrder
                    - voluntaryType
                    - changeReason
                    - remark
                    - solutionKey
                    - uploadedFileIds
                    - passengerList
                    - changeJourney
                    - contactInfo
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HWMHC8CPE9VNRAXM0JXW0VA1
                - data
              x-apifox-refs:
                01HWMHC8CPE9VNRAXM0JXW0VA1:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: '{{partnerId}}'
                sign: '{{sign}}'
              data:
                voluntaryType: 1
                changeReason: 1
                uploadedFileIds:
                  - 975b70c89f0ed3e3e1555729c11745eb
                  - a98c63e1f9371ccce1555729c11745eb
                changeJourney:
                  journey_0:
                    - airline: OD
                      flightNum: '606'
                      departure: HKG
                      departureDate: '2023-09-29'
                      departureTime: '15:15'
                      bookingCode: T
                      cabinClass: ECONOMY
                      arrival: KUL
                      arrivalDate: '2023-09-29'
                      arrivalTime: '19:05'
                    - airline: OD
                      flightNum: '520'
                      departure: KUL
                      departureDate: '2023-09-30'
                      departureTime: '09:55'
                      bookingCode: X
                      cabinClass: ECONOMY
                      arrival: DMK
                      arrivalDate: '2023-09-30'
                      arrivalTime: '11:05'
                  journey_1:
                    - airline: OD
                      flightNum: '521'
                      departure: DMK
                      departureDate: '2023-10-20'
                      departureTime: '11:50'
                      bookingCode: X
                      cabinClass: ECONOMY
                      arrival: KUL
                      arrivalDate: '2023-10-20'
                      arrivalTime: '15:05'
                    - airline: OD
                      flightNum: '605'
                      departure: KUL
                      departureDate: '2023-10-21'
                      departureTime: '10:15'
                      bookingCode: X
                      cabinClass: ECONOMY
                      arrival: HKG
                      arrivalDate: '2023-10-21'
                      arrivalTime: '14:15'
                buyerOrder: buyerOrder1
                solutionKey: ''
                orderNum: '916958798364810031'
                passengerList:
                  - birthday: '1999-09-09'
                    cardNum: ''
                    cardType: PP
                    firstName: yang
                    lastName: zhang
                    nationality: CN
                    sex: F
                contactInfo:
                  telNum: '15691012314'
                  name: amy
                  email: amy.zhang@pkfare.com
                  telCode: '+86'
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
                    description: Error code, refer to error code list
                  errorMsg:
                    type: string
                    description: "Error message\t"
                  data:
                    type: object
                    properties:
                      orderNum:
                        type: string
                        description: "Change order number\t"
                      parentOrderNum:
                        type: string
                        description: "PKFARE parent order number of this change order, it could be issued order number or change order number\t"
                      refOrderNum:
                        type: string
                        description: "PKFARE general order number, it may include more orders\t"
                      createTime:
                        type: string
                        description: "Order creation time, format yyyy-MM-dd HH:mm:ss(UTC+0)\t"
                      voluntaryType:
                        type: integer
                        description: "Change type: 0-voluntary, 1-involuntary\t"
                      changeReason:
                        type: integer
                        description: "Change reason: 0-Voluntary, 1-Flight reschedule / cancellation, 2-Reissue due to medical reasons, 3-Reissue due to visa refusal， 4-Others\t"
                      remark:
                        type: string
                        description: "Remark\t"
                      orderStatus:
                        type: string
                        description: Order status
                      pnr:
                        type: string
                        description: "PNR of order\t"
                      airPnr:
                        type: string
                        description: "Airline PNR of order\t"
                      platingCarrier:
                        type: string
                        description: "Plating carrier\t"
                      lastTktTime:
                        type: string
                        description: "Latest ticketing time\t"
                      solution:
                        type: object
                        properties:
                          solutionKey:
                            type: string
                            description: Unique identification of this solution
                          fareType:
                            type: string
                            description: Fare type, PUBLIC or PRIVATE
                          currency:
                            type: string
                            description: Currency code
                          changeServiceFee:
                            type: number
                            description: Change service fee per passenger
                          adtAdditionalFare:
                            type: number
                            description: Additional fare per adult
                          adtAdditionalTax:
                            type: number
                            description: Additional tax per adult
                          adtChangeFee:
                            type: number
                            description: >-
                              Adult change fee which is charged per penalty or
                              goverment in some special area
                          adtChangeAmount:
                            type: number
                            description: Total change amount per adult
                          chdAdditionalFare:
                            type: number
                            description: Additional fare per child
                          chdAdditionalTax:
                            type: number
                            description: Additional tax per child
                          chdChangeFee:
                            type: number
                            description: >-
                              Child change fee which is charged per penalty or
                              goverment in some special area
                          chdChangeAmount:
                            type: number
                            description: Total change amount per child
                          infAdditionalFare:
                            type: number
                            description: Additional fare per infant
                          infAdditionalTax:
                            type: number
                            description: Additional tax per infant
                          infChangeFee:
                            type: number
                            description: >-
                              Infant change fee which is charged per penalty or
                              goverment in some special area
                          infChangeAmount:
                            type: number
                            description: Total change amount per infant
                          totalChangeAmount:
                            type: number
                            description: Total change amount per infant
                          merchantFee:
                            type: number
                            description: Payment transaction fee
                          journeys:
                            type: object
                            properties:
                              journeys_0:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    journeyTime:
                                      type: integer
                                      description: Journey Time, Unit：minutes
                                    transferCount:
                                      type: integer
                                      description: Transfer count
                                    departureDate:
                                      type: string
                                    arrivalDate:
                                      type: string
                                    departureTime:
                                      type: string
                                    arrivalTime:
                                      type: string
                                    segments:
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
                                          equipment:
                                            type: string
                                            description: Equipment code
                                          cabinClass:
                                            type: string
                                            description: Cabin class
                                          bookingCode:
                                            type: string
                                            description: Booking code
                                          departure:
                                            type: string
                                            description: Departure airport code
                                          arrival:
                                            type: string
                                            description: Arrival airport code
                                          departureTerminal:
                                            type: string
                                            description: Departure terminal
                                          arrivalTerminal:
                                            type: string
                                            description: Arrival terminal
                                          departureDate:
                                            type: string
                                            description: >-
                                              Departure Date, format
                                              [yyyy-mm-dd]（local time）
                                          arrivalDate:
                                            type: string
                                            description: >-
                                              Arrival Date, format [yyyy-mm-dd]（local
                                              time）
                                          departureTime:
                                            type: string
                                            description: >-
                                              Departure time, format [hh:mm]（local
                                              time）
                                          arrivalTime:
                                            type: string
                                            description: >-
                                              Arrival time, format [hh:mm] （local
                                              time）
                                          flightTime:
                                            type: integer
                                            description: 'Flying time, Unit: minutes'
                                          stayTime:
                                            type: string
                                            description: 'Stay time, Unit: minutes'
                                          codeShare:
                                            type: string
                                            description: >-
                                              Code-share flight identifier [Y-Yes,
                                              N-No]
                                          opFltNo:
                                            type: string
                                            description: Operating flight number
                                          opFltAirline:
                                            type: string
                                            description: Operating airline
                                          stopover:
                                            type: string
                                            description: Stopover airport code
                                        x-apifox-orders:
                                          - airline
                                          - flightNum
                                          - equipment
                                          - cabinClass
                                          - bookingCode
                                          - departure
                                          - arrival
                                          - departureTerminal
                                          - arrivalTerminal
                                          - departureDate
                                          - arrivalDate
                                          - departureTime
                                          - arrivalTime
                                          - flightTime
                                          - stayTime
                                          - codeShare
                                          - opFltNo
                                          - opFltAirline
                                          - stopover
                                        required:
                                          - airline
                                          - flightNum
                                          - equipment
                                          - cabinClass
                                          - bookingCode
                                          - departure
                                          - arrival
                                          - departureDate
                                          - arrivalDate
                                          - departureTime
                                          - arrivalTime
                                          - flightTime
                                          - codeShare
                                        x-apifox-ignore-properties: []
                                  x-apifox-orders:
                                    - journeyTime
                                    - transferCount
                                    - departureDate
                                    - arrivalDate
                                    - departureTime
                                    - arrivalTime
                                    - segments
                                  required:
                                    - journeyTime
                                    - departureDate
                                    - arrivalDate
                                    - departureTime
                                    - arrivalTime
                                    - segments
                                  x-apifox-ignore-properties: []
                              journeys_1:
                                type: array
                                items:
                                  type: object
                                  properties: {}
                                  x-apifox-orders: []
                                  x-apifox-ignore-properties: []
                            x-apifox-orders:
                              - journeys_0
                              - journeys_1
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
                          - journeys
                        required:
                          - infAdditionalTax
                          - journeys
                        x-apifox-ignore-properties: []
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
                    x-apifox-orders:
                      - orderNum
                      - parentOrderNum
                      - refOrderNum
                      - createTime
                      - voluntaryType
                      - changeReason
                      - remark
                      - orderStatus
                      - pnr
                      - airPnr
                      - platingCarrier
                      - lastTktTime
                      - solution
                      - passengers
                    description: >-
                      The return data, this parameter is not empty only when the
                      errorCode retruns "0"
                    required:
                      - orderNum
                      - parentOrderNum
                      - refOrderNum
                      - createTime
                      - voluntaryType
                      - changeReason
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-ignore-properties: []
              examples:
                '1':
                  summary: Instant Repricing for Changes
                  value:
                    data:
                      parentOrderNum: '916958958684833601'
                      orderNum: '916958958684833602'
                      refOrderNum: '916958958684833601'
                      createTime: '2023-10-08T15:54:04+08:00'
                      voluntaryType: 1
                      changeReason: 1
                      orderStatus: To Be Paid
                      pnr: C3CV9F
                      airPnr: C3CV9F
                      platingCarrier: UO
                      lastTktTime: '2023-10-08T16:24:04+08:00'
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
                            journeyTime: 145
                            transferCount: 0
                            departureTime: '06:50'
                            arrivalTime: '10:15'
                            departureDate: '2024-03-04'
                            arrivalDate: '2024-03-04'
                            segments:
                              - airline: VJ
                                flightNum: '813'
                                equipment: '321'
                                cabinClass: ECONOMY
                                bookingCode: T
                                departure: SGN
                                arrival: SIN
                                departureTerminal: '2'
                                arrivalTerminal: '4'
                                departureDate: '2024-03-04'
                                arrivalDate: '2024-03-04'
                                departureTime: '06:50'
                                arrivalTime: '10:15'
                                flightTime: 145
                                codeShare: 'N'
                        merchantFee: 0
                        miniRuleMap:
                          CHD:
                            - miniRules: []
                              segmentIndex:
                                - '1'
                            - miniRules: []
                              segmentIndex:
                                - '2'
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
                    errorCode: '0'
                    errorMsg: ok
                '2':
                  summary: Async Repricing for Changes
                  value:
                    data:
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
                            journeyTime: 145
                            transferCount: 0
                            departureTime: '06:50'
                            arrivalTime: '10:15'
                            departureDate: '2024-03-04'
                            arrivalDate: '2024-03-04'
                            segments:
                              - airline: VJ
                                flightNum: '813'
                                equipment: '321'
                                cabinClass: ECONOMY
                                bookingCode: T
                                departure: SGN
                                arrival: SIN
                                departureTerminal: '2'
                                arrivalTerminal: '4'
                                departureDate: '2024-03-04'
                                arrivalDate: '2024-03-04'
                                departureTime: '06:50'
                                arrivalTime: '10:15'
                                flightTime: 145
                                codeShare: 'N'
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
                    errorCode: '0'
                    errorMsg: ok
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
                    description: Error code, refer to error code list
                  errorMsg:
                    type: string
                    description: Error message
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
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469947-run
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