# ValidateItinerary API

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /airline-data/json/validateItinerary:
    post:
      summary: ValidateItinerary API
      deprecated: false
      description: >+
        ##  Function


        This API can validate itineraries in order to avoid requests with
        invalid itineraries.



        ##  Versioning


        |Version|Sandbox Invoking Address|Update|

        |:----|:----|:----|

        |ValidateItinerary|[https://data-cache-api-test.pkfare.com/airline-data/json/validateItinerary](https://data-cache-api-test.pkfare.com/airline-data/json/validateItinerary)|   
        |



        *Below is the most updated version"





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
        - API Reference/Cache APIs
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                authentication:
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
                validation:
                  type: object
                  properties:
                    airline:
                      type: string
                      description: Search for specific airline; IATA airlines code
                    journeys:
                      type: array
                      items:
                        type: object
                        properties:
                          origin:
                            type: string
                            description: 'Origin [IATA airport/city code ], Example: DUB'
                          originType:
                            type: integer
                            description: 0-airport code;1- city code
                          destination:
                            type: string
                            description: 'Destination [IATA airport/city code],Example: MIL'
                          destinationType:
                            type: integer
                            description: 0-airport code;1- city code
                          departureDate:
                            type: string
                            description: Departure date [yyyy-mm-dd] Example:2024-10-26
                        x-apifox-orders:
                          - origin
                          - originType
                          - destination
                          - destinationType
                          - departureDate
                        required:
                          - origin
                          - originType
                          - destination
                          - destinationType
                          - departureDate
                      description: Journey details
                  x-apifox-orders:
                    - airline
                    - journeys
                  required:
                    - airline
                    - journeys
              x-apifox-orders:
                - authentication
                - validation
              required:
                - authentication
                - validation
            example:
              authentication:
                partnerId: ''
                sign: ''
              validation:
                airline: FR
                journeys:
                  - origin: CTA
                    originType: 1
                    destination: MIL
                    destinationType: 1
                    departureDate: '2025-05-09'
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
                    description: Error message
                  data:
                    type: object
                    properties:
                      valid:
                        type: boolean
                        description: >-
                          true-the Itinerary is valid false-the Itinerary is
                          invalid (Partial itinerary validation failure is
                          considered invalid)
                      invalidMsg:
                        type: string
                        description: >-
                          the reason why the itinerary is invalid Eg.Invalid
                          airport code; No flight schedules available
                    x-apifox-orders:
                      - valid
                      - invalidMsg
                    required:
                      - valid
                    description: validation information
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
                required:
                  - errorCode
                  - errorMsg
                  - data
              example:
                errorCode: '0'
                errorMsg: ok
                data:
                  valid: true
                  invalidMsg: null
          headers: {}
          x-apifox-name: Success
      security: []
      x-apifox-folder: API Reference/Cache APIs
      x-apifox-status: developing
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470500-run
components:
  schemas: {}
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```