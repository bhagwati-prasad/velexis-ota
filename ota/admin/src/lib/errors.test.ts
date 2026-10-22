import { OTA_ERROR_CODES } from "@velexis/errors";
import {
  ConnectionError,
  PermissionError,
  RateLimitError,
  ValidationError,
  VelexisError,
  createVelexisClient,
} from "@velexis/ota-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  INITIAL_ACTION_STATE,
  INVALID_FORM_MESSAGE,
  actionFailure,
  actionSuccess,
  fieldError,
  fieldErrorId,
  fieldName,
  fromZod,
} from "./action-state";
import {
  ERROR_MESSAGES,
  GENERIC_ERROR_MESSAGE,
  describeError,
  errorMessage,
  fieldErrorsToForm,
  fieldNameOfPointer,
  fromVelexisError,
  isVelexisErrorLike,
  withRequestId,
} from "./errors";

/** What the API's own `message` says in these tests: the admin must never show it. */
const API_MESSAGE = "Raw API text that the admin never shows";

/** An SDK error as a console call throws it, from the API's error envelope. */
async function sdkError(
  status: number,
  error: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const client = createVelexisClient({
    secretKey: "sk_test_dummy_key_for_errors",
    baseUrl: "http://127.0.0.1:4000",
    maxRetries: 0,
    fetch: () =>
      Promise.resolve(
        Response.json(
          { error: { message: API_MESSAGE, status, requestId: "req_01JBTEST", ...error } },
          { status, headers: { "X-Request-Id": "req_01JBTEST", ...headers } },
        ),
      ),
  });
  return client.console.auth.me().then(
    () => {
      throw new Error("expected the call to fail");
    },
    (caught: unknown) => caught,
  );
}

describe("error messages", () => {
  it("has a message only for codes of the OTA catalogue and the SDK's client-side codes", () => {
    const known = new Set<string>([...OTA_ERROR_CODES, "NETWORK_ERROR", "TIMEOUT", "ABORTED"]);

    for (const code of Object.keys(ERROR_MESSAGES)) {
      expect(known.has(code), code).toBe(true);
    }
  });

  it("covers every error of routes.md §1 and the session codes the console answers", () => {
    for (const code of [
      "TOKEN_EXPIRED",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "ENVIRONMENT_NOT_ALLOWED",
      "TENANT_SUSPENDED",
      "PRECONDITION_FAILED",
      "VERSION_CONFLICT",
      "RATE_LIMITED",
      "SUPPLIER_TIMEOUT",
      "REFRESH_TOKEN_INVALID",
      "REFRESH_TOKEN_REUSED",
      "STAFF_MEMBERSHIP_INACTIVE",
      "PORTAL_TOKEN_INVALID",
      "MFA_REQUIRED",
      "NOT_IMPLEMENTED",
    ] as const) {
      expect(ERROR_MESSAGES[code], code).toBeTruthy();
    }
    expect(errorMessage("PRECONDITION_FAILED")).toBe(
      "This record changed; reload to see the latest version.",
    );
    expect(errorMessage("ENVIRONMENT_NOT_ALLOWED")).toBe("Live is not available for this OTA or role.");
    expect(errorMessage("SUPPLIER_TIMEOUT")).toBe("Amadeus did not answer. Resync before retrying.");
  });

  it("maps an SDK error's code to the admin's message, never the API's own message", async () => {
    const error = await sdkError(412, { code: "PRECONDITION_FAILED" });

    expect(error).toBeInstanceOf(VelexisError);
    expect(isVelexisErrorLike(error)).toBe(true);
    expect(describeError(error)).toEqual({
      message: ERROR_MESSAGES.PRECONDITION_FAILED,
      code: "PRECONDITION_FAILED",
      requestId: "req_01JBTEST",
    });
    expect(JSON.stringify(describeError(error))).not.toContain(API_MESSAGE);
  });

  it("names the missing permission of a 403 FORBIDDEN", async () => {
    const error = await sdkError(403, {
      code: "FORBIDDEN",
      details: { requiredPermission: "bookings:issue" },
    });

    expect(error).toBeInstanceOf(PermissionError);
    expect(describeError(error).message).toBe("You do not have permission to do this (bookings:issue).");
    // A value that is not a permission is not echoed.
    const odd = await sdkError(403, { code: "FORBIDDEN", details: { requiredPermission: "<script>" } });
    expect(describeError(odd).message).toBe(ERROR_MESSAGES.FORBIDDEN);
  });

  it("says how long to wait after 429 RATE_LIMITED", async () => {
    const error = await sdkError(429, { code: "RATE_LIMITED" }, { "Retry-After": "12" });

    expect(error).toBeInstanceOf(RateLimitError);
    expect(describeError(error).message).toBe("Too many requests, retry in 12 s.");
    expect(
      errorMessage({ code: "RATE_LIMITED", status: 429, requestId: null, fieldErrors: [], retryable: true }),
    ).toBe(ERROR_MESSAGES.RATE_LIMITED);
  });

  it("falls back to the message of the status class for a code without a message of its own", async () => {
    const unknown = await sdkError(422, { code: "ASSET_SOMETHING_NEW" });
    const outage = await sdkError(502, { code: "SOMETHING_UPSTREAM" });

    expect(describeError(unknown).message).toBe(
      "The request was not accepted. Check the values and try again.",
    );
    expect(describeError(outage).message).toBe(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    expect(errorMessage("NOT_A_CODE")).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("describes a network failure and any other error without leaking it", () => {
    const network = new ConnectionError({ code: "NETWORK_ERROR", message: "fetch failed", status: 0 });

    expect(describeError(network)).toEqual({ message: ERROR_MESSAGES.NETWORK_ERROR, code: "NETWORK_ERROR" });
    expect(describeError(new Error("SELECT * FROM secrets"))).toEqual({ message: GENERIC_ERROR_MESSAGE });
    expect(isVelexisErrorLike({ digest: "NEXT_REDIRECT;replace;/x" })).toBe(false);
  });

  it("appends the request id for plain-text places", () => {
    expect(withRequestId("Failed.", "req_1")).toBe("Failed. (request id req_1)");
    expect(withRequestId("Failed.", null)).toBe("Failed.");
  });
});

describe("field errors to form state", () => {
  it("derives form field names from the API's JSON pointers", () => {
    expect(fieldNameOfPointer("/reason")).toBe("reason");
    expect(fieldNameOfPointer("/contacts/0/email")).toBe("contacts.0.email");
    expect(fieldNameOfPointer("/path/bookingId")).toBe("bookingId");
    expect(fieldNameOfPointer("/query/status")).toBe("status");
    expect(fieldNameOfPointer("/header/If-Match")).toBe("ifMatch");
    expect(fieldNameOfPointer("/remarks/a~1b~0c")).toBe("remarks.a/b~c");
    expect(fieldNameOfPointer("")).toBeUndefined();
    expect(fieldNameOfPointer("reason")).toBeUndefined();
  });

  it("keeps the first message per field, the API's or one by its code, and maps names the form uses", () => {
    expect(
      fieldErrorsToForm(
        [
          { path: "/reason", code: "required" },
          { path: "/reason", code: "maxLength", message: "Too long" },
          { path: "/contacts/0/email", code: "format", message: "Must be an e-mail address" },
          { path: "/header/If-Match", code: "required" },
          { path: "", code: "required", message: "The request body is required" },
          { path: "/odd", code: "somethingElse" },
        ],
        { ifMatch: "version" },
      ),
    ).toEqual({
      reason: "Required.",
      "contacts.0.email": "Must be an e-mail address",
      version: "Required.",
      odd: "This value was not accepted.",
    });
  });

  it("turns a 400 VALIDATION_FAILED of a server action into the form's state with the request id", async () => {
    const error = await sdkError(400, {
      code: "VALIDATION_FAILED",
      fieldErrors: [
        { path: "/text", code: "maxLength", message: "At most 2000 characters" },
        { path: "/path/bookingId", code: "pattern" },
      ],
    });

    expect(error).toBeInstanceOf(ValidationError);
    expect(fromVelexisError(error)).toEqual({
      ok: false,
      message: ERROR_MESSAGES.VALIDATION_FAILED,
      code: "VALIDATION_FAILED",
      requestId: "req_01JBTEST",
      fieldErrors: { text: "At most 2000 characters", bookingId: "Not in the expected format." },
    });
  });

  it("throws anything that is not an SDK error again (bugs, Next.js redirects)", () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/bookings;307;",
    });

    expect(() => fromVelexisError(redirect)).toThrow(redirect);
    expect(() => fromVelexisError("boom")).toThrow();
  });
});

describe("action state", () => {
  it("starts empty and records successes and failures as plain data", () => {
    expect(INITIAL_ACTION_STATE).toEqual({});
    expect(actionSuccess("Tickets issued")).toEqual({ ok: true, message: "Tickets issued" });
    expect(actionSuccess()).toEqual({ ok: true });
    expect(actionFailure("Failed.", { code: "CONFLICT", requestId: null, fieldErrors: {} })).toEqual({
      ok: false,
      message: "Failed.",
      code: "CONFLICT",
    });
    const state = actionFailure("Failed.", { requestId: "req_1", fieldErrors: { reason: "Required." } });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(fieldError(state, "reason")).toBe("Required.");
    expect(fieldError(state, "toString")).toBeUndefined();
  });

  it("turns a Zod failure into one message per field", () => {
    const schema = z.object({
      reason: z.string().min(3, "Give a reason of at least 3 characters.").max(10, "Too long."),
      contacts: z.array(z.object({ email: z.string().email("Enter an e-mail address.") })),
    });

    const parsed = schema.safeParse({ reason: "", contacts: [{ email: "x" }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(fromZod(parsed.error)).toEqual({
      ok: false,
      message: INVALID_FORM_MESSAGE,
      code: "VALIDATION_FAILED",
      fieldErrors: {
        reason: "Give a reason of at least 3 characters.",
        "contacts.0.email": "Enter an e-mail address.",
      },
    });

    const whole = z.object({ a: z.string() }).refine(() => false, "The form is not complete.");
    const failed = whole.safeParse({ a: "x" });
    expect(failed.success ? undefined : fromZod(failed.error).message).toBe("The form is not complete.");
  });

  it("names the error element of a field for aria-describedby", () => {
    expect(fieldName(["contacts", 0, "email"])).toBe("contacts.0.email");
    expect(fieldErrorId("contacts.0.email")).toBe("contacts-0-email-error");
  });
});
