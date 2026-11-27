# Signature V2

# Signature V2 (HMAC-SHA256)

PKFARE is introducing a new way to authenticate API requests. Instead of the static `sign` field in the request body, every request carries a set of `X-PK-*` HTTP headers, and the `X-PK-Signature` header is an HMAC-SHA256 signature computed over the request path, query, body and a timestamp.

Compared with the legacy `sign = MD5(partnerId + partnerKey)`:

- The signature changes on every request, so a captured request cannot be reused after a few minutes.
- The body is part of the signature, so a request cannot be modified in transit.
- Keys can be rotated without downtime, because two keys can be valid at the same time.

The request and response bodies of all APIs stay the same. Only authentication changes.

:::tip
This applies to the requests you send to PKFARE. The notifications PKFARE pushes to your system (for example TicketIssuanceNotify, ScheduleChangeNotify, RefundResultNotify) are not affected.
:::

## 1. Authentication modes

Your account manager sets one of the following modes on your Partner ID:

| Mode                     | Legacy `sign`     | Signature V2      | When to use                                                                                    |
| ------------------------ | ----------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| Legacy Authentication    | Accepted          | Rejected (`S205`) | Default for existing buyers                                                                    |
| Migration Mode           | Accepted          | Accepted          | While you switch your system to Signature V2. Both methods work, so you can migrate API by API |
| Signature Authentication | Rejected (`B003`) | Accepted          | After your migration is complete                                                               |

Recommended migration path:

1. Ask your account manager to enable **Migration Mode** and issue a key.
2. Implement Signature V2 and test it in the Sandbox environment.
3. Switch all your production traffic to Signature V2.
4. Ask your account manager to switch you to **Signature Authentication**. From then on, requests with only the legacy `sign` are rejected.

A mode change takes effect within about 1 minute.

## 2. Get your credentials

When your account manager creates a key for you:

1. The account manager sends you a one-time delivery link through your agreed secure channel.
2. PKFARE sends a 6-digit verification code to the technical contact email you provided. The email shows when the code and the link expire, in UTC. The link is valid for 24 hours.
3. Open the link, enter the verification code, and copy the three values shown:

| Value       | Description                                                                 | Confidential |
| ----------- | --------------------------------------------------------------------------- | ------------ |
| `partnerId` | Your Partner ID. The same value as in the legacy `authentication.partnerId` | No           |
| `keyId`     | Identifies the key, for example `k_20261113_ab12cd34`                       | No           |
| `secret`    | A Base64 string. Decode it to bytes and use the bytes as the HMAC key       | **Yes**      |

:::caution
The `secret` is shown **only once**. PKFARE cannot display it again. Store it in a secret manager or an encrypted configuration, never in source code, logs, tickets or chat messages.

The link can be used only once. It stops working after 24 hours or after 5 wrong verification codes, and a code cannot be resent. In any of these cases, or if you lose the secret, contact your account manager to issue a new key.
:::

## 3. Request headers

Add all six headers to every request:

| Header              | Value                                  | Format                                              |
| ------------------- | -------------------------------------- | --------------------------------------------------- |
| `X-PK-Auth-Version` | `2`                                    | Fixed value                                         |
| `X-PK-Partner-Id`   | Your `partnerId`                       | As issued, including any `+`, `/`, `=` characters   |
| `X-PK-Key-Id`       | Your `keyId`                           | As issued                                           |
| `X-PK-Timestamp`    | Current Unix time in **seconds** (UTC) | 10 digits, for example `1794560400`                 |
| `X-PK-Request-Id`   | A new random value for every request   | 16-128 characters, only `A-Z`, `a-z`, `0-9` and `-` |
| `X-PK-Signature`    | The signature, see section 4           | Base64                                              |

The timestamp must be within ±300 seconds of PKFARE server time. Keep your servers synchronized with NTP.

`X-PK-Request-Id` helps PKFARE find your request in the logs. Please include it when you contact support. 

## 4. Build the signature

### 4.1 String to sign

Join these 8 lines with a line feed (`\n`). Do not add a line feed after the last line.

```text
PK2-HMAC-SHA256
{canonicalPath}
{canonicalQuery}
{partnerId}
{keyId}
{timestamp}
{requestId}
{payloadHash}
```

`partnerId`, `keyId`, `timestamp` and `requestId` must be exactly the values you send in the headers.

Then compute:

```text
signature = Base64( HMAC-SHA256( key = Base64Decode(secret), message = UTF-8(stringToSign) ) )
```

### 4.2 Field rules

| Field            | Rule                                                                                                                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonicalPath`  | The URL path, percent-decoded once (UTF-8). For example `/json/shoppingV10`. The path must not contain an encoded `/` (`%2F`) or `\` (`%5C`), a double-encoded character, or `.` / `..` segments                                                                                                            |
| `canonicalQuery` | Empty string when the URL has no query. Otherwise: split the query on `&`, split each part on the first `=`, percent-decode the key and the value, then encode them again with RFC 3986 (see below). Sort by key, then by value, comparing character codes (not locale order). Join as `key=value` with `&` |
| `payloadHash`    | Lower-case hex SHA-256 of the exact body bytes you send. For an empty body this is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. For `multipart/form-data` file uploads use the fixed text `UNSIGNED-PAYLOAD`                                                                         |

RFC 3986 encoding: keep `A-Z a-z 0-9 - . _ ~` as they are, encode every other byte of the UTF-8 value as `%XX` with **upper-case** hex. A space becomes `%20` (not `+`). In a query, `+` is a literal plus sign and is encoded as `%2B`.

Canonical query examples:

| Query in the URL           | `canonicalQuery`                        |
| -------------------------- | --------------------------------------- |
| (none)                     | (empty string)                          |
| `currency=CNY&language=en` | `currency=CNY&language=en`              |
| `b=2&a=1`                  | `a=1&b=2`                               |
| `b=2&B=1`                  | `B=1&b=2` (upper case sorts first)      |
| `name=hello%20world`       | `name=hello%20world`                    |
| `name=hello world`         | `name=hello%20world`                    |
| `c=x+y`                    | `c=x%2By`                               |
| `a=Z&a=hello`              | `a=Z&a=hello` (same key: sort by value) |

:::tip
Most PKFARE APIs have no query string. The simplest approach is to send the canonical query itself as the URL query, so both sides are identical.
:::

:::caution
Sign the body **after** it is serialized, and send exactly those bytes. Do not let your HTTP client re-serialize, pretty-print, compress (`Content-Encoding: gzip`) or change the character encoding of the body after you sign it. The maximum body size is 10 MiB.
:::

### 4.3 Test vector

Use these values to check your implementation. The secret is a sample, not a real key.

```text
secret     : c2FtcGxlLXNlY3JldC1mb3ItZG9jcy1vbmx5LTAwMDA=
partnerId  : TestPartner+Id/Demo0000000000=
keyId      : k_20261113_ab12cd34
timestamp  : 1794560400
requestId  : 1794560400000-a1b2c3d4e5f6
method/URL : POST https://{host}/json/shoppingV10
body       : {"search":{"adults":1,"children":0,"infants":0,"nonstop":0,"airline":"","solutions":0,"tag":"","returnTagPrice":"Y","searchAirLegs":[{"cabinClass":"","departureDate":"2026-12-28","origin":"HKG","destination":"BKK","airline":""}]}}
```

String to sign (the third line is empty because there is no query):

```text
PK2-HMAC-SHA256
/json/shoppingV10

TestPartner+Id/Demo0000000000=
k_20261113_ab12cd34
1794560400
1794560400000-a1b2c3d4e5f6
e3e7a58d0803494e1d7cd8963f3c0e0142d5c760f9afe771d80ef44aee6566bf
```

Expected signature:

```text
Z9EwIUu0dLRhEVwZrXBLdwUpPIo9JXdQys5uYf/PO/E=
```

## 5. Test with Apifox

### 5.1 Environment variables

In your Apifox environment, add:

| Variable    | Value                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `partnerId` | Your Partner ID                                                                                                 |
| `keyId`     | Your Key ID                                                                                                     |
| `secret`    | Your secret. Put it in the **local value** only (not the shared/remote value), so it is not synced to your team |

Set the environment base URL to the scheme and host only, for example `https://api.pkfare.com`, without a path.

### 5.2 Pre-request script

Add the script below as a pre-request script. To sign every request at once, add it to the folder (or project) that contains the PKFARE APIs instead of to each request.

```js
// PKFARE Signature V2 (PK2-HMAC-SHA256) - Apifox pre-request script
// Required variables: partnerId, keyId, secret
const CryptoJS = require('crypto-js');

const partnerId = pm.variables.get('partnerId');
const keyId = pm.variables.get('keyId');
const secret = pm.variables.get('secret');
if (!partnerId || !keyId || !secret) {
  throw new Error('PKFARE signature: set partnerId, keyId and secret in the environment');
}

// RFC 3986: only A-Z a-z 0-9 - . _ ~ stay unencoded; hex digits are upper case.
const rfc3986 = value => encodeURIComponent(value)
  .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const canonicalQuery = rawQuery => {
  if (!rawQuery) return '';
  return rawQuery.split('&').map(part => {
    const i = part.indexOf('=');
    const key = i < 0 ? part : part.slice(0, i);
    const value = i < 0 ? '' : part.slice(i + 1);
    // '+' is a literal plus sign, not a space
    return [rfc3986(decodeURIComponent(key)), rfc3986(decodeURIComponent(value))];
  })
    .sort((a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]))
    .map(([k, v]) => k + '=' + v)
    .join('&');
};

const sha256Hex = text => CryptoJS.SHA256(CryptoJS.enc.Utf8.parse(text)).toString(CryptoJS.enc.Hex);

const url = pm.request.url;
const path = decodeURIComponent(pm.variables.replaceIn(url.getPath()));
const query = canonicalQuery(pm.variables.replaceIn(url.getQueryString() || ''));

const body = pm.request.body;
const mode = body && body.mode ? body.mode : 'none';
let payloadHash;
if (mode === 'none') {
  payloadHash = sha256Hex('');
} else if (mode === 'raw') {
  payloadHash = sha256Hex(pm.variables.replaceIn(body.raw || ''));
} else if (mode === 'formdata') {
  payloadHash = 'UNSIGNED-PAYLOAD'; // multipart/form-data file upload only
} else {
  throw new Error('PKFARE signature: use a raw body (JSON, or form text such as param=...), not "' + mode + '"');
}

const timestamp = String(Math.floor(Date.now() / 1000));
const requestId = Date.now() + '-' + Math.random().toString(36).slice(2).padEnd(12, '0').slice(0, 12);

const stringToSign = [
  'PK2-HMAC-SHA256', path, query, partnerId, keyId, timestamp, requestId, payloadHash
].join('\n');
const signature = CryptoJS.enc.Base64.stringify(
  CryptoJS.HmacSHA256(CryptoJS.enc.Utf8.parse(stringToSign), CryptoJS.enc.Base64.parse(secret))
);

pm.request.headers.upsert({ key: 'X-PK-Auth-Version', value: '2' });
pm.request.headers.upsert({ key: 'X-PK-Partner-Id', value: partnerId });
pm.request.headers.upsert({ key: 'X-PK-Key-Id', value: keyId });
pm.request.headers.upsert({ key: 'X-PK-Timestamp', value: timestamp });
pm.request.headers.upsert({ key: 'X-PK-Request-Id', value: requestId });
pm.request.headers.upsert({ key: 'X-PK-Signature', value: signature });
```

### 5.3 Send a request

1. Open an API, for example **Shopping V10** (`POST /json/shoppingV10`).
2. Choose **Body > raw > JSON** and paste the request body. You can remove the `authentication` object, it is not needed with Signature V2.
3. Send the request. The script adds the six `X-PK-*` headers. Do not type them by hand: the timestamp and signature must be new for every request.
4. Check the actual request in the Apifox console: the headers must be present, and the body must be the same text you signed.

:::note
If you see `S204` in Apifox, check that the body editor does not contain comments or trailing content that Apifox removes before sending, and that the environment base URL has no path.
:::

## 6. Code samples

The samples below build the canonical query from unencoded key/value pairs and return the query string to send, so the signed query and the sent query are identical.

### Java

```java
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class PkfareSigner {

  public static String rfc3986(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8)
        .replace("+", "%20").replace("*", "%2A").replace("%7E", "~");
  }

  /** pairs: unencoded key/value pairs. Returns the canonical query; send it as the URL query. */
  public static String canonicalQuery(List<Map.Entry<String, String>> pairs) {
    List<String[]> encoded = new ArrayList<>();
    for (Map.Entry<String, String> p : pairs) {
      encoded.add(new String[] {rfc3986(p.getKey()), rfc3986(p.getValue())});
    }
    encoded.sort(Comparator.<String[], String>comparing(e -> e[0]).thenComparing(e -> e[1]));
    StringJoiner joiner = new StringJoiner("&");
    for (String[] e : encoded) {
      joiner.add(e[0] + "=" + e[1]);
    }
    return joiner.toString();
  }

  public static String sha256Hex(byte[] data) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
    StringBuilder hex = new StringBuilder();
    for (byte b : digest) {
      hex.append(String.format("%02x", b));
    }
    return hex.toString();
  }

  /** path: decoded path such as /json/shoppingV10; body: the exact bytes you send. */
  public static Map<String, String> headers(String partnerId, String keyId, String secretBase64,
      String path, String canonicalQuery, byte[] body) throws Exception {
    String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
    String requestId = UUID.randomUUID().toString();
    String stringToSign = String.join("\n", "PK2-HMAC-SHA256", path, canonicalQuery,
        partnerId, keyId, timestamp, requestId, sha256Hex(body));
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(Base64.getDecoder().decode(secretBase64), "HmacSHA256"));
    String signature = Base64.getEncoder()
        .encodeToString(mac.doFinal(stringToSign.getBytes(StandardCharsets.UTF_8)));

    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("X-PK-Auth-Version", "2");
    headers.put("X-PK-Partner-Id", partnerId);
    headers.put("X-PK-Key-Id", keyId);
    headers.put("X-PK-Timestamp", timestamp);
    headers.put("X-PK-Request-Id", requestId);
    headers.put("X-PK-Signature", signature);
    return headers;
  }
}
```

### Python

```python
import base64, hashlib, hmac, time, uuid
from urllib.parse import quote

def rfc3986(value: str) -> str:
    return quote(value, safe="-._~")

def canonical_query(pairs) -> str:
    """pairs: list of unencoded (key, value). Returns the canonical query; send it as the URL query."""
    return "&".join(f"{k}={v}" for k, v in sorted((rfc3986(k), rfc3986(v)) for k, v in pairs))

def pk_headers(partner_id: str, key_id: str, secret_b64: str,
               path: str, query: str, body: bytes) -> dict:
    timestamp = str(int(time.time()))
    request_id = str(uuid.uuid4())
    string_to_sign = "\n".join([
        "PK2-HMAC-SHA256", path, query, partner_id, key_id, timestamp, request_id,
        hashlib.sha256(body).hexdigest(),
    ])
    signature = base64.b64encode(hmac.new(
        base64.b64decode(secret_b64), string_to_sign.encode("utf-8"), hashlib.sha256
    ).digest()).decode()
    return {
        "X-PK-Auth-Version": "2",
        "X-PK-Partner-Id": partner_id,
        "X-PK-Key-Id": key_id,
        "X-PK-Timestamp": timestamp,
        "X-PK-Request-Id": request_id,
        "X-PK-Signature": signature,
    }

# body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
# headers = pk_headers(PARTNER_ID, KEY_ID, SECRET, "/json/shoppingV10", "", body)
# requests.post(BASE_URL + "/json/shoppingV10", data=body,
#               headers={**headers, "Content-Type": "application/json"})
```

## 7. Body formats

| Body type                                                                          | `payloadHash`                                                                     | Notes                                                                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSON (`application/json`)                                                          | SHA-256 of the JSON bytes                                                         | Most APIs                                                                                                                                        |
| Form (`application/x-www-form-urlencoded`, for example `param=...` on legacy APIs) | SHA-256 of the encoded form text exactly as sent, for example `param=eyJhdXRo...` | Build the form text yourself and sign it. In Apifox use **raw** body with `Content-Type: application/x-www-form-urlencoded`, not the form editor |
| File upload (`multipart/form-data`), for example UploadAttachmentFile              | `UNSIGNED-PAYLOAD`                                                                | The path, query and headers are still signed                                                                                                     |
| Empty body                                                                         | SHA-256 of empty input (see section 4.2)                                          |                                                                                                                                                  |

## 8. The legacy `authentication` object

- With Signature V2 the `authentication` object in the body is optional. You can remove it.
- During migration you can keep it. If you keep it, `authentication.partnerId` must be the same as `X-PK-Partner-Id`, otherwise the request is rejected with `B003`. The legacy `sign` inside it is ignored when Signature V2 headers are present.
- In **Signature Authentication** mode, a request without Signature V2 headers is rejected with `B003`, even when the legacy `sign` is correct.

## 9. Key rotation

You can have up to two valid keys at the same time:

1. Your account manager issues a new key. You receive it through a new delivery link (section 2).
2. The old key keeps working for a retirement period agreed with your account manager (1 hour to 7 days). If you need more time, ask your account manager to extend it before it ends.
3. Deploy the new `keyId` and `secret` before the retirement period ends. After it, requests signed with the old key are rejected with `S203`.

If you believe your secret has leaked, contact your account manager immediately to revoke the key and issue a new one. A revocation takes effect within about 1 minute.

## 10. Error codes

Authentication errors are returned with an HTTP error status and a JSON body:

```json
{
  "errorCode": "S202",
  "errorMsg": "timestamp out of window",
  "serverTime": 1794560400
}
```

`serverTime` (PKFARE server time in Unix seconds) is only returned with `S202`.

| HTTP | errorCode | Meaning                                                                                      | What to check                                                                                                                                                       |
| ----:| --------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401  | `S201`    | Authentication header missing or invalid, invalid query encoding, or body larger than 10 MiB | All six headers are present; header formats in section 3; `X-PK-Auth-Version` is `2`                                                                                |
| 401  | `S202`    | Timestamp outside the allowed window                                                         | Use Unix **seconds**, not milliseconds; synchronize your clock; compare with `serverTime`                                                                           |
| 401  | `S203`    | Key not found, revoked or expired                                                            | `partnerId` and `keyId` belong together; you use the key for the correct environment (Sandbox / Production); the key has not been retired                           |
| 401  | `S204`    | Signature does not match                                                                     | See the checklist below                                                                                                                                             |
| 401  | `S205`    | Signature V2 is not enabled for your Partner ID                                              | Ask your account manager to enable Migration Mode                                                                                                                   |
| 403  | `S206`    | The key is not allowed to call this API                                                      | Contact your account manager                                                                                                                                        |
| 400  | `S207`    | Request path or query is not in canonical form                                               | The path contains `%2F`, `%5C`, a double-encoded character or `.` / `..` segments; or (when strict checking is enabled) the URL query is not sent in canonical form |
| 503  | `S001`    | Temporary system error                                                                       | Retry later. If it persists, contact support with the `X-PK-Request-Id`                                                                                             |
| 200  | `B003`    | Legacy `sign` not accepted, or `authentication.partnerId` differs from `X-PK-Partner-Id`     | Section 8                                                                                                                                                           |

`S204` checklist:

- The secret is Base64-decoded before it is used as the HMAC key.
- The string to sign has exactly 8 lines, separated by `\n` (not `\r\n`), with no line feed at the end. The query line is empty when there is no query.
- The headers you send carry the same `partnerId`, `keyId`, `timestamp` and `requestId` you signed.
- The body bytes you send are the bytes you hashed (no re-serialization, no compression, UTF-8).
- The path is decoded once, and the query is sorted and RFC 3986 encoded (space = `%20`, `+` = `%2B`, upper-case hex).
- Your implementation reproduces the test vector in section 4.3.

## 11. Go-live checklist

- [ ] Your implementation reproduces the test vector in section 4.3.
- [ ] A new timestamp, request ID and signature are generated for every request, including retries.
- [ ] The URL, query and body are not changed after signing.
- [ ] Server clocks are synchronized with NTP.
- [ ] The secret is stored securely and never logged. Do not log the `X-PK-Signature` header either.
- [ ] All APIs you call (shopping, pricing, booking, ticketing, order detail, ancillary, refund, change, void) pass in the Sandbox environment.
- [ ] Your production traffic uses Signature V2 before you ask for Signature Authentication mode.

When you contact support, provide the environment, the request time (UTC), the `X-PK-Request-Id`, the `keyId`, the full URL, the HTTP status and the `errorCode`. **Never send your secret.**
