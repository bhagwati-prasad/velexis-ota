// The second file of the X-025 AC3 scenario (mailpit-isolation.ts): it runs at the same time as mailpit.int.test.ts,
// in another Vitest worker, and sends to its own uniqueEmail("parallel") address with the same subject.
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  createSmtpTransport,
  expectOnlyOwnMail,
  MEETING_TIMEOUT_MS,
  type MailSender,
} from "./mailpit-isolation.js";

describe("two test files using uniqueEmail in parallel (second file)", () => {
  let transport: MailSender;

  beforeAll(() => {
    transport = createSmtpTransport();
  });

  afterAll(() => {
    transport?.close();
  });

  it(
    "never see each other's messages [X-025 AC3]",
    async () => {
      await expectOnlyOwnMail("second", transport);
    },
    MEETING_TIMEOUT_MS + 10_000,
  );
});
