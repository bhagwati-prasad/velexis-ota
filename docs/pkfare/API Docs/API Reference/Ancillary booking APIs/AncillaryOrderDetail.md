# AncillaryOrderDetail

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/ancillaryOrderDetail:
    post:
      summary: AncillaryOrderDetail
      deprecated: false
      description: |-
        ##  Function
          Through AncillaryOrderDetail API, you can check ancillary order details 
          

        ##  Error Code List

        |errorCode|errorMsg|
        |:----|:----|
        |0 |ok |
        |S001 |System error |
        |P002 |XXX is missing |
        |B002 |Partner is not exists |
        |B003 |Illegal sign |
        |B036 |Order is not exist |
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
                data:
                  type: object
                  properties:
                    ancillaryOrderNum:
                      type: string
                  required:
                    - ancillaryOrderNum
                  x-apifox-orders:
                    - ancillaryOrderNum
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HVRGWNQ4Q51CMAFVZ1F4E2RT
                - data
              x-apifox-refs:
                01HVRGWNQ4Q51CMAFVZ1F4E2RT:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: '{{sign}}'
                partnerId: '{{partnerId}}'
              data:
                ancillaryOrderNum: '917049521951368303'
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
                      ancillaryOrderNum:
                        type: string
                        description: PKFARE ancillary order number
                      airOrderNum:
                        type: string
                        description: associated air order number
                      ancillaryOrderStatus:
                        type: string
                        description: the status of ancillary order
                      ancillaryOrderType:
                        type: string
                        description: ancillary order type, ORIGIN-Ticketing Order
                      saleStage:
                        type: integer
                        description: sales stage：0- prebooking stage; 1-postbooking stage
                      ancillaryType:
                        type: integer
                        description: ancillary type：1-baggage; 2- seat
                      createTime:
                        type: string
                        description: "ancillary order created time（GMT）\t"
                      pnr:
                        type: string
                        description: PNR
                      airPnr:
                        type: string
                        description: "Airline PNR\t"
                      payGate:
                        type: string
                        description: "Form of payment, Alipay or Prepay\t"
                      paySerialNum:
                        type: string
                        description: "Serial Number of payment transaction\t"
                      lastTktTime:
                        type: string
                        description: "latest ticketing time (GMT)\t"
                      passengers:
                        type: array
                        items:
                          type: object
                          properties:
                            lastName:
                              type: string
                              description: "last name\t"
                            firstName:
                              type: string
                              description: "first name\t"
                            sex:
                              type: string
                              description: "gender；M-male，F-female\t"
                            birthday:
                              type: string
                              description: birthday
                            psgType:
                              type: string
                              description: "passenger type including ADT for adults, CHD for children\t"
                            passengerID:
                              type: string
                              description: "unique identification of the passenger\t"
                          required:
                            - lastName
                            - firstName
                            - sex
                            - birthday
                            - psgType
                            - passengerID
                          x-apifox-orders:
                            - lastName
                            - firstName
                            - sex
                            - birthday
                            - psgType
                            - passengerID
                          x-apifox-ignore-properties: []
                        description: passengers information
                      journeys:
                        type: array
                        items:
                          type: object
                          properties:
                            journeyID:
                              type: string
                              description: "unique identification of the journey\t"
                            segments:
                              type: array
                              items:
                                type: object
                                properties:
                                  airline:
                                    type: string
                                    description: "airline code\t"
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
                                  bookingCode:
                                    type: string
                                    description: "cabin code\t"
                                  segmentKey:
                                    type: string
                                    description: "unique identification of the segment\t"
                                x-apifox-orders:
                                  - airline
                                  - departure
                                  - departureDate
                                  - departureTime
                                  - arrival
                                  - arrivalDate
                                  - arrivalTime
                                  - flightNum
                                  - bookingCode
                                  - segmentKey
                                x-apifox-ignore-properties: []
                              description: "segment detail\t"
                          required:
                            - journeyID
                            - segments
                          x-apifox-orders:
                            - journeyID
                            - segments
                          x-apifox-ignore-properties: []
                        description: journey information
                      ancillaryInfos:
                        type: array
                        items:
                          type: object
                          properties:
                            baggages:
                              type: object
                              properties:
                                passengerID:
                                  type: string
                                  description: "unique identification of the passenger\t"
                                journeyID:
                                  type: string
                                  description: "unique identification of the journey\t"
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
                                  type: string
                                  description: price
                                description:
                                  type: string
                                  description: "baggage description\t"
                              x-apifox-orders:
                                - passengerID
                                - journeyID
                                - payBaggageType
                                - baggagePiece
                                - baggageWeight
                                - baggageCurrency
                                - baggagePrice
                                - description
                              description: "baggage detail\t"
                              x-apifox-ignore-properties: []
                            seats:
                              type: object
                              properties:
                                passengerID:
                                  type: string
                                  description: "unique identification of the passenger\t"
                                segmentKey:
                                  type: string
                                  description: "unique identification of the segment\t"
                                seatName:
                                  type: string
                                  description: seat name
                                column:
                                  type: string
                                  description: seat column
                                row:
                                  type: string
                                  description: seat row
                                seatCurrency:
                                  type: string
                                  description: currency
                                seatPrice:
                                  type: string
                                  description: seat price
                                characteristics:
                                  type: string
                                  description: "the traits of seats；inlude 4 options: window/middle/aisle/exit row\t"
                              x-apifox-orders:
                                - passengerID
                                - segmentKey
                                - seatName
                                - column
                                - row
                                - seatCurrency
                                - seatPrice
                                - characteristics
                              description: seat detail
                              x-apifox-ignore-properties: []
                          x-apifox-orders:
                            - baggages
                            - seats
                          x-apifox-ignore-properties: []
                        description: ancillary information
                    required:
                      - ancillaryOrderNum
                      - airOrderNum
                      - ancillaryOrderStatus
                      - ancillaryOrderType
                      - saleStage
                      - ancillaryType
                      - createTime
                      - pnr
                      - payGate
                      - paySerialNum
                      - lastTktTime
                      - passengers
                      - journeys
                    x-apifox-orders:
                      - ancillaryOrderNum
                      - airOrderNum
                      - ancillaryOrderStatus
                      - ancillaryOrderType
                      - saleStage
                      - ancillaryType
                      - createTime
                      - pnr
                      - airPnr
                      - payGate
                      - paySerialNum
                      - lastTktTime
                      - passengers
                      - journeys
                      - ancillaryInfos
                    description: >-
                      Only if the errorCode returns "0", returned data would not
                      be null.
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
                '1':
                  summary: Baggage Response
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      ancillaryOrderNum: '917137127561609502'
                      airOrderNum: '917137127561609501'
                      ancillaryOrderStatus: ISS_PRC
                      ancillaryOrderType: ORIGIN
                      saleStage: 0
                      ancillaryType: 1
                      createTime: '2024-04-21T15:19:17+00:00'
                      pnr: OV35WN
                      payGate: Prepay
                      paySerialNum: PREPAY_20240421231934_917137127571609501_3163
                      lastTktTime: 2024-04-21T17:19+00:00
                      passengers:
                        - lastName: LEEE
                          firstName: ANOUNG
                          psgType: ADT
                          birthday: '1989-07-18'
                          sex: F
                          passengerID: '25122869'
                        - lastName: CHO
                          firstName: HEEJUJU
                          psgType: ADT
                          birthday: '1996-05-10'
                          sex: F
                          passengerID: '25122888'
                      journeys:
                        - journeyID: '21808125'
                          segments:
                            - airline: VJ
                              departure: ICN
                              departureDate: '2024-05-08'
                              departureTime: '01:45'
                              arrival: PQC
                              arrivalDate: '05:10'
                              arrivalTime: '2024-05-08'
                              flightNum: '975'
                              bookingCode: U
                              segmentKey: '24281583'
                        - journeyID: '21808126'
                          segments:
                            - airline: VJ
                              departure: PQC
                              departureDate: '2024-05-11'
                              departureTime: '18:00'
                              arrival: ICN
                              arrivalDate: '01:25'
                              arrivalTime: '2024-05-12'
                              flightNum: '978'
                              bookingCode: I
                              segmentKey: '24281584'
                      ancillaryInfos:
                        - baggages:
                            passengerID: '25122879'
                            journeyID: '21808126'
                            payBaggageType: 1
                            baggagePiece: -1
                            baggageWeight: 20KG
                            baggageCurrency: USD
                            baggagePrice: '26.78'
                            description: Baggage 20kgs
                        - baggages:
                            passengerID: '25122879'
                            journeyID: '21808125'
                            payBaggageType: 1
                            baggagePiece: -1
                            baggageWeight: 20KG
                            baggageCurrency: USD
                            baggagePrice: '31.06'
                            description: Baggage 20kgs
                        - baggages:
                            passengerID: '25122880'
                            journeyID: '21808126'
                            payBaggageType: 1
                            baggagePiece: -1
                            baggageWeight: 20KG
                            baggageCurrency: USD
                            baggagePrice: '26.78'
                            description: Baggage 20kgs
                        - baggages:
                            passengerID: '25122880'
                            journeyID: '21808125'
                            payBaggageType: 1
                            baggagePiece: -1
                            baggageWeight: 20KG
                            baggageCurrency: USD
                            baggagePrice: '31.06'
                            description: Baggage 20kgs
                '2':
                  summary: Seat Response
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      ancillaryOrderNum: '917137082727027803'
                      airOrderNum: '917137082727027801'
                      ancillaryOrderStatus: ISS_PRC
                      ancillaryOrderType: ORIGIN
                      saleStage: 0
                      ancillaryType: 2
                      createTime: '2024-04-21T14:04:32+00:00'
                      pnr: ASZ4HG
                      airPnr: ASZ4HG
                      payGate: Prepay
                      paySerialNum: PREPAY_20240421220443_917137082727027901_5649
                      lastTktTime: 2024-04-21T16:04+00:00
                      passengers:
                        - lastName: KIMMIK
                          firstName: DOYOON
                          psgType: ADT
                          birthday: '2011-09-01'
                          sex: M
                          passengerID: '25120906'
                        - lastName: HWANGWANG
                          firstName: JIAE
                          psgType: ADT
                          birthday: '1985-12-21'
                          sex: F
                          passengerID: '25120909'
                        - lastName: KIMMIK
                          firstName: TAEWON
                          psgType: ADT
                          birthday: '1974-07-07'
                          sex: M
                          passengerID: '25120900'
                      journeys:
                        - journeyID: '21806653'
                          segments:
                            - airline: VJ
                              departure: ICN
                              departureDate: '2024-07-26'
                              departureTime: '06:50'
                              arrival: CXR
                              arrivalDate: '09:40'
                              arrivalTime: '2024-07-26'
                              flightNum: '835'
                              bookingCode: X
                              segmentKey: '24280025'
                      ancillaryInfos:
                        - seats:
                            passengerID: '25120903'
                            segmentKey: '24280025'
                            seatName: 10A
                            column: A
                            row: '10'
                            seatCurrency: USD
                            seatPrice: '11.32'
                            characteristics: window
                        - seats:
                            passengerID: '25120904'
                            segmentKey: '24280025'
                            seatName: 10B
                            column: B
                            row: '10'
                            seatCurrency: USD
                            seatPrice: '11.32'
                            characteristics: middle
                        - seats:
                            passengerID: '25120905'
                            segmentKey: '24280025'
                            seatName: 10C
                            column: C
                            row: '10'
                            seatCurrency: USD
                            seatPrice: '11.32'
                            characteristics: aisle
          headers: {}
          x-apifox-name: success
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
                errorCode: B036
                errorMsg: Order is not exist
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Ancillary booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469936-run
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