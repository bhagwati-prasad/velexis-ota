# Tricks for Playing with PKFARE API

## 1. How to use booking code wisely

:::tip
1)First of all, When you try to call precisePricing for a certain flight, it may be sold out and we respond you another booking code with new fare. If you can adapt to that, it will guarantee better pricing success rate and customers' experience.

2)Please remember to take booking code from shopping response to call precisePricing. It will minimize the price change and make sure you get the same booking code

3)For PrecisePricing V5 and earlier versions, if you get pricing errors from us but still want to get a fare of this solution, you may call precisePricing without `bookingcode`. For PrecisePricing V6 and latter versions,please retry by filling in the `Solutionid` parameter with **'direct pricing'*** string to trigger the direct pricing mechanism.
By doing so, We will try to search and get an available booking code and seat for you. But normally the price will change. Use it only after errors occur.
:::


## 2. How to improve Shopping responding time

:::tip
1)Build a cache from your side. But it may lose the price's freshness. You need to balance the cache time and price freshness.

2)We had TTL for Shopping response. You can set it shorter as you want, but it may lose price competitiveness because we may have more competitive price comming later than TTL.
:::


## 3. How to manage price change

:::caution

1)Always call Pricing with a booking code that you get from shopping response.

2)You can call precisePricing again before booking call. You can check the price again when customers are on the booking page.

3)When price change occurs, please let customers choose whether they need to continue or not.

This is how PKFARE define price change:

![image.png](https://apifox.pkfare.com/api/v1/projects/345083/resources/338213/image-preview)
:::



## 4. How to use orderDetail APIs wisely

:::tip
1)Please review the order status explanation carefully.

2)You set a fixed frequency to call orderDetail API to check order status and details, like every 5 minutes.
:::


## 5. How to avoid duplicate booking
:::caution
1)When the customer has already created an order through preciseBooking call, this customer has PNR and booking record from our side. When he try to rebook the same flight again even with additional passengers, we will respond you error B029. The most-effective solution that you recognize and block this kind of request from your front end since duplicate booking is not allowed based on airlines' rule. It will cause EMD.


2)Another solution is that we can configure and send your the previous order number when duplicate booking occur. But in this case, you have to notify your customers of this. If they choose to continue booking current one, please call CancelOrder to cancel the order first and then create a new order.
:::

## 6. How to avoid retriving PNR failure

:::note

1)When you call orderPricing, you may encounter these errors: B103, B107, and B109. The reason is that the time between booking call and orderPricing is too short and the GDS need time to generate PNR. There are two solutions: 1) set a retry mechanism; 2) call orderPricing two minutes after booking call.
:::

## 7. How to optimize buyer’s cache and reduce pricing verification failures

:::note

1)Update buyer’s cache to reflect real-time changes
When using the PK Shopping API, ensure that the buyer’s cache is updated upon a successful response. This helps maintain up-to-date pricing and availability data. If the PrecisePricing API identifies price changes or RBD (Reservation Booking Designator) updates, refresh the buyer’s cache to prevent outdated offers from being reused.

2)Handle pricing failures with Direct Pricing fallback:
If the PrecisePricing API fails, trigger Direct Pricing to revalidate the offer using updated logic.
•For PrecisePricing V5 and older, set the bookingcode value to empty.
•For PrecisePricing V6 and newer, use “direct pricing” as the value of solutionid.
If Direct Pricing succeeds, proceed to booking. If it fails, avoid reprocessing the failed request and log the error for reference.

3)Avoid reusing failed or outdated requests:
Continuously update the buyer’s cache at every stage (e.g., after successful pricing with changes, or when failures occur). This ensures future pricing and booking requests rely on the most accurate data, minimizing repetitive errors and improving user experience.

By implementing these practices, the system can effectively reduce pricing verification failures, provide accurate pricing information, and improve the overall booking experience for customers.


![buyer cache update rules.jpg](https://apifox.pkfare.com/api/v1/projects/345083/resources/338210/image-preview)
:::