# AncillaryPricing V7

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/ancillaryPricingV7:
    post:
      summary: AncillaryPricing V7
      deprecated: false
      description: "##  Function\n\nThrough AncillaryPricing API, you can search ancillary products and get product details.\n\n\nPaid baggage and seat selection are available in the initial booking. It is able to search multiple ancillary products at the \nsame time or search them separately.\n\n\nThe passengers and journeys are required when adding ancillary in the inital booking. The request structure of \nAncillaryPricing is the same as that of PrecisePricing. It is necessary to use PrecisePricing service before using this \ninterface. The whole process should be limited to 30 mins.\n\n\nAdditionally, paid baggage is also available in the postbooking process. The air order number is required in the \nAncillarypricing request when adding ancillary after the booking. AncillaryPricing Results are valid within half an hour.\n\n## Versioning\n\n|Version|Sandbox Invoking Address|Update|\n|:----|:----|:----|\n|ancillaryPricing|[https://api.pkfare.com/ancillaryPricing](https://api.pkfare.com/ancillaryPricing)|Support in-booking paid baggage|\n|ancillaryPricing_V3|[https://api.pkfare.com/ancillaryPricingV3](http://api.pkfare.com/ancillaryPricingV3)|Support in-booking seat selection|\n|ancillaryPricing_V4|[https://api.pkfare.com/ancillaryPricingV4](http://api.pkfare.com/ancillaryPricingV4)|Support postbooking paid bag|\n|ancillaryPricing_V5|[https://api.pkfare.com/ancillaryPricingV](http://api.pkfare.com/ancillaryPricingV4)5|Add solutionId to enhance tracebility and visibility|\n|ancillaryPricing_V5(json format)|https://api.pkfare.com/json/ancillaryPricingV5|Add solutionId to enhance tracebility and visibility;Support json formatted requesting parameter|\n|ancillaryPricing_V6(json format)|https://api.pkfare.com/json/ancillaryPricingV6|New feature: now support shopping and booking prices for different product tags, including PKFARE-defined special product types and airline-standard branded fares, etc. and support ancillary pricing for passengers traveling with infants|\n|ancillaryPricing_V7(json format)|https://api.pkfare.com/json/ancillaryPricingV7|Prices ancillary services using the Brand Fare and MultiTag information associated with the selected priced solution.|\n\n*Below is the most updated version* \n\n## Request Example\n\n1. One-Way Journey (Search Baggage)\n\n\n```plain\n{\n    \"authentication\": {\n        \"partnerId\":\"partnerId\",\n        \"sign\":\"sign\"\n    },\n    \"pricing\": {\n        \"adults\": 1,\n        \"children\": 0,\n        \"infants\": 1,\n        \"ancillary\": [\n            1\n        ],\n        \"solutionId\": \"1\",\n        \"journeys\": {\n            \"journey_0\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"HKG\",\n                    \"arrivalDate\":\"2022-04-23\",\n                    \"arrivalTime\":\"10:05\",\n                    \"bookingCode\":\"O\",\n                    \"departure\":\"SIN\",\n                    \"departureDate\":\"2022-04-23\",\n                    \"departureTime\":\"06:00\",\n                    \"flightNum\":\"980\"\n                }\n            ]\n        }\n    }\n}\n```\n\n\n2. One-Way Journey(Search Seat)\n```plain\n{\n    \"authentication\": {\n        \"partnerId\":\"partnerId\",\n        \"sign\":\"sign\"\n    },\n    \"pricing\": {\n        \"adults\": 1,\n        \"children\": 0,\n        \"infants\": 0,\n        \"ancillary\": [\n            2\n        ],\n        \"solutionId\": \"1\",\n        \"journeys\": {\n            \"journey_0\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"HKG\",\n                    \"arrivalDate\":\"2022-04-23\",\n                    \"arrivalTime\":\"10:05\",\n                    \"bookingCode\":\"O\",\n                    \"departure\":\"SIN\",\n                    \"departureDate\":\"2022-04-23\",\n                    \"departureTime\":\"06:00\",\n                    \"flightNum\":\"980\"\n                }\n            ]\n        }\n    }\n}\n```\n\n3.Round Journey (Search Baggage)\n```plain\n{\n    \"authentication\": {\n        \"partnerId\":\"partnerId\",\n        \"sign\":\"sign\"\n    },\n    \"pricing\": {\n        \"adults\": 1,\n        \"children\": 0,\n        \"infants\": 0,\n        \"ancillary\": [\n            1\n        ],\n        \"solutionId\": \"1\",\n        \"journeys\": {\n            \"journey_0\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"HKG\",\n                    \"arrivalDate\":\"2022-04-23\",\n                    \"arrivalTime\":\"10:05\",\n                    \"bookingCode\":\"O\",\n                    \"departure\":\"SIN\",\n                    \"departureDate\":\"2022-04-23\",\n                    \"departureTime\":\"06:00\",\n                    \"flightNum\":\"980\"\n                }\n            ],\n            \"journey_1\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"SIN\",\n                    \"arrivalDate\":\"2022-04-25\",\n                    \"arrivalTime\":\"14:50\",\n                    \"bookingCode\":\"W\",\n                    \"departure\":\"HKG\",\n                    \"departureDate\":\"2022-04-25\",\n                    \"departureTime\":\"10:55\",\n                    \"flightNum\":\"981\"\n                }\n            ]\n        }\n    }\n}\n```\n\n\n4. Round Journey (Search Baggage And Seat)\n```plain\n{\n    \"authentication\": {\n        \"sign\": \"sign\",\n        \"partnerId\": \"partnerId\"\n    },\n    \"pricing\": {\n        \"journeys\": {\n            \"journey_1\": [\n                {\n                    \"departureTime\": \"09:20\",\n                    \"flightNum\": \"625\",\n                    \"arrival\": \"SGN\",\n                    \"arrivalTime\": \"10:45\",\n                    \"bookingCode\": \"S\",\n                    \"departure\": \"DAD\",\n                    \"departureDate\": \"2023-12-10\",\n                    \"airline\": \"VJ\",\n                    \"arrivalDate\": \"2023-12-10\"\n                },\n                {\n                    \"departureTime\": \"19:00\",\n                    \"flightNum\": \"895\",\n                    \"arrival\": \"DEL\",\n                    \"arrivalTime\": \"22:50\",\n                    \"bookingCode\": \"S\",\n                    \"departure\": \"SGN\",\n                    \"departureDate\": \"2023-12-10\",\n                    \"airline\": \"VJ\",\n                    \"arrivalDate\": \"2023-12-10\"\n                }\n            ],\n            \"journey_0\": [\n                {\n                    \"departureTime\": \"00:05\",\n                    \"flightNum\": \"896\",\n                    \"arrival\": \"SGN\",\n                    \"arrivalTime\": \"06:20\",\n                    \"bookingCode\": \"I\",\n                    \"departure\": \"DEL\",\n                    \"departureDate\": \"2023-11-30\",\n                    \"airline\": \"VJ\",\n                    \"arrivalDate\": \"2023-11-30\"\n                },\n                {\n                    \"departureTime\": \"17:20\",\n                    \"flightNum\": \"632\",\n                    \"arrival\": \"DAD\",\n                    \"arrivalTime\": \"18:35\",\n                    \"bookingCode\": \"I\",\n                    \"departure\": \"SGN\",\n                    \"departureDate\": \"2023-11-30\",\n                    \"airline\": \"VJ\",\n                    \"arrivalDate\": \"2023-11-30\"\n                }\n            ]\n        },\n        \"children\": \"1\",\n        \"solutionId\": \"1\",\n        \"adults\": \"2\",\n        \"infants\": 1,\n        \"ancillary\": [\n            1,\n            2\n        ]\n    }\n}\n```\n\_\n5. Open Jaw (Search Baggage)\n\n\n```plain\n{\n    \"authentication\": {\n        \"partnerId\":\"partnerId\",\n        \"sign\":\"sign\"\n    },\n    \"pricing\": {\n        \"adults\": 1,\n        \"children\": 0,\n        \"infants\": 1,\n        \"ancillary\": [\n            1\n        ],\n        \"solutionId\": \"1\",\n        \"journeys\": {\n            \"journey_0\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"HKG\",\n                    \"arrivalDate\":\"2022-04-23\",\n                    \"arrivalTime\":\"10:05\",\n                    \"bookingCode\":\"O\",\n                    \"departure\":\"SIN\",\n                    \"departureDate\":\"2022-04-23\",\n                    \"departureTime\":\"06:00\",\n                    \"flightNum\":\"980\"\n                }\n            ],\n            \"journey_1\": [\n                {\n                    \"airline\":\"TR\",\n                    \"arrival\":\"CNX\",\n                    \"arrivalDate\":\"2022-04-25\",\n                    \"arrivalTime\":\"14:50\",\n                    \"bookingCode\":\"W\",\n                    \"departure\":\"HKG\",\n                    \"departureDate\":\"2022-04-25\",\n                    \"departureTime\":\"10:55\",\n                    \"flightNum\":\"981\"\n                }\n            ]\n        }\n    }\n}\n```\n\n\n6. Search Postbooking Baggage\n\n\n```plain\n{\n    \"authentication\": {\n        \"sign\": \"sign\",\n        \"partnerId\": \"partnerId\"\n    },\n    \"pricing\": {\n        \"airOrderNum\": \"917049521951368301\",\n        \"ancillary\": [\n            1\n        ]\n    }\n}\n```\n\n\n##  Error Code List\n\n|errorCode|errorMsg|Description|\n|:----|:----|:----|\n|0|ok|Request has been processed successfully.|\n|S001|System error|System error.|\n|P001|XXX is illegal|Parameter is illegal.|\n|P002|XXX is missing|Parameter is missing.|\n|P006|Invalid parameter|Wrong parameter, please check.|\n|B002|Partner is not exists|Partner ID does not exist.|\n|B003|Illegal sign|Illegal sign, please check your signature.|\n|B005|Can not find any matching precisePricing result within 30 minutes|Can not find the corresponding precisePricing record. Please check the itinerary and passenger numbers. AncillaryPricing has to be invoked within 30 minutes after pricing.|\n|B009|Order status is invalid|air order status doesn't meet the requirement.|\n|B010|The order was not found.|The air order number was not correct.|\n|B069|AncillaryPricing is offline-1|The AncillaryPricing API is offline, please contact PKFARE to enable it.|\n|B070|No ancillary price on this routing|No ancillary price for this routing.|\n|B085|The journey infomation of AncillaryPricing is not consistent with that of air order|The journey infomation of AncillaryPricing is not correct|\n|B086|The number of ancillary passenger type outnumbers that of air order.|The number of ancillary passenger type is not correct.|\n\n"
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
                pricing:
                  type: object
                  properties:
                    solutionId:
                      type: string
                      description: >-
                        Unique identification returned in PrecisePricing,
                        request with it for associating with the Pricing
                        solution and linking to the entire request process
                    brandFare:
                      type: string
                      description: >-
                        Brand Fare code associated with the selected priced
                        solution. This field replaces `tag` from the previous
                        version.
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
                            description: One associated product tag.
                            x-apifox-orders:
                              - tagCode
                            required:
                              - tagCode
                            x-apifox-ignore-properties: []
                          description: >-
                            Product tag type defined by the PKFARE Tag Query
                            API.
                      description: >-
                        MultiTag snapshot associated with the selected priced
                        solution. It identifies the product context used for
                        ancillary pricing.
                      x-apifox-orders:
                        - '{tagType}'
                      x-apifox-ignore-properties: []
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
                    - brandFare
                    - multiTags
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
      x-apifox-folder: API Reference/Ancillary booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470826-run
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