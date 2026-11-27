# AncillaryPricing V6

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/ancillaryPricingV6:
    post:
      summary: AncillaryPricing V6
      deprecated: false
      description: "##  Function\n\nThrough AncillaryPricing API, you can search ancillary products and get product details.\n\n\nPaid baggage and seat selection are available in the initial booking. It is able to search multiple ancillary products at the \nsame time or search them separately.\n\n\nThe passengers and journeys are required when adding ancillary in the inital booking. The request structure of \nAncillaryPricing is the same as that of PrecisePricing. It is necessary to use PrecisePricing service before using this \ninterface. The whole process should be limited to 30 mins.\n\n\nAdditionally, paid baggage is also available in the postbooking process. The air order number is required in the \nAncillarypricing request when adding ancillary after the booking. AncillaryPricing Results are valid within half an hour.\n\n## Versioning\n\n|Version|Sandbox Invoking Address|Update|\n|:----|:----|:----|\n|ancillaryPricing|[https://api.pkfare.com/ancillaryPricing](https://api.pkfare.com/ancillaryPricing)|Support in-booking paid baggage|\n|ancillaryPricing_V3|[https://api.pkfare.com/ancillaryPricingV3](http://api.pkfare.com/ancillaryPricingV3)|Support in-booking seat selection|\n|ancillaryPricing_V4|[https://api.pkfare.com/ancillaryPricingV4](http://api.pkfare.com/ancillaryPricingV4)|Support postbooking paid bag|\n|ancillaryPricing_V5|[https://api.pkfare.com/ancillaryPricingV](http://api.pkfare.com/ancillaryPricingV4)5|Add solutionId to enhance tracebility and visibility|\n|ancillaryPricing_V5(json format)|https://api.pkfare.com/json/ancillaryPricingV5|Add solutionId to enhance tracebility and visibility;Support json formatted requesting parameter|\n|ancillaryPricing_V6(json format)|https://api.pkfare.com/json/ancillaryPricingV6|New feature: now support shopping and booking prices for different product tags, including PKFARE-defined special product types and airline-standard branded fares, etc. and support ancillary pricing for passengers traveling with infants|\n\n*Below is the most updated version* \n\n## Request Example\n\n1. One-Way Journey (Search Baggage)\n\n\n```plain\n{\n    \"authentication\": {\n        \"partnerId\":\"partnerId\",\n        \"sign\":\"sign\"\n    },\n    \"pricing\": {\n        \"adults\": 1,\n        \"children\": 0,\n        \"infants\": 1,\n        \"ancillary\": [\n            1\n        ],\n        \"solutionId\": \"1\",\n        \"journeys\": {\n            \"journey_0\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"HKG\",\n                    \"arrivalDate\":\"2022-04-23\",\n                    \"arrivalTime\":\"10:05\",\n                    \"bookingCode\":\"O\",\n                    \"departure\":\"SIN\",\n                    \"departureDate\":\"2022-04-23\",\n                    \"departureTime\":\"06:00\",\n                    \"flightNum\":\"980\"\n                }\n            ]\n        }\n    }\n}\n```\n\n\n2. One-Way Journey(Search Seat)\n```plain\n{\n    \"authentication\": {\n        \"partnerId\":\"partnerId\",\n        \"sign\":\"sign\"\n    },\n    \"pricing\": {\n        \"adults\": 1,\n        \"children\": 0,\n        \"infants\": 0,\n        \"ancillary\": [\n            2\n        ],\n        \"solutionId\": \"1\",\n        \"journeys\": {\n            \"journey_0\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"HKG\",\n                    \"arrivalDate\":\"2022-04-23\",\n                    \"arrivalTime\":\"10:05\",\n                    \"bookingCode\":\"O\",\n                    \"departure\":\"SIN\",\n                    \"departureDate\":\"2022-04-23\",\n                    \"departureTime\":\"06:00\",\n                    \"flightNum\":\"980\"\n                }\n            ]\n        }\n    }\n}\n```\n\n3.Round Journey (Search Baggage)\n```plain\n{\n    \"authentication\": {\n        \"partnerId\":\"partnerId\",\n        \"sign\":\"sign\"\n    },\n    \"pricing\": {\n        \"adults\": 1,\n        \"children\": 0,\n        \"infants\": 0,\n        \"ancillary\": [\n            1\n        ],\n        \"solutionId\": \"1\",\n        \"journeys\": {\n            \"journey_0\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"HKG\",\n                    \"arrivalDate\":\"2022-04-23\",\n                    \"arrivalTime\":\"10:05\",\n                    \"bookingCode\":\"O\",\n                    \"departure\":\"SIN\",\n                    \"departureDate\":\"2022-04-23\",\n                    \"departureTime\":\"06:00\",\n                    \"flightNum\":\"980\"\n                }\n            ],\n            \"journey_1\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"SIN\",\n                    \"arrivalDate\":\"2022-04-25\",\n                    \"arrivalTime\":\"14:50\",\n                    \"bookingCode\":\"W\",\n                    \"departure\":\"HKG\",\n                    \"departureDate\":\"2022-04-25\",\n                    \"departureTime\":\"10:55\",\n                    \"flightNum\":\"981\"\n                }\n            ]\n        }\n    }\n}\n```\n\n\n4. Round Journey (Search Baggage And Seat)\n```plain\n{\n    \"authentication\": {\n        \"sign\": \"sign\",\n        \"partnerId\": \"partnerId\"\n    },\n    \"pricing\": {\n        \"journeys\": {\n            \"journey_1\": [\n                {\n                    \"departureTime\": \"09:20\",\n                    \"flightNum\": \"625\",\n                    \"arrival\": \"SGN\",\n                    \"arrivalTime\": \"10:45\",\n                    \"bookingCode\": \"S\",\n                    \"departure\": \"DAD\",\n                    \"departureDate\": \"2023-12-10\",\n                    \"airline\": \"VJ\",\n                    \"arrivalDate\": \"2023-12-10\"\n                },\n                {\n                    \"departureTime\": \"19:00\",\n                    \"flightNum\": \"895\",\n                    \"arrival\": \"DEL\",\n                    \"arrivalTime\": \"22:50\",\n                    \"bookingCode\": \"S\",\n                    \"departure\": \"SGN\",\n                    \"departureDate\": \"2023-12-10\",\n                    \"airline\": \"VJ\",\n                    \"arrivalDate\": \"2023-12-10\"\n                }\n            ],\n            \"journey_0\": [\n                {\n                    \"departureTime\": \"00:05\",\n                    \"flightNum\": \"896\",\n                    \"arrival\": \"SGN\",\n                    \"arrivalTime\": \"06:20\",\n                    \"bookingCode\": \"I\",\n                    \"departure\": \"DEL\",\n                    \"departureDate\": \"2023-11-30\",\n                    \"airline\": \"VJ\",\n                    \"arrivalDate\": \"2023-11-30\"\n                },\n                {\n                    \"departureTime\": \"17:20\",\n                    \"flightNum\": \"632\",\n                    \"arrival\": \"DAD\",\n                    \"arrivalTime\": \"18:35\",\n                    \"bookingCode\": \"I\",\n                    \"departure\": \"SGN\",\n                    \"departureDate\": \"2023-11-30\",\n                    \"airline\": \"VJ\",\n                    \"arrivalDate\": \"2023-11-30\"\n                }\n            ]\n        },\n        \"children\": \"1\",\n        \"solutionId\": \"1\",\n        \"adults\": \"2\",\n        \"infants\": 1,\n        \"ancillary\": [\n            1,\n            2\n        ]\n    }\n}\n```\n\_\n5. Open Jaw (Search Baggage)\n\n\n```plain\n{\n    \"authentication\": {\n        \"partnerId\":\"partnerId\",\n        \"sign\":\"sign\"\n    },\n    \"pricing\": {\n        \"adults\": 1,\n        \"children\": 0,\n        \"infants\": 1,\n        \"ancillary\": [\n            1\n        ],\n        \"solutionId\": \"1\",\n        \"journeys\": {\n            \"journey_0\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"HKG\",\n                    \"arrivalDate\":\"2022-04-23\",\n                    \"arrivalTime\":\"10:05\",\n                    \"bookingCode\":\"O\",\n                    \"departure\":\"SIN\",\n                    \"departureDate\":\"2022-04-23\",\n                    \"departureTime\":\"06:00\",\n                    \"flightNum\":\"980\"\n                }\n            ],\n            \"journey_1\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"CNX\",\n                    \"arrivalDate\":\"2022-04-25\",\n                    \"arrivalTime\":\"14:50\",\n                    \"bookingCode\":\"W\",\n                    \"departure\":\"HKG\",\n                    \"departureDate\":\"2022-04-25\",\n                    \"departureTime\":\"10:55\",\n                    \"flightNum\":\"981\"\n                }\n            ]\n        }\n    }\n}\n```\n\n\n6. Search Postbooking Baggage\n\n\n```plain\n{\n    \"authentication\": {\n        \"sign\": \"sign\",\n        \"partnerId\": \"partnerId\"\n    },\n    \"pricing\": {\n        \"airOrderNum\": \"917049521951368301\",\n        \"ancillary\": [\n            1\n        ]\n    }\n}\n```\n\n\n##  Error Code List\n\n|errorCode|errorMsg|Description|\n|:----|:----|:----|\n|0|ok|Request has been processed successfully.|\n|S001|System error|System error.|\n|P001|XXX is illegal|Parameter is illegal.|\n|P002|XXX is missing|Parameter is missing.|\n|P006|Invalid parameter|Wrong parameter, please check.|\n|B002|Partner is not exists|Partner ID does not exist.|\n|B003|Illegal sign|Illegal sign, please check your signature.|\n|B005|Can not find any matching precisePricing result within 30 minutes|Can not find the corresponding precisePricing record. Please check the itinerary and passenger numbers. AncillaryPricing has to be invoked within 30 minutes after pricing.|\n|B009|Order status is invalid|air order status doesn't meet the requirement.|\n|B010|The order was not found.|The air order number was not correct.|\n|B069|AncillaryPricing is offline-1|The AncillaryPricing API is offline, please contact PKFARE to enable it.|\n|B070|No ancillary price on this routing|No ancillary price for this routing.|\n|B085|The journey infomation of AncillaryPricing is not consistent with that of air order|The journey infomation of AncillaryPricing is not correct|\n|B086|The number of ancillary passenger type outnumbers that of air order.|The number of ancillary passenger type is not correct.|\n\n"
      tags:
        - API Reference/APIs with all versions/AncillaryPricing
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
                    solutionId:
                      type: string
                      description: >-
                        Unique identification returned in PrecisePricing,
                        request with it for associating with the Pricing
                        solution and linking to the entire request process
                    tag:
                      type: string
                      description: >-
                        Product tag, must be filled in according to PKFARE's
                        designated code (only one tag is supported in this
                        version). Please enter the product tag associated with
                        the Pricing price.
                    airOrderNum:
                      type: string
                      description: PKFARE air order number
                    ancillary:
                      type: array
                      items:
                        type: integer
                      description: ancillary type; 1-baggage;2-seat
                    adults:
                      type: string
                      description: adult passenger number
                    children:
                      type: string
                      description: children passenger number
                    infants:
                      type: string
                      description: infants passenger number
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
                                description: airline code
                              departure:
                                type: string
                                description: origin[IATA airport code]
                              departureDate:
                                type: string
                                description: "departure date[yyyy-MM-dd]\t"
                              departureTime:
                                type: string
                                description: departure time[hh:mm]
                              arrival:
                                type: string
                                description: destination[IATA airport code]
                              arrivalDate:
                                type: string
                                description: "arrival date[yyyy-MM-dd]\t"
                              arrivalTime:
                                type: string
                                description: "arrival time[hh:mm]\t"
                              bookingCode:
                                type: string
                                description: cabin code
                              flightNum:
                                type: string
                                description: flight number
                              fareBasis:
                                type: string
                                description: fare basis code
                            required:
                              - airline
                              - departure
                              - departureDate
                              - arrival
                              - arrivalDate
                              - bookingCode
                              - flightNum
                            x-apifox-orders:
                              - airline
                              - departure
                              - departureDate
                              - departureTime
                              - arrival
                              - arrivalDate
                              - arrivalTime
                              - bookingCode
                              - flightNum
                              - fareBasis
                            x-apifox-ignore-properties: []
                          description: journey_0 or  journey_1
                      required:
                        - journey_0
                      x-apifox-orders:
                        - journey_0
                      description: itinerary information
                      x-apifox-ignore-properties: []
                  required:
                    - solutionId
                    - ancillary
                  x-apifox-orders:
                    - solutionId
                    - tag
                    - airOrderNum
                    - ancillary
                    - adults
                    - children
                    - infants
                    - journeys
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - pricing
              x-apifox-orders:
                - 01HVQJCFPXQZP4YZRRXM74RK65
                - pricing
              x-apifox-refs:
                01HVQJCFPXQZP4YZRRXM74RK65:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: '{{sign}}'
                partnerId: '{{partnerId}}'
              pricing:
                journeys:
                  journey_0:
                    - departureTime: '14:40'
                      flightNum: '501'
                      arrival: DMK
                      arrivalTime: '16:40'
                      bookingCode: Z
                      departure: HKG
                      departureDate: '2024-12-15'
                      airline: FD
                      arrivalDate: '2024-12-15'
                  journey_1:
                    - departureTime: '15:30'
                      flightNum: '504'
                      arrival: HKG
                      arrivalTime: '17:15'
                      bookingCode: A
                      departure: DMK
                      departureDate: '2024-12-30'
                      airline: FD
                      arrivalDate: '2024-12-30'
                children: '0'
                solutionId: >-
                  iXf1ufZoOsBU+MpHfwQD6vzfcE3X5BFe1Vxl3oa9iNn1Noc75XschKYpLVXfU17PcPI7oU/EVSKjQj2Xuxt9QoSJGTP7oW12BBtDUQvlAzaZ1z0zhjr4N5cJVh2fElsdEXXtCGI00H3Nvx98/d2z6lUfU0Yhuny0kj/rOz4IMMmghIhWyGDa4e4T7y3BrTjFwEPZh0nHoEykVO13sMp0vXt8ub60T12OXl9dooXkhpqN51MhNjyCkSYjIYff//DJ1cRBps9+3e58SI0ifR8P6FiCKSCYOmCQLFKKLU0P8+Xlv4BsqxNY0pdOKT7LeR3w2YGgt1zSCyEXZCwy/+BBLA66j01ytAzieUvdZ3sqLyc8+7IG23vo1JfqVtlJo/pvRdlQyp6gQGJDPraSkTCSvA==
                tag: SAVER
                adults: '1'
                ancillary:
                  - 1
                  - 2
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
                    description: error code; refer to error code list
                  errorMsg:
                    type: string
                    description: error message
                  data:
                    type: array
                    items:
                      type: object
                      properties:
                        ancillaryType:
                          type: integer
                          description: ancillary type; 1-baggage;2-seat
                        ancillary:
                          type: object
                          properties:
                            journeys:
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
                                  bookingCode:
                                    type: string
                                    description: cabin code
                                  flightNum:
                                    type: string
                                    description: "flight number\t"
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
                                  - bookingCode
                                  - flightNum
                                  - segmentKey
                                x-apifox-ignore-properties: []
                              description: itinerary information
                            ancillaries:
                              type: object
                              properties:
                                baggage:
                                  type: array
                                  items:
                                    type: object
                                    properties:
                                      ancillaryKey:
                                        type: string
                                        description: unique identification of ancillary
                                      payBaggageType:
                                        type: integer
                                        description: >-
                                          baggage type; 1-checked baggage,
                                          2-carry-on baggage
                                      baggagePiece:
                                        type: integer
                                        description: >-
                                          baggage piece; -1 - no limit to baggage
                                          piece
                                      baggageWeight:
                                        type: string
                                        description: "baggage weight\t"
                                      baggageCurrency:
                                        type: string
                                        description: currency
                                      baggagePrice:
                                        type: number
                                        description: price
                                      description:
                                        type: string
                                        description: "baggage description\t"
                                    x-apifox-orders:
                                      - ancillaryKey
                                      - payBaggageType
                                      - baggagePiece
                                      - baggageWeight
                                      - baggageCurrency
                                      - baggagePrice
                                      - description
                                    x-apifox-ignore-properties: []
                                  description: baggage details
                                seat:
                                  type: array
                                  items:
                                    type: object
                                    properties:
                                      segmentKey:
                                        type: string
                                        description: "unique identification of the segment\t"
                                      seatMaps:
                                        type: array
                                        items:
                                          type: object
                                          properties:
                                            ancillaryKey:
                                              type: string
                                              description: unique identification of ancillary
                                            seatName:
                                              type: string
                                              description: seat number
                                            column:
                                              type: string
                                              description: seat column
                                            row:
                                              type: string
                                              description: seat row
                                            seatCategory:
                                              type: string
                                              description: seast category
                                            available:
                                              type: string
                                              description: "seat availability；True-available;False-occupied\t"
                                            seatCurrency:
                                              type: string
                                              description: "seat currency\t"
                                            seatPrice:
                                              type: string
                                              description: "seat price\t"
                                            deck:
                                              type: string
                                              description: deck
                                            characteristics:
                                              type: array
                                              items:
                                                type: string
                                              description: "the traits of seats；inlude 5 options: window/no window/middle/aisle/exit row\t"
                                          x-apifox-orders:
                                            - ancillaryKey
                                            - seatName
                                            - column
                                            - row
                                            - seatCategory
                                            - available
                                            - seatCurrency
                                            - seatPrice
                                            - deck
                                            - characteristics
                                          x-apifox-ignore-properties: []
                                        description: seatmaps information
                                    x-apifox-orders:
                                      - segmentKey
                                      - seatMaps
                                    x-apifox-ignore-properties: []
                                  description: seat details
                              x-apifox-orders:
                                - baggage
                                - seat
                              x-apifox-ignore-properties: []
                          x-apifox-orders:
                            - journeys
                            - ancillaries
                          description: ancillary data
                          required:
                            - journeys
                          x-apifox-ignore-properties: []
                      x-apifox-orders:
                        - ancillaryType
                        - ancillary
                      x-apifox-ignore-properties: []
                    description: >-
                      only if the errorCode returns "0", returned data would not
                      be null. Data is in JSON format, which contains three
                      collection objects: solutions, flights, segments
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
                  summary: Round Journey (Search Baggage And Seat)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      - ancillaryType: 1
                        ancillary:
                          journeys:
                            - airline: FD
                              flightNum: '504'
                              departure: DMK
                              departureDate: '2024-12-30'
                              departureTime: '15:30'
                              arrival: HKG
                              arrivalDate: '2024-12-30'
                              arrivalTime: '19:15'
                              bookingCode: A
                              cabinClass: ECONOMY
                          ancillaries:
                            baggage:
                              - ancillaryKey: 58ef0820cfb6dee57c3f89e6d4600be4
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 20KG
                                baggageCurrency: USD
                                baggagePrice: 28.3
                                description: ''
                              - ancillaryKey: 393fa6969e30a692c190ee2d303a59c8
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 25KG
                                baggageCurrency: USD
                                baggagePrice: 35.61
                                description: ''
                              - ancillaryKey: 742bcb8b01e37144a5f109cf2643b8fe
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 40KG
                                baggageCurrency: USD
                                baggagePrice: 81.58
                                description: 1 bag must not exceed 32 kg
                              - ancillaryKey: 1129247874c431bfe6f967ad4a797ef7
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 50KG
                                baggageCurrency: USD
                                baggagePrice: 105.47
                                description: 1 bag must not exceed 32 kg
                              - ancillaryKey: 88b4c663ed4a75d578a50cbd9e737f0c
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 60KG
                                baggageCurrency: USD
                                baggagePrice: 131.28
                                description: 1 bag must not exceed 32 kg
                      - ancillaryType: 1
                        ancillary:
                          journeys:
                            - airline: FD
                              flightNum: '501'
                              departure: HKG
                              departureDate: '2024-12-15'
                              departureTime: '14:40'
                              arrival: DMK
                              arrivalDate: '2024-12-15'
                              arrivalTime: '16:40'
                              bookingCode: Z
                              cabinClass: ECONOMY
                          ancillaries:
                            baggage:
                              - ancillaryKey: 907d145eaa761e8361bbd820d9bfb755
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 20KG
                                baggageCurrency: USD
                                baggagePrice: 32.99
                                description: ''
                              - ancillaryKey: 0f2e71c6e3aa1d950d2012ac06146211
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 25KG
                                baggageCurrency: USD
                                baggagePrice: 41.69
                                description: ''
                              - ancillaryKey: f03e7e584771f8fcbc9c72a86e4ab305
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 40KG
                                baggageCurrency: USD
                                baggagePrice: 96.08
                                description: 1 bag must not exceed 32 kg
                              - ancillaryKey: 894e81b1d1f3d88af28b704f8a0559a1
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 50KG
                                baggageCurrency: USD
                                baggagePrice: 124.38
                                description: 1 bag must not exceed 32 kg
                              - ancillaryKey: 67192268d63e1c8917f3a74620892fee
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: -1
                                baggageWeight: 60KG
                                baggageCurrency: USD
                                baggagePrice: 155.3
                                description: 1 bag must not exceed 32 kg
                      - ancillaryType: 2
                        ancillary:
                          journeys:
                            - airline: FD
                              flightNum: '501'
                              departure: HKG
                              departureDate: '2024-12-15'
                              departureTime: '14:40'
                              arrival: DMK
                              arrivalDate: '2024-12-15'
                              arrivalTime: '16:40'
                              bookingCode: Z
                              segmentKey: f8d6cecf01a2ce41505bc374ecd9363c
                              cabinClass: ECONOMY
                          ancillaries:
                            seat:
                              - segmentKey: f8d6cecf01a2ce41505bc374ecd9363c
                                seatMaps:
                                  - ancillaryKey: c0614ffbed329c490efd66ded445b588
                                    ancillaryType: 2
                                    seatName: 1A
                                    column: A
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '14.910'
                                    characteristics:
                                      - window
                                  - ancillaryKey: e4d6c3bf27bc379ed158600a3bd9cf49
                                    ancillaryType: 2
                                    seatName: 2A
                                    column: A
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - window
                                  - ancillaryKey: fd5340b46398d07641404b47a856bbca
                                    ancillaryType: 2
                                    seatName: 3A
                                    column: A
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - window
                                  - ancillaryKey: f48a8f23232d5325898696c5f5aa4386
                                    ancillaryType: 2
                                    seatName: 4A
                                    column: A
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - window
                                  - ancillaryKey: e63dd437a735f01d225ff5b5ae7b04ec
                                    ancillaryType: 2
                                    seatName: 5A
                                    column: A
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 48ccd68c7db205fa28c8b6ad1811f90a
                                    ancillaryType: 2
                                    seatName: 6A
                                    column: A
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 2deda6e44c0e5a1de793ecd867bcc740
                                    ancillaryType: 2
                                    seatName: 7A
                                    column: A
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 6725e1a22597cad8272e3e6ccc065e77
                                    ancillaryType: 2
                                    seatName: 8A
                                    column: A
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 986ea0bccbd0b8a0db2f8f62ed221770
                                    ancillaryType: 2
                                    seatName: 9A
                                    column: A
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 98a50cc822a554e55c0c46e12f516eca
                                    ancillaryType: 2
                                    seatName: 10A
                                    column: A
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - window
                                  - ancillaryKey: b353b4e8550afa1634357e8c66e625a3
                                    ancillaryType: 2
                                    seatName: 11A
                                    column: A
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 5b98474990c16231e009e5feed057482
                                    ancillaryType: 2
                                    seatName: 12A
                                    column: A
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '14.080'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 69e25e40f4c17be30c361b8dc3eeaaa2
                                    ancillaryType: 2
                                    seatName: 14A
                                    column: A
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '14.080'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 40f7057cb23466dbb71973eb0fdb13ac
                                    ancillaryType: 2
                                    seatName: 15A
                                    column: A
                                    row: '15'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 45c3308962e1518f227f7c92d8ae090b
                                    ancillaryType: 2
                                    seatName: 16A
                                    column: A
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: f0f6dca69c0df1639c7f92e8d75c06e4
                                    ancillaryType: 2
                                    seatName: 17A
                                    column: A
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 0438e208c858c31e269cffd0455f428d
                                    ancillaryType: 2
                                    seatName: 18A
                                    column: A
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 697d9c0c59f7e3111e29bce8536f4ca3
                                    ancillaryType: 2
                                    seatName: 19A
                                    column: A
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 2730613bd0fc8effcdd62e3a9de1d25a
                                    ancillaryType: 2
                                    seatName: 20A
                                    column: A
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: fcae5b8b23e539d6d2ae4455f7a3e72f
                                    ancillaryType: 2
                                    seatName: 21A
                                    column: A
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: f6380acbdfb40ba983c65cbabef09893
                                    ancillaryType: 2
                                    seatName: 22A
                                    column: A
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: f3f6dd5c6fe29b8ed608d6f29ead9c37
                                    ancillaryType: 2
                                    seatName: 23A
                                    column: A
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: b047ddb37c245eb4ffb57475437a5eb3
                                    ancillaryType: 2
                                    seatName: 24A
                                    column: A
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 8ca20fd09c71103d643f2e028a5f4550
                                    ancillaryType: 2
                                    seatName: 25A
                                    column: A
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 8cc98ed88985b77256a2268947c4d219
                                    ancillaryType: 2
                                    seatName: 26A
                                    column: A
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 88a925f3cfa435bd15057817664d5212
                                    ancillaryType: 2
                                    seatName: 27A
                                    column: A
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: d6aca757ef9162c7c49c1725e9dc7799
                                    ancillaryType: 2
                                    seatName: 28A
                                    column: A
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 467da72b665780d532bd1182ae39c3f0
                                    ancillaryType: 2
                                    seatName: 29A
                                    column: A
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: dc6565d218bd376c37bdadc6eb987d57
                                    ancillaryType: 2
                                    seatName: 30A
                                    column: A
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 318273a2b2c0c679c8035f0468c89744
                                    ancillaryType: 2
                                    seatName: 31A
                                    column: A
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 9ef040304d4293c23ade7beb121e58de
                                    ancillaryType: 2
                                    seatName: 1B
                                    column: B
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '14.910'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 3f07b4b5069288af972dc822db4ac0bb
                                    ancillaryType: 2
                                    seatName: 2B
                                    column: B
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.150'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 76512818b18891e50bf22bd9bbb08ac1
                                    ancillaryType: 2
                                    seatName: 3B
                                    column: B
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.150'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: b43bf428469e34aed7496c6b4ab43e9c
                                    ancillaryType: 2
                                    seatName: 4B
                                    column: B
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.150'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 59fce3fe6d1671d3fdecc56719f3acd9
                                    ancillaryType: 2
                                    seatName: 5B
                                    column: B
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.150'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: cb96dae9d19f3deff5553c4b9101c65e
                                    ancillaryType: 2
                                    seatName: 6B
                                    column: B
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.070'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 38375a045c36dfb886c419d6a84bf3b0
                                    ancillaryType: 2
                                    seatName: 7B
                                    column: B
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.070'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: e864da6f1407e57f99df83a53e746721
                                    ancillaryType: 2
                                    seatName: 8B
                                    column: B
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.070'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 60cf2b62734d9e6d8780f59a0451c7d0
                                    ancillaryType: 2
                                    seatName: 9B
                                    column: B
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: e3f3e4ed70d231f2ce082dd527346595
                                    ancillaryType: 2
                                    seatName: 10B
                                    column: B
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 1f44d249914ae4c3390ac46d24182f8c
                                    ancillaryType: 2
                                    seatName: 11B
                                    column: B
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 8b1f1027b492c0dfe45846e4bd5bb83f
                                    ancillaryType: 2
                                    seatName: 12B
                                    column: B
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '13.530'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 81466d57885279e1ce558f4c175abfc7
                                    ancillaryType: 2
                                    seatName: 14B
                                    column: B
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '13.530'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: fad6da7e44814019250ead5876de8151
                                    ancillaryType: 2
                                    seatName: 15B
                                    column: B
                                    row: '15'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.830'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: ff9d926b663d566443b248e4cda31d56
                                    ancillaryType: 2
                                    seatName: 16B
                                    column: B
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.830'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 4aef0678bacb7d3ab3efa6fd69cba11e
                                    ancillaryType: 2
                                    seatName: 17B
                                    column: B
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.830'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 4ce7ad4676563a9d3ea758aa24a0e337
                                    ancillaryType: 2
                                    seatName: 18B
                                    column: B
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.830'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: fc936e3e4929cb441f8868bc8195dd0c
                                    ancillaryType: 2
                                    seatName: 19B
                                    column: B
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: f9031455c5c39b846f4898aa1f166764
                                    ancillaryType: 2
                                    seatName: 20B
                                    column: B
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 576e4fe2fd277257a9121fb2807113dc
                                    ancillaryType: 2
                                    seatName: 21B
                                    column: B
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 0a1b23cbf71bd2bcc99351c5242c8aec
                                    ancillaryType: 2
                                    seatName: 22B
                                    column: B
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 5ab101d5c90bc87e6d8b2f871356105e
                                    ancillaryType: 2
                                    seatName: 23B
                                    column: B
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 8522218c8ed2796f98d27f0484dd4d49
                                    ancillaryType: 2
                                    seatName: 24B
                                    column: B
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: ac8e0bb2f77eb731037be2372270250a
                                    ancillaryType: 2
                                    seatName: 25B
                                    column: B
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: a5ff0fdc441d126b89f6b04230615a13
                                    ancillaryType: 2
                                    seatName: 26B
                                    column: B
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 2aff36d69afad3f69132784f93bbd193
                                    ancillaryType: 2
                                    seatName: 27B
                                    column: B
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: aa2fa34d0aacfd77c06c4d77a5b0d93d
                                    ancillaryType: 2
                                    seatName: 28B
                                    column: B
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: c210d9b650560945d1c10674760444a4
                                    ancillaryType: 2
                                    seatName: 29B
                                    column: B
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 22fb25743c7a7e924e06a0bd07c9b606
                                    ancillaryType: 2
                                    seatName: 30B
                                    column: B
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 672b35cfe71dc83fe9e9e3f6ca5fdf65
                                    ancillaryType: 2
                                    seatName: 31B
                                    column: B
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 745d157817c7f879842ab8f19581f709
                                    ancillaryType: 2
                                    seatName: 1C
                                    column: C
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '14.910'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: b4bff41f2d4b3c5e7418754b57cef81c
                                    ancillaryType: 2
                                    seatName: 2C
                                    column: C
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 5bc58e0fe52a8a1594670b588719cd48
                                    ancillaryType: 2
                                    seatName: 3C
                                    column: C
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 023687502130c102c8f00756595e1e68
                                    ancillaryType: 2
                                    seatName: 4C
                                    column: C
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 5d153f493c3625ad24567261a44bc7e3
                                    ancillaryType: 2
                                    seatName: 5C
                                    column: C
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 1ff4b9bfbf409a2f97b60c717b64c3f7
                                    ancillaryType: 2
                                    seatName: 6C
                                    column: C
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: af13bd309e082ebbb50710591ec9f6e5
                                    ancillaryType: 2
                                    seatName: 7C
                                    column: C
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 842479cf71d7b0dbfc71eb832366fd72
                                    ancillaryType: 2
                                    seatName: 8C
                                    column: C
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 30e0aed9765b40d1a247663706ca13ec
                                    ancillaryType: 2
                                    seatName: 9C
                                    column: C
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: fbaf091b2a18042936e6d03466d70512
                                    ancillaryType: 2
                                    seatName: 10C
                                    column: C
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 5a41d30aaaf2bf5865ab651f603d2efd
                                    ancillaryType: 2
                                    seatName: 11C
                                    column: C
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 33026b1eb0137e9a0c8df19baf636314
                                    ancillaryType: 2
                                    seatName: 12C
                                    column: C
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '14.080'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: d731534ffe25cd34e129387094b46442
                                    ancillaryType: 2
                                    seatName: 14C
                                    column: C
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '14.080'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 7560520272d9b98bec0c38b4b20aff89
                                    ancillaryType: 2
                                    seatName: 15C
                                    column: C
                                    row: '15'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 52a408941d6b6c35f125648b96f60934
                                    ancillaryType: 2
                                    seatName: 16C
                                    column: C
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 2ed2f8ba6838a8b7e562d585bb00abad
                                    ancillaryType: 2
                                    seatName: 17C
                                    column: C
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 27819c8db9062edd2e794ee324af5a05
                                    ancillaryType: 2
                                    seatName: 18C
                                    column: C
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 16be08cf5cd02289dc3c08bf26c050e8
                                    ancillaryType: 2
                                    seatName: 19C
                                    column: C
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 691070697d23b5c025cce565080abeab
                                    ancillaryType: 2
                                    seatName: 20C
                                    column: C
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 45462fa605763ab8a1597653d053b8c5
                                    ancillaryType: 2
                                    seatName: 21C
                                    column: C
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 181de6a608aba42fe521483f0c7b2c2e
                                    ancillaryType: 2
                                    seatName: 22C
                                    column: C
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 16a6f20e1b89b3cf0a3e8b09742e0af1
                                    ancillaryType: 2
                                    seatName: 23C
                                    column: C
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: a2b4b3947afb17f4204c478796ca362e
                                    ancillaryType: 2
                                    seatName: 24C
                                    column: C
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 38a17370b2b7bd4f1c0b606afc8a6376
                                    ancillaryType: 2
                                    seatName: 25C
                                    column: C
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: a5cc345292c00288537145b65db20810
                                    ancillaryType: 2
                                    seatName: 26C
                                    column: C
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: b9d9bef7b91c9fd58b3ac2f482dbf7e7
                                    ancillaryType: 2
                                    seatName: 27C
                                    column: C
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 9ecf32a70f7ad2fb5b2c050ab2884b0d
                                    ancillaryType: 2
                                    seatName: 28C
                                    column: C
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 198ba46975303c3e3dd4062c9a23684b
                                    ancillaryType: 2
                                    seatName: 29C
                                    column: C
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 1dadb720ca317d24671c791e7e718be4
                                    ancillaryType: 2
                                    seatName: 30C
                                    column: C
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: ac2f56a5a37bc0f9b915bbfd47348615
                                    ancillaryType: 2
                                    seatName: 31C
                                    column: C
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: b9bd046bb18b117be4236fa5eb4ba383
                                    ancillaryType: 2
                                    seatName: 1D
                                    column: D
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '14.910'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 04d8bdf1c7a868b7eac76ee6574b8e26
                                    ancillaryType: 2
                                    seatName: 2D
                                    column: D
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: a4bfb2eb4024c640ce06ce111a4c5bcc
                                    ancillaryType: 2
                                    seatName: 3D
                                    column: D
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 2b55c07784a6819cdfcc2bcd5d88cec8
                                    ancillaryType: 2
                                    seatName: 4D
                                    column: D
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: d27d11f68414e7c2876d8cd00fbd9718
                                    ancillaryType: 2
                                    seatName: 5D
                                    column: D
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 561f3687f08573e4be73c290b04a5d88
                                    ancillaryType: 2
                                    seatName: 6D
                                    column: D
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 7b46fee39cd21723c2c946033d8b71d0
                                    ancillaryType: 2
                                    seatName: 7D
                                    column: D
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: dfb9761876bd24182470a7e27726329b
                                    ancillaryType: 2
                                    seatName: 8D
                                    column: D
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: c0f2ba1beabcbda04ab11f4d9df1954e
                                    ancillaryType: 2
                                    seatName: 9D
                                    column: D
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: f1ab705192ecdd1d4edf84e939c3fbc9
                                    ancillaryType: 2
                                    seatName: 10D
                                    column: D
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: ccf31cd2d6fa9ffd8ce3facf071b23f3
                                    ancillaryType: 2
                                    seatName: 11D
                                    column: D
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: ab4f19f81336f88c6f90e69bdd3cb03a
                                    ancillaryType: 2
                                    seatName: 12D
                                    column: D
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '14.080'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 53ad5e42c02c89a940b7f180dcbabfb2
                                    ancillaryType: 2
                                    seatName: 14D
                                    column: D
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '14.080'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 9ef425a8db2a43d0e4b10e83d0c8e27b
                                    ancillaryType: 2
                                    seatName: 15D
                                    column: D
                                    row: '15'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 6c152472daaaeda4749d56c33b8de520
                                    ancillaryType: 2
                                    seatName: 16D
                                    column: D
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: c7887e25bd4d1114a74ddc8cea8055fb
                                    ancillaryType: 2
                                    seatName: 17D
                                    column: D
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 09a5b5ef146e1a51cc3ac407a403c49c
                                    ancillaryType: 2
                                    seatName: 18D
                                    column: D
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 34e31d8e333715bc04a53d07766d1cd8
                                    ancillaryType: 2
                                    seatName: 19D
                                    column: D
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 1ae5a06684acddefb18b4e7f0b9c0e73
                                    ancillaryType: 2
                                    seatName: 20D
                                    column: D
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 5a938f77849c7f445ee03831dcada61f
                                    ancillaryType: 2
                                    seatName: 21D
                                    column: D
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 652912703919071842dc164830933fd2
                                    ancillaryType: 2
                                    seatName: 22D
                                    column: D
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: aca6c3f85324c3d7d552ec1ba947a61e
                                    ancillaryType: 2
                                    seatName: 23D
                                    column: D
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 4303cbb99f4d9efa297e5464149750fd
                                    ancillaryType: 2
                                    seatName: 24D
                                    column: D
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 59542d7ea4402ad4350037c059e52932
                                    ancillaryType: 2
                                    seatName: 25D
                                    column: D
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 5cc7f4205ae42d954a3640b6a0ea0dd0
                                    ancillaryType: 2
                                    seatName: 26D
                                    column: D
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 5628c1410db509b36ca6c7b233a38e40
                                    ancillaryType: 2
                                    seatName: 27D
                                    column: D
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: d8db82881bffa0d5eaa4bcc1a6211772
                                    ancillaryType: 2
                                    seatName: 28D
                                    column: D
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 90293be5912cbf73a47c2446f3cbceff
                                    ancillaryType: 2
                                    seatName: 29D
                                    column: D
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: dd64ac1ab75f95f8131301d043946eb6
                                    ancillaryType: 2
                                    seatName: 30D
                                    column: D
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: bf9a9eb6c06ac62045ece940181a5633
                                    ancillaryType: 2
                                    seatName: 31D
                                    column: D
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 687d781ab3c5fafd465b5ae008442e74
                                    ancillaryType: 2
                                    seatName: 1E
                                    column: E
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '14.910'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 8688a821e7ece5f28dde081f82a786a1
                                    ancillaryType: 2
                                    seatName: 2E
                                    column: E
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.150'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: b3bac9eeb40150eac70a1e5e538d4f0e
                                    ancillaryType: 2
                                    seatName: 3E
                                    column: E
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.150'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 5d93d234b231728e3a9fa661c2e163e0
                                    ancillaryType: 2
                                    seatName: 4E
                                    column: E
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.150'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 227896f4097a5c01c110c362ee1285ab
                                    ancillaryType: 2
                                    seatName: 5E
                                    column: E
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.150'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 1f166a9eb1ad7bb18fb3cfb364b1a12a
                                    ancillaryType: 2
                                    seatName: 6E
                                    column: E
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.070'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 56f5d8569941855c66a1641731a47914
                                    ancillaryType: 2
                                    seatName: 7E
                                    column: E
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.070'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: f74c16305ac625e1c6043ffce8e68d25
                                    ancillaryType: 2
                                    seatName: 8E
                                    column: E
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.070'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: ceb8a265507d977a8194cb632e5c1ab9
                                    ancillaryType: 2
                                    seatName: 9E
                                    column: E
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 360f3bd85664b2f27fb9155f21412636
                                    ancillaryType: 2
                                    seatName: 10E
                                    column: E
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 2fa0b2c8878e42591e07055d1b91ceb6
                                    ancillaryType: 2
                                    seatName: 11E
                                    column: E
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: bd154b514fa953c572b016808939ef3d
                                    ancillaryType: 2
                                    seatName: 12E
                                    column: E
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '13.530'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: ca2c82131e3e9fb631e86bd715f61cda
                                    ancillaryType: 2
                                    seatName: 14E
                                    column: E
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '13.530'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 7ba0640936667249b07cdce3e101ab16
                                    ancillaryType: 2
                                    seatName: 15E
                                    column: E
                                    row: '15'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '4.830'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 5a3139fb3140041c09f295b521b7c368
                                    ancillaryType: 2
                                    seatName: 16E
                                    column: E
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.830'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: dacf4f9694ad787e5986b2125194fa72
                                    ancillaryType: 2
                                    seatName: 17E
                                    column: E
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.830'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 59f9b8cdfd6735b127e8e9f0e2e76a34
                                    ancillaryType: 2
                                    seatName: 18E
                                    column: E
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.830'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 6cfcac0ee37f36a06968e8cafaf46405
                                    ancillaryType: 2
                                    seatName: 19E
                                    column: E
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: ad137296d2dbf39104d20b1f73b5966b
                                    ancillaryType: 2
                                    seatName: 20E
                                    column: E
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 7c9c5a732977526efbdaaafa13197aea
                                    ancillaryType: 2
                                    seatName: 21E
                                    column: E
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 2373e08724dee6326ca3cba0378ef64c
                                    ancillaryType: 2
                                    seatName: 22E
                                    column: E
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: f420d729d0b51e198dc80d90c8b65a43
                                    ancillaryType: 2
                                    seatName: 23E
                                    column: E
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 6fd42ed82d1c3486895b5b2fca659b4e
                                    ancillaryType: 2
                                    seatName: 24E
                                    column: E
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 125c9280df7d328e85b08721402f02f6
                                    ancillaryType: 2
                                    seatName: 25E
                                    column: E
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 152e6bb26aab1f5d2093c41cd72af7c1
                                    ancillaryType: 2
                                    seatName: 26E
                                    column: E
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: de066b6d4131f97d41adcd63939c07ad
                                    ancillaryType: 2
                                    seatName: 27E
                                    column: E
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: b6efa3d8c0032b3096d9f34161b7ffa2
                                    ancillaryType: 2
                                    seatName: 28E
                                    column: E
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: a91e50cd12be2fbe0a26685245710616
                                    ancillaryType: 2
                                    seatName: 29E
                                    column: E
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 7f0738867323d456f858f666da526017
                                    ancillaryType: 2
                                    seatName: 30E
                                    column: E
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 475b9aa14b76018867301dfec1fac32e
                                    ancillaryType: 2
                                    seatName: 31E
                                    column: E
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: bbfb15e135caad33c2613f468c7d945b
                                    ancillaryType: 2
                                    seatName: 1F
                                    column: F
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '14.910'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 4bdf401554111d34121f007e2e76fd11
                                    ancillaryType: 2
                                    seatName: 2F
                                    column: F
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - window
                                  - ancillaryKey: f4382db01f676c444f1e5290ed6ca648
                                    ancillaryType: 2
                                    seatName: 3F
                                    column: F
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 75835e884c8a77ab438ed036729bd532
                                    ancillaryType: 2
                                    seatName: 4F
                                    column: F
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 62c7d40a9743fe4f867c9d9e8aedab15
                                    ancillaryType: 2
                                    seatName: 5F
                                    column: F
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '12.700'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 9de98d99c63392165ee82b7298afad25
                                    ancillaryType: 2
                                    seatName: 6F
                                    column: F
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 7c84c592e292cf5c4f5e5129387491e2
                                    ancillaryType: 2
                                    seatName: 7F
                                    column: F
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - window
                                  - ancillaryKey: e1b302df78f525775f5078efc460252b
                                    ancillaryType: 2
                                    seatName: 8F
                                    column: F
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '6.350'
                                    characteristics:
                                      - window
                                  - ancillaryKey: eaee24bc6fbe96816b9208025f6bf55b
                                    ancillaryType: 2
                                    seatName: 9F
                                    column: F
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - window
                                  - ancillaryKey: e2943484d8d12e37c988db670b31c8b7
                                    ancillaryType: 2
                                    seatName: 10F
                                    column: F
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 6013928f109d31772844c3a3d4e3db0e
                                    ancillaryType: 2
                                    seatName: 11F
                                    column: F
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.520'
                                    characteristics:
                                      - window
                                  - ancillaryKey: c9175e49d5ea0f91768c892f3cb01802
                                    ancillaryType: 2
                                    seatName: 12F
                                    column: F
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '14.080'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: d7e0c6bb1724e7a7862a1ca00238870e
                                    ancillaryType: 2
                                    seatName: 14F
                                    column: F
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '14.080'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: c8f87c6e77e6b13ce49869326e00841b
                                    ancillaryType: 2
                                    seatName: 15F
                                    column: F
                                    row: '15'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 837846dd95d2c86cacc20fa6eaa15426
                                    ancillaryType: 2
                                    seatName: 16F
                                    column: F
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: e76818039643de64f92d5889e632a5bc
                                    ancillaryType: 2
                                    seatName: 17F
                                    column: F
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 4034addcfb93a5c9c79369ad54c5cfa6
                                    ancillaryType: 2
                                    seatName: 18F
                                    column: F
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 5a9276197496cfa98b7858f16e24df36
                                    ancillaryType: 2
                                    seatName: 19F
                                    column: F
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.970'
                                    characteristics:
                                      - window
                                  - ancillaryKey: a8e35dd204d240278361a0b159feec43
                                    ancillaryType: 2
                                    seatName: 20F
                                    column: F
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 96237450b1bf7e4d95d6c213a82b9a17
                                    ancillaryType: 2
                                    seatName: 21F
                                    column: F
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: b8dd9a8045752f4ef77bc151d581a278
                                    ancillaryType: 2
                                    seatName: 22F
                                    column: F
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 157703560f3e6b650f36688107250b8b
                                    ancillaryType: 2
                                    seatName: 23F
                                    column: F
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: b5e5b645aff5ad6ff5d8dd2c780a06b1
                                    ancillaryType: 2
                                    seatName: 24F
                                    column: F
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 7dc650cbbbd6e742be127769a883ffed
                                    ancillaryType: 2
                                    seatName: 25F
                                    column: F
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: eb24044bd055ab42cfc82113af8712c7
                                    ancillaryType: 2
                                    seatName: 26F
                                    column: F
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 6e987b55bd46f28ef4887731a74cdcb8
                                    ancillaryType: 2
                                    seatName: 27F
                                    column: F
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 617dc8978fcf523f7c0eda7f05b40700
                                    ancillaryType: 2
                                    seatName: 28F
                                    column: F
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 4602a5a1e003f7b77431dc1f5e0b1213
                                    ancillaryType: 2
                                    seatName: 29F
                                    column: F
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: b17ce2cd9c84d9ceee6d4d137ee24886
                                    ancillaryType: 2
                                    seatName: 30F
                                    column: F
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 3331856cc6b7050155b2893f31afb45c
                                    ancillaryType: 2
                                    seatName: 31F
                                    column: F
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '4.140'
                                    characteristics:
                                      - window
                      - ancillaryType: 2
                        ancillary:
                          journeys:
                            - airline: FD
                              flightNum: '504'
                              departure: DMK
                              departureDate: '2024-12-30'
                              departureTime: '15:30'
                              arrival: HKG
                              arrivalDate: '2024-12-30'
                              arrivalTime: '19:15'
                              bookingCode: A
                              segmentKey: 7220d98f4bc622f83be11e0cb78e736a
                              cabinClass: ECONOMY
                          ancillaries:
                            seat:
                              - segmentKey: 7220d98f4bc622f83be11e0cb78e736a
                                seatMaps:
                                  - ancillaryKey: bf006e93febcd28fc12d95140c73c9c5
                                    ancillaryType: 2
                                    seatName: 1A
                                    column: A
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.360'
                                    characteristics:
                                      - window
                                  - ancillaryKey: fc3e94aebdb4d48b053cb47831945ce2
                                    ancillaryType: 2
                                    seatName: 2A
                                    column: A
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 3217d210b5d9102c08097f691d5acdc4
                                    ancillaryType: 2
                                    seatName: 3A
                                    column: A
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 7c78a8c78ce3009e36a04758cf5468d8
                                    ancillaryType: 2
                                    seatName: 4A
                                    column: A
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 584ef4bfe7eb99a04ac6b9aa4120335c
                                    ancillaryType: 2
                                    seatName: 5A
                                    column: A
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 3ef9b7a2c154ca3f9c2597f939ae8b29
                                    ancillaryType: 2
                                    seatName: 6A
                                    column: A
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - window
                                  - ancillaryKey: cecea0d8216985f157ea727991e88e29
                                    ancillaryType: 2
                                    seatName: 7A
                                    column: A
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - window
                                  - ancillaryKey: f504305d83fbf000580c41844a76ed8f
                                    ancillaryType: 2
                                    seatName: 8A
                                    column: A
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 09f725d56f2b66dbcb636784c14d94c1
                                    ancillaryType: 2
                                    seatName: 9A
                                    column: A
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 8cd94df718dd2ebef099884aaa7840cb
                                    ancillaryType: 2
                                    seatName: 10A
                                    column: A
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 5a05742b6fbcdc9e13c21c1be27226e4
                                    ancillaryType: 2
                                    seatName: 11A
                                    column: A
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 16cacbe0465c6b33377ac6f30fd22ce3
                                    ancillaryType: 2
                                    seatName: 12A
                                    column: A
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 8abd3c73fdd3318b972ccbe1c5badded
                                    ancillaryType: 2
                                    seatName: 14A
                                    column: A
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 897021c25f86c5256f3b821f9749d0a2
                                    ancillaryType: 2
                                    seatName: 15A
                                    column: A
                                    row: '15'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 31dea29b9eba0fe9e5978f9360379af0
                                    ancillaryType: 2
                                    seatName: 16A
                                    column: A
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 8480a1cd208c500b5a2696b8250c25d3
                                    ancillaryType: 2
                                    seatName: 17A
                                    column: A
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 109beac0bfac9bb8fe5f522af17142df
                                    ancillaryType: 2
                                    seatName: 18A
                                    column: A
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: a9d32f14816cbfff8b77a664e56af9c2
                                    ancillaryType: 2
                                    seatName: 19A
                                    column: A
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 79b8af417661155aa081f76d9b84af93
                                    ancillaryType: 2
                                    seatName: 20A
                                    column: A
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 06faa4df09bed68b8f2c90192cd79ecf
                                    ancillaryType: 2
                                    seatName: 21A
                                    column: A
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 2dd7ac19c483708e2f1c4b90a62bbcfc
                                    ancillaryType: 2
                                    seatName: 22A
                                    column: A
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: f1a2527cdaace49ba0b1b198c5b94d59
                                    ancillaryType: 2
                                    seatName: 23A
                                    column: A
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 5cc0923c0fbe535f566fed519932d749
                                    ancillaryType: 2
                                    seatName: 24A
                                    column: A
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: a88606dd65381fdc094ab04cbaa17d8e
                                    ancillaryType: 2
                                    seatName: 25A
                                    column: A
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 5b5c484110c2f0001bbb6e818ed9679e
                                    ancillaryType: 2
                                    seatName: 26A
                                    column: A
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 0ad314d6b0cdcb0a1ae12fc0cb73d16f
                                    ancillaryType: 2
                                    seatName: 27A
                                    column: A
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 7b40976d604c1caf07aa5f541b595b5c
                                    ancillaryType: 2
                                    seatName: 28A
                                    column: A
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: fd8a5c35a26eada81a5fd0a095c3df11
                                    ancillaryType: 2
                                    seatName: 29A
                                    column: A
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: b2f87171e98d439e13b62ea13a737b56
                                    ancillaryType: 2
                                    seatName: 30A
                                    column: A
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: d6b82a04b610df3f77f3c5f33a2fd435
                                    ancillaryType: 2
                                    seatName: 31A
                                    column: A
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 83d31643de6c195f32c5e3f2e5512764
                                    ancillaryType: 2
                                    seatName: 1B
                                    column: B
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.360'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 4561d2e0d2453a75aa14924b337e4092
                                    ancillaryType: 2
                                    seatName: 2B
                                    column: B
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 48d0f4d0144b4aec753dcd04e58cdc2f
                                    ancillaryType: 2
                                    seatName: 3B
                                    column: B
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 305cc53cd264f89cf82ea794db84a19a
                                    ancillaryType: 2
                                    seatName: 4B
                                    column: B
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 0ded57a04de302cb98cc654b439146c0
                                    ancillaryType: 2
                                    seatName: 5B
                                    column: B
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: d64acfef30ea379855d59070e32cf20e
                                    ancillaryType: 2
                                    seatName: 6B
                                    column: B
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 3abec5cfd82ae262586611a840038853
                                    ancillaryType: 2
                                    seatName: 7B
                                    column: B
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 67d0d15619ed2f915804a6bea652bd90
                                    ancillaryType: 2
                                    seatName: 8B
                                    column: B
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 0d04dbe6eefc26d6c4df097225a1b33c
                                    ancillaryType: 2
                                    seatName: 9B
                                    column: B
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 107ff7d9d4345c3872598dc974c2ed11
                                    ancillaryType: 2
                                    seatName: 10B
                                    column: B
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: cfa8bda609c9130c1725636977ed3506
                                    ancillaryType: 2
                                    seatName: 11B
                                    column: B
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 50de7a47fe46b6a234334119e552a610
                                    ancillaryType: 2
                                    seatName: 12B
                                    column: B
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 992b1b19ddadcf9d81f4ba936b516857
                                    ancillaryType: 2
                                    seatName: 14B
                                    column: B
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: cc4689d480a02f32470d615192a44f42
                                    ancillaryType: 2
                                    seatName: 15B
                                    column: B
                                    row: '15'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: a724014eac606b1018f546bbe8e12512
                                    ancillaryType: 2
                                    seatName: 16B
                                    column: B
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 9c8ef78d550d12212c4b2054f26f6e13
                                    ancillaryType: 2
                                    seatName: 17B
                                    column: B
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 98a20b670cb7e4e888b2ec5de9550f8d
                                    ancillaryType: 2
                                    seatName: 18B
                                    column: B
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: b3015c7db52a628e33f5659b1123aba3
                                    ancillaryType: 2
                                    seatName: 19B
                                    column: B
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: cdd70b4809addfce9293934ab51b6c8d
                                    ancillaryType: 2
                                    seatName: 20B
                                    column: B
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: c44f7fb583fc7c72954bc260ec8a823d
                                    ancillaryType: 2
                                    seatName: 21B
                                    column: B
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 57fc3b3db768da826f5e66d39b1cad4f
                                    ancillaryType: 2
                                    seatName: 22B
                                    column: B
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: a4a484c789a8591f0a4c9d8420433301
                                    ancillaryType: 2
                                    seatName: 23B
                                    column: B
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 1324ff711b3f12baaa6f714a5cfd26fa
                                    ancillaryType: 2
                                    seatName: 24B
                                    column: B
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 319bd2ec27112e2efef3b3f611381fe4
                                    ancillaryType: 2
                                    seatName: 25B
                                    column: B
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: c950f50c7946c751cece245758e30c73
                                    ancillaryType: 2
                                    seatName: 26B
                                    column: B
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 033e7aa9ecce3425b1bcd95f560f6ffa
                                    ancillaryType: 2
                                    seatName: 27B
                                    column: B
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 9af6e2513a09a26390af27c253766295
                                    ancillaryType: 2
                                    seatName: 28B
                                    column: B
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 11b17f86571945177a00a89835b4595f
                                    ancillaryType: 2
                                    seatName: 29B
                                    column: B
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 6517c28e1e825b935fab2d02b60d9704
                                    ancillaryType: 2
                                    seatName: 30B
                                    column: B
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: e7ac6357a3c6f3bfa5b6f3942230ef8a
                                    ancillaryType: 2
                                    seatName: 31B
                                    column: B
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 049d3a2f0564fb698dbb58663816c0b6
                                    ancillaryType: 2
                                    seatName: 1C
                                    column: C
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.360'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 74b1989a70ffe76f26b9a1e92dccc072
                                    ancillaryType: 2
                                    seatName: 2C
                                    column: C
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 68d25ecfd50dcfaf556d763b769de408
                                    ancillaryType: 2
                                    seatName: 3C
                                    column: C
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 17d70e628080e8a46a070659b79b5acc
                                    ancillaryType: 2
                                    seatName: 4C
                                    column: C
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 758f4c9e2f07f55a73c2837374094e1e
                                    ancillaryType: 2
                                    seatName: 5C
                                    column: C
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 8e63fa68c85e9cd93fe88639ea0d8f8f
                                    ancillaryType: 2
                                    seatName: 6C
                                    column: C
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: b77bd2de35feedfee23133cb9b7e6f12
                                    ancillaryType: 2
                                    seatName: 7C
                                    column: C
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 34011250f5d7a0498a6999ec31e1a0df
                                    ancillaryType: 2
                                    seatName: 8C
                                    column: C
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: eb4d6f4d5ce5426b3e45142d9e5c2f46
                                    ancillaryType: 2
                                    seatName: 9C
                                    column: C
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 9c308c13b6754b751ed46418cf26a27b
                                    ancillaryType: 2
                                    seatName: 10C
                                    column: C
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 310473e8e5a0c83ffb643752a9798e21
                                    ancillaryType: 2
                                    seatName: 11C
                                    column: C
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 9d4e574508d0d0bb78f592db89a8049d
                                    ancillaryType: 2
                                    seatName: 12C
                                    column: C
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 5f468255a3222537bb0292561ee95665
                                    ancillaryType: 2
                                    seatName: 14C
                                    column: C
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 26e1674579c87b135d6410bb46719470
                                    ancillaryType: 2
                                    seatName: 15C
                                    column: C
                                    row: '15'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 88544fc6ffb51c66065e7c3e74875419
                                    ancillaryType: 2
                                    seatName: 16C
                                    column: C
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 1749651f148f8ec5de48bd707a2b50e0
                                    ancillaryType: 2
                                    seatName: 17C
                                    column: C
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 0cb9aba450e116a52bb2f3131e5e6662
                                    ancillaryType: 2
                                    seatName: 18C
                                    column: C
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: ededbda156b6103f827f9f9d89b25ed2
                                    ancillaryType: 2
                                    seatName: 19C
                                    column: C
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 1f9a2f7af0db579e2bbb4833026a232a
                                    ancillaryType: 2
                                    seatName: 20C
                                    column: C
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 56bdc0bd9c3a30dafcab974294040a98
                                    ancillaryType: 2
                                    seatName: 21C
                                    column: C
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: b57c5554c181f6785959fc2aa5ea2254
                                    ancillaryType: 2
                                    seatName: 22C
                                    column: C
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 9865f80dfcfc6cc7eeaf46fe2e6ce887
                                    ancillaryType: 2
                                    seatName: 23C
                                    column: C
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 9e76b7caf02db8888f03130cdb8029fa
                                    ancillaryType: 2
                                    seatName: 24C
                                    column: C
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 759efb6c36a6f1b0bb03eaace3c15866
                                    ancillaryType: 2
                                    seatName: 25C
                                    column: C
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: a0bc352a36db2a72e1b396288cc0484b
                                    ancillaryType: 2
                                    seatName: 26C
                                    column: C
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 6b1d18655e893bae31b4cd176eaa1115
                                    ancillaryType: 2
                                    seatName: 27C
                                    column: C
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: db3b5b44929d33dc168e7a958de4cd20
                                    ancillaryType: 2
                                    seatName: 28C
                                    column: C
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 2fec8a2be6172c68bbad4fe2a81b433c
                                    ancillaryType: 2
                                    seatName: 29C
                                    column: C
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: c869007ab2d1125f88b5d63ec843914b
                                    ancillaryType: 2
                                    seatName: 30C
                                    column: C
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 729f24c4a22533285026f23b7e453239
                                    ancillaryType: 2
                                    seatName: 31C
                                    column: C
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 0d0506fee12a7bb315312404e778e8e9
                                    ancillaryType: 2
                                    seatName: 1D
                                    column: D
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.360'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 63d8b20ec412f23e68da430fe9673fe4
                                    ancillaryType: 2
                                    seatName: 2D
                                    column: D
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 88ae56b8eb3c0b0a4545efb4ead02bf5
                                    ancillaryType: 2
                                    seatName: 3D
                                    column: D
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: fb9a5f39c4911f1e2fa0440b7821dceb
                                    ancillaryType: 2
                                    seatName: 4D
                                    column: D
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 1b26aba793b413f15783a82047398556
                                    ancillaryType: 2
                                    seatName: 5D
                                    column: D
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 30653ab4a26e6d8f4cdcdb5c1894cc4b
                                    ancillaryType: 2
                                    seatName: 6D
                                    column: D
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: e44d5857314db91963308523e49cf01c
                                    ancillaryType: 2
                                    seatName: 7D
                                    column: D
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 34eeb51b22f976e223de481549d77b4e
                                    ancillaryType: 2
                                    seatName: 8D
                                    column: D
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 2e271139cbec4412d4d745bb38a27a08
                                    ancillaryType: 2
                                    seatName: 9D
                                    column: D
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 7953f9f4061f6b7541757464fd0413a8
                                    ancillaryType: 2
                                    seatName: 10D
                                    column: D
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: a640218f4a72973bff1f024dac67086e
                                    ancillaryType: 2
                                    seatName: 11D
                                    column: D
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: bd5c7c720c463db8c45d832f76dfb3d8
                                    ancillaryType: 2
                                    seatName: 12D
                                    column: D
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 5dcaaabbd9ae33099a17a4829698ae5f
                                    ancillaryType: 2
                                    seatName: 14D
                                    column: D
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: c05755cb466d86c8456eccc8518b4e9b
                                    ancillaryType: 2
                                    seatName: 15D
                                    column: D
                                    row: '15'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: b742b2af6e59ab077d03a928a803d0dd
                                    ancillaryType: 2
                                    seatName: 16D
                                    column: D
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 6f8dc6510762a67ad8f227d8adb32077
                                    ancillaryType: 2
                                    seatName: 17D
                                    column: D
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: f7137661537b22a18ec4eb5f3107eb55
                                    ancillaryType: 2
                                    seatName: 18D
                                    column: D
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: ee25c6dbd66ab3217bcef0a27ced16f3
                                    ancillaryType: 2
                                    seatName: 19D
                                    column: D
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 01e6d26a6a5fa03271a7ced6a6932ecb
                                    ancillaryType: 2
                                    seatName: 20D
                                    column: D
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 0f65e742d5f5269be05a99a620e7d5c0
                                    ancillaryType: 2
                                    seatName: 21D
                                    column: D
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 95addbbbdb60a214989ff498d4e0cbcb
                                    ancillaryType: 2
                                    seatName: 22D
                                    column: D
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: c2aa07c90fffa695a95ae7516e13dd18
                                    ancillaryType: 2
                                    seatName: 23D
                                    column: D
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 96048d7672ac0a44509629426c32bff9
                                    ancillaryType: 2
                                    seatName: 24D
                                    column: D
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: a3b371c443112628045d355d21b664f1
                                    ancillaryType: 2
                                    seatName: 25D
                                    column: D
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: ca5c6a91ca5593afeea381eba3e25a0c
                                    ancillaryType: 2
                                    seatName: 26D
                                    column: D
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: e65a37b1443707b273ee5affe055907e
                                    ancillaryType: 2
                                    seatName: 27D
                                    column: D
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 5568413baf0e2558e6f091402bcf0ceb
                                    ancillaryType: 2
                                    seatName: 28D
                                    column: D
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: d1346c333a725a189191a8419bb5c29c
                                    ancillaryType: 2
                                    seatName: 29D
                                    column: D
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 3550c0e0dd62d8e944597b403b7f468b
                                    ancillaryType: 2
                                    seatName: 30D
                                    column: D
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 6209b7cef748f52596540fc9e058688a
                                    ancillaryType: 2
                                    seatName: 31D
                                    column: D
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - aisle
                                  - ancillaryKey: 799d2ad00b44a1fcede761a94d2e7fcc
                                    ancillaryType: 2
                                    seatName: 1E
                                    column: E
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.360'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: c4b5e8b3ac87c05c434aa0ea74bd5382
                                    ancillaryType: 2
                                    seatName: 2E
                                    column: E
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: bf42919b2262ee4f047c2e48c6a25de8
                                    ancillaryType: 2
                                    seatName: 3E
                                    column: E
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 85c012def73b1a641548c5dcc79e0c26
                                    ancillaryType: 2
                                    seatName: 4E
                                    column: E
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: e8beafa940fecc457695fcc5e721a358
                                    ancillaryType: 2
                                    seatName: 5E
                                    column: E
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 4ea528cabd175306e41feb391835249c
                                    ancillaryType: 2
                                    seatName: 6E
                                    column: E
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 10dc787c6a1f2a0484b4871d2a4d823a
                                    ancillaryType: 2
                                    seatName: 7E
                                    column: E
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 3aad86fc5c883de5bed0092a2f35cc40
                                    ancillaryType: 2
                                    seatName: 8E
                                    column: E
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 95c075c6968c20ad829dc38f98ec1c64
                                    ancillaryType: 2
                                    seatName: 9E
                                    column: E
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: c6ebd51f0f2f56508386bcf0b3732231
                                    ancillaryType: 2
                                    seatName: 10E
                                    column: E
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 3ea51340c8909644b251108cdf1d4a36
                                    ancillaryType: 2
                                    seatName: 11E
                                    column: E
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: dc20a0ed81b7978f29f72dfb39f1e46d
                                    ancillaryType: 2
                                    seatName: 12E
                                    column: E
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 19d8afe61ff81c7db13e015230ae7917
                                    ancillaryType: 2
                                    seatName: 14E
                                    column: E
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '15.460'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: a71739672f557e5dc80af6d748dabcdf
                                    ancillaryType: 2
                                    seatName: 15E
                                    column: E
                                    row: '15'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 8fc70f15abd0edb5cdedde4ebdf88e85
                                    ancillaryType: 2
                                    seatName: 16E
                                    column: E
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: fcf82bc73df45ef61bae4156c3ed048b
                                    ancillaryType: 2
                                    seatName: 17E
                                    column: E
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 1052f5a7b568d05a8cd23b2622db0d27
                                    ancillaryType: 2
                                    seatName: 18E
                                    column: E
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: e8ed4cc4b4f10fb79b897bce77d21c3d
                                    ancillaryType: 2
                                    seatName: 19E
                                    column: E
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: eaaed16ee4edae2f6c1be46dacfb93ed
                                    ancillaryType: 2
                                    seatName: 20E
                                    column: E
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: d17c68cfd691ec849a27c385c1bdff62
                                    ancillaryType: 2
                                    seatName: 21E
                                    column: E
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: b18e30111ed345f59102cf4ca38a0bea
                                    ancillaryType: 2
                                    seatName: 22E
                                    column: E
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: c3f1484f64abaf6b419dec2becbdf812
                                    ancillaryType: 2
                                    seatName: 23E
                                    column: E
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 9ac6bdefa9cd821ef8cf99ccdbc53db8
                                    ancillaryType: 2
                                    seatName: 24E
                                    column: E
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: bcf365506c4e4c12bc8236471102f865
                                    ancillaryType: 2
                                    seatName: 25E
                                    column: E
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 5591d8e163c8c8a90e94337822040b33
                                    ancillaryType: 2
                                    seatName: 26E
                                    column: E
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: d939331df36c139ce425ce7e8ebf5da4
                                    ancillaryType: 2
                                    seatName: 27E
                                    column: E
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 27f15cc31f221abd89e2563c28fc2c8c
                                    ancillaryType: 2
                                    seatName: 28E
                                    column: E
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 02196df3d3fc13cc4c112d466e184597
                                    ancillaryType: 2
                                    seatName: 29E
                                    column: E
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 23e27c9b8fdb74c5012152c201257f3a
                                    ancillaryType: 2
                                    seatName: 30E
                                    column: E
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: ee60c03b92562ddc09c07be67b4ea4fa
                                    ancillaryType: 2
                                    seatName: 31E
                                    column: E
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - middle
                                  - ancillaryKey: 6275252ad9d43d66e89143c7dc37df5a
                                    ancillaryType: 2
                                    seatName: 1F
                                    column: F
                                    row: '1'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.360'
                                    characteristics:
                                      - window
                                  - ancillaryKey: c4f991a6222ad05fb1ae209a7ca41846
                                    ancillaryType: 2
                                    seatName: 2F
                                    column: F
                                    row: '2'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 7b1f9a5df6d2008c475efedf8a49a40a
                                    ancillaryType: 2
                                    seatName: 3F
                                    column: F
                                    row: '3'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 6c0b111ead47ed328b4de55cf3ee75c0
                                    ancillaryType: 2
                                    seatName: 4F
                                    column: F
                                    row: '4'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - window
                                  - ancillaryKey: c017533ae745c3d6ffce51615e5366d4
                                    ancillaryType: 2
                                    seatName: 5F
                                    column: F
                                    row: '5'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 2a5f68b9a7be11f24690f69bea37882c
                                    ancillaryType: 2
                                    seatName: 6F
                                    column: F
                                    row: '6'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - window
                                  - ancillaryKey: e5402fe73fa7fa3a5aef9e7049b50ba6
                                    ancillaryType: 2
                                    seatName: 7F
                                    column: F
                                    row: '7'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 75b146cdb937a0713781fb3b3c02436f
                                    ancillaryType: 2
                                    seatName: 8F
                                    column: F
                                    row: '8'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '8.420'
                                    characteristics:
                                      - window
                                  - ancillaryKey: a16dc6d942c9a3abb6fe30c397c24aee
                                    ancillaryType: 2
                                    seatName: 9F
                                    column: F
                                    row: '9'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 7834284345c009a6914e6add27f4a005
                                    ancillaryType: 2
                                    seatName: 10F
                                    column: F
                                    row: '10'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - window
                                  - ancillaryKey: d2c018183012982ae37558c4902fa11f
                                    ancillaryType: 2
                                    seatName: 11F
                                    column: F
                                    row: '11'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '7.040'
                                    characteristics:
                                      - window
                                  - ancillaryKey: c5973a47b464e287e01b65230c2caecf
                                    ancillaryType: 2
                                    seatName: 12F
                                    column: F
                                    row: '12'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 74407773475d7ebe11e2df48ad8021b9
                                    ancillaryType: 2
                                    seatName: 14F
                                    column: F
                                    row: '14'
                                    deck: '1'
                                    available: 'False'
                                    seatCurrency: USD
                                    seatPrice: '18.770'
                                    characteristics:
                                      - exit row
                                  - ancillaryKey: 679f55381c4d1c987c4447345330e33a
                                    ancillaryType: 2
                                    seatName: 15F
                                    column: F
                                    row: '15'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: ab51a28bba80b6a98a4d989b7ca1c755
                                    ancillaryType: 2
                                    seatName: 16F
                                    column: F
                                    row: '16'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 120130bb4044f76eb4c0d69d6983c719
                                    ancillaryType: 2
                                    seatName: 17F
                                    column: F
                                    row: '17'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 88c0f1a6fa496ee2ae684c08e877fd51
                                    ancillaryType: 2
                                    seatName: 18F
                                    column: F
                                    row: '18'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: e45439996e36030767629ebc976c7b2c
                                    ancillaryType: 2
                                    seatName: 19F
                                    column: F
                                    row: '19'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.940'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 949f17b5144e00ee6620b6c8444406db
                                    ancillaryType: 2
                                    seatName: 20F
                                    column: F
                                    row: '20'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: fc9a665d0d7a1ed5151a06a9e56d7a13
                                    ancillaryType: 2
                                    seatName: 21F
                                    column: F
                                    row: '21'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 086765b88c389d5457eaae8eeda37edc
                                    ancillaryType: 2
                                    seatName: 22F
                                    column: F
                                    row: '22'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 601c758062ede86f5b30b26548b75c68
                                    ancillaryType: 2
                                    seatName: 23F
                                    column: F
                                    row: '23'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: fceb5c3f843979c1eea7fd97727f0969
                                    ancillaryType: 2
                                    seatName: 24F
                                    column: F
                                    row: '24'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 5d7e3a079a8b94d1e2d98540081a17fe
                                    ancillaryType: 2
                                    seatName: 25F
                                    column: F
                                    row: '25'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 655e47352e574e103c19f6ac2c3f4c61
                                    ancillaryType: 2
                                    seatName: 26F
                                    column: F
                                    row: '26'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: b6da4c6e8f800f500fb1fd87cd91c22f
                                    ancillaryType: 2
                                    seatName: 27F
                                    column: F
                                    row: '27'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 61ef867e1dd70e90c57dd81363ecad0c
                                    ancillaryType: 2
                                    seatName: 28F
                                    column: F
                                    row: '28'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: d496eb810d3d7f1577e7e1ec4e14646a
                                    ancillaryType: 2
                                    seatName: 29F
                                    column: F
                                    row: '29'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: 93dffe32cbd61423736c578656ef1adc
                                    ancillaryType: 2
                                    seatName: 30F
                                    column: F
                                    row: '30'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                                  - ancillaryKey: a8df26050466428f1a7766db2a8699a7
                                    ancillaryType: 2
                                    seatName: 31F
                                    column: F
                                    row: '31'
                                    deck: '1'
                                    available: 'True'
                                    seatCurrency: USD
                                    seatPrice: '5.110'
                                    characteristics:
                                      - window
                '4':
                  summary: One-Way Journey (Search Baggage)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      - ancillaryType: 1
                        ancillary:
                          journeys:
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
                          ancillaries:
                            baggage:
                              - ancillaryKey: 572bf8651a81e06444e41848529877f0
                                ancillaryType: 1
                                payBaggageType: 2
                                baggagePiece: 1
                                baggageWeight: 30KG
                                baggageCurrency: CNY
                                baggagePrice: 39
                              - ancillaryKey: 2b8b47606c79a8bc98c08c7fda4ef567
                                ancillaryType: 1
                                payBaggageType: 2
                                baggagePiece: 1
                                baggageWeight: 40KG
                                baggageCurrency: CNY
                                baggagePrice: 48
                              - ancillaryKey: d02b41f29adb4ec0fc2a97657a8c6e46
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: 1
                                baggageWeight: 10KG
                                baggageCurrency: CNY
                                baggagePrice: 21
                              - ancillaryKey: 8175c28399363d09fad4c50dbcf40b9e
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: 1
                                baggageWeight: 20KG
                                baggageCurrency: CNY
                                baggagePrice: 30
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
                  summary: Error(B005)
                  value: >-
                    {
                        "errorCode": "B005",
                        "errorMsg": "Can not find any matching precisePricing result within 60 minutes."
                    }


                    Remark: This error occurs under a few circumstances -

                    1. The timegap between PrecisePricing and AncillaryPricing
                    API calls exceeds 30 minutes. 

                    2. The timegap between receiving PrecisePricing API
                    responses and making AncillaryPricing API calls is too short
                    (in millescends) that system could not relate the request to
                    the corresponding results.

                    3. Invoke AncillaryPricing API even when there is error
                    response with PrecisePricing Interface.

                    4. The parameters or values in AncillaryPricing API requests
                    deviate from which in PrecisePricing responses 




                    Suggestion: 

                    1. Ensure that the timestamp between PrecisePricing and
                    AncillaryPricing is correctly mapped.

                    2. Ensure that there is no error response in previous calls
                    before invoking AncillaryPricing endpoint.

                    3. Correlates the requesting structure of AncillaryPricing
                    with the responses from PrecisePricing endpoint.
                '3':
                  summary: Error(B070)
                  value: >-
                    {
                        "errorCode": "B070",
                        "errorMsg": "No ancillary price on this routing."
                    }


                    Remark:

                    There is limited ancillary price quote for the selected
                    route, please proceed with booking without the ancillary
                    items 
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/APIs with all versions/AncillaryPricing
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469932-run
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