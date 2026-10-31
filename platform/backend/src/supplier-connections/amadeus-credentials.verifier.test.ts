// The pure parts of the OTA's own Amadeus credentials (PBE-053) without a database, Redis or Amadeus: the submission's
// office rules and `public_data` (amadeus-credentials.service.ts), and how the verifier reads `public_data` back and
// turns a token answer into the verdict of `credentials.verify` (amadeus-credentials.verifier.ts). The end-to-end
// behaviour is in test/integration/supplier-connections/own-credentials.int.test.ts.
import { describe, expect, it } from "vitest";
import { SUBMISSION_ERROR_CODE } from "../common/credentials/credentials-verify.processor";
import {
  NOT_A_SUBMITTED_OFFICE,
  officeProblems,
  publicDataOf,
  type SubmitAmadeusCredentialsRequest,
} from "./amadeus-credentials.service";
import {
  AMADEUS_CREDENTIALS_INVALID,
  amadeusPublicDataOf,
  CONNECTION_DISABLED,
  connectionSecretPlace,
  credentialCheckOf,
  InvalidAmadeusSubmissionError,
  refusesCredentials,
  TENANT_NOT_ACTIVE,
} from "./amadeus-credentials.verifier";

const REQUEST: SubmitAmadeusCredentialsRequest = {
  clientId: "acme-amadeus-client",
  clientSecret: "not-a-secret-of-this-test",
  officeIds: ["OSLN12345", "OSLN12346"],
  defaultOfficeId: "OSLN12345",
};

const STUB = "http://127.0.0.1:4900";

describe("officeProblems and publicDataOf", () => {
  it("[PBE-053 AC1] accepts offices among officeIds and defaults the queuing and owner offices to the default office", () => {
    expect(officeProblems(REQUEST)).toEqual([]);
    expect(officeProblems({ ...REQUEST, queuingOfficeId: "OSLN12346", ownerOfficeId: "OSLN12345" })).toEqual(
      [],
    );
    expect(publicDataOf(REQUEST)).toEqual({
      clientId: "acme-amadeus-client",
      officeIds: ["OSLN12345", "OSLN12346"],
      defaultOfficeId: "OSLN12345",
      queuingOfficeId: "OSLN12345",
      ownerOfficeId: "OSLN12345",
    });
    // The secret never reaches public_data.
    expect(JSON.stringify(publicDataOf(REQUEST))).not.toContain(REQUEST.clientSecret);
  });

  it("[PBE-053 AC1] names each office outside officeIds in body order, never echoing the value", () => {
    const problems = officeProblems({
      ...REQUEST,
      defaultOfficeId: "NCE1A0001",
      queuingOfficeId: "NCE1A0002",
      ownerOfficeId: "NCE1A0003",
    });

    expect(problems).toEqual([
      { path: "/defaultOfficeId", code: "unknown", message: NOT_A_SUBMITTED_OFFICE },
      { path: "/queuingOfficeId", code: "unknown", message: NOT_A_SUBMITTED_OFFICE },
      { path: "/ownerOfficeId", code: "unknown", message: NOT_A_SUBMITTED_OFFICE },
    ]);
    expect(JSON.stringify(problems)).not.toMatch(/NCE1A000/);
  });
});

describe("amadeusPublicDataOf", () => {
  it("[PBE-053] reads back what submitAmadeusCredentials stores", () => {
    const stored = JSON.parse(JSON.stringify(publicDataOf(REQUEST))) as Record<string, unknown>;

    expect(amadeusPublicDataOf(stored)).toEqual(publicDataOf(REQUEST));
  });

  it.each([
    ["no client id", { clientId: undefined }],
    ["a client id with a space", { clientId: "acme client" }],
    ["no offices", { officeIds: [] }],
    ["a malformed office", { officeIds: ["osln12345"] }],
    ["a repeated office", { officeIds: ["OSLN12345", "OSLN12345"] }],
    ["a default office outside officeIds", { defaultOfficeId: "NCE1A0001" }],
    ["no queuing office", { queuingOfficeId: undefined }],
  ])("[PBE-053] refuses public_data with %s", (_case, change) => {
    const stored = { ...publicDataOf(REQUEST), ...change };

    expect(() => amadeusPublicDataOf(stored)).toThrow(InvalidAmadeusSubmissionError);
  });
});

describe("credentialCheckOf", () => {
  it("[PBE-053 AC2] verifies a token answer and hands the checked host to apply", () => {
    expect(credentialCheckOf({ outcome: "verified", httpStatus: 200 }, STUB)).toEqual({
      outcome: "verified",
      result: { baseUrl: STUB },
    });
  });

  it.each([
    [{ outcome: "rejected", httpStatus: 401, error: "HTTP 401 invalid_client (Amadeus code 38187)" }],
    [{ outcome: "rejected", httpStatus: 401, error: "HTTP 401" }],
    [{ outcome: "rejected", httpStatus: 400, error: "HTTP 400 invalid_client" }],
  ] as const)(
    "[PBE-053 AC1] rejects credentials Amadeus refuses (%o) with AMADEUS_CREDENTIALS_INVALID",
    (answer) => {
      const check = credentialCheckOf(answer, STUB);

      expect(refusesCredentials(answer)).toBe(true);
      expect(check).toEqual({
        outcome: "rejected",
        errorCode: AMADEUS_CREDENTIALS_INVALID,
        errorMessage: `Amadeus refused the client id and secret (${answer.error}).`,
      });
    },
  );

  it.each([
    [{ outcome: "unavailable", httpStatus: 500, error: "HTTP 500 (Amadeus code 141)" }],
    [{ outcome: "unavailable", httpStatus: 429, error: "HTTP 429" }],
    [{ outcome: "unavailable", httpStatus: null, error: "timeout after 10 s" }],
    [{ outcome: "rejected", httpStatus: 404, error: "HTTP 404" }],
    [{ outcome: "rejected", httpStatus: 400, error: "HTTP 400 invalid_request" }],
    [{ outcome: "rejected", httpStatus: 302, error: "HTTP 302" }],
    [{ outcome: "rejected", httpStatus: 200, error: "HTTP 200 without an access token" }],
  ] as const)("[PBE-053] answers %o unavailable: retried, then PROVIDER_UNAVAILABLE", (answer) => {
    expect(refusesCredentials(answer)).toBe(false);
    expect(credentialCheckOf(answer, STUB)).toEqual({
      outcome: "unavailable",
      errorMessage: `Amadeus could not verify the credentials (${answer.error}).`,
    });
  });

  it("[PBE-053] uses submission result codes of the processor's shape", () => {
    for (const code of [AMADEUS_CREDENTIALS_INVALID, TENANT_NOT_ACTIVE, CONNECTION_DISABLED]) {
      expect(code).toMatch(SUBMISSION_ERROR_CODE);
    }
  });
});

describe("connectionSecretPlace", () => {
  it("[PBE-053 AC2] binds the re-encrypted secret to the connection's row, as the OTA backend opens it", () => {
    expect(connectionSecretPlace("sc_01JATESTRW0000000000000001")).toEqual({
      table: "supplier_connections",
      column: "client_secret_ciphertext",
      rowId: "sc_01JATESTRW0000000000000001",
    });
  });
});
