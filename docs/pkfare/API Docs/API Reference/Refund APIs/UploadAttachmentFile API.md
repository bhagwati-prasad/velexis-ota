# UploadAttachmentFile API

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /json/uploadAttachmentFile:
    post:
      summary: UploadAttachmentFile API
      deprecated: false
      description: >-
        ## Function

        Some Api requests require you to provide attachment files, such as
        RefundPricing. You can upload files using the UploadAttachmentFile Api.
        After successful file upload, the Api returns the corresponding file ID,
        which corresponds to a unique file. When any other interfaces need to
        use this file, you only need to provide the corresponding file ID.



        :::highlight blue 💡

        To prevent abuse of the Api, the size of a single file should be less
        than 5MB, and you can upload up to 5000 files per day.

        :::


        ## Error Code List


        | error code | error message | description |

        | --- | --- | --- |

        | 0 | ok | success |

        | S001 | System error | System error |

        | P001 | Invalid authentication | Invalid authentication |

        | P006 | Wrong parameter | Wrong parameter |

        | B002 | Partner is not exists | Partner does not exist |

        | B003 | Illegal sign | Illegal signature |

        | B139 | File is oversize. It should be less than 5MB. | The file
        exceeds the size limit. |

        | B151 | Upload files allowance is less than 5000 files per day. |
        Exceeded the daily limit of upload times |


        ## Special Notes on Interface Requests


        Unlike other interfaces, the HTTP request body for the file upload
        interface must be in `multipart/form-data` format. The request body
        contains two fields: `param` and `file`.The `param` field is used to
        pass additional parameters and is of type string in the form.The `file`
        field is used to pass the file itself and is of type file in the form.


        The Content-Type for the param field alone is `application/json`,
        meaning the param field itself is a JSON structure string. The structure
        of the param field itself is as follows:


        ```json

        {
            "authentication": {
                "partnerId": "",
                "sign": ""
            }
        }

        ```

        As can be seen, the parameters in this field are similar to those in
        other interfaces, mainly used to transmit information related to
        interface authorization. For a detailed explanation of the
        `authentication` part, please refer to other interfaces.


        This is a postman reqeust example:


        ![request.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338113/image-preview)
      tags:
        - API Reference/Refund APIs
      parameters: []
      requestBody:
        content:
          multipart/form-data:
            encoding:
              param:
                contentType: application/json
            schema:
              type: object
              properties:
                param:
                  example: >-
                    {"authentication":{"partnerId":"{{partnerId}}","sign":"{{sign}}"}}
                  type: string
                file:
                  example: ''
                  type: string
                  format: binary
              required:
                - param
                - file
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
                  data:
                    type: object
                    properties:
                      fileId:
                        type: string
                        description: >-
                          File ID. A file ID corresponds to a unique file. When
                          any other interface needs to use this file, you only
                          need to provide the corresponding file ID. The length
                          of the file ID is within 128.
                      fileName:
                        type: string
                        description: File name.
                    required:
                      - fileId
                      - fileName
                    x-apifox-orders:
                      - fileId
                      - fileName
                    description: >-
                      The returned data, this parameter is not empty only when
                      the error code returns "0"
                required:
                  - errorCode
                  - errorMsg
                  - data
                x-apifox-orders:
                  - errorCode
                  - errorMsg
                  - data
              example:
                errorCode: '0'
                errorMsg: ok
                data:
                  fileId: 1ee71d50b4d59ef3e1555729c11745eb
                  fileName: Pkfarer.jpg
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
                '2':
                  summary: B002
                  value:
                    errorCode: B002
                    errorMsg: Partner does not exist.
                '3':
                  summary: B139
                  value:
                    errorCode: B139
                    errorMsg: File is oversize. It should be less than 5MB.
          headers: {}
          x-apifox-name: Error
      security: []
      x-apifox-folder: API Reference/Refund APIs
      x-apifox-status: released
      x-run-in-apifox: https://apifox.pkfare.com/web/project/345083/apis/api-3469923-run
components:
  schemas: {}
  securitySchemes: {}
servers:
  - url: https://api.pkfare.com
    description: Sandbox Env
security: []

```