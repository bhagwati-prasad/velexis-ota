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
 * (`documents`, `formOfIdentifications`, `mfa` and `oauth` at depth 1 or 2, and `req.headers` / `res.headers` when the
 * `req` and `res` serializers are replaced), the redactor copies only along that literal path. A `card`, `creditCard`
 * or `formOfPayments` object nested inside such a branch is still kept out of the line, but the censor is also written
 * into the caller's object. Realistic shapes (identity documents, forms of identification, MFA and OAuth bodies,
 * header strings) never nest card objects there, and the tests check that every realistic logged object stays
 * unchanged.
 *
 * Identity document numbers (`documents[*].number`) and the numbers of an Amadeus flight order's forms of
 * identification (`formOfIdentifications[*].number`: passport, identity card or driving licence numbers;
 * FIX-W26-SECURITY) are censored at the same depths: as the list itself (depth 1 of the line) and one level down.
 *
 * The platform's paths (platform/docs/architecture.md §8): Stripe secret keys and webhook secrets, bank numbers,
 * recovery codes, TOTP secrets and `otpauth://` URLs, MFA challenge and invitation tokens, the secret variables of an
 * e-mail (`secretData`, and the links with tokens it holds: `verifyUrl`, `resetUrl`, `acceptUrl`; PBE-011), and the
 * `code` and `state` of an MFA or OAuth body. pino paths
 * cannot look at a sibling key, and `code` alone is the error code of every `err` and error envelope, so `code` and
 * `state` are censored only below the keys `mfa` and `oauth`: a body of
 * `verifyMfa`, `stepUp`, `enableMfa` or `completeStripeConnect` that is ever logged goes under one of those two keys
 * (`logger.warn({ mfa: body }, …)`), never under a generic one.
 *
 * The airline card's paths (ota/docs/architecture.md §9, OADR-0004 point 2; OBE-050): the whole `card` object of the
 * airline-card completion body (the `card` paths above), and its fields `holderName`, `expiryMonth` and `expiryYear` at
 * the top level and one level down for a card flattened into another object (`number` and `securityCode` are covered
 * by the card paths and `securityCode`); the headers the storefront edge and Stripe send, `x-velexis-edge`,
 * `x-csrf-token`, `x-booking-token` and `stripe-signature`. A payout account's `holderName` is censored too.
 *
 * Every path costs time on every line (about 0.1 ms per line for this list): log events, not loops.
 */

/** The value that replaces every redacted field in a log line. */
export const REDACT_CENSOR = "[REDACTED]";

/** Every path pino censors, in the syntax of pino's `redact.paths`. */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  // Depth 1: secrets, tokens, bank numbers, recovery codes and card fields at the top level of a log line.
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
  "secretKey",
  "webhookSecret",
  "iban",
  "accountNumber",
  "recoveryCode",
  "recoveryCodes",
  "totpSecret",
  "otpauthUrl",
  "mfaChallengeToken",
  "invitationToken",
  "secretData",
  "verifyUrl",
  "resetUrl",
  "acceptUrl",
  "card",
  "creditCard",
  "formOfPayments",
  "holderName",
  "expiryMonth",
  "expiryYear",

  // Depth 2: the same keys one level down, and the code and state of an MFA or OAuth body at the top level.
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
  "*.secretKey",
  "*.webhookSecret",
  "*.iban",
  "*.accountNumber",
  "*.recoveryCode",
  "*.recoveryCodes",
  "*.totpSecret",
  "*.otpauthUrl",
  "*.mfaChallengeToken",
  "*.invitationToken",
  "*.secretData",
  "*.verifyUrl",
  "*.resetUrl",
  "*.acceptUrl",
  "*.card",
  "*.creditCard",
  "*.formOfPayments",
  "*.holderName",
  "*.expiryMonth",
  "*.expiryYear",
  "mfa.code",
  "mfa.state",
  "oauth.code",
  "oauth.state",

  // Depth 3: credential headers (also the first-party edge header, the platform's BFF key of PADR-0019 and the
  // signature of a Stripe webhook), card numbers, the code and state of an MFA or OAuth body one level down, card
  // objects.
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'req.headers["x-booking-token"]',
  'req.headers["x-velexis-edge"]',
  'req.headers["x-velexis-bff-key"]',
  'req.headers["stripe-signature"]',
  "*.card.number",
  "*.creditCard.number",
  "documents[*].number",
  "formOfIdentifications[*].number",
  "*.mfa.code",
  "*.mfa.state",
  "*.oauth.code",
  "*.oauth.state",
  "*.*.card",
  "*.*.creditCard",
  "*.*.formOfPayments",

  // Depth 4: identity document and form-of-identification numbers, card objects.
  "*.documents[*].number",
  "*.formOfIdentifications[*].number",
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
