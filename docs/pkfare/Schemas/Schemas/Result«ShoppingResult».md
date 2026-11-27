# Result«ShoppingResult»

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths: {}
components:
  schemas:
    SegmentInfoDTO:
      type: object
      properties:
        availabilityCount:
          type: integer
          format: int32
          description: 剩余舱位数
        bookingCode:
          type: string
          description: 舱位
        cabinClass:
          type: string
          description: 舱等
        fareBasis:
          type: string
          description: fareBasis
        segmentIndex:
          type: integer
          format: int32
          description: 航段序号
      title: SegmentInfoDTO
      x-apifox-orders:
        - availabilityCount
        - bookingCode
        - cabinClass
        - fareBasis
        - segmentIndex
      x-apifox-folder: ''
    JourneysDTO:
      type: object
      properties:
        segments:
          type: array
          items:
            $ref: '#/components/schemas/SegmentInfoDTO'
          refType: SegmentInfoDTO
      title: JourneysDTO
      x-apifox-orders:
        - segments
      x-apifox-folder: ''
    RefundDTO:
      type: object
      properties:
        allowed:
          type: boolean
          description: 是否可退票
        description:
          type: string
          description: 描述
        penaltyAmount:
          type: number
          description: 退票费用
        penaltyCurrency:
          type: string
          description: 退票费用币种
      title: RefundDTO
      x-apifox-orders:
        - allowed
        - description
        - penaltyAmount
        - penaltyCurrency
      x-apifox-folder: ''
    OtherDTO:
      type: object
      properties:
        available:
          type: boolean
          description: 是否可用
        description:
          type: string
          description: 描述
        serviceName:
          type: string
          description: 服务名称
      title: OtherDTO
      x-apifox-orders:
        - available
        - description
        - serviceName
      x-apifox-folder: ''
    ChangeDTO:
      type: object
      properties:
        allowed:
          type: boolean
          description: 是否可改期
        description:
          type: string
          description: 描述
        penaltyAmount:
          type: number
          description: 改期费用
        penaltyCurrency:
          type: string
          description: 改期费用币种
      title: ChangeDTO
      x-apifox-orders:
        - allowed
        - description
        - penaltyAmount
        - penaltyCurrency
      x-apifox-folder: ''
    ConditionsDTO:
      type: object
      properties:
        change:
          $ref: '#/components/schemas/ChangeDTO'
        other:
          type: array
          description: 其它的服务
          items:
            $ref: '#/components/schemas/OtherDTO'
          refType: OtherDTO
        priorityBoarding:
          type: boolean
          description: 是否可选餐
        refund:
          $ref: '#/components/schemas/RefundDTO'
        seatSelection:
          type: boolean
          description: 是否可选座
      title: ConditionsDTO
      x-apifox-orders:
        - change
        - other
        - priorityBoarding
        - refund
        - seatSelection
      x-apifox-folder: ''
    BaggageDTO:
      type: object
      properties:
        amount:
          type: integer
          format: int32
          description: 行李数量
        segmentIndex:
          type: integer
          format: int32
          description: 航段序号
        size:
          type: string
          description: 行李尺寸
        type:
          type: string
          description: 行李类型:carryon,checked(baggage)
        weight:
          type: integer
          format: int32
          description: 行李重量
      title: BaggageDTO
      x-apifox-orders:
        - amount
        - segmentIndex
        - size
        - type
        - weight
      x-apifox-folder: ''
    SolutionsDTO:
      type: object
      properties:
        adultFare:
          type: number
          description: 成人票价
        adultTax:
          type: number
          description: 成人税费
        adultTotalPerPerson:
          type: number
          description: 成人总价
        baggages:
          type: object
          description: 行李信息
          additionalProperties:
            type: array
            items:
              $ref: '#/components/schemas/BaggageDTO'
          refType: BaggageDTO
          x-apifox-orders: []
        childFare:
          type: number
          description: 儿童票价
        childTax:
          type: number
          description: 儿童税费
        childTotalPerPerson:
          type: number
          description: 儿童总价
        conditions:
          $ref: '#/components/schemas/ConditionsDTO'
        currency:
          type: string
          description: 货币
        fareName:
          type: string
          description: 套餐名
        fareType:
          type: string
          description: 运价类型
        infantFare:
          type: number
          description: 婴儿票价
        infantTax:
          type: number
          description: 婴儿税费
        infantTotalPerPerson:
          type: number
          description: 婴儿总价
        journeys:
          type: array
          description: 行程信息
          items:
            $ref: '#/components/schemas/JourneysDTO'
          refType: JourneysDTO
        platingCarrier:
          type: string
          description: 开票航司
        solutionKey:
          type: string
          description: 报价标识
      title: SolutionsDTO
      x-apifox-orders:
        - adultFare
        - adultTax
        - adultTotalPerPerson
        - baggages
        - childFare
        - childTax
        - childTotalPerPerson
        - conditions
        - currency
        - fareName
        - fareType
        - infantFare
        - infantTax
        - infantTotalPerPerson
        - journeys
        - platingCarrier
        - solutionKey
      x-apifox-folder: ''
    SegmentsDTO:
      type: object
      properties:
        airline:
          type: string
          description: Airline code
        arrival:
          type: string
          description: Arrival airport
        arrivalDate:
          type: string
          description: Arrival date [yyyy-mm-dd]
        arrivalTerminal:
          type: string
          description: Arrival airport terminal
        arrivalTime:
          type: string
          description: Arrival time [hh:mm]
        codeShare:
          type: string
          description: 'Code share or not: [Y-yes, N-no]'
        departure:
          type: string
          description: Departure airport
        departureDate:
          type: string
          description: Departure date [yyyy-mm-dd]
        departureTerminal:
          type: string
          description: Departure airport terminal
        departureTime:
          type: string
          description: Departure time [hh:mm]
        equipment:
          type: string
          description: Equipment
        flightNum:
          type: string
          description: Flight number
        flightTime:
          type: integer
          format: int32
          description: 'Flight time, unit: minute'
        opFltAirline:
          type: string
          description: Operated carrier
        opFltNo:
          type: string
          description: Flight number of operated carrier
        segmentIndex:
          type: integer
          format: int32
          description: Segment index
        stayTime:
          type: integer
          format: int32
          description: 'Stay time, valid with ''stopover'', unit: minute'
        stopover:
          type: string
          description: Stopover airport
      title: SegmentsDTO
      x-apifox-orders:
        - airline
        - arrival
        - arrivalDate
        - arrivalTerminal
        - arrivalTime
        - codeShare
        - departure
        - departureDate
        - departureTerminal
        - departureTime
        - equipment
        - flightNum
        - flightTime
        - opFltAirline
        - opFltNo
        - segmentIndex
        - stayTime
        - stopover
      x-apifox-folder: ''
    ShoppingResult:
      type: object
      properties:
        searchKey:
          type: string
          description: Unique identification
        segments:
          type: array
          items:
            $ref: '#/components/schemas/SegmentsDTO'
          refType: SegmentsDTO
        solutions:
          type: array
          items:
            $ref: '#/components/schemas/SolutionsDTO'
          refType: SolutionsDTO
      title: ShoppingResult
      x-apifox-orders:
        - searchKey
        - segments
        - solutions
      x-apifox-folder: ''
    Result«ShoppingResult»:
      type: object
      required:
        - errorCode
        - errorMsg
      properties:
        data:
          $ref: '#/components/schemas/ShoppingResult'
        errorCode:
          type: string
          description: Error code
        errorMsg:
          type: string
          description: Error message
        success:
          type: boolean
      title: Result«ShoppingResult»
      x-apifox-orders:
        - data
        - errorCode
        - errorMsg
        - success
      x-apifox-folder: ''
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```