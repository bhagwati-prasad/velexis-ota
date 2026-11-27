# PreciseBooking V8

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/preciseBooking_V8:
    post:
      summary: PreciseBooking V8
      deprecated: false
      description: "##  Function\n\nThrough the most updated version PreciseBooking_V5 API, Seat selection in \_the bookings are supported based on the results from AncillaryPricing_V3.\_\n\nIt's not supported that multiple paid checked bags or multiple paid carry-on bags are added for the same passenger on a single journey, but it's allowed to add a checked bag and a carry-on baggage on a single journey at the same time.\n\nBesides, \_it's not allowed to add multiple seats for the same passenger in a flight or select the same seat for multiple passengers in a flight.\n\nIt is necessary to use PrecisePricing service before using this interface. The whole process should be limited to 30 mins.\n\n##  Versioning\n\n|Version|Sandbox Invoking Address|Update|\n|:----|:----|:----|\n|PreciseBooking|[https://api.pkfare.com/preciseBooking](https://api.pkfare.com/preciseBooking)|    |\n|PreciseBooking_V2|[https://api.pkfare.com/preciseBooking_V2](https://api.pkfare.com/preciseBooking_V2)|It is capable of buying ancillaries|\n|PreciseBooking_V3|[https://api.pkfare.com/preciseBooking_V](https://api.pkfare.com/preciseBooking_V2)3|Support infant (no seat) bookings.|\n|PreciseBooking_V4|[https://api.pkfare.com/preciseBooking_V4](http://api.pkfare.com/preciseBooking_V4)|support seat selection in the initial booking|\n|PreciseBooking_V5|[https://api.pkfare.com/preciseBooking_V](https://api.pkfare.com/preciseBooking_V2)5|Add solutionId to enhance tracebility and visibility|\n|PreciseBooking_V5(json format)|https://api.pkfare.com/json/preciseBooking_V5|Add solutionId to enhance tracebility and visibility; Support json formatted requesting structure|\n|PreciseBooking_V6(json format)|https://api.pkfare.com/json/preciseBooking_V6|Add solutionId to enhance tracebility and visibility; Support json formatted requesting structure|\n|PreciseBooking_V7(json format)|https://api.pkfare.com/json/preciseBooking_V7|support booking prices for different product tags, including PKFARE-defined special product types and airline-standard branded fares, etc.|\n|PreciseBooking_V8(json format)|https://api.pkfare.com/json/preciseBooking_V8|Creates a booking using the priced solution and carries the confirmed Brand Fare and MultiTag information.|\n\n*Below is the most updated version*\n\n\n\n##  Error Code List\n\n|erroCode<img width=10/>|erroMsg|Description|\n|:----|:----|:----|\n|0|ok|Request has been processed successfully.|\n|S001|System error.|System error.|\n|B002|Partner is not exists.|PartnerID does not exist.|\n|B003|Illegal sign.|Illegal sign. Please check your signature.|\n|B035|Concurrency limited. Please contact PKFARE API support team for assistant.|Concurrency exceeded system limits.|\n|P001|XXX is illegal.|The field of XXX is illegal.|\n|P002|XXX is missing.|The field of XXX is missing.|\n|P006|Invalid parameter.|Value of request cannot pass the validation, please check on the request.|\n|0307|Reservation failed - Booking class is sold out.|Reservation failed. Seats have been sold out.|\n|B004|There are errors in the passenger type of Adults.|Adult passenger's age does not meet the requirements.|\n|B005|Can not find any matching precisePricing result within 30 minutes.|Can not find the corresponding precisePricing record. Please check the itinerary and passenger numbers. PreciseBooking has to be invoked within 30 minutes after pricing.|\n|B006|Reservation failed - Other. OrderNum is XXX.|Booking fail for other reason. The order has been created which is indicated in Other.OrderNum field|\n|B006|Reservation failed.|Booking fail for other reason.|\n|B007|Reservation failed - Segment status is not HK.|Segment status is invalid from GDS. Please select other flight options.|\n|B008|Itinerary is different between PNR and order.|Itinerary in reservation is different from precisePricing. There might be a flight schedule change. System validate the time by default. Please do NOT retry after this error occurs, as this may lead to ADM. If you need to disable validation and return the latest flgiht time, please contact PKFARE.|\n|B011|Reservation failed - Fare is unavailable.|Fare is unavailable form GDS. Please select other flight options.|\n|B012|Reservation failed - Create PNR time out.|Create PNR time out from GDS. Please wait some minutes or select other flight options.|\n|B017|Price is changed.|Price is changed.|\n|B023|Reservation failed - Save price fail.|Fail to save price from GDS.|\n|B022|There are errors in the passenger type of Children|Child passenger's age does not meet the requirements.|\n|B025|Reservation failed - RT PNR fail.|Fail to retieve PNR from GDS.|\n|B027|Airline PNR is missing.|Airline PNR is missing from GDS.|\n|B028|Reservation failed - Time out.|Booking time out from GDS.|\n|B029|Duplicate reservations have been found for passenger XXX/XXX in order XXX, in pnr XXX.|Duplicated reservation is not allowed. If there is an order with same segment and passenger, system will block the second reservation and return error. Please cancel the last duplicated order or pay the last order directly.|\n|B030|Illegal passenger name, please use Chinese character.|Wrong passenger name. If passengers use Chinese ID card to make reservation for China domestic flight, please use Chinese character.|\n|B031|Illegal passenger name, please use correct Chinese character.|Wrong passenger name. If passengers use chinese ID card to make reservation, the chinese name length is over the limitation.|\n|B032|Illegal passport, please use 'N' as document type if you are using Chinese ID card to make reservation.|Illegal passport. If passengers book Chinese flight, please use correct passport.|\n|B043|Reservation failed: Create PNR failed.|Booking failed from GDS.|\n|B044|Reservation failed - Create PNR failed, end transaction failed.|Booking failed from GDS.|\n|B062|The length of passenger name should be 40 English alphabet including / between last name and first name.|Passenger's name should be within 40 English alphabet, including \"/\" between last name and first name.|\n|B064|The lastName of passegner should be within 2-30 English alphabet.|Passenger's last name should be within 2-30 English alphabet.|\n|B065|Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality.|Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality.Please contact PKFARE API support.|\n|B069|Reservation failed, this fare has passenger age limitation.|Reservation failed, because this fare has a passenger age limition.|\n|B077|There are erros in the passenger type of infants.|Infant passenger's age does not meet the requirements.|\n|B078|Lack of passengerIndex.|For bookings contain infant(s) , passengerIndex is required for each passenger.|\n|B079|Each infant must be associated to one adult and each adult can only be associated to one infant maximum.|Each infant must be associated to one adult and each adult can only be associated to one infant maximum.|\n|B080|Invalid or duplicated or discontinuous passengerIndex|PassengerIndex must be positive and continuous integers starting from 1.|\n|B081|Error in ancillary passenger info.|Error in ancillary passenger info.|\n|B087|Booking Failed. System has recognized possible churning.|Churning booking behaviour were detected and booking request with the same passenger will be restricted.|\n|B192|Duplicate baggages are not allowed in the same journey.|Only one baggage purchase is allowed for the same journey, all subsequent attempts will be granted with this response.|\n|B193|Multiple seat selection is not allowed in the same flight.|Only one seat selection is allowed for the same journey, all subsequent attempts will be granted with this response.|\n|B205|Passengers under the minimum solo travel age must travel with an eligible accompanying passenger aged XX or above based on airline policy. PKFARE does not support unaccompanied minor services yet through API|young passengers solo travel restriction|"
      tags:
        - API Reference/Air ticket booking APIs
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
                booking:
                  type: object
                  properties:
                    passengers:
                      type: array
                      items:
                        type: object
                        properties:
                          passengerIndex:
                            type: integer
                            description: >-
                              Passenger sequence number. Positive and continuous
                              integers starting from 1. Only bookings contain
                              infant passengers need to fullfill this part.
                          birthday:
                            type: string
                            description: Date of birth [yyyy-mm-dd]
                          cardType:
                            type: string
                            description: >-
                              Type of travel document, P as passport, N as
                              Chinese Identity, O as others. Passengers could
                              make reservations with Chinese Identity if the
                              itinerary is China domestic journey (NOT including
                              Hong Kong, Macao and Taiwan). If using Chinese
                              Identity please input 'N' into 'cardType' and
                              input name in Chinese character.If
                              bookingWithoutCard is 1 in responds of
                              PrecisePricing API, you can leave it as blank.
                          cardNum:
                            type: string
                            description: >-
                              Travel document number. If bookingWithoutCard is 1
                              in responds of PrecisePricing API, you can leave
                              it as blank.
                          cardExpiredDate:
                            type: string
                            description: >-
                              Travel document expired date. The expiry date
                              should be at least 6 months later before the
                              departure date of the last flights. If using
                              Chinese Identity please input a fake
                              cardExpiredDate to pass the parameter validation.
                              If bookingWithoutCard is 1 in responds of
                              PrecisePricing API, you can leave it as
                              blank.[yyyy-mm-dd]
                          firstName:
                            type: string
                            description: >-
                              First name. Please use a real name and do not use
                              "TEST"
                          lastName:
                            type: string
                            description: >-
                              Last name. Please use a real name and do not use
                              "TEST"
                          nationality:
                            type: string
                            description: Nationality [2-letter country code].
                          psgType:
                            type: string
                            description: >-
                              Passenger type including ADT for adults, CHD for
                              children, INF for infants (no seat)
                          sex:
                            type: string
                            description: Gender, including M for male, F for female
                          associatedPassengerIndex:
                            type: integer
                            description: >-
                              Only required for infant passengers. The adult
                              passenger sequence number which the infant is
                              associated to.
                          ffpNumber:
                            type: string
                            description: The airline's frequent flyer number
                          ffpAirline:
                            type: string
                            description: Airline of the frequent flyer program
                          ktn:
                            type: string
                            description: >-
                              The expedited screening program in the United
                              States
                          redress:
                            type: string
                            description: >-
                              The Rapid Screening Program Auxiliary
                              identification number in the United States
                        required:
                          - birthday
                          - firstName
                          - lastName
                          - nationality
                          - psgType
                          - sex
                        x-apifox-orders:
                          - passengerIndex
                          - birthday
                          - cardType
                          - cardNum
                          - cardExpiredDate
                          - firstName
                          - lastName
                          - nationality
                          - psgType
                          - sex
                          - associatedPassengerIndex
                          - ffpNumber
                          - ffpAirline
                          - ktn
                          - redress
                        x-apifox-ignore-properties: []
                      description: Passenger information
                    solution:
                      type: object
                      properties:
                        solutionId:
                          type: string
                          description: >-
                            Unique identification returned in PrecisePricing,
                            request with it for associating with the Pricing
                            solution and linking to the entire request process.
                            Please note that each solutionId could only be used
                            once during the booking process and try to pick
                            other solutions once an ID be used
                        fareType:
                          type: string
                          description: Fare type, including PUBLIC and PRIVATE
                        adtFare:
                          type: number
                          description: Adult fare
                        adtTax:
                          type: number
                          description: Adult tax
                        chdFare:
                          type: number
                          description: Child[age 2-12] fare
                        chdTax:
                          type: number
                          description: Child[age 2-12] tax
                        infFare:
                          type: number
                          description: Infant[age 0-2, no seat] fare
                        infTax:
                          type: number
                          description: Infant[age 0-2, no seat] tax
                        brandFare:
                          type: string
                          description: >-
                            Brand Fare code of the solution selected from
                            Pricing. This field replaces `tag` from the previous
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
                                x-apifox-orders:
                                  - tagCode
                                required:
                                  - tagCode
                                description: One selected product tag.
                                x-apifox-ignore-properties: []
                              description: >-
                                Product tag type defined by the PKFARE Tag Query
                                API.
                          x-apifox-orders:
                            - '{tagType}'
                          description: >-
                            MultiTag snapshot of the solution selected from
                            Pricing. It is used to associate and carry the
                            selected product attributes into booking.
                          required:
                            - '{tagType}'
                          x-apifox-ignore-properties: []
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
                                  - arrival
                                  - arrivalDate
                                  - arrivalTime
                                  - departure
                                  - departureDate
                                  - departureTime
                                  - bookingCode
                                x-apifox-ignore-properties: []
                              description: journey_0 or journey_1
                          required:
                            - journey_0
                          x-apifox-orders:
                            - journey_0
                          x-apifox-ignore-properties: []
                      required:
                        - solutionId
                        - multiTags
                        - journeys
                      x-apifox-orders:
                        - solutionId
                        - fareType
                        - adtFare
                        - adtTax
                        - chdFare
                        - chdTax
                        - infFare
                        - infTax
                        - brandFare
                        - multiTags
                        - journeys
                      description: Journey information
                      x-apifox-ignore-properties: []
                    buyerOrder:
                      type: string
                      description: Your order number if you want to store at PKFARE side
                      nullable: true
                    ancillary:
                      type: array
                      items:
                        type: object
                        properties:
                          ancillaryPassenger:
                            type: object
                            properties:
                              firstName:
                                type: string
                                description: >-
                                  First name (This field is required when
                                  booking with ancillaries)
                              lastName:
                                type: string
                                description: >-
                                  Last name (This field is required when booking
                                  with ancillaries)
                              psgType:
                                type: string
                                description: >-
                                  Passenger type (This field is required when
                                  booking with ancillaries); ADT-Adult,
                                  CHD-Child[2-12 years old]; Cannot be infant
                                  passenger
                            required:
                              - firstName
                              - lastName
                              - psgType
                            x-apifox-orders:
                              - firstName
                              - lastName
                              - psgType
                            description: >-
                              Booking ancillary passenger (If booking with
                              ancillaries, this field is required and cannot be
                              an infant passenger)
                            x-apifox-ignore-properties: []
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
                                      description: >-
                                        Baggage details (This field is required
                                        when booking with ancillaries);
                                        1-baggage
                                    ancillaryKey:
                                      type: string
                                      description: >-
                                        Unique ID returned in AncillaryPricing
                                        (This field is required when booking
                                        with ancillaries)
                                    payBaggageType:
                                      type: string
                                      description: >-
                                        Baggage type (This field is required
                                        when booking with ancillaries);
                                        1-checked baggage, 2-carry-on baggage
                                    baggagePiece:
                                      type: string
                                      description: >-
                                        Baggage piece (This field is required
                                        when booking with ancillaries); -1 - no
                                        limit to baggage piece
                                    baggageWeight:
                                      type: string
                                      description: >-
                                        Baggage weight (This field is required
                                        when booking with ancillaries)
                                    baggageCurrency:
                                      type: string
                                      description: >-
                                        Currency (This field is required when
                                        booking)
                                    baggagePrice:
                                      type: string
                                      description: >-
                                        Price (This field is required when
                                        booking)
                                    description:
                                      type: string
                                      description: Baggage description
                                    ancillaryJourneys:
                                      type: array
                                      items:
                                        type: object
                                        properties:
                                          airline:
                                            type: string
                                            description: Airline code
                                          departure:
                                            type: string
                                            description: Origin[IATA airport code]
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
                                          bookingCode:
                                            type: string
                                            description: Cabin code
                                          flightNum:
                                            type: string
                                            description: Flight number
                                        required:
                                          - airline
                                          - departure
                                          - departureDate
                                          - departureTime
                                          - arrival
                                          - arrivalDate
                                          - arrivalTime
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
                                        x-apifox-ignore-properties: []
                                      description: >-
                                        Itinerary information (This field is
                                        required when booking with ancillaries)
                                    buyerOrder:
                                      type: string
                                      description: Buyer ancillary order number
                                  x-apifox-orders:
                                    - ancillaryType
                                    - ancillaryKey
                                    - payBaggageType
                                    - baggagePiece
                                    - baggageWeight
                                    - baggageCurrency
                                    - baggagePrice
                                    - description
                                    - ancillaryJourneys
                                    - buyerOrder
                                  required:
                                    - ancillaryType
                                    - ancillaryKey
                                    - payBaggageType
                                    - baggagePiece
                                    - baggageWeight
                                    - baggageCurrency
                                    - baggagePrice
                                    - ancillaryJourneys
                                  x-apifox-ignore-properties: []
                              seat:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    ancillaryType:
                                      type: string
                                      description: >-
                                        seat details (This field is required
                                        when booking with ancillaries); 2-seat
                                    ancillaryKey:
                                      type: string
                                      description: >-
                                        Unique ID returned in AncillaryPricing
                                        (This field is required when booking
                                        with ancillaries)
                                    seatName:
                                      type: string
                                      description: seat name
                                    column:
                                      type: string
                                      description: seat column
                                    row:
                                      type: string
                                      description: seat row
                                    seatCategory:
                                      type: string
                                      description: seat category
                                    seatCurrency:
                                      type: string
                                      description: currency
                                    seatPrice:
                                      type: string
                                      description: price
                                    characteristics:
                                      type: array
                                      items:
                                        type: string
                                      description: >-
                                        the traits of seats, like
                                        ["window"]；["middle"]；["aisle"]；["exit_row"]
                                    buyerOrder:
                                      type: string
                                      description: buyer ancillary order number
                                    ancillarySegment:
                                      type: object
                                      properties:
                                        airline:
                                          type: string
                                          description: Airline code
                                        departure:
                                          type: string
                                          description: Origin[IATA airport code]
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
                                        bookingCode:
                                          type: string
                                          description: Cabin code
                                        flightNum:
                                          type: string
                                          description: Flight number
                                      required:
                                        - airline
                                        - departure
                                        - departureDate
                                        - departureTime
                                        - arrival
                                        - arrivalDate
                                        - arrivalTime
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
                                      x-apifox-ignore-properties: []
                                  required:
                                    - ancillaryType
                                    - ancillaryKey
                                    - ancillarySegment
                                  x-apifox-orders:
                                    - ancillaryType
                                    - ancillaryKey
                                    - seatName
                                    - column
                                    - row
                                    - seatCategory
                                    - seatCurrency
                                    - seatPrice
                                    - characteristics
                                    - buyerOrder
                                    - ancillarySegment
                                  x-apifox-ignore-properties: []
                            x-apifox-orders:
                              - baggage
                              - seat
                            description: >-
                              Ancillary data( If booking with ancillaries, this
                              field is required)
                            x-apifox-ignore-properties: []
                        x-apifox-orders:
                          - ancillaryPassenger
                          - ancillaries
                        required:
                          - ancillaryPassenger
                          - ancillaries
                        x-apifox-ignore-properties: []
                      description: Ancillary information
                    contact:
                      type: object
                      properties:
                        name:
                          type: string
                          description: 'Name format: FirstnameLastname'
                        email:
                          type: string
                          description: >-
                            Email address, only supports three special
                            characters: 1.@ (at sign), 2. _ (underscore), 3. -
                            (dash) 
                        telCode:
                          type: string
                          description: Area Code
                        mobile:
                          type: string
                          description: Telephone
                        postcode:
                          type: string
                          description: Postcode
                        address:
                          type: string
                          description: Address
                        buyerEmail:
                          type: string
                          description: Buyer email
                        buyerTelCode:
                          type: string
                          description: Buyer telephone code
                        buyerMobile:
                          type: string
                          description: Buyer mobile
                      x-apifox-orders:
                        - name
                        - email
                        - telCode
                        - mobile
                        - postcode
                        - address
                        - buyerEmail
                        - buyerTelCode
                        - buyerMobile
                      x-apifox-ignore-properties: []
                  required:
                    - passengers
                    - solution
                  x-apifox-orders:
                    - passengers
                    - solution
                    - buyerOrder
                    - ancillary
                    - contact
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - booking
              x-apifox-orders:
                - 01HVFSTY1G7KRFZ31J4SYPV7Z6
                - booking
              x-apifox-refs:
                01HVFSTY1G7KRFZ31J4SYPV7Z6:
                  $ref: '#/components/schemas/Authentication'
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: ''
                partnerId: ''
              booking:
                passengers:
                  - passengerIndex: 1
                    birthday: '1993-06-22'
                    firstName: Mary
                    lastName: Jones
                    nationality: PH
                    psgType: ADT
                    sex: F
                    ffpNumber: '125003559853'
                    ffpAirline: CA
                    ktn: '1029490'
                    redress: '2039401'
                  - passengerIndex: 2
                    birthday: '2021-04-12'
                    firstName: Jason
                    lastName: Smith
                    nationality: PH
                    psgType: CHD
                    sex: M
                    ffpNumber: '125003559853'
                    ffpAirline: CA
                    ktn: null
                    redress: null
                  - passengerIndex: 3
                    birthday: '2023-11-24'
                    firstName: Laura
                    lastName: Smith
                    nationality: PH
                    psgType: INF
                    sex: F
                    associatedPassengerIndex: 1
                solution:
                  solutionId: >-
                    OqDCC1j2GhG9XTKOd0/KF+6M/7Mn+gurPNfAlXIf00HtDIJIZmfk2/NfuNJ8U2NS4KZ5IHjxWoNYHt7SgOgt+PwbtwEji+tazJ+2u2Gmmtxr0fPZjbWUBzlNkMCRhoB3Rzt0Av7jBdhCM4LocbIrD0YzA4S6SxfrTr0woQVRPS1WLvZhJwx7IzWEctrqdnv7TOEK5QbnBDh8RalKJoykngem8SOx/0E4p6mjulWQH8XYvBwaq+THRi7ZdDLHgOLvAWpM+ja0R8Rzzu3yPfD5iNXaG1LUs87R+yDEjYQH7fY0BkctfLCoLVVZSMVyyA2UgwLRCazQwDXmYe29tsiNAg==
                  adtFare: 117.25
                  adtTax: 59.11
                  chdFare: 108.87
                  chdTax: 59.11
                  infFare: 28.45
                  infTax: 0
                  journeys:
                    journey_0:
                      - airline: FD
                        flightNum: '503'
                        arrival: DMK
                        arrivalDate: '2024-12-31'
                        arrivalTime: '00:20'
                        departure: HKG
                        departureDate: '2024-12-30'
                        departureTime: '22:20'
                        bookingCode: A
                contact:
                  name: AndyGuan
                  email: an-dy.gu_an@pkfare.com
                  telCode: '+86'
                  mobile: '17826050868'
                  buyerEmail: alan.wang@pkfare.com
                  buyerTelCode: '+86'
                  buyerMobile: '18066793072'
                ancillary:
                  - ancillaries:
                      baggage:
                        - ancillaryType: 1
                          ancillaryKey: 0c3596cc08171e66748b91bdad5c1e57
                          payBaggageType: '1'
                          baggagePiece: '2'
                          baggageWeight: 36KG
                          baggageCurrency: CNY
                          baggagePrice: '95.0'
                          description: ''
                          ancillaryJourneys:
                            - airline: FD
                              flightNum: '503'
                              arrival: DMK
                              arrivalDate: '2024-12-31'
                              arrivalTime: '00:20'
                              departure: HKG
                              departureDate: '2024-12-30'
                              departureTime: '22:20'
                              bookingCode: A
                          buyerOrder: ' '
                      seat:
                        - ancillaryKey: 4f556396a9e7490cccb75a91ae19dbca
                          ancillaryType: '2'
                          ancillarySegment:
                            departureTime: '00:05'
                            flightNum: '896'
                            arrival: SGN
                            arrivalTime: '06:20'
                            bookingCode: I
                            departure: DEL
                            departureDate: '2023-11-30'
                            airline: VJ
                            arrivalDate: '2023-11-30'
                          characteristics:
                            - middle
                          row: '26'
                          column: B
                          seatName: 26B
                          seatPrice: '8.3'
                          seatCurrency: USD
                        - ancillaryKey: b9fb374c9c7fb51d88b04b415027be67
                          ancillaryType: '2'
                          ancillarySegment:
                            departureTime: '17:20'
                            flightNum: '632'
                            arrival: DAD
                            arrivalTime: '18:35'
                            bookingCode: I
                            departure: SGN
                            departureDate: '2023-11-30'
                            airline: VJ
                            arrivalDate: '2023-11-30'
                          characteristics:
                            - window
                          row: '26'
                          column: A
                          seatName: 26A
                          seatPrice: '8.3'
                          seatCurrency: USD
                    ancillaryPassenger:
                      firstName: Mary
                      lastName: Jones
                      psgType: ADT
                      sex: F
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
                      orderNum:
                        type: string
                        description: "Order number.\t"
                      pnr:
                        type: string
                        description: Pnr
                      solution:
                        type: object
                        properties:
                          solutionId:
                            type: string
                            description: Unique identification
                          solutionKey:
                            type: string
                            description: "Unique identification\t"
                          brandFare:
                            type: string
                            description: Brand Fare code retained for the booked solution.
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
                                      description: Code of the booked product tag.
                                    tagName:
                                      type: string
                                      description: Name of the booked product tag.
                                  x-apifox-orders:
                                    - tagCode
                                    - tagName
                                  description: One booked product tag.
                                  required:
                                    - tagCode
                                    - tagName
                                  x-apifox-ignore-properties: []
                                description: Type of the booked product tag.
                            description: >-
                              MultiTag product attributes retained for the
                              booked solution.
                            x-apifox-orders:
                              - '{tagType}'
                            x-apifox-ignore-properties: []
                          fareType:
                            type: string
                            description: "Fare type including PUBLIC and PRIVATE\t"
                          currency:
                            type: string
                            description: Currency
                          adtFare:
                            type: number
                            description: Adult fare
                          adtTax:
                            type: number
                            description: "Adult tax\t"
                          chdFare:
                            type: number
                            description: Children [age 2-12] fare
                          chdTax:
                            type: number
                            description: "Children [age 2-12] tax\t"
                          infFare:
                            type: number
                            description: "Infant [ age 0-2, no seat ] fare\t"
                          infTax:
                            type: number
                            description: "Infant [ age 0-2, no seat] tax\t"
                          qCharge:
                            type: number
                            description: "Q charge, bunker adjustment surcharge, for reference only\t"
                          tktFee:
                            type: number
                            description: "Ticketing service fee\t"
                          platformServiceFee:
                            type: number
                            description: "Platform service fee, defaults to 0\t"
                          journeys:
                            type: object
                            properties:
                              journey_0:
                                type: array
                                items:
                                  type: string
                                description: journey_0 Or journey_1
                            x-apifox-orders:
                              - journey_0
                            description: 'JSON format string array. Content: flightID'
                            x-apifox-ignore-properties: []
                          platingCarrier:
                            type: string
                            description: "Ticketing airline\t"
                          merchantFee:
                            type: number
                            description: "Payment transaction fee\t"
                          afterSaleRule:
                            type: object
                            properties: {}
                            x-apifox-orders: []
                            description: "After sale rule, not supported yet\t"
                            x-apifox-ignore-properties: []
                        x-apifox-orders:
                          - solutionId
                          - solutionKey
                          - brandFare
                          - multiTags
                          - fareType
                          - currency
                          - adtFare
                          - adtTax
                          - chdFare
                          - chdTax
                          - infFare
                          - infTax
                          - qCharge
                          - tktFee
                          - platformServiceFee
                          - journeys
                          - platingCarrier
                          - merchantFee
                          - afterSaleRule
                        x-apifox-ignore-properties: []
                      flights:
                        type: array
                        items:
                          type: object
                          properties:
                            flightId:
                              type: string
                              description: Flight ID， unique identification
                            journeyTime:
                              type: integer
                              description: "Journey Time, unit: minute\t"
                            transferCount:
                              type: integer
                              description: "Number of transfers\t"
                            lastTktTime:
                              type: string
                              description: Latest ticketing time (GMT)
                            segmengtIds:
                              type: array
                              items:
                                type: string
                              description: >-
                                Number of segment arrays (please note the
                                segmengtIds is a typo due to history edition)
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
                              description: "Airline code\t"
                            flightNum:
                              type: string
                              description: "Flight number\t"
                            equipment:
                              type: string
                              description: Equipment
                            cabinClass:
                              type: string
                              description: "Cabin class including Economy, PremiumEconomy, Business, First\t"
                            bookingCode:
                              type: string
                              description: "Cabin code\t"
                            availabilityCount:
                              type: integer
                              description: "Available seats, for reference only\t"
                            departure:
                              type: string
                              description: "Departure airport\t"
                            arrival:
                              type: string
                              description: "Arrival airport\t"
                            departureTerminal:
                              type: string
                              description: "Departure airport terminal\t"
                            arrivalTerminal:
                              type: string
                              description: "Arrival airport terminal\t"
                            departureDate:
                              type: integer
                              description: "Departure date [unix time]\t"
                            arrivalDate:
                              type: integer
                              description: "Arrival date [unix time]\t"
                            flightTime:
                              type: integer
                              description: "Flight time, unit: minute\t"
                            "stayTime\t":
                              type: integer
                              description: "Stay time, valid with 'stopover' , unit: minute\t"
                            codeShare:
                              type: string
                              description: 'Code share or not: [Y-yes, N-no]'
                            opFltNo:
                              type: string
                              description: "Flight number of operated carrier\t"
                            opFltAirline:
                              type: string
                              description: "Operated carrier\t"
                            stopover:
                              type: string
                              description: "Stopover airport\t"
                            strDepartureDate:
                              type: string
                              description: "Departure date[yyyy-mm-dd], local time\t"
                            strDepartureTime:
                              type: string
                              description: "Departure time[hh:mm], local time\t"
                            strArrivalDate:
                              type: string
                              description: "Arrival date[yyyy-mm-dd], local time\t"
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
                            - "stayTime\t"
                            - codeShare
                            - opFltNo
                            - opFltAirline
                            - stopover
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
                              description: "Last name\t"
                            firstName:
                              type: string
                              description: "First name\t"
                            psgType:
                              type: string
                              description: "Passenger type; ADT-Adult, CHD-Child[2-12 years old]\t"
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
                                        description: "Unique ID returned in AncillaryPricing\t"
                                      ancillaryType:
                                        type: integer
                                        description: "Baggage details; 1-baggage\t"
                                      payBaggageType:
                                        type: integer
                                        description: "Baggage type; 1-checked baggage, 2-carry-on baggage\t"
                                      baggagePiece:
                                        type: integer
                                        description: "Baggage piece; -1 - no limit to baggage piece\t"
                                      baggageWeight:
                                        type: string
                                        description: "Baggage weight\t"
                                      baggageCurrency:
                                        type: string
                                        description: Currency
                                      baggagePrice:
                                        type: integer
                                        description: Price
                                      ancillaryJourneys:
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
                                              description: "Cabin code\t"
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
                                        description: Itinerary information
                                    x-apifox-orders:
                                      - ancillaryKey
                                      - ancillaryType
                                      - payBaggageType
                                      - baggagePiece
                                      - baggageWeight
                                      - baggageCurrency
                                      - baggagePrice
                                      - ancillaryJourneys
                                    x-apifox-ignore-properties: []
                                  description: Baggage details
                                seat:
                                  type: array
                                  items:
                                    type: object
                                    properties:
                                      ancillaryKey:
                                        type: string
                                        description: "Unique ID returned in AncillaryPricing\t"
                                      ancillaryType:
                                        type: integer
                                        description: "seat details; 2-seat\t"
                                      seatName:
                                        type: string
                                        description: "seat name\t"
                                      column:
                                        type: string
                                        description: "seat column\t"
                                      row:
                                        type: string
                                        description: "seat row\t"
                                      "seatCategory\t":
                                        type: string
                                        description: "seat category\t"
                                      characteristics:
                                        type: array
                                        items:
                                          type: string
                                        description: >-
                                          the traits of
                                          seats：window；middle；aisle；exit_row
                                      seatCurrency:
                                        type: string
                                        description: currency
                                      seatPrice:
                                        type: string
                                        description: price
                                      ancillarySegment:
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
                                            description: "Cabin code\t"
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
                                        description: The segment details of ancillary
                                        x-apifox-ignore-properties: []
                                      buyerOrder:
                                        type: string
                                        description: "buyer ancillary order number\t"
                                    x-apifox-orders:
                                      - ancillaryKey
                                      - ancillaryType
                                      - seatName
                                      - column
                                      - row
                                      - "seatCategory\t"
                                      - characteristics
                                      - seatCurrency
                                      - seatPrice
                                      - ancillarySegment
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
                        description: Ancillary information.
                    x-apifox-orders:
                      - orderNum
                      - pnr
                      - solution
                      - flights
                      - segments
                      - ancillary
                    description: "Only if the errorCode returns \"0\", returned data would not be null. Data is in JSON format, which contains three collection objects: solutions, flights, segments.\t"
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
                  summary: Success(Response without ancillary)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderNum: '917132752968703001'
                      pnr: WC7JP4
                      solution:
                        solutionKey: 0bbef6a2cfbaf9188b344fbb7229dd2b
                        solutionId: >-
                          OqDCC1j2GhG9XTKOd0/KF+6M/7Mn+gurPNfAlXIf00HtDIJIZmfk2/NfuNJ8U2NS4KZ5IHjxWoNYHt7SgOgt+PwbtwEji+tazJ+2u2Gmmtxr0fPZjbWUBzlNkMCRhoB3Rzt0Av7jBdhCM4LocbIrD0YzA4S6SxfrTr0woQVRPS1WLvZhJwx7IzWEctrqdnv7TOEK5QbnBDh8RalKJoykngem8SOx/0E4p6mjulWQH8XYvBwaq+THRi7ZdDLHgOLvAWpM+ja0R8Rzzu3yPfD5iNXaG1LUs87R+yDEjYQH7fY0BkctfLCoLVVZSMVyyA2UgwLRCazQwDXmYe29tsiNAg==
                        fareType: PRIVATE
                        currency: USD
                        adtFare: 117.25
                        adtTax: 59.11
                        chdFare: 108.87
                        chdTax: 59.11
                        infFare: 28.45
                        infTax: 0
                        qCharge: 0
                        tktFee: 0
                        platformServiceFee: 0
                        journeys:
                          journey_0:
                            - 3ca255ac07063fd19f13a4c4055aade2
                        platingCarrier: FD
                        merchantFee: 0
                        adults: 1
                        children: 1
                        infants: 1
                        baggageMap:
                          CHD:
                            - segmentIndexList:
                                - 1
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                          INF:
                            - segmentIndexList:
                                - 1
                          ADT:
                            - segmentIndexList:
                                - 1
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                      flights:
                        - flightId: 3ca255ac07063fd19f13a4c4055aade2
                          journeyTime: 180
                          transferCount: 0
                          segmengtIds:
                            - ea3506f2711c19a82c12bf157fa6b153
                      segments:
                        - segmentId: ea3506f2711c19a82c12bf157fa6b153
                          airline: FD
                          flightNum: '503'
                          equipment: '320'
                          cabinClass: ECONOMY
                          bookingCode: A
                          availabilityCount: 5
                          departure: HKG
                          arrival: DMK
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1735568400000
                          arrivalDate: 1735575600000
                          flightTime: 180
                          codeShare: 'N'
                          strDepartureDate: '2024-12-30'
                          strDepartureTime: '22:20'
                          strArrivalDate: '2024-12-31'
                          strArrivalTime: '00:20'
                '2':
                  summary: Success(Response with baggage)
                  value:
                    data:
                      flights:
                        - flightId: ef8caaf829406399310863e678196849
                          journeyTime: 450
                          lastTktTime: '2023-07-07 23:59:00'
                          segmengtIds:
                            - b8ea011c2f09f69cfe9311ceef3e3a5b
                            - 43ee963d98ef57314e55677c10b86ca0
                          transferCount: 1
                      orderNum: 1014766841
                      pnr: SQFTQJ
                      segments:
                        - airline: MU
                          arrival: HKG
                          arrivalDate: 1499399400000
                          arrivalTerminal: '1'
                          availabilityCount: 1
                          bookingCode: B
                          cabinClass: ECONOMY
                          codeShare: 'N'
                          departure: PVG
                          departureDate: 1499391000000
                          departureTerminal: '1'
                          equipment: '320'
                          flightNum: '501'
                          flightTime: 140
                          opFltAirline: ''
                          segmentId: 43ee963d98ef57314e55677c10b86ca0
                          strArrivalDate: '2023-07-07'
                          strArrivalTime: '11:50'
                          strDepartureDate: '2023-07-07'
                          strDepartureTime: '09:30'
                        - airline: MU
                          arrival: PVG
                          arrivalDate: 1499383200000
                          arrivalTerminal: '1'
                          availabilityCount: 1
                          bookingCode: R
                          cabinClass: ECONOMY
                          codeShare: 'Y'
                          departure: KUL
                          departureDate: 1499364600000
                          departureTerminal: M
                          equipment: '738'
                          flightNum: '9862'
                          flightTime: 310
                          opFltAirline: FM
                          opFltNo: '862'
                          segmentId: b8ea011c2f09f69cfe9311ceef3e3a5b
                          strArrivalDate: '2023-07-07'
                          strArrivalTime: '07:20'
                          strDepartureDate: '2023-07-07'
                          strDepartureTime: '02:10'
                      solution:
                        adtFare: 1330
                        adtTax: 753
                        afterSaleRule: null
                        chdFare: 567
                        chdTax: 234.2
                        infFare: 218
                        infTax: 97.6
                        currency: CNY
                        fareType: PUBLIC
                        journeys:
                          journey_0:
                            - ef8caaf829406399310863e678196849
                        merchantFee: 2.08
                        platformServiceFee: 0
                        platingCarrier: MU
                        qCharge: 0
                        solutionKey: 3aed0b90f0c04b5ea51ad01f3470f254
                        solutionId: '1'
                        tktFee: 0
                      ancillary:
                        - ancillaries:
                            baggage:
                              - ancillaryJourneys:
                                  - airline: MU
                                    arrival: HKG
                                    arrivalDate: '2023-07-07'
                                    arrivalTime: '11:50'
                                    bookingCode: B
                                    departure: PVG
                                    departureDate: '2023-07-07'
                                    departureTime: '09:30'
                                    flightNum: '501'
                                  - airline: MU
                                    arrival: PVG
                                    arrivalDate: '2023-07-07'
                                    arrivalTime: '07:20'
                                    bookingCode: R
                                    departure: KUL
                                    departureDate: '2023-07-07'
                                    departureTime: '02:10'
                                    flightNum: '9862'
                                ancillaryId: 9b43ce6302e3ae8e130b94112f992771
                                ancillaryType: 1
                                baggageCurrency: CNY
                                baggagePiece: 1
                                baggagePrice: 663
                                baggageWeight: 50KG
                                description: extra 1 piece baggage
                                payBaggageType: 1
                          firstName: Mary
                          lastName: Jones
                          psgType: ADT
                    errorCode: '0'
                    errorMsg: ok
                '3':
                  summary: Success(Response with seat)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderNum: '916995304456203701'
                      pnr: A8GS1Q
                      solution:
                        solutionKey: 03d83a531a25d8853baa94d02fe7cb79
                        solutionId: '1'
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
                            - 036343eddc01e31dbe364d10df1c4e5a
                        platingCarrier: VJ
                        merchantFee: 0
                        adults: 1
                        children: 0
                        infants: 0
                        baggageMap:
                          ADT:
                            - segmentIndexList:
                                - 1
                              baggageAmount: 0PC
                            - segmentIndexList:
                                - 2
                              baggageAmount: 0PC
                      flights:
                        - flightId: 036343eddc01e31dbe364d10df1c4e5a
                          journeyTime: 360
                          transferCount: 1
                          segmengtIds:
                            - def32e56f53ad461c6437c0d237ae6db
                            - 4abffb5c6b36b9a366075d4726460a66
                      segments:
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
                      ancillary:
                        - lastName: LIN
                          firstName: LIHONG
                          psgType: ADT
                          ancillaries:
                            seat:
                              - ancillaryKey: 4f556396a9e7490cccb75a91ae19dbca
                                ancillaryType: 2
                                ancillarySegment:
                                  airline: VJ
                                  flightNum: '896'
                                  departure: DEL
                                  departureDate: '2023-11-30'
                                  departureTime: '00:05'
                                  arrival: SGN
                                  arrivalDate: '2023-11-30'
                                  arrivalTime: '06:20'
                                  bookingCode: I
                                seatName: 46A
                                column: A
                                row: '46'
                                characteristics:
                                  - middle
                                seatCurrency: CNY
                                seatPrice: '40.0'
                              - ancillaryKey: b9fb374c9c7fb51d88b04b415027be67
                                ancillaryType: 2
                                ancillarySegment:
                                  airline: VJ
                                  flightNum: '632'
                                  departure: SGN
                                  departureDate: '2023-11-30'
                                  departureTime: '17:20'
                                  arrival: DAD
                                  arrivalDate: '2023-11-30'
                                  arrivalTime: '18:35'
                                  bookingCode: I
                                seatName: 15A
                                column: A
                                row: '15'
                                characteristics:
                                  - middle
                                seatCurrency: CNY
                                seatPrice: '40.0'
                '4':
                  summary: Success(Response with baggage and seat)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderNum: '916995304456203701'
                      pnr: A8GS1Q
                      solution:
                        solutionKey: 03d83a531a25d8853baa94d02fe7cb79
                        solutionId: '1'
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
                            - 036343eddc01e31dbe364d10df1c4e5a
                        platingCarrier: VJ
                        merchantFee: 0
                        adults: 1
                        children: 0
                        infants: 0
                        baggageMap:
                          ADT:
                            - segmentIndexList:
                                - 1
                              baggageAmount: 0PC
                            - segmentIndexList:
                                - 2
                              baggageAmount: 0PC
                      flights:
                        - flightId: 036343eddc01e31dbe364d10df1c4e5a
                          journeyTime: 360
                          transferCount: 1
                          segmengtIds:
                            - def32e56f53ad461c6437c0d237ae6db
                            - 4abffb5c6b36b9a366075d4726460a66
                      segments:
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
                      ancillary:
                        - lastName: LIN
                          firstName: LIHONG
                          psgType: ADT
                          ancillaries:
                            baggage:
                              - ancillaryKey: 0c3596cc08171e66748b91bdad5c1e57
                                ancillaryType: 1
                                payBaggageType: 1
                                baggagePiece: 2
                                baggageWeight: 36KG
                                baggageCurrency: CNY
                                baggagePrice: 95
                                ancillaryJourneys:
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
                            seat:
                              - ancillaryKey: 4f556396a9e7490cccb75a91ae19dbca
                                ancillaryType: 2
                                ancillarySegment:
                                  airline: VJ
                                  flightNum: '896'
                                  departure: DEL
                                  departureDate: '2023-11-30'
                                  departureTime: '00:05'
                                  arrival: SGN
                                  arrivalDate: '2023-11-30'
                                  arrivalTime: '06:20'
                                  bookingCode: I
                                seatName: 46A
                                column: A
                                row: '46'
                                characteristics:
                                  - middle
                                seatCurrency: CNY
                                seatPrice: '40.0'
                              - ancillaryKey: b9fb374c9c7fb51d88b04b415027be67
                                ancillaryType: 2
                                ancillarySegment:
                                  airline: VJ
                                  flightNum: '632'
                                  departure: SGN
                                  departureDate: '2023-11-30'
                                  departureTime: '17:20'
                                  arrival: DAD
                                  arrivalDate: '2023-11-30'
                                  arrivalTime: '18:35'
                                  bookingCode: I
                                seatName: 15A
                                column: A
                                row: '15'
                                characteristics:
                                  - middle
                                seatCurrency: CNY
                                seatPrice: '40.0'
                '5':
                  summary: Success(Response With Fare Family)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderNum: '917132752968703001'
                      pnr: WC7JP4
                      solution:
                        solutionKey: 0bbef6a2cfbaf9188b344fbb7229dd2b
                        solutionId: >-
                          OqDCC1j2GhG9XTKOd0/KF+6M/7Mn+gurPNfAlXIf00HtDIJIZmfk2/NfuNJ8U2NS4KZ5IHjxWoNYHt7SgOgt+PwbtwEji+tazJ+2u2Gmmtxr0fPZjbWUBzlNkMCRhoB3Rzt0Av7jBdhCM4LocbIrD0YzA4S6SxfrTr0woQVRPS1WLvZhJwx7IzWEctrqdnv7TOEK5QbnBDh8RalKJoykngem8SOx/0E4p6mjulWQH8XYvBwaq+THRi7ZdDLHgOLvAWpM+ja0R8Rzzu3yPfD5iNXaG1LUs87R+yDEjYQH7fY0BkctfLCoLVVZSMVyyA2UgwLRCazQwDXmYe29tsiNAg==
                        fareType: PRIVATE
                        currency: USD
                        adtFare: 117.25
                        adtTax: 59.11
                        chdFare: 108.87
                        chdTax: 59.11
                        infFare: 28.45
                        infTax: 0
                        qCharge: 0
                        tktFee: 0
                        platformServiceFee: 0
                        journeys:
                          journey_0:
                            - 3ca255ac07063fd19f13a4c4055aade2
                        platingCarrier: FD
                        merchantFee: 0
                        adults: 1
                        children: 1
                        infants: 1
                        baggageMap:
                          CHD:
                            - segmentIndexList:
                                - 1
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                          INF:
                            - segmentIndexList:
                                - 1
                          ADT:
                            - segmentIndexList:
                                - 1
                              baggageAmount: 0PC
                              carryOnAmount: 1PC
                              carryOnWeight: 7KG
                      tag: SAVER
                      otherFareRules:
                        ADT:
                          - segmentIndexList:
                              - 1
                            detail:
                              - free meal
                      flights:
                        - flightId: 3ca255ac07063fd19f13a4c4055aade2
                          journeyTime: 180
                          transferCount: 0
                          segmengtIds:
                            - ea3506f2711c19a82c12bf157fa6b153
                      segments:
                        - segmentId: ea3506f2711c19a82c12bf157fa6b153
                          airline: FD
                          flightNum: '503'
                          equipment: '320'
                          cabinClass: ECONOMY
                          bookingCode: A
                          availabilityCount: 5
                          departure: HKG
                          arrival: DMK
                          departureTerminal: '1'
                          arrivalTerminal: '2'
                          departureDate: 1735568400000
                          arrivalDate: 1735575600000
                          flightTime: 180
                          codeShare: 'N'
                          strDepartureDate: '2024-12-30'
                          strDepartureTime: '22:20'
                          strArrivalDate: '2024-12-31'
                          strArrivalTime: '00:20'
                '6':
                  summary: Success(with multiTag)
                  value:
                    errorCode: '0'
                    errorMsg: ok
                    data:
                      orderNum: '917863567003892901'
                      pnr: QDDS5X
                      solution:
                        solutionKey: 7c1516310d33c248894fae3020c2188d
                        solutionId: >-
                          zgLGZAANnMKX46KcjrC1CeAg3gSublYFlkykB1krxHFnywHp7nMPgk91qobUz4OE42OQ6EywCQRCzQ8EaupFj4BwN12tgoMvyjzH6ORkmMg3XsLGm6o90l2j18DCoW410hSjpNw994yGIGGfnBb/whWu/lrp7vI7hGzEtCbN4KpL/5JyP9qY/I1dBSJsaSlpzGuDf1Qa30SSwv5OpouCc+yPX4JNby3QEAlMBSSFd1smtbiBb8y5NgnOWbf/OkECvBNVPJnh5HM4xP/z72BQ90TDfn6yOVTR9dNyArMF78tHHNr6tZ6FHerdcGi2MmKHhekm0Z5C9ASTZ68W4HXumUix5Ini32GoFlSOAzUO0XaqcjvWZvT7pl1p9K2+l49LK/waORYtrosLof50KkoUpzPAJdx7l0f/APnkYFiox28=
                        fareType: PRIVATE
                        currency: CNY
                        adtFare: 3998
                        adtTax: 2412.66
                        chdFare: 0
                        chdTax: 0
                        chnFare: 0
                        chnTax: 0
                        infFare: 0
                        infTax: 0
                        qCharge: 0
                        tktFee: 0
                        platformServiceFee: 0
                        journeys:
                          journey_0:
                            - 1cfda8a9c2400ca5e41aba0630b83485
                          journey_1:
                            - 15cfaa6b4976352d7906d3504697b181
                        platingCarrier: SG
                        merchantFee: 0
                        adults: 1
                        children: 0
                        infants: 0
                        baggageMap:
                          ADT:
                            - segmentIndexList:
                                - 1
                              baggageAmount: 1PC
                              baggageWeight: 20KG
                              carryOnAmount: 1PC
                              carryOnWeight: 10KG
                            - segmentIndexList:
                                - 2
                              baggageAmount: 1PC
                              baggageWeight: 20KG
                              carryOnAmount: 1PC
                              carryOnWeight: 10KG
                        multiTags:
                          SpecialProductType:
                            - tagCode: test-非标
                              tagName: test-非标
                        brandFare: testlxy
                      flights:
                        - flightId: 1cfda8a9c2400ca5e41aba0630b83485
                          journeyTime: 130
                          transferCount: 0
                          segmengtIds:
                            - 8a28f9036137be0631e27343cfd8648a
                        - flightId: 15cfaa6b4976352d7906d3504697b181
                          journeyTime: 145
                          transferCount: 0
                          segmengtIds:
                            - 573ac61cd8a9cd83eeaa6799d627c4b8
                      segments:
                        - segmentId: 8a28f9036137be0631e27343cfd8648a
                          airline: SG
                          flightNum: '169'
                          equipment: '737'
                          cabinClass: ECONOMY
                          bookingCode: E
                          availabilityCount: 10
                          departure: DEL
                          arrival: BOM
                          departureTerminal: T-1D
                          arrivalTerminal: T-1
                          departureDate: 1814796000000
                          arrivalDate: 1814803800000
                          flightTime: 130
                          codeShare: 'N'
                          strDepartureDate: '2027-07-05'
                          strDepartureTime: '22:00'
                          strArrivalDate: '2027-07-06'
                          strArrivalTime: '00:10'
                        - segmentId: 573ac61cd8a9cd83eeaa6799d627c4b8
                          airline: SG
                          flightNum: '152'
                          equipment: '737'
                          cabinClass: ECONOMY
                          bookingCode: E
                          availabilityCount: 10
                          departure: BOM
                          arrival: DEL
                          departureTerminal: T-1
                          arrivalTerminal: T-1D
                          departureDate: 1815170700000
                          arrivalDate: 1815179400000
                          flightTime: 145
                          codeShare: 'N'
                          strDepartureDate: '2027-07-10'
                          strDepartureTime: '06:05'
                          strArrivalDate: '2027-07-10'
                          strArrivalTime: '08:30'
                '7':
                  summary: Error(B065)
                  value: >-
                    {
                        "errorCode": "B065",
                        "errorMsg": "Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality."
                    }


                    Remark: 

                    This error occurs frequently when there is missing parameter
                    - 'nationality' under the context that ID is not required.
                    Please note that 'Nationality' is still a mandatory field
                    even the ID is not mandatory. 


                    Suggestion: 

                    Retry by adding passenger's nationality in the requests
                '8':
                  summary: Error(B005)
                  value: >-
                    {
                        "errorCode": "B005",
                        "errorMsg": "Can not find any matching precisePricing result within 30 minutes."
                    }




                    Remark: This error occurs under a few circumstances -

                    1. The timegap between PrecisePricing and PrciseBooking API
                    calls exceeds 30 minutes. 

                    2. The timegap between receiving PrecisePricing API
                    responses and making PrciseBooking API calls is too short
                    (in millescends) that system could not relate the request to
                    the corresponding results.

                    3. Invoke PreciseBooking API even when there is error
                    response with PrecisePricing Interface.

                    4. The parameters or values in PreciseBooking API requests
                    deviate from which in PrecisePricing or AncillaryPricing
                    responses 




                    Suggestion: 

                    1. Ensure that the timestamp between PrecisePricing and
                    PreciseBooking is correctly mapped.

                    2. Ensure that there is no error response in previous calls
                    before invoking PrciseBooking endpoint.

                    3. Correlates the requesting structure of PreciseBooking
                    with the responses from PrecisePricing and AncillaryPricing
                    endpoints.
                '9':
                  summary: Error(B029)
                  value: >-
                    {
                        "errorCode": "B029",
                        "errorMsg": "Duplicate reservations have been found for passenger XXX/XXX in order XXX, in pnr XXX."
                    }



                    Remark: 

                    This error is with regards to duplicate orders. If the same
                    passenger had placed an order for specific flights, any
                    subsequent booking requests will be identified as duplicated
                    bookings and be blocked by the system automatically. 



                    Suggestion: 

                    Please invoke Cancel API to cancel and clear any unwanted
                    orders placed in the system before proceeding with bookings
                    for the same flights.
                '10':
                  summary: Error(B004)
                  value: >-
                    {
                        "errorCode": "B004",
                        "errorMsg": "There are errors in the passenger type of Adults."
                    }



                    Remark: 

                    This error occurs when the age of the passenger does not
                    fall within the age definition for Adult, Child or infant,
                    especially for Child. For instance, for Wizz airlines, the
                    definition of child is 2-14 while which is 2-12 among other
                    airlines.



                    Suggestion: 

                    Conform to different airlines' rules for passgener age
                    requirement upon placing the bookings
                '11':
                  summary: Error(P008)
                  value: >-
                    {
                        "errorCode": "P008",
                        "errorMsg": "Invalid first Name/last Name."
                    }


                    Remark:

                    This error derives when receiving Invalid passenger name
                    values such as hyphen or other special characters.
                    Currently, only space and English letters are accepeted for
                    the fields 'firstName'/'lastName'. 


                    Suggestion: 

                    Please remove any other input values except English letters
                    and space
                '12':
                  summary: Error(B038)
                  value:
                    errorCode: B038
                    errorMsg: Departure date must be today to a year.
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
                    description: Error code, refer to Error Code List
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
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Air ticket booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470821-run
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