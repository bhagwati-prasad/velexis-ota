# Change Passenger Info

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/change/changePassengerInfo:
    post:
      summary: Change Passenger Info
      deprecated: false
      description: >-
        ### Function


        This API is used for raising change request for changing passenger
        information. User can indicate order number, booked passenger(s) and new
        passenger(s) to create a change request. Order number is refer to PKFARE
        order number, the change is able to raise base on issued order or change
        order.


        ###  Error Code List



        | errorCode<img width=10/>   | errorMsg           | Description   
        |                   

        |----|----|----|

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

        |B162 |Change is not applicable for passenger xxx/xxx |Passenger has
        requested for void or refund, change is not allowed. |

        |B163 |Ticket(s) [ticket number] is No-show, change is not applicable.
        |The ticket is noshow per airline rules, change is not allowed. |

        |B164 |Passenger(s) must has same routing and request to change. If
        routing is varies, please request per passenger. |One of multiple
        Passenger(s) in the request has requested to change the routing. Change
        is not allow to raise togther. |

        |B176 |Infant is not support for change. Please kindly contact online
        service for help. |Infant is not support for change. Please kindly
        contact online service for help. |
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
                      type: integer
                    buyerOrder:
                      type: string
                      description: >-
                        Buyer order number. If you would like PKFARE to store
                        your order, please kindly put it in this element.
                    remark:
                      type: string
                      description: "Remark to support reason (maximum 500 characters)\t"
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
                          originPassengerInfo:
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
                          changePassengerInfo:
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
                        x-apifox-orders:
                          - originPassengerInfo
                          - changePassengerInfo
                        x-apifox-ignore-properties: []
                      description: Passengers who you want to change
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
                      x-apifox-orders:
                        - name
                        - telNum
                        - email
                      description: >-
                        Contact information of this change request. If leave as
                        blank, contact of origin order will be used
                      x-apifox-ignore-properties: []
                  required:
                    - orderNum
                    - passengerList
                  x-apifox-orders:
                    - orderNum
                    - buyerOrder
                    - remark
                    - uploadedFileIds
                    - passengerList
                    - contactInfo
                  x-apifox-ignore-properties: []
              required:
                - Authentication
                - data
              x-apifox-orders:
                - 01HWMX5F6G5V0ZXW7NYHKMK0V5
                - data
              x-apifox-refs:
                01HWMX5F6G5V0ZXW7NYHKMK0V5:
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
                  warningMsg:
                    type: string
                    description: "Warning message\t"
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
                      rejectedReason:
                        type: string
                        description: 'Reject reason '
                      remarks:
                        type: string
                        description: "Reject remark\t"
                      orderStatus:
                        type: string
                        description: "Order status\t"
                      pnr:
                        type: string
                        description: PNR of order
                      airPnr:
                        type: string
                        description: Airline PNR of order
                      platingCarrier:
                        type: string
                        description: "Plating carrier\t"
                      lastTktTime:
                        type: string
                        description: "Latest ticketing time\t"
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
                              description: First name
                            cardType:
                              type: string
                              description: "Travel document type, which used for creating the booking.\t"
                            cardNum:
                              type: string
                              description: "Travel document number, which used for creating the booking.\t"
                            cardExpiredDate:
                              type: string
                              description: "Travel document expired date, which used for creating the booking\t"
                            nationality:
                              type: string
                              description: "Nationality\t"
                            psgType:
                              type: string
                              description: Passenger type
                            sex:
                              type: string
                              description: Gender
                            birthday:
                              type: string
                              description: "Date of birth[YYYY-MM-DD]\t"
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
                      passengerPriceList:
                        type: array
                        items:
                          type: object
                          properties:
                            solutionId:
                              type: string
                              description: "Unique identification of this solution\t"
                            solutionKey:
                              type: string
                              description: "Unique identification of this solution\t"
                            fareType:
                              type: string
                              description: "Fare type, PUBLIC or PRIVATE\t"
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
                            chdAdditionalFare:
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
                              description: "Total change amount per infant\t"
                            merchantFee:
                              type: number
                              description: "Payment transaction fee\t"
                          x-apifox-orders:
                            - solutionId
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
                          x-apifox-ignore-properties: []
                    x-apifox-orders:
                      - orderNum
                      - parentOrderNum
                      - refOrderNum
                      - createTime
                      - rejectedReason
                      - remarks
                      - orderStatus
                      - pnr
                      - airPnr
                      - platingCarrier
                      - lastTktTime
                      - passengers
                      - passengerPriceList
                    description: >-
                      The return data, this parameter is not empty only when the
                      errorCode retruns "0"
                    x-apifox-ignore-properties: []
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - warningMsg
                  - data
                x-apifox-ignore-properties: []
              example:
                errorCode: '0'
                errorMsg: ok
                data:
                  parentOrderNum: '916974267198317218'
                  orderNum: '916974267198317240'
                  refOrderNum: '9169742671983172'
                  createTime: '2023-10-16T20:21:55+08:00'
                  orderStatus: Under review
                  pnr: 5BDWCY
                  platingCarrier: UO
                  passengers:
                    - lastName: YANGA
                      firstName: TIFFANY
                      cardType: PP
                      cardNum: E07700466
                      cardExpiredDate: '2024-03-17'
                      nationality: US
                      psgType: ADT
                      sex: F
                      birthday: '1990-08-23'
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
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469948-run
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