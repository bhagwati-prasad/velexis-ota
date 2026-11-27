# DownloadAttachmentFile

## 1 Description

### 1.1 Function 

DownloadAttachmentFile Api allows you to download files that were uploaded using the UploadAttachmentFile Api and also download the Voucher or EMD from airlines. You only need to provide the corresponding file ID.

> `Note` This interface provides Postman collections, and you can contact your account manager to obtain the corresponding collections.

### 1.2 Target Reader

The DownloadAttachmentFile Api documentation is intended for website developers, maintainers, and managers who have a certain level of website development skills, are familiar with one of the mainstream programming languages such as Java, Python, ASP.NET, PHP, Node.js, and have a basic understanding of the HTTP network protocol.

### 1.3 Character encoding

The character encoding for this Api is unified as UTF-8.

### 1.4 URLs
|Environment|URL|
|:----|:----|
|Test Environment|http://api.pkfare.com/downloadAttachmentFile|
|Prod Environment|http://{{apiHost}}/downloadAttachmentFile|

> `Notes` The production environment URL will be provided after you have completed the Api development and testing, and before the official launch. You can replace the "{{apiHost}}" in the production environment URL with the provided domain name.

### 1.5 Http Method

POST

### 1.6 Request Header

|key|value|
|:----|:----|
|Content-Type|application/x-www-form-urlencoded|

### 1.7 Response Header

|key|value|
|:----|:----|
|Content-Type|image/jpeg <br> application/pdf <br> application/octet-stream|
|Content-Disposition|form-data;name="attachment";filename="Pkfare.jpg"|

## 2 Request

### 2.1 Schema

|name|description|type|
|:----|:----|:----|
|param|The value after Base64 encoding the ***Basic Request***. The Basic Request is a JSON-structured data, and the detailed explanation is provided in the following text.|Text|

#### 2.1.1 Basic Request

Sample

```json
{
    "authentication": {
        "partnerId": "sVSX4=",
        "sign": "e707d"
    },
    "data": {
        "fileId": "31d6ff3fe24d73a8e1555729c11745eb"
    }
}
```
|name|type|required|description|
|:----|:----|:----|:----|
|authentication|Object|yes|Identity information, refer to 2.1.2.|
|data|Object|yes|File information, refer to 2.1.3|

#### 2.1.2 Authentication

|name|type|required|description|
|:----|:----|:----|:----|
|partnerId|String|yes|partner ID|
|sign|String|yes|Signature, refer to sections 4.1 and 4.2 for the signature method.|

#### 2.1.3 Data

|name|type|required|description|
|:----|:----|:----|:----|
|fileId|String|yes|File ID. Returned by UploadAttachmentFile Api.|

### 2.2  Example of Request Construction Process

#### 2.2.1 Construct  Basic Request in JSON

```json
{
    "authentication": {
        "partnerId": "RksVSX7PfZmWYsCD7M4=",
        "sign": "17e707b5d9dae8459065dbb139e5f1bd"
    },
    "data": {
        "fileId": "31d6ff3fe24d73a8e1555729c11745eb"
    }
}
```
#### 2.2.2 Base64 transcode the Basic Request

```json
ewogICAgImF1dGhlbnRpY2F0aW9uIjogewogICAgICAgICJwYXJ0bmVySWQiOiAiUmtzVlNYN1BmWm1XWXNDRDdNND0iLAogICAgICAgICJzaWduIjogIjE3ZTcwN2I1ZDlkYWU4NDU5MDY1ZGJiMTM5ZTVmMWJkIgogICAgfSwKICAgICJkYXRhIjogewogICAgICAgICJmaWxlSWQiOiAiMzFkNmZmM2ZlMjRkNzNhOGUxNTU1NzI5YzExNzQ1ZWIiCiAgICB9Cn0=
```
#### 2.2.3 Request interface to retrieve files for download

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338116/image-preview)

## 3 Response
The file data is returned in binary stream format.

Here is an example of the Response Header for a jpg image:

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338117/image-preview)

Here is an example of the Response Header for a pdf file:


![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338118/image-preview)

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
Sign = MD5(abcdefg123456jkHKhkikdhy258dffj) = d7e99ae9d5c3c7d7113aced071e3ca08
```
## 5 Appendix
### 5.1 Error Code List

|error code	|error message	|description
|----|---|---|
|0	|ok	|success
|S001	|System error	|System error
|P001	|Invalid authentication	|Invalid authentication
|P006	|Wrong parameter	|Wrong parameter
|B002	|Partner is not exists	|Partner does not exist
|B003	|Illegal sign	|Illegal signature