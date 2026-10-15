/**
 * The single redaction list of every Velexis process (ADR-0016, conventions §7).
 *
 * A new sensitive field = a new path here plus a test in `redaction.test.ts`, in the same pull request.
 *
 * pino paths are not recursive: `password` matches only the top level and `*.password` only the second
 * level. The whole `card`, `creditCard` and `formOfPayments` objects are therefore spelt out at the top
 * level and at every nesting depth down to depth 8, because Amadeus-shaped bodies nest deeply
 * (`err.cause.body.data.formOfPayments[0].creditCard`): an Amadeus Flight Create Orders body logged as
 * the value of a key at depth 1 to 6 has its `formOfPayments` at depth 3 to 8. On top of this list, the
 * `err` serializer of `createLogger` drops request and response bodies along the whole `cause` chain.
 *
 * Keep the list ordered from shallow to deep: pino applies the paths in this order, and censoring a whole
 * object first keeps the deeper wildcard paths from walking into it. pino's redactor copies only the
 * branches it expects to change and shares the rest with the logged object, so a deeper path that reached
 * a shared branch would write the censor into the caller's own object.
 *
 * Known upstream limit (pino 9.14 with @pinojs/redact 0.4.0): below a key that also starts a literal path
 * (`documents` at depth 1 or 2, and `req.headers` / `res.headers` when the `req` and `res` serializers are
 * replaced), the redactor copies only along that literal path. A `card`, `creditCard` or `formOfPayments`
 * object nested inside such a branch is still kept out of the line, but the censor is also written into
 * the caller's object. Realistic shapes (identity documents, header strings) never nest card objects
 * there, and the tests check that every realistic logged object stays unchanged.
 *
 * Every path costs time on every line (about 0.1 ms per line for this list): log events, not loops.
 */

/** The value that replaces every redacted field in a log line. */
export const REDACT_CENSOR = "[REDACTED]";

/** Every path pino censors, in the syntax of pino's `redact.paths`. */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  // Depth 1: secrets, tokens and card fields at the top level of a log line.
  "password",
  "newPassword",
  "currentPassword",
  "mfaCode",
  "accessToken",
  "refreshToken",
  "portalToken",
  "bookingToken",
  "token",
  "clientSecret",
  "secret",
  "apiKey",
  "securityCode",
  "cvc",
  "cardNumber",
  "certificateNumber",
  "card",
  "creditCard",
  "formOfPayments",

  // Depth 2: the same keys one level down.
  "*.password",
  "*.newPassword",
  "*.currentPassword",
  "*.mfaCode",
  "*.accessToken",
  "*.refreshToken",
  "*.portalToken",
  "*.bookingToken",
  "*.token",
  "*.clientSecret",
  "*.secret",
  "*.apiKey",
  "*.securityCode",
  "*.cvc",
  "*.cardNumber",
  "*.certificateNumber",
  "*.card",
  "*.creditCard",
  "*.formOfPayments",

  // Depth 3: credential headers (also the first-party edge header and the platform's BFF key of PADR-0019), card
  // numbers, card objects.
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'req.headers["x-booking-token"]',
  'req.headers["x-velexis-edge"]',
  'req.headers["x-velexis-bff-key"]',
  "*.card.number",
  "*.creditCard.number",
  "documents[*].number",
  "*.*.card",
  "*.*.creditCard",
  "*.*.formOfPayments",

  // Depth 4: identity document numbers, card objects.
  "*.documents[*].number",
  "*.*.*.card",
  "*.*.*.creditCard",
  "*.*.*.formOfPayments",

  // Depths 5 to 8: card objects.
  "*.*.*.*.card",
  "*.*.*.*.creditCard",
  "*.*.*.*.formOfPayments",
  "*.*.*.*.*.card",
  "*.*.*.*.*.creditCard",
  "*.*.*.*.*.formOfPayments",
  "*.*.*.*.*.*.card",
  "*.*.*.*.*.*.creditCard",
  "*.*.*.*.*.*.formOfPayments",
  "*.*.*.*.*.*.*.card",
  "*.*.*.*.*.*.*.creditCard",
  "*.*.*.*.*.*.*.formOfPayments",
]);
