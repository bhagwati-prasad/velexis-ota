// support/mailpit.ts without a Mailpit: the client of @velexis/testing/mailpit is replaced by a fake whose
// `waitForMessage` the tests answer; extractLinks and the rest of the module stay real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MailpitModule from "@velexis/testing/mailpit";
import type { MailpitMessage } from "@velexis/testing/mailpit";
import { E2E_MAIL_TIMEOUT_MS, waitForEmail, waitForLink } from "../support/mailpit";

const { waitForMessage } = vi.hoisted(() => ({ waitForMessage: vi.fn() }));

vi.mock("@velexis/testing/mailpit", async (importOriginal) => {
  const actual = await importOriginal<typeof MailpitModule>();
  return {
    ...actual,
    mailpitApiUrl: () => "http://127.0.0.1:8025",
    createMailpitClient: () => ({ waitForMessage }),
  };
});

const TO = "signup+0b5e@example.com";

/** A message as Mailpit returns it, with `html` as its HTML part. */
function message(html: string, subject = "Verify your e-mail address"): MailpitMessage {
  return {
    ID: "m1",
    MessageID: "m1@example.com",
    From: { Name: "Velexis", Address: "no-reply@mail.ota.example.com" },
    To: [{ Name: "", Address: TO }],
    Cc: [],
    Bcc: [],
    ReplyTo: [],
    ReturnPath: "",
    Subject: subject,
    Date: "2026-10-14T12:00:00Z",
    Tags: [],
    Text: "",
    HTML: html,
    Size: html.length,
    Inline: [],
    Attachments: [],
  };
}

beforeEach(() => {
  waitForMessage.mockReset();
});

describe("waitForEmail", () => {
  it("waits for the recipient's newest e-mail with the stack's timeout unless the journey gives one", async () => {
    waitForMessage.mockResolvedValue(message("<p>hello</p>"));
    await waitForEmail({ to: TO });
    expect(waitForMessage).toHaveBeenLastCalledWith({ to: TO, timeoutMs: E2E_MAIL_TIMEOUT_MS });
    await waitForEmail({ to: TO, subject: /verify/i, timeoutMs: 2_000 });
    expect(waitForMessage).toHaveBeenLastCalledWith({ to: TO, subject: /verify/i, timeoutMs: 2_000 });
  });
});

describe("waitForLink", () => {
  const html =
    '<a href="/help">Help</a>' +
    '<a href="http://127.0.0.1:3001/verify-email?token=admin-token">elsewhere</a>' +
    '<a href="http://127.0.0.1:3000/verify-email?token=secret-token-123">Verify</a>' +
    '<a href="http://127.0.0.1:3000/privacy">Privacy</a>';

  it("returns the link with the path and origin asked for, query string included", async () => {
    waitForMessage.mockResolvedValue(message(html));
    const link = await waitForLink({ to: TO, path: "/verify-email", origin: "http://127.0.0.1:3000" });
    expect(link.href).toBe("http://127.0.0.1:3000/verify-email?token=secret-token-123");
    expect(link.searchParams.get("token")).toBe("secret-token-123");
  });

  it("takes the first link with the path when no origin is asked for", async () => {
    waitForMessage.mockResolvedValue(message(html));
    const link = await waitForLink({ to: TO, path: "/verify-email" });
    expect(link.origin).toBe("http://127.0.0.1:3001");
  });

  it("names the links the e-mail has without their query strings, which hold the tokens", async () => {
    waitForMessage.mockResolvedValue(message(html));
    const failure = waitForLink({ to: TO, path: "/reset-password", origin: "http://127.0.0.1:3000" });
    await expect(failure).rejects.toThrow(
      'the e-mail "Verify your e-mail address" to signup+0b5e@example.com has no link to ' +
        "http://127.0.0.1:3000/reset-password (links: http://127.0.0.1:3001/verify-email, " +
        "http://127.0.0.1:3000/verify-email, http://127.0.0.1:3000/privacy)",
    );
    await expect(failure).rejects.not.toThrow(/token/);
  });
});
