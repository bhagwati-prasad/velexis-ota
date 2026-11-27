# AncillaryBooking

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/ancillaryBookingV2:
    post:
      summary: AncillaryBooking
      deprecated: false
      description: >-
        ##  Function
          You can add ancillary products and create an ancillary order in PKFARE through AncillaryBooking API. It is necessary to use AncillaryPricing service before using this interface.

        ##  Error Code List


        |errorCode|errorMsg|

        |:----|:----|

        |0 |ok |

        |S001 |System error. |

        |P001 |XXX is illegal. |

        |P002 |XXX is missing. |

        |P006 |Invalid parameter. |

        |B002 |Partner is not exists. |

        |B003 |Illegal sign. |

        |B005 |Can not find any matching ancillaryPricing result within 30
        minutes. |

        |B009 |Order status is invalid |

        |B010 |The order was not found |

        |B017 |Price is changed. |

        |B029 |Duplicate reservations have been found for passenger XXX/XXX in
        order XXX. |

        |B071 |Itinerary is different between request and order. |

        |B075 |There are duplicate bookings and the same passenger is only
        allowed to choose one of baggage weights in the same journey. |

         
      tags:
        - API Reference/Ancillary booking APIs
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
                airOrderNum:
                  type: string
                  description: PKFARE air order number
                buyerOrder:
                  type: string
                  description: your order number if you want to store at PKFARE side
                ancillaryBooking:
                  type: object
                  properties:
                    baggages:
                      type: array
                      items:
                        type: object
                        properties:
                          passenger:
                            type: object
                            properties:
                              lastName:
                                type: string
                                description: last name
                              firstName:
                                type: string
                                description: "first name\t"
                              birthday:
                                type: string
                                description: birthday
                              psgType:
                                type: string
                                description: "passenger type including ADT for adults, CHD for children\t"
                              sex:
                                type: string
                                description: "gender, including M for male, F for female\t"
                            required:
                              - lastName
                              - firstName
                              - birthday
                              - psgType
                              - sex
                            x-apifox-orders:
                              - lastName
                              - firstName
                              - birthday
                              - psgType
                              - sex
                            description: passenger detail
                            x-apifox-ignore-properties: []
                          products:
                            type: array
                            items:
                              type: object
                              properties:
                                ancillaryKey:
                                  type: string
                                  description: "unique identification of ancillary\t"
                              required:
                                - ancillaryKey
                              x-apifox-orders:
                                - ancillaryKey
                              x-apifox-ignore-properties: []
                            description: product detail
                        required:
                          - passenger
                          - products
                        x-apifox-orders:
                          - passenger
                          - products
                        x-apifox-ignore-properties: []
                      description: baggage detail
                  required:
                    - baggages
                  x-apifox-orders:
                    - baggages
                  description: ancillary booking information
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - airOrderNum
                - ancillaryBooking
              x-apifox-orders:
                - 01HVRD9TEY8FNP3K8WYDAQYSG1
                - airOrderNum
                - buyerOrder
                - ancillaryBooking
              x-apifox-refs:
                01HVRD9TEY8FNP3K8WYDAQYSG1:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: '{{}}'
                partnerId: '{{}}'
              airOrderNum: '917049521951368301'
              ancillaryBooking:
                baggages:
                  - passenger:
                      birthday: '2003-03-23'
                      firstName: XiaoJun
                      lastName: Zhong
                      psgType: ADT
                      sex: M
                    products:
                      - ancillaryKey: 38781f820e9ee25737d7b313410b5317
                      - ancillaryKey: 2781c40741271185391c4ef5dab51df5
                  - passenger:
                      birthday: '2003-03-23'
                      firstName: Harris
                      lastName: Kaufman
                      psgType: ADT
                      sex: M
                    products:
                      - ancillaryKey: 38781f820e9ee25737d7b313410b5317
                      - ancillaryKey: 2781c40741271185391c4ef5dab51df5
                  - passenger:
                      birthday: '2015-03-23'
                      firstName: Yue
                      lastName: Hong
                      psgType: CHD
                      sex: M
                    products:
                      - ancillaryKey: 38781f820e9ee25737d7b313410b5317
                      - ancillaryKey: 2781c40741271185391c4ef5dab51df5
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
                    description: error code, refer to Error Code List
                  errorMsg:
                    type: string
                    description: error msg
                  data:
                    type: object
                    properties:
                      baggageOrder:
                        type: object
                        properties:
                          ancillaryOrderNum:
                            type: string
                            description: PKFARE ancillary order number
                          buyerOrder:
                            type: string
                            description: >-
                              your order number if you want to store at PKFARE
                              side
                          baggages:
                            type: array
                            items:
                              type: object
                              properties:
                                passenger:
                                  type: object
                                  properties:
                                    lastName:
                                      type: string
                                      description: last name
                                    firstName:
                                      type: string
                                      description: "first name\t"
                                    birthday:
                                      type: string
                                      description: birthday
                                    psgType:
                                      type: string
                                      description: "passenger type including ADT for adults, CHD for children\t"
                                    sex:
                                      type: string
                                      description: "gender, including M for male, F for female\t"
                                  x-apifox-orders:
                                    - lastName
                                    - firstName
                                    - birthday
                                    - psgType
                                    - sex
                                  description: passenger detail
                                  x-apifox-ignore-properties: []
                                baggageDetails:
                                  type: array
                                  items:
                                    type: object
                                    properties:
                                      ancillaryKey:
                                        type: string
                                        description: "unique identification of ancillary\t"
                                      payBaggageType:
                                        type: integer
                                        description: "baggage type; 1-checked baggage, 2-carry-on baggage\t"
                                      baggagePiece:
                                        type: integer
                                        description: "baggage piece; -1 - no limit to baggage piece\t"
                                      baggageWeight:
                                        type: string
                                        description: "baggage weight\t"
                                      baggageCurrency:
                                        type: string
                                        description: currency
                                      baggagePrice:
                                        type: integer
                                        description: price
                                      description:
                                        type: string
                                        description: "baggage description\t"
                                      journey:
                                        type: array
                                        items:
                                          type: object
                                          properties:
                                            airline:
                                              type: string
                                              description: airline code
                                            departure:
                                              type: string
                                              description: "origin[IATA airport code]\t"
                                            departureDate:
                                              type: string
                                              description: "departure date[yyyy-MM-dd]\t"
                                            departureTime:
                                              type: string
                                              description: "departure time[hh:mm]\t"
                                            arrival:
                                              type: string
                                              description: "destination[IATA airport code]\t"
                                            arrivalDate:
                                              type: string
                                              description: "arrival date[yyyy-MM-dd]\t"
                                            arrivalTime:
                                              type: string
                                              description: "arrival time[hh:mm]\t"
                                            flightNum:
                                              type: string
                                              description: "flight number\t"
                                            cabinClass:
                                              type: string
                                              description: "cabin class\t"
                                            bookingCode:
                                              type: string
                                              description: "cabin code\t"
                                          x-apifox-orders:
                                            - airline
                                            - departure
                                            - departureDate
                                            - departureTime
                                            - arrival
                                            - arrivalDate
                                            - arrivalTime
                                            - flightNum
                                            - cabinClass
                                            - bookingCode
                                          x-apifox-ignore-properties: []
                                    x-apifox-orders:
                                      - ancillaryKey
                                      - payBaggageType
                                      - baggagePiece
                                      - baggageWeight
                                      - baggageCurrency
                                      - baggagePrice
                                      - description
                                      - journey
                                    x-apifox-ignore-properties: []
                                  description: baggage details
                              x-apifox-orders:
                                - passenger
                                - baggageDetails
                              x-apifox-ignore-properties: []
                        x-apifox-orders:
                          - ancillaryOrderNum
                          - buyerOrder
                          - baggages
                        description: baggage order detail
                        x-apifox-ignore-properties: []
                    x-apifox-orders:
                      - baggageOrder
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-ignore-properties: []
              example:
                errorCode: '0'
                errorMsg: ok
                data:
                  baggageOrder:
                    ancillaryOrderNum: '917134367036776903'
                    baggages:
                      - passenger:
                          birthday: '2003-03-23'
                          firstName: Vivian
                          lastName: Guo
                          psgType: ADT
                          sex: M
                        baggageDetails:
                          - ancillaryKey: 51b015fc291b71604b8fd1325a883602
                            payBaggageType: 1
                            baggagePiece: 1
                            baggageWeight: 10KG
                            baggageCurrency: CNY
                            baggagePrice: 21
                            journey:
                              - airline: TR
                                flightNum: '307'
                                departure: SGN
                                departureDate: '2024-05-18'
                                departureTime: '15:15'
                                arrival: SIN
                                arrivalDate: '2024-05-18'
                                arrivalTime: '18:20'
                                bookingCode: O
                                cabinClass: ECONOMY
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
                    description: error code, refer to Error Code List
                  errorMsg:
                    type: string
                    description: error msg
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                x-apifox-ignore-properties: []
              example:
                errorCode: B005
                errorMsg: >-
                  Can not find any matching ancillaryPricing result within 30
                  minutes.
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Ancillary booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469934-run
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