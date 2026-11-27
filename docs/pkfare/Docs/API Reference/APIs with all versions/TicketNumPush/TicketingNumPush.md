# TicketingNumPush

### 1 Document Description
#### 1.1 Function Description
**Buyer partners should provide a ticketing number reception service based on HTTP/HTTPS protocol to PKFARE for pushing back ticket numbers.
PKFARE will push back the ticketing numbers when the tickets are issued.**

#### 1.2 Target Reader
The TicketingNumPush API document targets developers who work in the fields of network development, maintenance as well as management, and they should have the knowledge of at least one of the following programming languages: ASP, PHP, JAVA, ASP.NET or SQL.

#### 1.3 Character Encoding
The character code of this API is `UTF-8`.

#### 1.4 Invoking Address
This address is provided by the customer.
</br>
### 2 Request Parameter
This request is sent by PKFARE API. Requesting method would be POST.
#### 2.1 Parameter Construction
##### 2.1.1 Basic Parameter
| Name          | Type   | Parameter Description                                       | Sample                           |
| ------------- | ------ | ----------------------------------------------------------- | -------------------------------- |
| orderNum      | String | [PKFARE] Order number                                       | 1012674912                       |
| airPnr        | String | airline PNR                                                 | CA/JFDKHF                        |
| paymentGate   | String | payment gate                                                | ALIPAY                           |
| serialNum     | String | payment serial number                                       | 2013012200021000200172105074     |
| merchantOrder | String | merchant order number                                       | ALIPAY_20161101105225_1028814703 |
| ticketNums    | Array  | passengers and corresponding ticket numbers，refer to 2.1.2 | -                                |

##### 2.1.2 TicketNums
| Name      | Type   | Parameter Description                                        | Sample        |
| --------- | ------ | ------------------------------------------------------------ | ------------- |
| ticketNum | String | ticket number, multiple number will be separated by '/', like9991234567890/9991234567891 | 1122334455667 |
| psgName   | String | passenger name                                               | Wang/Jango    |

#### 2.2 Request Sample
```
{
	"orderNum": "1010792124",
	"airPnr": "CA/JFDKHF",
	"paymentGate": "ALIPAY",
	"serialNum": "2013012200021000200172105074",
	"merchantOrder": "ALIPAY_20161101105225_1028814703",
	"ticketNums": [{
		"psgName": "HAN/MEIMEI",
		"ticketNum": "1122334455665"
	},
	{
		"psgName": "LI/LEI",
		"ticketNum": "1122334455668"
	}]
}
```
</br>
### 3 Response Parameter
This response is returned by the buyer partners. Please respond as the format we provided below. Otherwise system is not able to recognize the response. If the response is not with 'errorCode' 0, system would try to push the ticket numbers to partners' URL again for 4 times.

#### 3.1 Response Parameter Construction
| Name      | Type   | Parameter Description | Sample |
| --------- | ------ | --------------------- | ------ |
| errorCode | String | Error code            | 0      |
| errorMsg  | String | Error message         | ok     |

#### 3.2 Response Sample
##### 3.2.1 Normal Response
```
{"errorCode":0,"errorMsg":"ok"}
```

##### 3.2.2 Error Response
```
{"errorCode":1,"errorMsg":"Failure reason"}
```
</br>
<a href="javascript:window.scrollTo(0, 0)">Top</a>
</br>