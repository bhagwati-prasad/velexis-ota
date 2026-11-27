# DownloadAttachmentFile API

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/downloadAttachmentFile:
    post:
      summary: DownloadAttachmentFile API
      deprecated: false
      description: >+
        ## Function

        DownloadAttachmentFile Api allows you to download files that were
        uploaded using the UploadAttachmentFile Api and also download the
        Voucher or EMD from airlines. You only need to provide the corresponding
        file ID.


        ## Error Code List


        | error code | error message | description |

        | --- | --- | --- |

        | 0 | ok | success |

        | S001 | System error | System error |

        | P001 | Invalid authentication | Invalid authentication |

        | P006 | Wrong parameter | Wrong parameter |

        | B002 | Partner is not exists | Partner does not exist |

        | B003 | Illegal sign | Illegal signature |

      tags:
        - API Reference/Refund APIs
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
                    sign:
                      type: string
                      description: >-
                        Signature, You can refer to the instructions about
                        signatures in the API documentation.
                    partnerId:
                      type: string
                      description: Partner ID, You can obtain it from your account manager.
                  required:
                    - sign
                    - partnerId
                  x-apifox-orders:
                    - partnerId
                    - sign
                  description: Identity information
                data:
                  type: object
                  properties:
                    fileId:
                      type: string
                      description: File ID. Returned by UploadAttachmentFile API.
                  required:
                    - fileId
                  x-apifox-orders:
                    - fileId
              required:
                - authentication
                - data
              x-apifox-orders:
                - authentication
                - data
            example:
              authentication:
                partnerId: ''
                sign: ''
              data:
                fileId: ''
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
                    description: >-
                      Error code, see the error cod list in the documentation
                      for details.
                  errorMsg:
                    type: string
                    description: Error message.
                required:
                  - errorCode
                  - errorMsg
                x-apifox-orders:
                  - errorCode
                  - errorMsg
              examples:
                '1':
                  summary: B002
                  value:
                    errorCode: B002
                    errorMsg: Partner does not exist.
                '2':
                  summary: B003
                  value:
                    errorCode: B003
                    errorMsg: Illegal sign.
          headers: {}
          x-apifox-name: Error
        '201':
          description: ''
          content:
            '*/*':
              schema:
                type: object
                properties: {}
          headers: {}
          x-apifox-name: Success
      security: []
      x-apifox-folder: API Reference/Refund APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469922-run
components:
  schemas: {}
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```