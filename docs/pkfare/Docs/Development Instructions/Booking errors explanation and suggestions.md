# Booking errors explanation and suggestions 

# Booking errors explanation and suggestions

There are numerous error codes returned when calling our PreciseBooking API, some of them indcating the defected or wrongful api calling behaviors. This is the guidance summarizing the typical booking errors casued by the illegitimate api calling logic, ranging from using unsupported values when composing requesting schema to make flawed API calling process. In addition, practical solutions will be provided to cope with these scenarios and optimize the API calling successful rate.
- - - 

:::danger
## Error code - B005: Can not find any matching precisePricing/AncillaryPricing result within 30 minutes. 
:::


### This error code will occur under these circumstances:
1. The timegap among PrecisePricing, AncillaryPricing and PrceseBooking calls exceeds 30 mintues.

2. The paramters of PreciseBooking requests are not exactly the same with PrecisePricing requests or responses. For instances, the booking code is not consistent betwen PrecisePricing and PreciseBooking; requested for one adult and one child fare but placed orders for two adults. 

3. Make simultaneous calls of PrecisePricing and PreciseBooking. Normally, you should wait until you get the response from previous API before calling the next one. If you invoke them concurrently, this error will derive.

4. Make booking calls even after had received seat unavailabilty error in PrecisePricing responses. 

:::tip
### Suggestions:
1. Make sure that PrecisePricing, AncillaryPricing and PreciseBooking API be invoked within 30 minutes. 

2. Make sure that the parameters formed across PrecisePricing, AncillaryPricing and PreciseBooking are intact and consistent.

3. Avoid invoking two or more APIs concurrently. Wait until the respones of previous API call to be displayed before making any subsequent moves. 

4. Avoid making booking calls when receiving errors in PrecisePricing and choose other available options by going through Shopping-Pricing-Booking process again. 
:::

- - - 


:::danger
## Error code - P008: Invalid First/Last Name of the Passenger
:::


### This error code will occur under these circumstances:
1. Use obvious fake name inputs such as 'TEST', 'AAA'and others. 

2. Include non-English character such as hyphen and other special letters.

:::tip
### Suggestions:
1. Avoid using 'TEST' or other obviously fake name elements. 

2. Include only English letters and space for the passenger names. For those passengers who do have hyphen in their names, please adhere to the rules and airlines before making the requests.
:::

- - - 

:::danger
## Error code - B004: There are errors in the passenger type 
:::

### This error code will occur under these circumstances:

- passengers aged at 9 but were grouped as adults when forming 'PassengerType' parameter 
- passengers aged at 18 but were grouped as child when forming 'PassengerType' parameter 

:::tip
### Suggestions:
Make sure that each booking passenger be assigned to correct value for 'PassengerType' 
:::

- - - 

:::danger
## Error code - B029: Duplicate reservations have been found for passenger XXX/XXX in order XXX, in pnr XXX.
:::

### This error code will occur under these circumstances:

- A passenger placed an order in your system but without payment, later on he went for other priorities and came back again for the new search of the same flight as which in the previous generated order. The passenger placed a new order with the flight details  in your system.  

:::tip
### Suggestions:
1. Invoke 'Cancel Order' API to cancel any unpaid orders before placing a new orders 
2. Set restriction on your end to limit this type of requests made to your system.  
:::

- - - 


:::danger
## Error code - B065: Passenger's document information must be filled in for this trip. Passenger's document information contains cardType, cardNum, cardExpiredDate and nationality.
:::

### This error code will occur under these circumstances:

1. Make booking requests partially with or totally without ID information. 
2. Make booking requests without 'Nationality' details even the exemption is given for the particular booking that ID information is not mandatory.

:::tip
### Suggestions:
1. Invoke 'Cancel Order' API to cancel any unpaid orders before placing a new orders 
2. Set restriction on your end to limit this type of requests made to your system.  
:::