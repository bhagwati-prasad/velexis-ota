# OrderPricing V5

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/orderPricingV5:
    post:
      summary: OrderPricing V5
      deprecated: false
      description: "##  Function\n\nThrough OrderPricing_V4 API, users can check if the PNR and order price are available before doing the payment to ensure the validity of order price and PNR. It is mandatory to invoke OrderPricing before Ticketing. Ticketing need to be done within\_30 minutes\_after OrderPricing. \n\n##  Versioning\n\n|Version|Sandbox Invoking Address|Update|\n|:----|:----|:----|\n|OrderPricing|\_[https://api.pkfare.com/orderPricing](https://api.pkfare.com/orderPricing)|    |\n|OrderPricing_V2|[https://api.pkfare.com/orderPricingV2](https://api.pkfare.com/orderPricingV2)|Support to check paid baggage price.|\n|OrderPricing_V3|[https://api.pkfare.com/orderPricingV](https://api.pkfare.com/orderPricingV2)3|Support to check infant ticket price. Display more fare details for change orders.|\n|OrderPricing_V4|https://api.pkfare.com/orderPricingV4|Support to check seat price|\n|OrderPricing_V4 (json format)|https://api.pkfare.com/json/orderPricingV4|Support to check seat price; Support json formatted requesting strcture|\n|OrderPricing_V5 (json format)|https://api.pkfare.com/json/orderPricingV5|Support checking orders of different product tags, including PKFARE-defined special product types and airline-standard branded fares, etc.|\n\n\n##  Error Code List\n\n|erroCode|erroMsg|Description|\n|:----|:----|:----|\n|0|ok|Request has been processed successfully.|\n|P001|-|Wrong parameter|\n|S001|System error|System error|\n|310|Retrieve PNR failed, please try again.|Retrieve PNR failed|\n|B002|Partner is not exists|PartnerID does not exist|\n|B003|Illegal sign|Illegal sign. Please check your signature|\n|B009|Order status is invalid|Order status is invalid|\n|B010|The order was not found|The order was not found.|\n|B026|Latest_tkt_time will be expired within 1 hour.|Latest ticketing time will be expired within 1 hour.|\n|B101|supplier status is invalid|Supplier is offline.|\n|B102|Segment status is invalid.|Segment status is invalid.|\n|B103|No airline PNR existed, please try again.|No airline PNR exist.|\n|B104|Flight No. in PNR is not match with the one in the order|Flight No. in PNR is not match with the one in the order .|\n|B105|Passenger No. in PNR is not match with the one in the order|Passenger No. in PNR is not match with the one in the order.|\n|B106|No price|PNR has no filed fare.|\n|B107|Fare changed, and update order failed. Please try again.|Fare changed, and update order failed.|\n|B108|Supplier has cross the day, fare is not guaranteed.|Supplier had crossed the day, fare is not guaranteed.|\n|B109|Supplier has cross the day, and price has changed|Supplier had crossed the day, and price has changed.|\n|B112|The order has been paid before, please update status accordingly.|The order had been paid before.|\n|B113|Filed fare in PNR is not match with the price in the order, and price has changed.|Filed fare in PNR is not match with the price in the order, and price had changed.|\n|B114|Flight changed|Flight changed|\n|B115|Latest_tkt_time has expired.|Latest ticketing time is expired.|\n|B116|Price changed|Price had changed|\n|B117|Order Pricing failed|Caused by other reasons, please connect administrator|\n|B118|PNR status is invalid|PNR status is invalid|\n|B119|Order Pricing failed, please try again|LCC content: Pre-check before payment failed. Please try again|\n|B120|Order Pricing failed|Supplier saved booking failed.|"
      tags:
        - API Reference/APIs with all versions/OrderPricing
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
                orderPricing:
                  type: object
                  properties:
                    orderNum:
                      type: string
                      description: Order Number
                  required:
                    - orderNum
                  x-apifox-orders:
                    - orderNum
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - orderPricing
              x-apifox-orders:
                - 01HVGACMTZZ0F5EA3PEBD9VX0G
                - orderPricing
              x-apifox-refs:
                01HVGACMTZZ0F5EA3PEBD9VX0G:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                partnerId: '{{partnerId}}'
                sign: '{{sign}}'
              orderPricing:
                orderNum: '917131658934384601'
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
                      pricingResult:
                        type: object
                        properties:
                          solution:
                            type: object
                            properties:
                              currency:
                                type: string
                                description: Currency
                              buyerExchRate:
                                type: number
                                description: Buyer exchange rate, not supported yet
                              adtFare:
                                type: number
                                description: Fare for adult
                              adtTax:
                                type: number
                                description: Taxes for adult
                              chdFare:
                                type: number
                                description: Fare for child[age 2-12]
                              chdTax:
                                type: number
                                description: Taxes for child[age 2-12]
                              infFare:
                                type: number
                                description: Taxes for infant[age 0-2, no seat]
                              infTax:
                                type: number
                                description: Taxes for infant[age 0-2, no seat]
                              tag:
                                type: string
                                description: The product tag corresponding to the solution.
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
                                          description: Associated segment number.
                                        detail:
                                          type: array
                                          items:
                                            type: string
                                          description: Fare rules detail.
                                      x-apifox-orders:
                                        - segmentIndexList
                                        - detail
                                      x-apifox-ignore-properties: []
                                description: >-
                                  Other fare rules corresponding to the
                                  solution.
                                x-apifox-orders:
                                  - ADT
                                x-apifox-ignore-properties: []
                              fareType:
                                type: string
                                description: Fare type, including PUBLIC and PRIVATE
                              qCharge:
                                type: number
                                description: Q Charge, for reference only
                              tktFee:
                                type: number
                                description: Ticketing Fee
                              platformServiceFee:
                                type: number
                                description: Platform Service Fee, for reference only
                              journeys:
                                type: object
                                properties:
                                  journey_0:
                                    type: array
                                    items:
                                      type: string
                                required:
                                  - journey_0
                                x-apifox-orders:
                                  - journey_0
                                description: >-
                                  Journeys. JSON format string array. Content:
                                  flight ID. The flight ID in journey is the
                                  specific one chose by users. Refer to Flights.
                                x-apifox-ignore-properties: []
                              merchantFee:
                                type: number
                                description: Payment transaction fee
                              adtAdditionalFare:
                                type: number
                                description: >-
                                  Addtional fare of adult. Only for change
                                  orders.
                              adtAdditionalTax:
                                type: number
                                description: >-
                                  Addtional Tax of adult. Only for change
                                  orders.
                              adtChangeFee:
                                type: number
                                description: Change fee of adult. Only for change orders
                              adtChangeServiceFee:
                                type: number
                                description: >-
                                  Change service fee of adult. Only for change
                                  orders.
                              adtChangeAmount:
                                type: number
                                description: >-
                                  Change amount of adult. Only for change
                                  orders.
                              chdAdditionalFare:
                                type: number
                                description: >-
                                  Addtional fare of child. Only for change
                                  orders.
                              chdAdditionalTax:
                                type: number
                                description: >-
                                  Addtional Tax of child. Only for change
                                  orders.
                              chdChangeFee:
                                type: number
                                description: Change fee of child. Only for change orders.
                              chdChangeServiceFee:
                                type: number
                                description: >-
                                  Change service fee of child. Only for change
                                  orders.
                              chdChangeAmount:
                                type: number
                                description: >-
                                  Change amount of child. Only for change
                                  orders.
                              infAdditionalFare:
                                type: number
                                description: >-
                                  Addtional fare of infant. Only for change
                                  orders.
                              infAdditionalTax:
                                type: number
                                description: >-
                                  Addtional Tax of infant. Only for change
                                  orders.
                              infChangeFee:
                                type: number
                                description: Change fee of infant. Only for change orders.
                              infChangeServiceFee:
                                type: number
                                description: >-
                                  Change service fee of infant. Only for change
                                  orders.
                              infChangeAmount:
                                type: number
                                description: >-
                                  Change amount of infant. Only for change
                                  orders.
                            x-apifox-orders:
                              - currency
                              - buyerExchRate
                              - adtFare
                              - adtTax
                              - chdFare
                              - chdTax
                              - infFare
                              - infTax
                              - tag
                              - otherFareRules
                              - fareType
                              - qCharge
                              - tktFee
                              - platformServiceFee
                              - journeys
                              - merchantFee
                              - adtAdditionalFare
                              - adtAdditionalTax
                              - adtChangeFee
                              - adtChangeServiceFee
                              - adtChangeAmount
                              - chdAdditionalFare
                              - chdAdditionalTax
                              - chdChangeFee
                              - chdChangeServiceFee
                              - chdChangeAmount
                              - infAdditionalFare
                              - infAdditionalTax
                              - infChangeFee
                              - infChangeServiceFee
                              - infChangeAmount
                            x-apifox-ignore-properties: []
                          flights:
                            type: array
                            items:
                              type: object
                              properties:
                                flightId:
                                  type: string
                                  description: Flight ID, unique identification
                                journeyTime:
                                  type: integer
                                  description: 'Journey Time, unit: minute'
                                transferCount:
                                  type: integer
                                  description: Number of Transfers
                                lastTktTime:
                                  type: string
                                  description: >-
                                    Latest ticketing time (GMT) [2015-10-28
                                    23:59:00]
                                segmengtIds:
                                  type: array
                                  items:
                                    type: string
                                    description: segmengtId
                                  description: >-
                                    Number of segment arrays (please note the
                                    segmengtIds is a typo due to history
                                    edition)
                              x-apifox-orders:
                                - flightId
                                - journeyTime
                                - transferCount
                                - lastTktTime
                                - segmengtIds
                              x-apifox-ignore-properties: []
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
                                    Cabin class, including ECONOMY, PREMIUM
                                    ECONOMY, BUSINESS and FIRST
                                bookingCode:
                                  type: string
                                  description: Cabin code
                                availabilityCount:
                                  type: integer
                                  description: "Available seats, for reference only\t"
                                departure:
                                  type: string
                                  description: Departure airport
                                arrival:
                                  type: string
                                  description: Arrival airport
                                departureTerminal:
                                  type: string
                                  description: "Departure airport terminal\t"
                                arrivalTerminal:
                                  type: string
                                  description: "Arrival airport terminal\t"
                                departureDate:
                                  type: integer
                                  description: Departure date [unix time]
                                  format: long
                                arrivalDate:
                                  type: integer
                                  format: long
                                  description: Arrival date [unix time]
                                flightTime:
                                  type: integer
                                  description: "Flight time, unit: minute\t"
                                codeShare:
                                  type: string
                                  description: 'Code share or not: [Y-yes, N-no]'
                                strDepartureDate:
                                  type: string
                                  description: Departure date[yyyy-mm-dd], local time
                                strDepartureTime:
                                  type: string
                                  description: Departure time[hh:mm], local time
                                strArrivalDate:
                                  type: string
                                  description: Arrival date[yyyy-mm-dd], local time
                                strArrivalTime:
                                  type: string
                                  description: "Arrival time[hh:mm], local time\t"
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
                                - codeShare
                                - strDepartureDate
                                - strDepartureTime
                                - strArrivalDate
                                - strArrivalTime
                              x-apifox-ignore-properties: []
                          ancillary:
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
                                psgType:
                                  type: string
                                  description: >-
                                    Passenger type; ADT-Adult, CHD-Child[2-12
                                    years old]
                                ancillaries:
                                  type: object
                                  properties:
                                    baggage:
                                      type: array
                                      items:
                                        type: object
                                        properties:
                                          ancillaryType:
                                            type: integer
                                            description: Baggage details; 1-baggage
                                          payBaggageType:
                                            type: integer
                                            description: >-
                                              Baggage type; 1-checked baggage,
                                              2-carry-on baggage
                                          baggagePiece:
                                            type: integer
                                            description: >-
                                              Baggage piece; -1 - no limit to Baggage
                                              piece
                                          baggageWeight:
                                            type: string
                                            description: "Baggage weight\t"
                                          baggageCurrency:
                                            type: string
                                            description: Currency
                                          baggagePrice:
                                            type: integer
                                            description: Price
                                          description:
                                            type: string
                                            description: "Baggage description\t"
                                          journeys:
                                            type: array
                                            items:
                                              type: object
                                              properties:
                                                airline:
                                                  type: string
                                                  description: "Airline code\t"
                                                departure:
                                                  type: string
                                                  description: "Origin[IATA airport code]\t"
                                                departureDate:
                                                  type: string
                                                  description: "Departure date[yyyy-MM-dd]\t"
                                                departureTime:
                                                  type: string
                                                  description: "Departure time[hh:mm]\t"
                                                arrival:
                                                  type: string
                                                  description: "Destination[IATA airport code]\t"
                                                arrivalDate:
                                                  type: string
                                                  description: "Arrival date[yyyy-MM-dd]\t"
                                                arrivalTime:
                                                  type: string
                                                  description: "Arrival time[hh:mm]\t"
                                                flightNum:
                                                  type: string
                                                  description: "Flight number\t"
                                                bookingCode:
                                                  type: string
                                                  description: Cabin code
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
                                              x-apifox-ignore-properties: []
                                          buyerOrder:
                                            type: string
                                            description: "Buyer ancillary order number\t"
                                        x-apifox-orders:
                                          - ancillaryType
                                          - payBaggageType
                                          - baggagePiece
                                          - baggageWeight
                                          - baggageCurrency
                                          - baggagePrice
                                          - description
                                          - journeys
                                          - buyerOrder
                                        x-apifox-ignore-properties: []
                                      description: Baggage details
                                    seat:
                                      type: array
                                      items:
                                        type: object
                                        properties:
                                          ancillaryType:
                                            type: integer
                                            description: Seat details; 2-seat
                                          seatName:
                                            type: string
                                            description: Seat name
                                          column:
                                            type: string
                                            description: Seat column
                                          row:
                                            type: string
                                            description: Seat row
                                          seatCategory:
                                            type: string
                                            description: Seat category
                                          seatCurrency:
                                            type: string
                                            description: Currency
                                          seatPrice:
                                            type: string
                                            description: Price
                                          characteristics:
                                            type: array
                                            items:
                                              type: string
                                            description: The traits of seats
                                          segment:
                                            type: array
                                            items:
                                              type: object
                                              properties:
                                                airline:
                                                  type: string
                                                  description: Airline code
                                                departure:
                                                  type: string
                                                  description: "Origin[IATA airport code]\t"
                                                departureDate:
                                                  type: string
                                                  description: Departure date[yyyy-MM-dd]
                                                departureTime:
                                                  type: string
                                                  description: Departure time[hh:mm]
                                                arrival:
                                                  type: string
                                                  description: Destination[IATA airport code]
                                                arrivalDate:
                                                  type: string
                                                  description: Arrival date[yyyy-MM-dd]
                                                arrivalTime:
                                                  type: string
                                                  description: Arrival time[hh:mm]
                                                flightNum:
                                                  type: string
                                                  description: Flight number
                                                bookingCode:
                                                  type: string
                                                  description: Cabin code
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
                                              x-apifox-ignore-properties: []
                                          buyerOrder:
                                            type: string
                                            description: Buyer ancillary order number
                                        x-apifox-orders:
                                          - ancillaryType
                                          - seatName
                                          - column
                                          - row
                                          - seatCategory
                                          - seatCurrency
                                          - seatPrice
                                          - characteristics
                                          - segment
                                          - buyerOrder
                                        x-apifox-ignore-properties: []
                                      description: Seat details
                                  x-apifox-orders:
                                    - baggage
                                    - seat
                                  x-apifox-ignore-properties: []
                              x-apifox-orders:
                                - lastName
                                - firstName
                                - psgType
                                - ancillaries
                              x-apifox-ignore-properties: []
                        x-apifox-orders:
                          - solution
                          - flights
                          - segments
                          - ancillary
                        x-apifox-ignore-properties: []
                      orderResult:
                        type: object
                        properties:
                          orderNum:
                            type: string
                            description: Order number
                          pnr:
                            type: string
                            description: PNR
                        x-apifox-orders:
                          - orderNum
                          - pnr
                        x-apifox-ignore-properties: []
                    x-apifox-orders:
                      - pricingResult
                      - orderResult
                    description: >-
                      Returned data, will not be empty when error code is "0".
                      Data is in JSON format, which contains two collections:
                      PricingResult and OrderResult
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
                  summary: Success
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      pricingResult:
                        solution:
                          fareType: PRIVATE
                          currency: CNY
                          adtFare: 2862
                          adtTax: 1211
                          chdFare: 0
                          chdTax: 0
                          qCharge: 0
                          tktFee: 0
                          platformServiceFee: 0
                          journeys:
                            journey_0:
                              - f5deaeeae1538fb6c45901d524ee2f98
                          merchantFee: 0
                          adults: 1
                          children: 0
                          infants: 0
                        flights:
                          - flightId: f5deaeeae1538fb6c45901d524ee2f98
                            journeyTime: 360
                            transferCount: 1
                            lastTktTime: '2023-11-09 13:47:00'
                            segmengtIds:
                              - def32e56f53ad461c6437c0d237ae6db
                              - 4abffb5c6b36b9a366075d4726460a66
                        segments:
                          - segmentId: def32e56f53ad461c6437c0d237ae6db
                            airline: VJ
                            flightNum: '896'
                            cabinClass: ECONOMY
                            bookingCode: I
                            availabilityCount: 3
                            departure: DEL
                            arrival: SGN
                            departureDate: 1701273900000
                            arrivalDate: 1701296400000
                            flightTime: 285
                            codeShare: 'N'
                            strDepartureDate: '2023-11-30'
                            strDepartureTime: '00:05'
                            strArrivalDate: '2023-11-30'
                            strArrivalTime: '06:20'
                          - segmentId: 4abffb5c6b36b9a366075d4726460a66
                            airline: VJ
                            flightNum: '632'
                            cabinClass: ECONOMY
                            bookingCode: I
                            availabilityCount: 3
                            departure: SGN
                            arrival: DAD
                            departureDate: 1701336000000
                            arrivalDate: 1701340500000
                            flightTime: 75
                            codeShare: 'N'
                            strDepartureDate: '2023-11-30'
                            strDepartureTime: '17:20'
                            strArrivalDate: '2023-11-30'
                            strArrivalTime: '18:35'
                        ancillary:
                          - lastName: LIN
                            firstName: LIHONG
                            psgType: ADT
                            ancillaries:
                              baggage:
                                - ancillaryType: 1
                                  payBaggageType: 1
                                  baggagePiece: 2
                                  baggageWeight: 36KG
                                  baggageCurrency: CNY
                                  baggagePrice: 95
                                  journeys:
                                    - airline: VJ
                                      flightNum: '896'
                                      departure: DEL
                                      departureDate: '2023-11-30'
                                      departureTime: '00:05'
                                      arrival: SGN
                                      arrivalDate: '2023-11-30'
                                      arrivalTime: '06:20'
                                      bookingCode: I
                                    - airline: VJ
                                      flightNum: '632'
                                      departure: SGN
                                      departureDate: '2023-11-30'
                                      departureTime: '17:20'
                                      arrival: DAD
                                      arrivalDate: '2023-11-30'
                                      arrivalTime: '18:35'
                                      bookingCode: I
                          - lastName: LIN
                            firstName: LIHONG
                            psgType: ADT
                            ancillaries:
                              seat:
                                - ancillaryType: 2
                                  seatName: 46A
                                  column: A
                                  row: '46'
                                  seatCurrency: CNY
                                  seatPrice: '40.00'
                                  characteristics:
                                    - middle
                                  segment:
                                    - airline: VJ
                                      departure: DEL
                                      departureDate: '2023-11-30'
                                      departureTime: '00:05'
                                      arrival: SGN
                                      arrivalDate: '2023-11-30'
                                      arrivalTime: '06:20'
                                      flightNum: '896'
                                      bookingCode: I
                                  buyerOrder: '23146'
                                - ancillaryType: 2
                                  seatName: 15A
                                  column: A
                                  row: '15'
                                  seatCurrency: CNY
                                  seatPrice: '40.00'
                                  characteristics:
                                    - middle
                                  segment:
                                    - airline: VJ
                                      departure: SGN
                                      departureDate: '2023-11-30'
                                      departureTime: '17:20'
                                      arrival: DAD
                                      arrivalDate: '2023-11-30'
                                      arrivalTime: '18:35'
                                      flightNum: '632'
                                      bookingCode: I
                                  buyerOrder: '23147'
                      orderResult:
                        orderNum: '9169953203701'
                        pnr: A8GS1Q
                '3':
                  summary: Success(Fare Family)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      pricingResult:
                        solution:
                          fareType: PRIVATE
                          currency: CNY
                          adtFare: 2862
                          adtTax: 1211
                          chdFare: 0
                          chdTax: 0
                          qCharge: 0
                          tktFee: 0
                          platformServiceFee: 0
                          journeys:
                            journey_0:
                              - f5deaeeae1538fb6c45901d524ee2f98
                          merchantFee: 0
                          adults: 1
                          children: 0
                          infants: 0
                          tag: SAVER
                          otherFareRules:
                            ADT:
                              - segmentIndexList:
                                  - 1
                                detail:
                                  - free meal
                        flights:
                          - flightId: f5deaeeae1538fb6c45901d524ee2f98
                            journeyTime: 360
                            transferCount: 1
                            lastTktTime: '2023-11-09 13:47:00'
                            segmengtIds:
                              - def32e56f53ad461c6437c0d237ae6db
                              - 4abffb5c6b36b9a366075d4726460a66
                        segments:
                          - segmentId: def32e56f53ad461c6437c0d237ae6db
                            airline: VJ
                            flightNum: '896'
                            cabinClass: ECONOMY
                            bookingCode: I
                            availabilityCount: 3
                            departure: DEL
                            arrival: SGN
                            departureDate: 1701273900000
                            arrivalDate: 1701296400000
                            flightTime: 285
                            codeShare: 'N'
                            strDepartureDate: '2023-11-30'
                            strDepartureTime: '00:05'
                            strArrivalDate: '2023-11-30'
                            strArrivalTime: '06:20'
                          - segmentId: 4abffb5c6b36b9a366075d4726460a66
                            airline: VJ
                            flightNum: '632'
                            cabinClass: ECONOMY
                            bookingCode: I
                            availabilityCount: 3
                            departure: SGN
                            arrival: DAD
                            departureDate: 1701336000000
                            arrivalDate: 1701340500000
                            flightTime: 75
                            codeShare: 'N'
                            strDepartureDate: '2023-11-30'
                            strDepartureTime: '17:20'
                            strArrivalDate: '2023-11-30'
                            strArrivalTime: '18:35'
                        ancillary:
                          - lastName: LIN
                            firstName: LIHONG
                            psgType: ADT
                            ancillaries:
                              baggage:
                                - ancillaryType: 1
                                  payBaggageType: 1
                                  baggagePiece: 2
                                  baggageWeight: 36KG
                                  baggageCurrency: CNY
                                  baggagePrice: 95
                                  journeys:
                                    - airline: VJ
                                      flightNum: '896'
                                      departure: DEL
                                      departureDate: '2023-11-30'
                                      departureTime: '00:05'
                                      arrival: SGN
                                      arrivalDate: '2023-11-30'
                                      arrivalTime: '06:20'
                                      bookingCode: I
                                    - airline: VJ
                                      flightNum: '632'
                                      departure: SGN
                                      departureDate: '2023-11-30'
                                      departureTime: '17:20'
                                      arrival: DAD
                                      arrivalDate: '2023-11-30'
                                      arrivalTime: '18:35'
                                      bookingCode: I
                          - lastName: LIN
                            firstName: LIHONG
                            psgType: ADT
                            ancillaries:
                              seat:
                                - ancillaryType: 2
                                  seatName: 46A
                                  column: A
                                  row: '46'
                                  seatCurrency: CNY
                                  seatPrice: '40.00'
                                  characteristics:
                                    - middle
                                  segment:
                                    - airline: VJ
                                      departure: DEL
                                      departureDate: '2023-11-30'
                                      departureTime: '00:05'
                                      arrival: SGN
                                      arrivalDate: '2023-11-30'
                                      arrivalTime: '06:20'
                                      flightNum: '896'
                                      bookingCode: I
                                  buyerOrder: '23146'
                                - ancillaryType: 2
                                  seatName: 15A
                                  column: A
                                  row: '15'
                                  seatCurrency: CNY
                                  seatPrice: '40.00'
                                  characteristics:
                                    - middle
                                  segment:
                                    - airline: VJ
                                      departure: SGN
                                      departureDate: '2023-11-30'
                                      departureTime: '17:20'
                                      arrival: DAD
                                      arrivalDate: '2023-11-30'
                                      arrivalTime: '18:35'
                                      flightNum: '632'
                                      bookingCode: I
                                  buyerOrder: '23147'
                      orderResult:
                        orderNum: '9169953203701'
                        pnr: A8GS1Q
          headers: {}
          x-apifox-name: Success
        x-200:Error:
          description: ''
          content:
            application/json:
              schema:
                type: object
                properties: {}
                x-apifox-orders: []
                x-apifox-ignore-properties: []
              examples:
                '2':
                  summary: Error(B009)
                  value: >-
                    {
                      "errorCode": "B009",
                      "errorMsg": "Order status is invalid."
                    }



                    Remark: 

                    This error code indicates that the order staus is not 'Paid,
                    to be issued'. Please make sure the order status is correct
                    before calling this interface 
                '4':
                  summary: Error(B010)
                  value:
                    errorCode: B010
                    errorMsg: The order was not found.
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/APIs with all versions/OrderPricing
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469928-run
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