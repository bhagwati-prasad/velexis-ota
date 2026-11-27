# UploadAttachmentFile

## 1 Description

### 1.1 Function 

Some Api requests require you to provide attachment files, such as RefundPricing. You can upload files using the UploadAttachmentFile Api. After successful file upload, the Api returns the corresponding file ID, which corresponds to a unique file. When any other interfaces need to use this file, you only need to provide the corresponding file ID.

> `Note` To prevent abuse of the Api, the size of a single file should be less than 5MB, and you can upload up to 5000 files per day.
> `Note` This Api provides Postman collections, and you can contact your account manager to obtain the corresponding collections.
### 1.2 Target Reader

The UploadAttachmentFile Api documentation is intended for website developers, maintainers, and managers who have a certain level of website development skills, are familiar with one of the mainstream programming languages such as Java, Python, ASP.NET, PHP, Node.js, and have a basic understanding of the HTTP network protocol.

### 1.3 Character encoding

The character encoding for this Api is unified as UTF-8.

### 1.4 URLs
|Environment|URL
|:----|:----|
|Test Environment|http://api.pkfare.com/uploadAttachmentFile|
|Prod environment|http://{{apiHost}}/uploadAttachmentFile|

> `Notes`The production environment URL will be provided after you have completed the Api development and testing, and before the official launch. You can replace the "{{apiHost}}" in the production environment URL with the provided domain name.
### 1.5 Http Method

POST 

### 1.6 Request Header

|key|value|
|:----|:----|
|Content-Type|multipart/form-data|

### 1.7 Response Header

|key|value|
|:----|:----|
|Content-Type|application/json|

## 2 Request

### 2.1 Schema

|name|description|type|
|:----|:----|:----|
|param|The value after Base64 encoding the ***Basic Request***. The Basic Request is a JSON-structured data, and the detailed explanation is provided in the following text.|Text|
|file|The file to be uploaded. Supported file types: docx, pdf, gif, png, jpeg, zip, rar. The file size should be less than 5MB.|File|

#### 2.1.1 Basic Request

Sample

```json
{
    "authentication": {
        "partnerId": "sVSX7PfsCD7M4=",
        "sign": "e707b5d9dae8459065d"
    }
}
```
|name|type|required|description|
|:----|:----|:----|:----|
|authentication|Object|yes|Identity information, refer to 2.1.2.|

#### 2.1.2 Authentication

|name|type|required|description|
|:----|:----|:----|:----|
|partnerId|String|yes|partnerID|
|sign|String|yes|Signature, refer to sections 4.1 and 4.2 for the signature method.|

### 2.2 Example of Request Construction Process

#### 2.2.1 Construct  Basic Request in JSON

```json
{
    "authentication": {
        "partnerId": "sVCD7M4=",
        "sign": "e707b5d9da1bd"
    }
}
```
#### 2.2.2   Base64 transcode the Basic Request

```json
ogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiUmtzVlNYN1BmWm1XWXNDRDdNND0iLAogICAgICAgICJzaWduIjogIjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIgogICAgfQp9
```
#### 2.2.3 Attach the file to be uploaded and send the request


![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338115/image-preview)


## 3 Response

### 3.1 Sample
Data will be return in Json.

Response sample in the case of success：
```
{
    "errorCode": "0",
    "errorMsg": "ok",
    "data": {
        "fileId": "1ee71d50b4d59ef3e1555729c11745eb",
        "fileName": "Pkfarer.jpg"
    }
}
```
Response sample in the case of failure：
```
{
    "errorCode": "B139",
    "errorMsg": "File is oversize. It should be less than 5MB."
}
```

### 3.2 Schema
#### 3.2.1 Basic parameters
|name	|type	|description|	sample|
|:----|:----|:----|:----|
|errorCode|	String|	error code，refer to 5.1|	0|
|errorMsg|	String|	error message|	ok|
|data|	Object	|The returned data, this parameter is not empty only when the error code returns "0", refer to section 3.2.2.|	-|

#### 3.2.1 Data

|name	| type	|description	|sample|
|:----|:----|:----|:----|
|fileId	|String	|File ID. A file ID corresponds to a unique file. When any other interface needs to use this file, you only need to provide the corresponding file ID. The length of the file ID is within 128.	|1ee71d50b4d59ef3e1555729c11745eb|
|fileName	|String	|File name.	|Pkfarer.jpg|

## 4 Signature
### 4.1 The parameters involved in signature
partnerId，partnerKey

### 4.2 Signature
MD5 encrypt the combination of partnerId and partnerKey.

Sign = MD5(partnerId+partnerKey)。
```
Sample
partnerId: abcdefg123456
partnerKey: jkHKhkikdhy258dffj
Sign = MD5(abcdefg12ikdhy258dffj) = d7e99ae9d5cd071e3ca08
```

## 5 Appendix
### 5.1 Error Code List
|error code	|error message	|description
|:----|:----|:----|
|0	|ok	|success
|S001	|System error	|System error
|P001	|Invalid authentication	|Invalid authentication
|P006	|Wrong parameter	|Wrong parameter
|B002	|Partner is not exists	|Partner does not exist
|B003	|Illegal sign	|Illegal signature
|B139	|File is oversize. It should be less than 5MB.	|The file exceeds the size limit.
|B151	|Upload files allowance is less than 5000 files per day.	|Exceeded the daily limit of upload times