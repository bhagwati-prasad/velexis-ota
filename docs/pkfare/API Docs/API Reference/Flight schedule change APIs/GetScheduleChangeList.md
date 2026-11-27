# GetScheduleChangeList

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/scheduleChange/getScheduleChangeList:
    post:
      summary: GetScheduleChangeList
      deprecated: false
      description: >-
        ### Function Description

        After the order is generated, the airline may send the flight change
        information. Types of message include:


        Flight cancelled


        Flight cancelled, with protected flight(s)


        Flight schedule changed, it could be time change, equipment change,
        terminal change, etc.


        Through GetScheduleChangeList API, you are able to request by a time
        schedule to get the schedule change information.

        Note When you requested AcknowledageScheduleChange and
        AcceptScheduleChange API, we will clear this message. Then, you will not
        get same message again.

        Note If the flight has token off, the message will be cleared
        automatically. So you will not get its message.

        Note If you request with a order number to get schedule change
        information, we will response the message for this order only. In this
        case, you has a order for issuing ticket, then passenger requested to
        change, you will got the second order which is change order. Multiple
        Schedule change messages existed and belongs to two orders. If you want
        to receive all messages of 1 request by indicating the order number for
        issuing ticket, you may contact PKFARE's implementor to change the
        setting.

        Note To limited the size of response, the duration of
        "messageCreateTimeStart" and "messageCreateTimeEnd" should be within 24
        hours.


        ###  Appendix

        ####  Error Code List

        |   errorCode       |   errorMsg                        |   
        Description                             |

        |----|----|----|

        |   0               |   ok                                            
        |   Request has been processed successfully.                       |

        |   S001            |   System error                                  
        |   System error.                          |

        |   P001            |   xxx is illegal                          |  
        Request parameter is illegal, xxx will display request
        parameter           |

        |   B002            |   Partner is not
        exists                                 |   Partner does not
        exist.                    |

        |   B003            |   Illegal sign                                  
        |   Illegal sign.               |

        | B035      |Concurrency limited. Please contact PKFARE API support team
        for assistant.| Concurrent users contral. Please contact PKFARE API
        support for assistant.|

        |   B037            |    Order is not exist.       |   Order does not
        exist.                 |

        |   B048            |    Invalid buyer       |   Buyer is
        invalid.                 |

        |   B130            |    Message is not exist.       |   Schedule change
        message does not exist.                 |


        ####  Cabin Class

        | Enum   | Description   |

        |----|----|

        |   ECONOMY              |  Economy Class         |

        |   PREMIUM ECONOMY       |   Premium Economy Class       |

        |   BUSINESS             |   Business Class         |

        |   FIRST                |   First Class         |


        #### Type of Travel Document

        | Enum   | Description   |

        |----|----|

        |  P       |  Passport    |

        |  N       |  Chinese Identity    |

        |  O       | Others    |


        #### Passenger Type

        | Enum   | Description   |

        |----|----|

        |  ADT     |  adult         |

        |  CHD     |  children[2-12 years old]  |


        #### Gender

        | Enum   | Description   |

        |----|----|

        |  M       |  Male    |

        |  F       |  Female    |
      tags:
        - API Reference/Flight schedule change APIs
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
                    messageId:
                      type: string
                      description: "PKFARE message ID. You can get specific message by indicating the messageId\t"
                    orderNum:
                      type: string
                      description: "PKFARE order number\t"
                    messageType:
                      type: string
                      description: |-
                        Message type: 
                        1-Flight changed 
                        2-Flight canceled with protect flight 
                        3-Flight canceled 
                        4-Flight resumed. 
                        5- Flight overbooking. 
                        You can speicfic a message type to get the message list.
                    sensitivityLevel:
                      type: string
                      description: >-
                        Message sensitivity level:

                        0-This level is not eligible to request involuntary
                        refund or changes, and it is not required to be accepted
                        by passenger.

                        1-This level may not be eligible to request involuntary
                        refund or changes, but it is required to be accepted by
                        passenger.

                        2-This level is eligible to request involuntary refund
                        or changes and it is required to be accepted by
                        passenger.

                        You can spcific a sensitivity level to get the message
                        list.
                    messageCreateTimeStart:
                      type: string
                      description: >-
                        Schedule change message create time,[yyyy-mm-dd
                        hh:mm:ss]. You can get message list which created in a
                        time duration, this element is start time. The time is
                        refer to Beijing time, which timezone is at GMT+8.
                    messageCreateTimeEnd:
                      type: string
                      description: "Schedule change message create time,[yyyy-mm-dd hh:mm:ss]. You can get message list which created in a time duration, this element is end time. The time is refer to Beijing time, which timezone is at GMT+8.\t"
                  required:
                    - messageCreateTimeStart
                    - messageCreateTimeEnd
                  x-apifox-orders:
                    - messageId
                    - orderNum
                    - messageType
                    - sensitivityLevel
                    - messageCreateTimeStart
                    - messageCreateTimeEnd
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HW7R00NKCN4405CQ807G8SDQ
                - data
              x-apifox-refs:
                01HW7R00NKCN4405CQ807G8SDQ:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example: ''
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
                    description: Error Code
                  errorMsg:
                    type: string
                    description: Error Message
                  data:
                    type: array
                    items:
                      type: object
                      properties:
                        orderNum:
                          type: string
                          description: PKFARE order number
                        buyerOrder:
                          type: string
                          description: "Buyer partner's order number. If you would like to receive a buyerOrder, please send it in the request of preciseBooking API. The buyer order number will be record and send it back when schedule change happened.\t"
                        messageId:
                          type: string
                          description: "PKFARE message id\t"
                        messageCreateTime:
                          type: string
                          description: >-
                            Schedule change message create time [ yyyy-mm-dd
                            hh:mm:ss(GMT+8)]
                        sensitivityLevel:
                          type: string
                          description: >-
                            Message sensitivity level: 0-This level is not
                            eligible to request involuntary refund or changes,
                            and it is not required to be accepted by passenger.
                            1-This level may not be eligible to request
                            involuntary refund or changes, but it is required to
                            be accepted by passenger. 2-This level is eligible
                            to request involuntary refund or changes and it is
                            required to be accepted by passenger.
                        orderPnr:
                          type: string
                          description: >-
                            PNR of this order, the booking reference of
                            reservation system
                        orderAirlinePnr:
                          type: string
                          description: "Airline PNR of this order, the booking reference of airline system\t"
                        pnrList:
                          type: array
                          items:
                            type: object
                            properties:
                              segmentNo:
                                type: integer
                                description: "The segment sequency of the journey\t"
                              departure:
                                type: string
                                description: "Departure airport code, 3 letters IATA code\t"
                              arrival:
                                type: string
                                description: "Arrival airport code, 3 letters IATA code\t"
                              flightNum:
                                type: string
                                description: "Flight number, format:Airline code and flight number\t"
                              cabinClass:
                                type: string
                                description: >-
                                  Cabin class [ECONOMY, PREMIUM ECONOMY,
                                  BUSINESS, FIRST]
                              bookingCode:
                                type: string
                                description: "Booking code\t"
                              pnr:
                                type: string
                                description: "PNR of this segment, the booking reference of reservation system. It will be blank if the reservation made for the whole order.\t"
                              airPnr:
                                type: string
                                description: "PNR of this segment, the booking reference of airline system. It will be blank if the reservation made for the whole order.\t"
                              ticketNums:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    ticketNum:
                                      type: string
                                      description: "Ticket number\t"
                                    lastName:
                                      type: string
                                      description: "Last name\t"
                                    firstName:
                                      type: string
                                      description: "First name\t"
                                    birthday:
                                      type: string
                                      description: "Date of birth [yyyy-mm-dd]\t"
                                    sex:
                                      type: string
                                      description: Gender, M - male, F - Female.
                                    cardType:
                                      type: string
                                      description: >-
                                        Travel document
                                        type,[P-Passport,N-Chinese Identity

                                        , O-Others]
                                    cardNum:
                                      type: string
                                      description: Travel document number
                                  required:
                                    - lastName
                                    - firstName
                                    - birthday
                                    - sex
                                  x-apifox-orders:
                                    - ticketNum
                                    - lastName
                                    - firstName
                                    - birthday
                                    - sex
                                    - cardType
                                    - cardNum
                                  x-apifox-ignore-properties: []
                                description: Passesger and ticket number information
                            required:
                              - segmentNo
                              - departure
                              - arrival
                              - flightNum
                              - cabinClass
                              - bookingCode
                            x-apifox-orders:
                              - segmentNo
                              - departure
                              - arrival
                              - flightNum
                              - cabinClass
                              - bookingCode
                              - pnr
                              - airPnr
                              - ticketNums
                            x-apifox-ignore-properties: []
                          description: PNR List of this order.
                        passengers:
                          type: array
                          items:
                            type: object
                            properties:
                              lastName:
                                type: string
                                description: "Last name\t"
                              firstName:
                                type: string
                                description: "First name\t"
                              birthday:
                                type: string
                                description: "Date of birth [yyyy-mm-dd]\t"
                              sex:
                                type: string
                                description: "Gender, M - male, F - Female. Refer to 5.5\t"
                              psgType:
                                type: string
                                description: 'ADT - adult, CHD - child , INF-Infant. '
                              cardType:
                                type: string
                                description: >-
                                  Travel document type,[P-Passport,N-Chinese
                                  Identity , O-Others]
                              cardNum:
                                type: string
                                description: "Travel document number\t"
                              cardExpiredDate:
                                type: string
                                description: Travel document expiration date, [yyyy-mm-dd]
                              nationality:
                                type: string
                                description: >-
                                  Nationality of the passenger, 2 letters
                                  country code
                              ticketNum:
                                type: string
                                description: >-
                                  Ticket number. If multiple ticket numbers, it
                                  will be separted by slash[/]
                            x-apifox-orders:
                              - lastName
                              - firstName
                              - birthday
                              - sex
                              - psgType
                              - cardType
                              - cardNum
                              - cardExpiredDate
                              - nationality
                              - ticketNum
                            required:
                              - lastName
                              - firstName
                              - psgType
                            x-apifox-ignore-properties: []
                          description: passengers of this order.
                        originFlightList:
                          type: array
                          items:
                            type: object
                            properties:
                              journeySeq:
                                type: string
                                description: >-
                                  Journey sequency, outbound refer to 1, inbound
                                  refer to 2.
                              segments:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    airline:
                                      type: string
                                      description: "Airline code\t"
                                    flightNum:
                                      type: string
                                      description: "Flight number\t"
                                    equipment:
                                      type: string
                                      description: "Equipment code\t"
                                    cabinClass:
                                      type: string
                                      description: >-
                                        Cabin class [ECONOMY, PREMIUM ECONOMY,
                                        BUSINESS, FIRST]
                                    bookingCode:
                                      type: string
                                      description: "Booking code\t"
                                    departure:
                                      type: string
                                      description: "Departure airport code, 3 letters IATA code\t"
                                    arrival:
                                      type: string
                                      description: "Arrival airport code, 3 letters IATA code\t"
                                    departureTerminal:
                                      type: string
                                      description: Departure terminal
                                    "arrivalTerminal\t":
                                      type: string
                                      description: "Arrival terminal\t"
                                    departureDate:
                                      type: string
                                      description: >-
                                        Departure date, [yyyy-mm-dd], local time
                                        of departure city
                                    arrivalDate:
                                      type: string
                                      description: "Arrival date, [yyyy-mm-dd], local time of arrival city\t"
                                    departureTime:
                                      type: string
                                      description: "Departure time, [hh:mm],local time of departure city\t"
                                    arrivalTime:
                                      type: string
                                      description: "Arrival time, [hh:mm], local time of arrival city\t"
                                    flightTime:
                                      type: integer
                                      description: "Flight time, unit: minutes\t"
                                    stayTime:
                                      type: integer
                                      description: "Stay time for stopover flight, unit: minutes\t"
                                    codeShare:
                                      type: string
                                      description: >-
                                        Code share flight flag, Y - Code share
                                        flight, N - Not code share flight
                                    opFltNo:
                                      type: string
                                      description: "Operation flight number\t"
                                    opFltAirline:
                                      type: string
                                      description: "Operation airline\t"
                                    stopover:
                                      type: string
                                      description: >-
                                        Stopover airport code, 3 letters IATA
                                        code
                                    messageType:
                                      type: string
                                      description: >-
                                        Message type: 

                                        1-Flight changed 

                                        2-Flight canceled with protect flight 

                                        3-Flight canceled 

                                        4-Flight resumed. 

                                        5- Flight overbooking. 

                                        For type 3, 4 and 5, there is no
                                        ChangeFlightList information.
                                  required:
                                    - airline
                                    - flightNum
                                    - cabinClass
                                    - bookingCode
                                    - departure
                                    - arrival
                                    - departureDate
                                    - arrivalDate
                                    - departureTime
                                    - arrivalTime
                                  x-apifox-orders:
                                    - airline
                                    - flightNum
                                    - equipment
                                    - cabinClass
                                    - bookingCode
                                    - departure
                                    - arrival
                                    - departureTerminal
                                    - "arrivalTerminal\t"
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
                                    - messageType
                                  x-apifox-ignore-properties: []
                                description: flight information.
                            x-apifox-orders:
                              - journeySeq
                              - segments
                            x-apifox-ignore-properties: []
                          description: >-
                            Journey and segment information before this schedule
                            change.
                        changeFlightList:
                          type: array
                          items:
                            type: object
                            properties:
                              journeySeq:
                                type: string
                                description: >-
                                  Journey sequency, outbound refer to 1, inbound
                                  refer to 2.
                              segments:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    airline:
                                      type: string
                                      description: "Airline code\t"
                                    flightNum:
                                      type: string
                                      description: "Flight number\t"
                                    equipment:
                                      type: string
                                      description: "Equipment code\t"
                                    cabinClass:
                                      type: string
                                      description: >-
                                        Cabin class [ECONOMY, PREMIUM ECONOMY,
                                        BUSINESS, FIRST]
                                    bookingCode:
                                      type: string
                                      description: "Booking code\t"
                                    departure:
                                      type: string
                                      description: "Departure airport code, 3 letters IATA code\t"
                                    arrival:
                                      type: string
                                      description: "Arrival airport code, 3 letters IATA code\t"
                                    departureTerminal:
                                      type: string
                                      description: Departure terminal
                                    "arrivalTerminal\t":
                                      type: string
                                      description: "Arrival terminal\t"
                                    departureDate:
                                      type: string
                                      description: >-
                                        Departure date, [yyyy-mm-dd], local time
                                        of departure city
                                    arrivalDate:
                                      type: string
                                      description: "Arrival date, [yyyy-mm-dd], local time of arrival city\t"
                                    departureTime:
                                      type: string
                                      description: "Departure time, [hh:mm],local time of departure city\t"
                                    arrivalTime:
                                      type: string
                                      description: "Arrival time, [hh:mm], local time of arrival city\t"
                                    flightTime:
                                      type: integer
                                      description: "Flight time, unit: minutes\t"
                                    stayTime:
                                      type: integer
                                      description: "Stay time for stopover flight, unit: minutes\t"
                                    codeShare:
                                      type: string
                                      description: >-
                                        Code share flight flag, Y - Code share
                                        flight, N - Not code share flight
                                    opFltNo:
                                      type: string
                                      description: "Operation flight number\t"
                                    opFltAirline:
                                      type: string
                                      description: "Operation airline\t"
                                    stopover:
                                      type: string
                                      description: >-
                                        Stopover airport code, 3 letters IATA
                                        code
                                    messageType:
                                      type: string
                                      description: >-
                                        Message type: 

                                        1-Flight changed 

                                        2-Flight canceled with protect flight 

                                        3-Flight canceled 

                                        4-Flight resumed. 

                                        5- Flight overbooking. 

                                        For type 3, 4 and 5, there is no
                                        ChangeFlightList information.
                                  required:
                                    - airline
                                    - flightNum
                                    - cabinClass
                                    - bookingCode
                                    - departure
                                    - arrival
                                    - departureDate
                                    - arrivalDate
                                    - departureTime
                                    - arrivalTime
                                  x-apifox-orders:
                                    - airline
                                    - flightNum
                                    - equipment
                                    - cabinClass
                                    - bookingCode
                                    - departure
                                    - arrival
                                    - departureTerminal
                                    - "arrivalTerminal\t"
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
                                    - messageType
                                  x-apifox-ignore-properties: []
                                description: flight information.
                            x-apifox-orders:
                              - journeySeq
                              - segments
                            x-apifox-ignore-properties: []
                          description: >-
                            Journey and segment information before this schedule
                            change.
                      x-apifox-orders:
                        - orderNum
                        - buyerOrder
                        - messageId
                        - messageCreateTime
                        - sensitivityLevel
                        - orderPnr
                        - orderAirlinePnr
                        - pnrList
                        - passengers
                        - originFlightList
                        - changeFlightList
                      required:
                        - orderNum
                        - messageId
                        - messageCreateTime
                        - sensitivityLevel
                        - passengers
                        - originFlightList
                        - changeFlightList
                      x-apifox-ignore-properties: []
                    description: Return data, will not be empty when error code is "0".
                required:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-ignore-properties: []
              example:
                errorCode: '0'
                errorMsg: ok
                data:
                  - orderNum: '916766125109920601'
                    messageId: '2944668'
                    messageCreateTime: '2023-02-22 15:07:10'
                    sensitivityLevel: '1'
                    orderPnr: TGBYHN
                    orderAirlinePnr: TGBYHN
                    pnrList:
                      - segmentNo: 1
                        departure: PEK
                        arrival: HKG
                        flightNum: '391'
                        cabinClass: ECONOMY
                        bookingCode: B
                        pnr: TGBYHN
                        airPnr: TGBYHN
                        ticketNums:
                          - ticketNum: '123321'
                            lastName: YANGUJM
                            firstName: TIFFANY
                            cardType: PP
                            cardNum: E07700466
                            sex: F
                            birthday: '1990-08-23'
                      - segmentNo: 2
                        departure: HKG
                        arrival: BKK
                        flightNum: '617'
                        cabinClass: ECONOMY
                        bookingCode: A
                        pnr: TGBYHN
                        airPnr: TGBYHN
                        ticketNums:
                          - ticketNum: '456456'
                            lastName: YANGUJM
                            firstName: TIFFANY
                            cardType: PP
                            cardNum: E07700466
                            sex: F
                            birthday: '1990-08-23'
                    passengers:
                      - birthday: '1990-08-23'
                        cardType: PP
                        cardNum: E07700466
                        cardExpiredDate: '2024-03-17'
                        lastName: YANGUJM
                        firstName: TIFFANY
                        nationality: CN
                        psgType: ADT
                        sex: F
                        ticketNum: '123321'
                    originFlightList:
                      - journeySeq: '1'
                        segments:
                          - airline: CX
                            flightNum: '391'
                            equipment: '333'
                            cabinClass: ECONOMY
                            bookingCode: S
                            departure: PEK
                            arrival: HKG
                            departureDate: '2023-03-31'
                            arrivalDate: '2023-03-31'
                            departureTime: '13:40'
                            arrivalTime: '17:35'
                            flightTime: 235
                            stayTime: 0
                            codeShare: 'N'
                            messageType: '1'
                          - airline: CX
                            flightNum: '617'
                            equipment: '333'
                            cabinClass: ECONOMY
                            bookingCode: S
                            departure: HKG
                            arrival: BKK
                            departureDate: '2023-03-31'
                            arrivalDate: '2023-03-31'
                            departureTime: '21:50'
                            arrivalTime: '23:50'
                            flightTime: 180
                            stayTime: 0
                            codeShare: 'N'
                            messageType: '1'
                    changeFlightList:
                      - journeySeq: '1'
                        segments:
                          - airline: CX
                            flightNum: '391'
                            equipment: '333'
                            cabinClass: ECONOMY
                            bookingCode: B
                            departure: PEK
                            arrival: HKG
                            departureDate: '2023-03-31'
                            arrivalDate: '2023-03-31'
                            departureTime: '13:40'
                            arrivalTime: '17:35'
                            stayTime: 0
                            codeShare: 'N'
                            stopover: ''
                          - airline: CX
                            flightNum: '617'
                            equipment: '333'
                            cabinClass: ECONOMY
                            bookingCode: A
                            departure: HKG
                            arrival: BKK
                            departureDate: '2023-03-31'
                            arrivalDate: '2023-03-31'
                            departureTime: '21:50'
                            arrivalTime: '23:50'
                            stayTime: 0
                            codeShare: 'N'
                            stopover: ''
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
              example:
                errorCode: B130
                errorMsg: Message is not exist
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Flight schedule change APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469938-run
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