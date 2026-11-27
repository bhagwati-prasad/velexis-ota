# Receive flight rescheduled notification

# Overview

:::highlight purple 💡
Mark had a return journey from HKG to DFW. One of flight get flight change. You have to notify him and check whether he accept the flight change.
:::

To fullfill this, you need to

1. Notify your customers
2. Accept the flight changes

---

## 1. Notify your customers

:::highlight purple 💡
Mark's flight, AA126, got flight changes.
:::


There are two ways to get the flight rescheduled information or flight:


1/ Use ScheduleChangeNotify API: We will push you the notification automatically when flight changes occur.

2/ Use GetScheduleChangeList API: You can input a period of past time to get all the orders that encounter flight change issue; If you acknowledge a certain flight change, you can use AcknowledgeScheduleChange to remove this flight change.


**ScheduleChangeNotify Example**
```plain
{
    "messageId": "1234567",
    "messageCreateTime": "2023-02-22 15:07:10",
    "orderAirlinePnr": "CX/WCK5N6|AA/HMMRAK",
    "orderNum": "916727111389870001",
    "buyerOrder":"10387629"
    "orderPnr": "HMMRRJ",
    "sensitivityLevel": "1",
    "changeFlightList": [
        {
            "journeySeq": "1",
            "segments": [            
                {
                    "airline": "AA",
                    "arrival": "DFW",
                    "arrivalDate": "2023-12-03",
                    "arrivalTime": "16:50",
                    "bookingCode": "C5",
                    "cabinClass": "FIRST",
                    "codeShare": "N",
                    "departure": "HKG",
                    "departureDate": "2023-11-24",
                    "departureTime": "14:20",
                    "equipment": "77W",
                    "flightNum": "126",
                    "stayTime": 0,
                    "stopover": ""
                }
            ]
        }
    ],
    "originFlightList": [
        {
            "journeySeq": "1",
            "segments": [
                {
                    "airline": "AA",
                    "arrival": "DFW",
                    "arrivalDate": "2023-12-02",
                    "arrivalTime": "16:50",
                    "bookingCode": "C5",
                    "cabinClass": "FIRST",
                    "codeShare": "N",
                    "departure": "HKG",
                    "departureDate": "2023-11-26",
                    "departureTime": "14:20",
                    "equipment": "77W",
                    "flightNum": "126",
                    "messageType": "2",
                    "stayTime": 0,
                    "stopover": "",
                    "messageType":2
                }
            ]
        }
    ],
    "passengers": [
        {
            "birthday": "2003-02-12",
            "cardExpiredDate": "2025-02-05",
            "cardNum": "89374924",
            "cardType": "PP",
            "firstName": "MARK",
            "lastName": "ZUO",
            "nationality": "US",
            "psgType": "ADT",
            "sex": "M",
            "ticketNum": "0063742676484"
        },
        {
            "birthday": "2003-04-01",
            "cardExpiredDate": "2025-03-25",
            "cardNum": "293874123",
            "cardType": "PP",
            "firstName": "DARRYL",
            "lastName": "COX",
            "nationality": "US",
            "psgType": "ADT",
            "sex": "F",
            "ticketNum": "0063742676484"
        }
    ]
}
```
**GetScheduleChangeList Example**
```plain
{
    "data": {
        "messageCreateTimeStart": "2023-02-22 15:00:00",
        "messageCreateTimeEnd": "2023-02-22 16:00:00",
        "orderNum": "916727111389870001",
        "messageId":"1234567",
        "messageType":"2",
        "sensitivityLevel":"2"
    },
    "authentication": {
        "partnerId": "RksVSX7Pk9fZmWYsCD7M4=",
        "sign": "17e707b5d9dae8459k065dbb139e5f1bd"
    }
}
```


## 2. Accept the flight changes


:::highlight purple 💡
Mark accepted the flight change.
:::

Please use AcceptScheduleChange API to accept the flight change if acceptance is needed. Otherwise, the seat may be cancelled by airlines.


**AcceptScheduleChange Request example**

```plain
{
    "data": {
        "messageId": "1234567",
        "email": "jaylee.li@pkfare.com",
        "passengers": [
            {
                "birthday": "2003-04-20",
                "firstName": "MARK",
                "lastName": "ZUO",
                "nationality": "US",
                "psgType": "ADT", 
                "sex": "M",
                "cardType":"P",
                "cardNum":"P76541234",
                "cardExpiredDate":"2025-05-10"
            }
        ]
    },
    "authentication": {
        "partnerId": "RksVSX7PfyZmWYsCD7M4=",
        "sign": "17e707b5d9dae8e459065dbb139e5f1bd"
    }
}
```




