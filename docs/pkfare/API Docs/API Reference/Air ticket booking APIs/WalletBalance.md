# WalletBalance

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/walletBalance:
    post:
      summary: WalletBalance
      deprecated: false
      description: |-
        ##  Function
          Through the Wallet Balance API, you can check the wallet balance details of the main buyer and sub-buyers.
          

        ##  Error Code List

        |errorCode|errorMsg|
        |:----|:----|
        |0 |ok |
        |B207 |PKFARE wallet not activated |
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
              x-apifox-orders:
                - 01HVRGWNQ4Q51CMAFVZ1F4E2RT
              x-apifox-refs:
                01HVRGWNQ4Q51CMAFVZ1F4E2RT:
                  $ref: '#/components/schemas/Authentication'
              required:
                - Authentication
              x-apifox-ignore-properties:
                - Authentication
            example:
              authentication:
                sign: '{{sign}}'
                partnerId: '{{partnerId}}'
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
                      mainWallet:
                        type: array
                        items:
                          type: object
                          properties:
                            buyerCode:
                              type: string
                              description: Main buyer code
                            currency:
                              type: string
                              description: Wallet currency
                            accountStatus:
                              type: string
                              description: 'Wallet status: INVALID/VALID'
                            availableBalance:
                              type: number
                              description: Available balance
                            withdrawableBalance:
                              type: number
                              description: Withdrawable balance
                            cashBalance:
                              type: number
                              description: Cash account balance
                            creditBalance:
                              type: number
                              description: Credit account balance
                            temporaryCreditBalance:
                              type: number
                              description: Temporary credit account balance
                            depositBalance:
                              type: number
                              description: Deposit account balance
                          required:
                            - buyerCode
                            - currency
                            - accountStatus
                            - availableBalance
                            - withdrawableBalance
                            - cashBalance
                            - creditBalance
                            - temporaryCreditBalance
                            - depositBalance
                          x-apifox-orders:
                            - buyerCode
                            - currency
                            - accountStatus
                            - availableBalance
                            - withdrawableBalance
                            - cashBalance
                            - creditBalance
                            - temporaryCreditBalance
                            - depositBalance
                          x-apifox-ignore-properties: []
                        description: Main buyer wallet information
                      subBuyerWallets:
                        type: array
                        items:
                          type: object
                          properties:
                            buyerCode:
                              type: string
                              description: Sub-buyer code
                            status:
                              type: string
                              description: 'Sub-buyer wallet status: INVALID/VALID'
                            type:
                              type: string
                              description: Sub-buyer wallet sharing type:SEPARATE/SHARED
                            creditBalance:
                              type: number
                              description: >-
                                Sub-buyer cash account balance.Returned only
                                when type = SEPARATE.
                            cashBalance:
                              type: number
                              description: >-
                                Sub-buyer credit account balance.Returned only
                                when type = SEPARATE.
                            availableBalance:
                              type: number
                              description: >-
                                Sub-buyer available balance.Returned only when
                                type = SEPARATE.
                            withdrawableBalance:
                              type: number
                              description: >-
                                Sub-buyer withdrawable balance.Returned only
                                when type = SEPARATE.
                          required:
                            - buyerCode
                            - status
                            - type
                          x-apifox-orders:
                            - buyerCode
                            - status
                            - type
                            - creditBalance
                            - cashBalance
                            - availableBalance
                            - withdrawableBalance
                          x-apifox-ignore-properties: []
                        description: >-
                          Sub-buyer wallets information,This field is returned
                          when sub-buyer wallets exist.
                    required:
                      - mainWallet
                    x-apifox-orders:
                      - mainWallet
                      - subBuyerWallets
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
                  summary: Main Buyer Response
                  value:
                    errorCode: '0'
                    errorMsg: success
                    data:
                      mainWallet:
                        - buyerCode: BUYER_MAIN_001
                          currency: CNY
                          accountStatus: VALID
                          availableBalance: 9999743325.65
                          withdrawableBalance: 9999743325.65
                          cashBalance: 9999743325.65
                          creditBalance: 0
                          temporaryCreditBalance: 0
                          depositBalance: 0
                      subBuyerWallets:
                        - buyerCode: sub_buyer_test1
                          status: VALID
                          type: SEPARATE
                          creditBalance: 0
                          cashBalance: 5630
                          availableBalance: 5630
                          withdrawableBalance: 5630
                        - buyerCode: sub_buyer_test1
                          status: Valid
                          type: SHARED
                '2':
                  summary: Sub Buyer Response(SHARED Type)
                  value:
                    errorCode: '0'
                    errorMsg: success
                    data:
                      mainWallet:
                        - buyerCode: BUYER_MAIN_001
                          currency: CNY
                          accountStatus: VALID
                          availableBalance: 9999743325.65
                          withdrawableBalance: 9999743325.65
                          cashBalance: 9999743325.65
                          creditBalance: 0
                          temporaryCreditBalance: 0
                          depositBalance: 0
                      subBuyerWallets:
                        - buyerCode: sub_buyer_test1
                          status: Valid
                          type: SHARED
                '3':
                  summary: Sub Buyer Response(SEPARATE Type)
                  value:
                    errorCode: '0'
                    errorMsg: success
                    data:
                      subBuyerWallets:
                        - buyerCode: sub_buyer_test1
                          status: VALID
                          type: SEPARATE
                          creditBalance: 0
                          cashBalance: 5630
                          availableBalance: 5630
                          withdrawableBalance: 5630
                '4':
                  summary: Error
                  value:
                    errorCode: B207
                    errorMsg: PKFARE wallet not activated
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
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Air ticket booking APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3470854-run
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