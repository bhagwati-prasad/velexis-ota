// Integration tests of @velexis/testing/mailpit (X-025) against a real Mailpit: e-mails go out with nodemailer to
// SMTP_URL and are read back through MAILPIT_API_URL (root .env.example, CI services).
//
// Other test files and other runs share the Mailpit, so nothing here empties it (no clear()): every test sends to its
// own uniqueEmail address. This file is also the first of the two files of X-025 AC3 (mailpit-isolation.ts).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractLinks,
  mailpit,
  mailpitApiUrl,
  MailpitTimeoutError,
  uniqueEmail,
  waitForMessage,
} from "../../src/mailpit.js";
import {
  createSmtpTransport,
  expectOnlyOwnMail,
  mailpitMessageId,
  MEETING_TIMEOUT_MS,
  TEST_MAIL_FROM,
  type MailSender,
} from "./mailpit-isolation.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

describe("@velexis/testing/mailpit with Mailpit", () => {
  let transport: MailSender;

  beforeAll(() => {
    transport = createSmtpTransport();
  });

  afterAll(() => {
    transport?.close();
  });

  it("finds an e-mail sent with nodemailer by recipient and subject regex, with its link [X-025 AC1]", async () => {
    const to = uniqueEmail("verify");
    // A test value in a fake link, not a secret.
    const link = `https://portal.example.com/verify-email?token=${randomUUID()}&lang=en`;
    const sent = await transport.sendMail({
      from: TEST_MAIL_FROM,
      to,
      subject: "Verify your e-mail address",
      text: `Welcome to Velexis.\n\nVerify your e-mail address: ${link}\n\nThe link is valid for 24 hours.\n`,
      html:
        `<p>Welcome to Velexis.</p><p><a href="${link.replaceAll("&", "&amp;")}">Verify your e-mail address</a></p>` +
        "<p>The link is valid for 24 hours.</p>",
    });

    const message = await waitForMessage({ to, subject: /^Verify your e-mail/ });
    expect(message.MessageID).toBe(mailpitMessageId(sent));
    expect(message.To.map((address) => address.Address)).toEqual([to]);
    expect(message.From?.Address).toBe("no-reply@example.com");
    expect(message.Subject).toBe("Verify your e-mail address");
    expect(message.Text).toContain(link);
    expect(message.HTML).toContain("&amp;lang=en");
    // The href of the HTML part (decoded) and the URL of the text part: the same link, once.
    expect(extractLinks(message)).toEqual([link]);

    // The same e-mail through search() and get().
    const found = await mailpit.search({ to, subject: "Verify your e-mail address" });
    expect(found.map((summary) => summary.ID)).toEqual([message.ID]);
    expect(found[0]?.Created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const again = await mailpit.get(message.ID);
    expect([again.ID, again.Text, again.HTML]).toEqual([message.ID, message.Text, message.HTML]);
  });

  it("reads Mailpit at MAILPIT_API_URL", () => {
    expect(mailpit.apiUrl).toBe(mailpitApiUrl().replace(/\/$/, ""));
  });

  it("fails after the timeout with a readable message for a recipient that never gets mail [X-025 AC2]", async () => {
    const to = uniqueEmail("nobody");
    const started = performance.now();
    const error = await waitForMessage({ to, subject: /Verify/, timeoutMs: 300 }).catch(
      (caught: unknown) => caught,
    );
    const elapsed = performance.now() - started;

    expect(error).toBeInstanceOf(MailpitTimeoutError);
    expect((error as Error).message).toMatch(
      new RegExp(
        `^waitForMessage: no message to ${escapeRegExp(to)} with a subject matching /Verify/ arrived within 300 ms ` +
          `\\(Mailpit at ${escapeRegExp(mailpit.apiUrl)}, \\d+ checks\\)\\.\\n` +
          "Messages to that address it did see: none\\.$",
      ),
    );
    expect((error as MailpitTimeoutError).seen).toEqual([]);
    // After the timeout, not before, and not the default 5 s.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(3_000);
  });

  it("lists the messages to the recipient that it did see when none has the subject [X-025 AC2]", async () => {
    const to = uniqueEmail("welcome-only");
    await transport.sendMail({ from: TEST_MAIL_FROM, to, subject: "Welcome to Velexis", text: "Welcome." });
    const welcome = await waitForMessage({ to, subject: "Welcome to Velexis" });

    const error = await waitForMessage({ to, subject: "Verify your e-mail address", timeoutMs: 200 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MailpitTimeoutError);
    const lines = (error as Error).message.split("\n");
    expect(lines[0]).toContain(`no message to ${to} with the subject "Verify your e-mail address" arrived`);
    expect(lines.slice(1)).toEqual([
      "Messages to that address it did see (1):",
      expect.stringMatching(
        new RegExp(
          `^ {2}- "Welcome to Velexis", received \\d{4}-\\d{2}-\\d{2}T\\S+, ID ${escapeRegExp(welcome.ID)}$`,
        ),
      ),
    ]);
  });

  it(
    "two parallel test files using uniqueEmail never see each other's messages (first file) [X-025 AC3]",
    async () => {
      await expectOnlyOwnMail("first", transport);
    },
    MEETING_TIMEOUT_MS + 10_000,
  );
});
