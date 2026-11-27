# Signature

All interface requests require a `sign` field to verify the identity of the requester. The signature needs to use the `partnerId` and `partnerKey` fields, and the method of signing is to calculate the MD5 value of the combination of these two fields. You can obtain the `partnerId` and `partnerKey` from your account manager.

For example, below is a code sample for generating the `sign` field in real-time within the Pre-request Script of Postman, using JavaScript:

```js
const partnerId = pm.environment.get("partnerId");
const partnerKey = pm.environment.get("partnerKey");
const sign = CryptoJS.MD5(partnerId + partnerKey).toString();
```